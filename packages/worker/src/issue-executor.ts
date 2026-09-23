import { spawnExecution } from "./execution-process.js";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { chmodSync, appendFileSync } from "node:fs";
import type {
  AgentSession,
  Issue,
  RunEvent,
  SessionSkillRef,
} from "@foundry/protocol";
import {
  profileConfigForSession,
  type AgentProfileLocalConfig,
} from "./profiles.js";
import { ExecutionStore } from "./execution-storage.js";
import { ensureRepository } from "./issue-environments.js";
import { executorEnvironment, sandboxCommand } from "./execution-sandbox.js";
import type { IssueEnvironment } from "./execution-types.js";
import { readAgentRuntimeSettings } from "./device.js";
import { issueRuntimeOptions } from "./issue-runtime-options.js";
import { materializeSessionSkills } from "./skill-materializer.js";
import { registerIssueSteering } from "./issue-steering.js";
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
): Promise<{ response: string; environment: IssueEnvironment }> {
  const registration = store.registration(environment.workspaceId)!;
  const toolPath = fileURLToPath(
    new URL("./repository-tool.js", import.meta.url),
  );
  const childPath = fileURLToPath(
    new URL("./issue-executor-child.js", import.meta.url),
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
    do {
      requested.clear();
      const session: AgentSession = {
        ...issueRuntimeOptions(issue),
        id: `${runId}_${++turn}`,
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
        prompt: `${confirmedExecutionPrompt(issue)}\n\nFoundry execution contract:\nYour CWD is the candidate workspace: ${environment.cwd}. Read its AGENTS.md and CLAUDE.md and applicable nested rules. Original workspace ${environment.sourcePath} is available for read-only exploration, including unprepared repositories. Only candidate content is submitted for review. Do not modify original paths. Git staging/commits, formal verification and Accept are performed by Foundry after you finish. Your execution summary is not verification evidence. If the goal or rubric needs to change, ask the user to revise and confirm the contract; do not silently substitute standards.\nRepositories: ${JSON.stringify(registration.repositories.map((repo) => ({ id: repo.id, path: repo.relativePath, status: repo.status, prepared: environment.repositories.some((candidate) => candidate.repoId === repo.id && candidate.status === "ready") })))}\nTo prepare an additional repository run: ${JSON.stringify(process.execPath)} ${JSON.stringify(toolPath)} prepare <repository-id>. If queued, end your turn immediately; Foundry will prepare the worktree and resume you. Never create replacement repositories or symlink source directories. Prepared repositories retain their relative paths under CWD. Complete the task and report changes and validation.`,
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
      if (environment.error)
        session.prompt += `\n\nPrevious execution or integration feedback:\n${environment.error}\nResolve conflicts in candidate files. Foundry will stage and commit the resolved files after this turn.`;
      const command = sandboxCommand(
        environment,
        registration,
        process.execPath,
        [childPath],
      );
      const env = {
        ...executorEnvironment(environment),
        FOUNDRY_EXECUTOR_SETTINGS: JSON.stringify(readAgentRuntimeSettings()),
        FOUNDRY_REPOSITORY_SOCKET: socketPath,
        FOUNDRY_REPOSITORY_TOKEN: token,
      };
      environment.status = "running";
      store.saveEnvironment(environment);
      response = await new Promise<string>((done, reject) => {
        const child = spawnExecution(
          command.command,
          command.args,
          {
            cwd: environment.cwd,
            env,
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
          },
          signal,
          Number(process.env.FOUNDRY_ISSUE_TIMEOUT_MS ?? 900_000),
        );
        let result: string | undefined;
        let failure: string | undefined;
        let events = Promise.resolve();
        let responseText = "";
        let publishedText = "";
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
        const steering = new Map<
          string,
          { resolve: () => void; reject: (error: Error) => void }
        >();
        const unregisterSteering = registerIssueSteering(issue.id, {
          runId,
          send: (message) =>
            new Promise<void>((resolve, reject) => {
              const id = randomUUID();
              const timer = setTimeout(() => {
                steering.delete(id);
                reject(
                  new Error(
                    "Steer acknowledgement timed out; check the conversation before retrying.",
                  ),
                );
              }, 15_000);
              steering.set(id, {
                resolve: () => {
                  clearTimeout(timer);
                  resolve();
                },
                reject: (error) => {
                  clearTimeout(timer);
                  reject(error);
                },
              });
              child.stdin.write(
                `${JSON.stringify({ type: "steer", id, message })}\n`,
              );
            }),
        });
        child.stderr.on("data", (data) =>
          appendFileSync(
            resolve(environment.scratch, "executor.stderr.log"),
            data,
          ),
        );
        createInterface({ input: child.stdout }).on("line", (line) => {
          try {
            const value = JSON.parse(line);
            if (value.type === "event" && value.label === "Response stream")
              responseText = value.detail;
            if (value.type === "steer_result") {
              const pending = steering.get(value.id);
              // Wait until the native steer event has been persisted by transport.
              void events.then(
                () =>
                  value.error
                    ? pending?.reject(new Error(value.error))
                    : pending?.resolve(),
                (error) => pending?.reject(error),
              );
              steering.delete(value.id);
            }
            // The durable Issue conversation stores the final answer. Native
            // session logs retain streaming chunks; avoid storing hundreds of
            // cumulative copies in every Run projection and SQLite update.
            if (value.type === "event" && value.label !== "Response stream")
              events = events.then(() =>
                record(value.label, value.detail, value.level),
              );
            if (value.type === "native") {
              environment.nativeSessionId = value.nativeSessionId;
              store.saveEnvironment(environment);
            }
            if (value.type === "result") result = value.response ?? "";
            if (value.type === "error") failure = value.error;
          } catch {
            /* Provider diagnostics are not protocol messages. */
          }
        });
        child.once("error", reject);
        child.once("close", (code) => {
          clearInterval(streamTimer);
          flushResponse();
          unregisterSteering();
          for (const pending of steering.values())
            pending.reject(
              new Error("Execution ended before steer was acknowledged."),
            );
          steering.clear();
          void events.then(
            () =>
              code === 0 && result !== undefined
                ? done(result)
                : reject(
                    new Error(
                      failure ??
                        `Issue executor exited with code ${code}; see private executor.stderr.log`,
                    ),
                  ),
            reject,
          );
        });
        child.stdin.on("error", () => {});
        child.stdin.write(
          `${JSON.stringify({ cwd: environment.cwd, session, profile, managedSkills })}\n`,
        );
      });
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
