import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AgentSessionEvent,
  Issue,
  Run,
  SessionSkillRef,
} from "@bd777/foundry-protocol";
import {
  daemonMessageTypes,
  validateEvidenceModel,
} from "@bd777/foundry-protocol";
import { ExecutionStore } from "../candidate-store/execution-storage.js";
import {
  prepareIssueEnvironment,
  snapshotEnvironment,
} from "./issue-environments.js";
import { runIssueExecutor } from "./issue-executor.js";
import type { AgentProfileLocalConfig } from "../harness/profiles.js";
import type { SessionAmbientEnv } from "../session/session-ambient.js";
import { readWorkspace } from "../workspace/workspaces.js";
import type { ReliableSessionTransport } from "../transport/transport.js";
import { writeJSON } from "../platform/storage.js";
import type { IssueEnvironment } from "../candidate-store/execution-types.js";
import { refreshCandidate } from "./candidate-refresh.js";
import {
  beginIssueExecution,
  finishIssueExecution,
} from "./execution-process.js";
import { errorMessage } from "../platform/utils.js";

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

export interface RunTransport {
  appendEvent(event: AgentSessionEvent): Promise<void>;
  completeIssue(issueId: string, input: IssueCompletion): Promise<void>;
  startRun(issueId: string, run: Run): Promise<void>;
}

/**
 * An Issue execution reports through its session (role issue_execution): the
 * run starts and ends with the session, run events are session events, and
 * the Issue result travels with session_completed.
 */
export class SessionRunTransport implements RunTransport {
  constructor(
    private readonly transport: ReliableSessionTransport,
    private readonly sessionId: string,
    private readonly inputId?: string,
  ) {}
  async startRun(): Promise<void> {
    this.transport.send(daemonMessageTypes.sessionStarted, {
      sessionId: this.sessionId,
      inputId: this.inputId,
    });
  }
  async appendEvent(event: AgentSessionEvent): Promise<void> {
    this.transport.send(daemonMessageTypes.sessionEvent, { event });
  }
  async completeIssue(_issueId: string, input: IssueCompletion): Promise<void> {
    this.transport.send(
      daemonMessageTypes.sessionCompleted,
      issueSessionCompletion(this.sessionId, this.inputId, input),
    );
  }
}

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
 * Implement a confirmed Issue in its candidate workspace. `runId` names this
 * attempt: the id of the execution session the server dispatched.
 */
export async function executeIssue(
  serverURL: string,
  workspacePath: string,
  issue: Issue,
  transport: RunTransport,
  store = new ExecutionStore(),
  skillRefs: SessionSkillRef[] = [],
  userFiles: "readable" | "hidden" = "hidden",
  runId = `run_${randomUUID()}`,
  profileOverride?: AgentProfileLocalConfig,
  ambient?: SessionAmbientEnv,
  draftsEnabled = false,
): Promise<void> {
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
    validateEvidenceModel("IssueContract", contract).length ||
    contract.issueId !== issue.id ||
    contract.workspaceId !== issue.workspaceId ||
    contract.revision !== issue.currentContractRevision ||
    contract.status !== "confirmed"
  )
    throw new Error("confirmed_execution_contract_required");
  const workspace = readWorkspace(workspacePath);
  if (issue.workspaceId && issue.workspaceId !== workspace.id)
    throw new Error("Issue belongs to another workspace");
  return store.lock(workspace.id, `execution-${issue.id}`, async () => {
    const retained = store.environment(workspace.id, issue.id);
    const runDir = retained
      ? store.runDirectory(retained, runId)
      : resolve(store.executionRoot, workspace.id, "runs", runId);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const run: Run = {
      id: runId,
      runtime: issue.runtime,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    writeJSON(resolve(runDir, "run.json"), run);
    writeJSON(resolve(runDir, "issue.json"), issue);
    await transport.startRun(issue.id, run);
    const record = async (
      label: string,
      detail: string,
      level: AgentSessionEvent["level"] = "info",
    ): Promise<void> => {
      await transport.appendEvent({
        id: `evt_${randomUUID()}`,
        sessionId: runId,
        at: new Date().toISOString(),
        label,
        detail,
        level,
      });
    };
    let environment: IssueEnvironment | undefined;
    let response = "";
    const control = beginIssueExecution(issue.id);
    try {
      control.signal.throwIfAborted();
      environment = await prepareIssueEnvironment(
        workspacePath,
        workspace.id,
        issue.id,
        store,
      );
      environment.contractRevision = issue.currentContractRevision;
      environment.controlIsolationVersion = 1;
      environment.controlServerURL = serverURL;
      environment.userFiles = userFiles;
      store.saveEnvironment(environment);
      if (issue.checks.includes("Changes requested"))
        environment = await refreshCandidate(environment, store);
      await record("Candidate workspace ready", environment.cwd);
      if (issue.runtime === "mock") {
        response = `# ${issue.title}\n\n${issue.sourceInput}\n\nMock execution completed in an isolated Issue worktree.\n`;
        writeFileSync(
          resolve(environment.cwd, `foundry-result-${issue.id}.md`),
          response,
        );
      } else {
        const result = await runIssueExecutor(
          environment,
          issue,
          runId,
          record,
          store,
          profileOverride,
          control.signal,
          serverURL,
          skillRefs,
          ambient,
          draftsEnabled,
        );
        environment = result.environment;
        response = result.response;
      }
      environment = await store.lock(
        workspace.id,
        `environment-${issue.id}`,
        () => snapshotEnvironment(environment!, store),
      );
      run.environmentId = environment.id;
      run.environmentRevision = environment.revision;
      run.executionCwd = environment.cwd;
      run.status = "completed";
      await record(
        "Awaiting Workspace Accept",
        `${environment.repositories.length} repositories; candidate revision ${environment.revision}`,
      );
    } catch (error) {
      run.status = control.signal.aborted ? "canceled" : "failed";
      run.error = control.signal.aborted
        ? "Issue execution canceled; candidate files are retained"
        : errorMessage(error);
      if (environment) {
        environment = store.environment(workspace.id, issue.id) ?? environment;
        environment.status = "failed";
        environment.error = run.error;
        store.saveEnvironment(environment);
        run.environmentId = environment.id;
        run.executionCwd = environment.cwd;
      }
      await record("Issue execution failed", run.error, "error");
    } finally {
      finishIssueExecution(issue.id);
    }
    run.completedAt = new Date().toISOString();
    writeJSON(resolve(runDir, "run.json"), run);
    const completion = {
      canceled: run.status === "canceled",
      response: response.slice(0, 64_000),
      runId,
      checks: run.error
        ? [run.error]
        : ["Candidate changes await explicit Workspace Accept"],
      environmentId: run.environmentId,
      environmentRevision: run.environmentRevision,
      executionCwd: run.executionCwd,
      error: run.error,
    };
    writeJSON(resolve(runDir, "completion.json"), completion);
    await transport.completeIssue(issue.id, completion);
  });
}
