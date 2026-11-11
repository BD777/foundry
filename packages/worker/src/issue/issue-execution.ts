import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentSession,
  Issue,
  Run,
  RunSessionPayload,
} from "@bd777/foundry-protocol";
import { ExecutionStore } from "../candidate-store/execution-storage.js";
import type {
  IssueEnvironment,
  WorkspaceRegistration,
} from "../candidate-store/execution-types.js";
import {
  ensureRepository,
  prepareIssueEnvironment,
  snapshotEnvironment,
} from "./issue-environments.js";
import { refreshCandidate } from "./candidate-refresh.js";
import {
  executorEnvironment,
  issueIsolationError,
  issueSandboxProfile,
} from "./execution-sandbox.js";
import { issueReferences } from "./issue-references.js";
import { issueRuntimeOptions } from "./issue-runtime-options.js";
import {
  confirmedExecutionPrompt,
  executionFeedback,
} from "./issue-execution-prompt.js";
import { readWorkspace } from "../workspace/workspaces.js";
import { writeJSON } from "../platform/storage.js";
import { errorMessage } from "../platform/utils.js";
import {
  AgentSessionCanceledError,
  takeQueuedSessionCancel,
} from "../session/session-control.js";
import type { WorkspaceSandbox } from "../session/index.js";
import type { SessionAmbientEnv } from "../session/session-ambient.js";
import type { SessionRole } from "../session/session-role.js";

export type IssueCompletion = {
  canceled?: boolean;
  response?: string;
  checks: string[];
  runId: string;
  environmentId?: string;
  environmentRevision?: number;
  executionCwd?: string;
  error?: string;
};

/** The session_completed message that hands an Issue result to the server. */
export function issueSessionCompletion(
  sessionId: string,
  inputId: string | undefined,
  completion: IssueCompletion,
): Record<string, unknown> {
  return {
    sessionId,
    inputId,
    response: completion.response,
    error: completion.error,
    issueResult: completion,
  };
}

/**
 * An Issue's execution: an ordinary session (role issue_execution) that
 * implements the confirmed contract in the Issue's candidate. `execute`
 * runs it like any session (daemon/session-execution.ts) with the role this
 * adds: the candidate it works in and its sandbox, the contract as its
 * prompt, repositories prepared between turns, and the candidate it leaves
 * as its result. A contract that is not confirmed refuses it before it
 * starts.
 */
export async function executeIssue(
  serverURL: string,
  workspacePath: string,
  payload: RunSessionPayload,
  /** The session's Foundry credentials, scoped to this Issue. */
  ambient: SessionAmbientEnv,
  execute: (role: SessionRole) => Promise<void>,
  store = new ExecutionStore(),
): Promise<void> {
  const { session, issue } = payload;
  if (!issue || issue.id !== session.issueId)
    throw new Error("The Issue to execute was not sent with its session.");
  if (
    issue.contractState !== "confirmed" ||
    !issue.currentContractRevision ||
    issue.draftContractRevision
  )
    throw new Error(
      "contract_confirmation_required: confirm the exact criterion contract before execution",
    );
  const contract = issue.executionContract;
  if (
    !contract ||
    contract.issueId !== issue.id ||
    contract.workspaceId !== issue.workspaceId ||
    contract.revision !== issue.currentContractRevision ||
    contract.status !== "confirmed"
  )
    throw new Error("confirmed_execution_contract_required");
  const workspace = readWorkspace(workspacePath);
  if (issue.workspaceId && issue.workspaceId !== workspace.id)
    throw new Error("Issue belongs to another workspace");
  await store.lock(workspace.id, `execution-${issue.id}`, () =>
    execute(
      issueExecutionRole(
        serverURL,
        workspacePath,
        workspace.id,
        session,
        issue,
        payload.userFiles === "readable" ? "readable" : "hidden",
        ambient,
        store,
      ),
    ),
  );
}

