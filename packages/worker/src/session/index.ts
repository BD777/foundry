/**
 * Session Runtime: the one way the worker starts an agent session.
 *
 * Callers give a role, a harness and a prompt; the role decides the tools,
 * instructions and limits (./policy.ts), the runtime owns the private home,
 * provider environment, sandbox, timeout and cancellation, and a harness
 * adapter (./claude.ts, ./codex.ts) talks to the native SDK. Today it runs
 * isolated read-only sessions; Chat, orchestrated and Issue execution
 * sessions migrate onto it next. See docs/architecture-modules.md §5.2.
 */
import { mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  configuredAgentProfiles,
  profileID,
  profileRuntimeEnvironment,
} from "../profiles.js";
import { isSandboxError, sandboxLauncher } from "../sandbox/index.js";
import { claudeHarness } from "./claude.js";
import { codexHarness } from "./codex.js";
import type { HarnessAdapter } from "./harness.js";
import { sessionPolicy } from "./policy.js";
import type { SessionHandle, SessionResult, SessionSpec } from "./types.js";

export type {
  SessionHandle,
  SessionResult,
  SessionRole,
  SessionSpec,
} from "./types.js";
export { codexDisabledFeatures } from "./policy.js";

const harnesses: Record<SessionSpec["harness"], HarnessAdapter> = {
  claude: claudeHarness,
  codex: codexHarness,
};

/** Provider connection, auth and model fields; never custom tool configuration. */
const providerEnvironmentKeys = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_BASE_URL",
];

export function startSession(spec: SessionSpec): SessionHandle {
  const cancel = new AbortController();
  return {
    result: run(spec, cancel.signal),
    cancel: () => cancel.abort(),
  };
}

async function run(
  spec: SessionSpec,
  canceled: AbortSignal,
): Promise<SessionResult> {
  const profile = configuredAgentProfiles("").find(
    (p) => profileID(p) === spec.profileId && p.runtime === spec.harness,
  );
  if (!profile || profile.command)
    throw new Error("isolated_verifier_profile_unavailable");
  const policy = sessionPolicy(spec.role, Boolean(spec.workspace));
  const home = resolve(spec.directory, "isolated-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const activity: string[] = [];
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    CLAUDE_CODE_TMPDIR: home,
    LANG: "C.UTF-8",
  };
  for (const [key, value] of Object.entries(profileRuntimeEnvironment(profile)))
    if (providerEnvironmentKeys.includes(key)) env[key] = value;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), policy.timeoutMs);
  try {
    const result = await harnesses[spec.harness].run({
      spec,
      policy,
      profile,
      home,
      env,
      sandboxedExecutable: (command) =>
        stageLauncher(command, home, {
          serverURL: spec.controlServerURL,
          readRoots: spec.workspace
            ? [spec.workspace.path, ...spec.workspace.readRoots]
            : [],
          workdir: spec.workspace?.path,
        }),
      signal: AbortSignal.any([timeout.signal, canceled]),
      note: (entry) => {
        if (activity.length < 200) activity.push(entry.slice(0, 2000));
      },
    });
    return { ...result, activity };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The harness CLI inside a read-only sandbox: defense in depth even if a
 * provider ignores a disabled-tool setting. Only the private home is ever
 * writable; the policy and launcher live beside it, outside it.
 */
export function stageLauncher(
  command: string,
  home: string,
  options: {
    serverURL?: string;
    /** Directories the session may read. It can never write to them. */
    readRoots?: string[];
    /** Initial working directory; defaults to the private home. */
    workdir?: string;
  } = {},
): string {
  try {
    const stage = resolve(realpathSync(home), "..");
    return sandboxLauncher(
      {
        kind: "readonly_agent",
        policyFile: resolve(stage, "verifier.sb"),
        home,
        readRoots: options.readRoots ?? [],
        workdir: options.workdir,
        controlServerURL: options.serverURL,
      },
      command,
      resolve(stage, "verifier-cli"),
    );
  } catch (error) {
    if (!isSandboxError(error)) throw error;
    switch (error.code) {
      case "executable_missing":
        throw new Error("verifier_executable_missing");
      case "workdir_not_readable":
        throw new Error("stage_workdir_not_readable");
      default:
        throw new Error("agent_verifier_isolation_unavailable");
    }
  }
}
