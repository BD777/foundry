import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { chmodSync } from "node:fs";
import type {
  AgentSession,
  Issue,
  RunEvent,
  SessionSkillRef,
} from "@bd777/foundry-protocol";
import {
  profileConfigForSession,
  type AgentProfileLocalConfig,
} from "./profiles.js";
import { ExecutionStore } from "./execution-storage.js";
import { ensureRepository } from "./issue-environments.js";
import {
  executorEnvironment,
  issueIsolationError,
  issueSandboxProfile,
} from "./execution-sandbox.js";
import type { IssueEnvironment } from "./execution-types.js";
import { issueRuntimeOptions } from "./issue-runtime-options.js";
import { materializeSessionSkills } from "./skill-materializer.js";
import { issueReferences } from "./issue-references.js";
import { registerIssueSteering } from "./issue-steering.js";
import { steerActiveSession } from "./session-helpers.js";
import { runWorkspaceSession } from "./session/index.js";
import type { SessionAmbientEnv } from "./session-ambient.js";
import {
  confirmedExecutionPrompt,
  executionFeedback,
} from "./issue-execution-prompt.js";

export async function runIssueExecutor(
  environment: IssueEnvironment,
  issue: Issue,
  runId: string,
  record: (
    label: string,
    detail: string,
    level?: RunEvent["level"],
  ) => Promise<void>,
  store = new ExecutionStore(),
  profileOverride?: AgentProfileLocalConfig,
  signal?: AbortSignal,
  serverURL?: string,
  skillRefs: SessionSkillRef[] = [],
  /** The execution session's Foundry credentials, scoped to this Issue. */
  ambient?: SessionAmbientEnv,
): Promise<{ response: string; environment: IssueEnvironment }> {
  const registration = store.registration(environment.workspaceId)!;
  const toolPath = fileURLToPath(
    new URL("./repository-tool.js", import.meta.url),
  );
  const requested = new Set<string>();
  const token = randomUUID();
  const socketPath = resolve(tmpdir(), `foundry-${randomUUID()}.sock`);
  const broker = createServer({ allowHalfOpen: true }, (socket) => {
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
        if (
          environment.repositories.some(
            (item) => item.repoId === repo.id && item.status === "ready",
          )
        ) {
          socket.end(
            JSON.stringify({
              cwd: resolve(environment.cwd, repo.relativePath),
              ready: true,
            }),
          );
          return;
        }
        requested.add(repo.id);
        socket.end(
          JSON.stringify({
            ready: false,
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
    broker.once("error", reject);
    broker.listen(socketPath, () => {
      chmodSync(socketPath, 0o600);
      done();
    });
  });
  try {
    let response = "";
    let turn = 0;
    // Issue runs enforce the same workspace skill allowlist as chats. The
    // selection arrives in the run_issue dispatch and is materialized once.
    const managedSkills = await materializeSessionSkills(
      skillRefs,
      environment.controlServerURL || serverURL || "",
      environment.cwd,
    );
    if (managedSkills.skills.length > 0) {
      await record(
        "Loaded skills",
        managedSkills.skills.map((skill) => skill.name).join(", "),
      );
    }
    const references = await issueReferences(environment, issue, store);
    if (references.length)
      await record(
        "Loaded references",
        references.map((reference) => reference.name).join(", "),
      );
    do {
      requested.clear();
      const session: AgentSession = {
        ...issueRuntimeOptions(issue),
        id: `${runId}_${++turn}`,
        // An Issue session: the sandbox provides its temporary space.
        issueId: issue.id,
        threadId: environment.id,
        nativeSessionId: environment.nativeSessionId,
        workspaceId: environment.workspaceId,
        agentId: "",
        deviceId: "",
        provider: issue.runtime === "codex" ? "codex" : "claude",
        status: "running",
        title: issue.title,
        createdLabel: "just now",
        updatedLabel: "just now",
        prompt: `${confirmedExecutionPrompt(issue)}\n\nFoundry execution contract:\nYour CWD is the candidate workspace: ${environment.cwd}. Read its AGENTS.md and CLAUDE.md and applicable nested rules. Original workspace ${environment.sourcePath} is available for read-only exploration, including unprepared repositories. Only candidate content is submitted for review. Do not modify original paths. Git staging/commits, formal verification and Accept are performed by Foundry after you finish. Your execution summary is not verification evidence. If the goal or rubric needs to change, ask the user to revise and confirm the contract; do not silently substitute standards. If you need a decision or a permission only the person can give (a choice the contract leaves open, or a side effect outside the candidate such as deploying or sending a message), call the Foundry tool ask_person with the question, then end your turn with a short summary of where you are; Foundry resumes you here with the answer. Do not ask about anything you can decide yourself.\nRepositories: ${JSON.stringify(registration.repositories.map((repo) => ({ id: repo.id, path: repo.relativePath, status: repo.status, prepared: environment.repositories.some((candidate) => candidate.repoId === repo.id && candidate.status === "ready") })))}\nTo prepare an additional repository run: ${JSON.stringify(process.execPath)} ${JSON.stringify(toolPath)} prepare <repository-id>. If queued, end your turn immediately; Foundry will prepare the worktree and resume you. Never create replacement repositories or symlink source directories. Prepared repositories retain their relative paths under CWD. Complete the task and report changes and validation.`,
      };
      const profile =
        profileOverride ??
        profileConfigForSession(environment.sourcePath, session);
      if (turn === 1) {
        await record(
          "Execution settings",
          JSON.stringify({
            runtime: session.provider,
            model: session.model ?? profile.model ?? "provider default",
            effort:
              session.provider === "claude"
                ? (session.claudeEffort ??
                  profile.claudeEffort ??
                  "provider default")
                : (session.codexReasoningEffort ??
                  profile.codexReasoningEffort ??
                  "provider default"),
            permission:
              session.provider === "claude"
                ? "bypassPermissions"
                : "never / danger-full-access",
          }),
        );
      }
      const feedback = executionFeedback(issue);
      if (feedback.length)
        session.prompt += `\n\nPost-confirmation execution feedback, in order (does not amend the contract):\n${feedback.join("\n\n")}`;
      if (environment.conflicts?.length)
        session.prompt += `\n\nBringing the Workspace's newer accepted changes into this candidate left merge conflicts in:\n${environment.conflicts.join("\n")}\nResolve them in the candidate files so the accepted changes and this Issue's confirmed contract both hold, and remove every conflict marker. Foundry stages and commits the resolved files after this turn, then the result is checked again.`;
      else if (environment.error)
        session.prompt += `\n\nThe previous execution of this Issue ended with:\n${environment.error}\nContinue from the current candidate files.`;
      environment.status = "running";
      store.saveEnvironment(environment);
      let responseText = "";
      let publishedText = "";
      let events = Promise.resolve();
      const flushResponse = () => {
        if (responseText === publishedText) return;
        const append =
          Boolean(publishedText) && responseText.startsWith(publishedText);
        const detail = append
          ? responseText.slice(publishedText.length)
          : responseText;
        publishedText = responseText;
        events = events.then(() =>
          record(append ? "Response delta" : "Response reset", detail),
        );
      };
      const streamTimer = setInterval(flushResponse, 500);
      const unregisterSteering = registerIssueSteering(issue.id, {
        runId,
        send: (message) => steerActiveSession(session.id, message),
      });
      try {
        // The contract's reference materials travel with every turn, so the
        // execution can look at what it is asked to match.
        session.input = {
          id: session.id,
          prompt: session.prompt,
          attachments: references,
        };
        const result = await runWorkspaceSession({
          cwd: environment.cwd,
          session,
          profile,
          managedSkills,
          // The durable Issue conversation stores the final answer. Native
          // session logs retain streaming chunks; avoid storing hundreds of
          // cumulative copies in every Run projection and SQLite update.
          emit: async (label, detail, level) => {
            if (label === "Response stream") responseText = detail;
            else events = events.then(() => record(label, detail, level));
            await events;
          },
          emitSetup: async () => {},
          reportNativeSessionId: (nativeSessionId) => {
            environment.nativeSessionId = nativeSessionId;
            store.saveEnvironment(environment);
          },
          sandbox: {
            profile: issueSandboxProfile(environment, registration, [
              socketPath,
            ]),
            env: {
              ...executorEnvironment(environment),
              FOUNDRY_REPOSITORY_SOCKET: socketPath,
              FOUNDRY_REPOSITORY_TOKEN: token,
            },
            stderrFile: resolve(environment.scratch, "executor.stderr.log"),
            timeoutMs: Number(process.env.FOUNDRY_ISSUE_TIMEOUT_MS ?? 900_000),
            signal,
            ambient,
          },
        }).catch((error) => {
          throw issueIsolationError(error);
        });
        response = result.response;
      } finally {
        clearInterval(streamTimer);
        flushResponse();
        unregisterSteering();
        await events;
      }
      for (const repoId of requested) {
        environment = await ensureRepository(
          environment.workspaceId,
          environment.issueId,
          repoId,
          store,
        );
        await record(
          "Repository prepared",
          registration.repositories.find((repo) => repo.id === repoId)!
            .relativePath,
        );
      }
    } while (requested.size);
    return { response, environment };
  } finally {
    broker.close();
  }
}