function issueExecutionRole(
  serverURL: string,
  workspacePath: string,
  workspaceId: string,
  session: AgentSession,
  issue: Issue,
  userFiles: "readable" | "hidden",
  ambient: SessionAmbientEnv,
  store: ExecutionStore,
): SessionRole {
  // The dispatch names the run; a model retry gets a fresh native execution
  // record while staying the same logical session input.
  const runId = session.dispatchId?.trim() || session.id;
  const retained = store.environment(workspaceId, issue.id);
  const runDir = retained
    ? store.runDirectory(retained, runId)
    : resolve(store.executionRoot, workspaceId, "runs", runId);
  const run: Run = {
    id: runId,
    runtime: issue.runtime,
    status: "running",
    startedAt: new Date().toISOString(),
  };
  let environment: IssueEnvironment | undefined;
  let prepared = session;
  const finish = (
    response: string,
    error?: string,
    canceled = false,
  ): IssueCompletion => {
    run.status = canceled ? "canceled" : error ? "failed" : "completed";
    run.error = error;
    run.completedAt = new Date().toISOString();
    writeJSON(resolve(runDir, "run.json"), run);
    const completion: IssueCompletion = {
      canceled,
      response: response.slice(0, 64_000),
      runId,
      checks: error
        ? [error]
        : ["Candidate changes await explicit Workspace Accept"],
      environmentId: run.environmentId,
      environmentRevision: run.environmentRevision,
      executionCwd: run.executionCwd,
      error,
    };
    writeJSON(resolve(runDir, "completion.json"), completion);
    return completion;
  };
  return {
    prepare: async (emit) => {
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      writeJSON(resolve(runDir, "run.json"), run);
      writeJSON(resolve(runDir, "issue.json"), issue);
      environment = await prepareIssueEnvironment(
        workspacePath,
        workspaceId,
        issue.id,
        store,
      );
      environment.contractRevision = issue.currentContractRevision;
      environment.controlServerURL = serverURL;
      environment.userFiles = userFiles;
      store.saveEnvironment(environment);
      if (issue.checks.includes("Changes requested"))
        environment = await refreshCandidate(environment, store);
      await emit("Candidate workspace ready", environment.cwd);
      // The contract's reference materials travel with every turn, so the
      // execution can look at what it is asked to match.
      const references = await issueReferences(environment, issue, store);
      if (references.length)
        await emit(
          "Loaded references",
          references.map((reference) => reference.name).join(", "),
        );
      prepared = {
        ...session,
        ...issueRuntimeOptions(issue),
        input: {
          id: session.input?.id ?? session.id,
          prompt: "",
          attachments: references,
        },
      };
      return {
        execution: {
          cwd: environment.cwd,
          // Session records stay beside the candidate, never inside it.
          stateRoot: environment.directory,
        },
        session: prepared,
      };
    },
    nativeSessionId: (nativeSessionId) => {
      // A later execution of this Issue resumes the same native session.
      environment!.nativeSessionId = nativeSessionId;
      store.saveEnvironment(environment!);
    },
    run: async (agent, emit) => {
      if (issue.runtime === "mock") {
        const response = `# ${issue.title}\n\n${issue.sourceInput}\n\nMock execution completed in an isolated Issue worktree.\n`;
        writeFileSync(
          resolve(environment!.cwd, `foundry-result-${issue.id}.md`),
          response,
        );
        return { response };
      }
      const broker = await repositoryBroker(
        store.registration(workspaceId)!,
        () => environment!,
      );
      try {
        // A repository the agent asks for is prepared once its turn ended;
        // the next turn resumes it with that repository writable.
        for (;;) {
          broker.requested.clear();
          environment!.status = "running";
          store.saveEnvironment(environment!);
          const prompt = executionPrompt(
            issue,
            environment!,
            broker.registration,
          );
          const result = await agent(
            {
              ...prepared,
              prompt,
              nativeSessionId: environment!.nativeSessionId,
              input: { ...prepared.input!, prompt },
            },
            executionSandbox(environment!, broker, ambient),
          ).catch((error) => {
            throw issueIsolationError(error);
          });
          if (!broker.requested.size) return result;
          for (const repoId of broker.requested) {
            environment = await ensureRepository(
              workspaceId,
              issue.id,
              repoId,
              store,
            );
            await emit(
              "Repository prepared",
              broker.registration.repositories.find(
                (repo) => repo.id === repoId,
              )!.relativePath,
            );
          }
          if (takeQueuedSessionCancel(session.id, session.input?.id))
            throw new AgentSessionCanceledError();
        }
      } finally {
        broker.close();
      }
    },
    settle: async (result, emit) => {
      environment = await store.lock(
        workspaceId,
        `environment-${issue.id}`,
        () => snapshotEnvironment(environment!, store),
      );
      run.environmentId = environment.id;
      run.environmentRevision = environment.revision;
      run.executionCwd = environment.cwd;
      await emit(
        "Awaiting Workspace Accept",
        `${environment.repositories.length} repositories; candidate revision ${environment.revision}`,
      );
      return { issueResult: finish(result.response) };
    },
    stopped: (error, canceled) => {
      const message = canceled
        ? "Issue execution canceled; candidate files are retained"
        : errorMessage(error);
      if (environment) {
        environment = store.environment(workspaceId, issue.id) ?? environment;
        environment.status = "failed";
        environment.error = message;
        store.saveEnvironment(environment);
        run.environmentId = environment.id;
        run.executionCwd = environment.cwd;
      }
      return { error: message, issueResult: finish("", message, canceled) };
    },
  };
}

