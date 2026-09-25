import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { AgentSession } from "@foundry/protocol";
import { readAgentRuntimeSettings } from "../device.js";
import type { AgentProfileLocalConfig } from "../profiles.js";
import { spawnProcessGroup } from "../process-group.js";
import {
  AgentSessionCanceledError,
  runClaudeWorkspaceSession,
  runCodexWorkspaceSession,
} from "../runner.js";
import { sandboxLaunch, type WritableTreeProfile } from "../sandbox/index.js";
import type { SessionAmbientEnv } from "../session-ambient.js";
import {
  activeSessionCancelTargets,
  activeSessionSteerTargets,
  type ActiveSessionCancelTarget,
  type ActiveSessionSteerTarget,
  type AgentSessionRunResult,
  type SessionEventEmitter,
} from "../session-state.js";
import type { ManagedSkillRuntime } from "../skill-materializer.js";
import { resolveClaudeCommand, resolveCodexCommand } from "../utils.js";

/** Where and how a sandboxed workspace session runs. */
export interface WorkspaceSandbox {
  profile: WritableTreeProfile;
  /** Base environment of the session process. */
  env: NodeJS.ProcessEnv;
  /** Private file that receives the session process's diagnostics. */
  stderrFile: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Orchestration credentials the agent may use inside the sandbox. */
  ambient?: SessionAmbientEnv;
}

export interface WorkspaceSessionRun {
  /** Directory the agent works in. */
  cwd: string;
  session: AgentSession;
  profile: AgentProfileLocalConfig;
  managedSkills?: ManagedSkillRuntime;
  emit: SessionEventEmitter;
  emitSetup: () => Promise<void>;
  reportNativeSessionId: (nativeSessionId: string) => void;
  /**
   * Run the agent in its own process inside this sandbox. Absent: run it in
   * this process without a sandbox, as Chat does.
   */
  sandbox?: WorkspaceSandbox;
}

/**
 * Run a Chat, orchestrated or Issue execution session in a workspace. Steer
 * and cancel go through the shared active-session registries either way.
 */
export async function runWorkspaceSession(
  run: WorkspaceSessionRun,
): Promise<AgentSessionRunResult> {
  if (run.sandbox) return runSandboxed(run, run.sandbox);
  const start =
    run.session.provider === "codex"
      ? runCodexWorkspaceSession
      : runClaudeWorkspaceSession;
  return start(
    run.cwd,
    run.session,
    run.profile,
    run.emit,
    run.emitSetup,
    run.reportNativeSessionId,
    run.managedSkills,
  );
}

const hostPath = fileURLToPath(new URL("./host-child.js", import.meta.url));

async function runSandboxed(
  run: WorkspaceSessionRun,
  sandbox: WorkspaceSandbox,
): Promise<AgentSessionRunResult> {
  const { session } = run;
  // The agent CLI is resolved here, where the whole host is visible, and
  // handed to the sandbox as a program it may run.
  const harness = run.profile.command
    ? undefined
    : harnessExecutable(session.provider);
  const launch = sandboxLaunch(
    {
      ...sandbox.profile,
      executables: [
        ...sandbox.profile.executables,
        ...(harness ? [harness] : []),
      ],
    },
    process.execPath,
    [hostPath],
  );
  const canceled = new AbortController();
  const signal = sandbox.signal
    ? AbortSignal.any([sandbox.signal, canceled.signal])
    : canceled.signal;
  const child = spawnProcessGroup(
    launch.command,
    launch.args,
    {
      cwd: run.cwd,
      env: {
        ...sandbox.env,
        // The device's state is unreadable inside; pass the settings along.
        FOUNDRY_EXECUTOR_SETTINGS: JSON.stringify(readAgentRuntimeSettings()),
        ...(harness &&
          (session.provider === "codex"
            ? { FOUNDRY_CODEX_BIN: harness }
            : { FOUNDRY_CLAUDE_BIN: harness })),
      },
    },
    signal,
    sandbox.timeoutMs,
  );
  // Events are applied in order; results and steer acknowledgements wait for
  // the events before them to be delivered.
  let events = Promise.resolve();
  const steering = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  const steerTarget: ActiveSessionSteerTarget = {
    provider: session.provider,
    steer: (message) =>
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
  };
  const cancelTarget: ActiveSessionCancelTarget = {
    provider: session.provider,
    cancel: () => canceled.abort(),
  };
  // Codex cannot steer an active turn; whoever owns the session keeps its
  // own answer for that.
  if (session.provider !== "codex")
    activeSessionSteerTargets.set(session.id, steerTarget);
  activeSessionCancelTargets.set(session.id, cancelTarget);
  try {
    return await new Promise<AgentSessionRunResult>((done, reject) => {
      let result: AgentSessionRunResult | undefined;
      let failure: string | undefined;
      const apply = (action: () => Promise<void> | void) => {
        events = events.then(action);
      };
      child.stderr.on("data", (data) =>
        appendFileSync(sandbox.stderrFile, data),
      );
      createInterface({ input: child.stdout }).on("line", (line) => {
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          return; // Provider diagnostics are not protocol messages.
        }
        if (value.type === "event")
          apply(() =>
            run.emit(
              value.label,
              value.detail,
              value.level,
              value.metadata,
              value.message,
            ),
          );
        if (value.type === "setup") apply(() => run.emitSetup());
        if (value.type === "native")
          apply(() => run.reportNativeSessionId(value.nativeSessionId));
        if (value.type === "steer_result") {
          const pending = steering.get(value.id);
          steering.delete(value.id);
          void events.then(
            () =>
              value.error
                ? pending?.reject(new Error(value.error))
                : pending?.resolve(),
            (error) => pending?.reject(error),
          );
        }
        if (value.type === "result")
          result = {
            nativeSessionId: value.nativeSessionId,
            response: value.response ?? "",
          };
        if (value.type === "error") failure = value.error;
      });
      child.once("error", reject);
      child.once("close", (code) => {
        for (const pending of steering.values())
          pending.reject(
            new Error("Execution ended before steer was acknowledged."),
          );
        steering.clear();
        void events.then(() => {
          if (canceled.signal.aborted) reject(new AgentSessionCanceledError());
          else if (code === 0 && result) done(result);
          else
            reject(
              new Error(
                failure ??
                  `Sandboxed session exited with code ${code}; see private ${sandbox.stderrFile}`,
              ),
            );
        }, reject);
      });
      child.stdin.on("error", () => {});
      child.stdin.write(
        `${JSON.stringify({
          cwd: run.cwd,
          session,
          profile: run.profile,
          managedSkills: run.managedSkills,
          ambient: sandbox.ambient,
        })}\n`,
      );
    });
  } finally {
    if (activeSessionSteerTargets.get(session.id) === steerTarget)
      activeSessionSteerTargets.delete(session.id);
    if (activeSessionCancelTargets.get(session.id) === cancelTarget)
      activeSessionCancelTargets.delete(session.id);
  }
}

/** The installed agent CLI as a real path, or undefined when it is missing. */
function harnessExecutable(
  provider: AgentSession["provider"],
): string | undefined {
  let command: string;
  try {
    command =
      provider === "codex" ? resolveCodexCommand() : resolveClaudeCommand();
  } catch {
    return undefined; // The session reports the missing CLI itself.
  }
  const path = isAbsolute(command)
    ? command
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((root) => resolve(root, command))
        .find(existsSync);
  return path && existsSync(path) ? realpathSync(path) : undefined;
}