// TODO(native-prompts): besides the confirmed contract (the task itself),
// the "Foundry execution contract" text tells the agent how to behave and
// which Foundry tool to use; that belongs to the tools' own descriptions and
// the sandbox. Rework with the Issue role refactor.
/** What a turn of the execution is asked: the contract, then its candidate. */
function executionPrompt(
  issue: Issue,
  environment: IssueEnvironment,
  registration: WorkspaceRegistration,
): string {
  let prompt = `${confirmedExecutionPrompt(issue)}\n\nFoundry execution contract:\nYour CWD is the candidate workspace: ${environment.cwd}. Original workspace ${environment.sourcePath} is available for read-only exploration, including unprepared repositories. Only candidate content is submitted for review. Do not modify original paths. Git staging/commits, formal verification and Accept are performed by Foundry after you finish. Your execution summary is not verification evidence. If the goal or rubric needs to change, ask the user to revise and confirm the contract; do not silently substitute standards. A decision or a permission only the person can give (a choice the contract leaves open, or a side effect outside the candidate such as deploying or sending a message) is asked with the Foundry tool ask_person; once the turn ends, Foundry resumes you here with the answer.\nRepositories: ${JSON.stringify(registration.repositories.map((repo) => ({ id: repo.id, path: repo.relativePath, status: repo.status, prepared: environment.repositories.some((candidate) => candidate.repoId === repo.id && candidate.status === "ready") })))}\nTo prepare an additional repository run: ${JSON.stringify(process.execPath)} ${JSON.stringify(repositoryToolPath)} prepare <repository-id>. If queued, end your turn immediately; Foundry will prepare the worktree and resume you. Never create replacement repositories or symlink source directories. Prepared repositories retain their relative paths under CWD. Complete the task and report changes and validation.`;
  const feedback = executionFeedback(issue);
  if (feedback.length)
    prompt += `\n\nPost-confirmation execution feedback, in order (does not amend the contract):\n${feedback.join("\n\n")}`;
  if (environment.conflicts?.length)
    prompt += `\n\nBringing the Workspace's newer accepted changes into this candidate left merge conflicts in:\n${environment.conflicts.join("\n")}\nResolve them in the candidate files so the accepted changes and this Issue's confirmed contract both hold, and remove every conflict marker. Foundry stages and commits the resolved files after this turn, then the result is checked again.`;
  else if (environment.error)
    prompt += `\n\nThe previous execution of this Issue ended with:\n${environment.error}\nContinue from the current candidate files.`;
  return prompt;
}

const repositoryToolPath = fileURLToPath(
  new URL("./repository-tool.js", import.meta.url),
);

/** The candidate's sandbox, with the repository broker reachable. */
function executionSandbox(
  environment: IssueEnvironment,
  broker: RepositoryBroker,
  ambient: SessionAmbientEnv,
): WorkspaceSandbox {
  return {
    profile: issueSandboxProfile(environment, broker.registration, [
      broker.socketPath,
    ]),
    env: {
      ...executorEnvironment(environment),
      FOUNDRY_REPOSITORY_SOCKET: broker.socketPath,
      FOUNDRY_REPOSITORY_TOKEN: broker.token,
    },
    stderrFile: resolve(environment.scratch, "executor.stderr.log"),
    timeoutMs: Number(process.env.FOUNDRY_ISSUE_TIMEOUT_MS ?? 900_000),
    ambient,
  };
}

type RepositoryBroker = Awaited<ReturnType<typeof repositoryBroker>>;

/**
 * The socket repository-tool.ts talks to from inside the sandbox: it lists
 * the workspace's repositories and queues one for preparation.
 */
async function repositoryBroker(
  registration: WorkspaceRegistration,
  environment: () => IssueEnvironment,
) {
  const requested = new Set<string>();
  const token = randomUUID();
  const socketPath = resolve(tmpdir(), `foundry-${randomUUID()}.sock`);
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let request = "";
    socket.setTimeout(30_000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", (data) => {
      request += data.toString();
      if (request.length > 8192) socket.destroy();
    });
    socket.on("end", () => {
      try {
        const value = JSON.parse(request);
        if (value.token !== token)
          throw new Error("Invalid repository capability");
        if (value.action === "list") {
          socket.end(JSON.stringify(registration.repositories));
          return;
        }
        const repo = registration.repositories.find(
          (item) => item.id === value.repoId,
        );
        if (value.action !== "prepare" || !repo || repo.status !== "ready")
          throw new Error("Repository is not available for preparation");
        const current = environment();
        if (
          current.repositories.some(
            (item) => item.repoId === repo.id && item.status === "ready",
          )
        ) {
          socket.end(
            JSON.stringify({
              cwd: resolve(current.cwd, repo.relativePath),
              ready: true,
            }),
          );
          return;
        }
        requested.add(repo.id);
        socket.end(
          JSON.stringify({
            ready: false,
            // TODO(native-prompts): behaviour guidance ("finish this turn")
            // in a tool result; rework with the Issue role refactor.
            instruction:
              "Preparation queued. Finish this turn now. Foundry will prepare the repository and resume this session with the new candidate path writable.",
          }),
        );
      } catch (error) {
        socket.end(JSON.stringify({ error: String(error) }));
      }
    });
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o600);
      done();
    });
  });
  return {
    registration,
    requested,
    token,
    socketPath,
    close: () => server.close(),
  };
}
