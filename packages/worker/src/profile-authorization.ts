import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { IPty } from "node-pty";
import * as pty from "node-pty";
import type { ProfileAuthorization, WorkerRuntimeId } from "@foundry/protocol";
import { resolveClaudeCommand, resolveCodexCommand } from "./utils.js";
import { clearNativeLoginHealth } from "./native-login.js";
import { nativeLoginEnvironment } from "./native-login-environment.js";

/**
 * Agent CLI logins bind a fixed local callback port, so one login left running
 * by a previous daemon makes every later attempt hang with no output. The pids
 * this daemon spawns are recorded on disk, outliving restarts, so the next
 * attempt can end the abandoned one instead of waiting out its timeout.
 */
const authorizationPidsPath = resolve(
  homedir(),
  ".foundry",
  "authorization-pids.json",
);

function readAuthorizationPids(): Record<string, number[]> {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(authorizationPidsPath, "utf8"),
    );
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, number[]>)
      : {};
  } catch {
    return {};
  }
}

function writeAuthorizationPids(pids: Record<string, number[]>): void {
  try {
    mkdirSync(dirname(authorizationPidsPath), { recursive: true });
    writeFileSync(authorizationPidsPath, JSON.stringify(pids), { mode: 0o600 });
  } catch {
    // Losing the bookkeeping only costs a slower next attempt.
  }
}

export function recordAuthorizationPid(runtime: string, pid: number): void {
  const pids = readAuthorizationPids();
  pids[runtime] = [...new Set([...(pids[runtime] ?? []), pid])];
  writeAuthorizationPids(pids);
}

export function forgetAuthorizationPid(runtime: string, pid: number): void {
  const pids = readAuthorizationPids();
  const remaining = (pids[runtime] ?? []).filter((entry) => entry !== pid);
  if (remaining.length > 0) pids[runtime] = remaining;
  else delete pids[runtime];
  writeAuthorizationPids(pids);
}

/** Ends logins this daemon or an earlier one left behind. Returns the pids it killed. */
export function reapAbandonedAuthorizations(runtime: string): number[] {
  const pids = readAuthorizationPids();
  const killed: number[] = [];
  for (const pid of pids[runtime] ?? []) {
    try {
      process.kill(pid, "SIGTERM");
      killed.push(pid);
    } catch {
      // Already gone; the entry is dropped below either way.
    }
  }
  delete pids[runtime];
  writeAuthorizationPids(pids);
  return killed;
}

/**
 * node-pty ships prebuilt binaries whose `spawn-helper` loses its executable
 * bit through the npm tarball, which makes every `pty.spawn` fail with the
 * opaque message `posix_spawnp failed.`. Restore the bit before the first
 * spawn so authorization works on a plain `pnpm install` without a native
 * toolchain. Only macOS builds and uses the helper; Linux forks directly.
 */
export function ensurePtySpawnHelperExecutable(
  platform: string = process.platform,
  arch: string = process.arch,
): string | undefined {
  if (platform !== "darwin") return undefined;
  const require = createRequire(import.meta.url);
  const helper = join(
    dirname(require.resolve("node-pty/package.json")),
    "prebuilds",
    `${platform}-${arch}`,
    "spawn-helper",
  );
  try {
    accessSync(helper, constants.X_OK);
    return helper;
  } catch {
    chmodSync(helper, statSync(helper).mode | 0o111);
    return helper;
  }
}

interface AuthorizationFlow {
  id: string;
  profileId: string;
  runtime: Exclude<WorkerRuntimeId, "mock">;
  process: IPty;
  output: string;
  result: ProfileAuthorization;
  timeout: NodeJS.Timeout;
}

const activeFlows = new Map<string, AuthorizationFlow>();
const authorizationTimeoutMs = 15 * 60 * 1000;
const completedRetentionMs = 5 * 60 * 1000;

export function stopProfileAuthorizations(): void {
  for (const flow of activeFlows.values()) {
    clearTimeout(flow.timeout);
    if (flow.result.status === "waiting_for_user") flow.process.kill();
  }
  activeFlows.clear();
}
const ansiPattern =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;

function cleanTerminalOutput(value: string): string {
  return value.replace(ansiPattern, "").replaceAll("\r", "");
}

export function authorizationCodeFromInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    return parsed.searchParams.get("code")?.trim() || trimmed;
  } catch {
    return trimmed;
  }
}

export function authorizationPromptFromOutput(
  value: string,
  runtime: Exclude<WorkerRuntimeId, "mock">,
): Pick<ProfileAuthorization, "url" | "code"> {
  const clean = cleanTerminalOutput(value);
  const url = clean.match(/https:\/\/[^\s]+/)?.[0];
  const code =
    runtime === "codex"
      ? clean.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/)?.[0]
      : undefined;
  return { code, url };
}

function publicResult(flow: AuthorizationFlow): ProfileAuthorization {
  return { ...flow.result };
}

function finishFlow(
  flow: AuthorizationFlow,
  status: "completed" | "failed",
  message?: string,
): void {
  clearNativeLoginHealth();
  clearTimeout(flow.timeout);
  flow.result = {
    ...flow.result,
    message,
    status,
  };
  setTimeout(() => activeFlows.delete(flow.id), completedRetentionMs).unref();
}

function commandFor(runtime: Exclude<WorkerRuntimeId, "mock">): {
  command: string;
  args: string[];
} {
  return runtime === "claude"
    ? { command: resolveClaudeCommand(), args: ["auth", "login"] }
    : { command: resolveCodexCommand(), args: ["login", "--device-auth"] };
}

export async function startProfileAuthorization(
  profileId: string,
  runtime: Exclude<WorkerRuntimeId, "mock">,
): Promise<ProfileAuthorization> {
  // Restarting authorization supersedes an abandoned attempt (the user closed
  // the dialog without pasting a code) instead of blocking for the 15 minute
  // flow timeout.
  for (const flow of activeFlows.values()) {
    if (flow.runtime === runtime && flow.result.status === "waiting_for_user") {
      flow.process.kill();
      finishFlow(flow, "failed", "Superseded by a new authorization attempt.");
    }
  }

  // A login left running by an earlier daemon still owns the CLI's callback
  // port, so the fresh attempt would hang with no prompt until it times out.
  reapAbandonedAuthorizations(runtime);

  const id = `auth_${randomUUID()}`;
  ensurePtySpawnHelperExecutable();
  const native = commandFor(runtime);
  const child = pty.spawn(native.command, native.args, {
    cols: 320,
    cwd: process.cwd(),
    env: Object.fromEntries(
      Object.entries({
        ...process.env,
        ...nativeLoginEnvironment(runtime),
        NO_COLOR: "1",
        TERM: "xterm-256color",
      }).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    name: "xterm-256color",
    rows: 40,
  });
  recordAuthorizationPid(runtime, child.pid);
  const flow: AuthorizationFlow = {
    id,
    output: "",
    process: child,
    profileId,
    result: { id, profileId, runtime, status: "waiting_for_user" },
    runtime,
    timeout: undefined as unknown as NodeJS.Timeout,
  };
  flow.timeout = setTimeout(() => {
    child.kill();
    finishFlow(flow, "failed", "Authorization expired after 15 minutes.");
  }, authorizationTimeoutMs);
  flow.timeout.unref();
  activeFlows.set(id, flow);

  child.onData((chunk) => {
    flow.output = `${flow.output}${chunk}`.slice(-64 * 1024);
    const prompt = authorizationPromptFromOutput(flow.output, runtime);
    flow.result = { ...flow.result, ...prompt };
  });
  child.onExit(({ exitCode }) => {
    forgetAuthorizationPid(runtime, child.pid);
    const clean = cleanTerminalOutput(flow.output);
    finishFlow(
      flow,
      exitCode === 0 ? "completed" : "failed",
      exitCode === 0
        ? "Authorization completed on this device."
        : clean.split("\n").filter(Boolean).slice(-1)[0] ||
            "Authorization failed.",
    );
  });

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (flow.result.url || flow.result.status !== "waiting_for_user") break;
    await delay(500);
  }
  if (!flow.result.url && flow.result.status === "waiting_for_user") {
    child.kill();
    finishFlow(
      flow,
      "failed",
      "The agent CLI did not provide an authorization URL.",
    );
  }
  return publicResult(flow);
}

export async function completeProfileAuthorization(
  flowId: string,
  authorizationResult?: string,
): Promise<ProfileAuthorization> {
  const flow = activeFlows.get(flowId);
  if (!flow)
    throw new Error("Authorization session was not found or has expired.");
  if (flow.result.status !== "waiting_for_user") return publicResult(flow);

  if (flow.runtime === "claude" && authorizationResult?.trim()) {
    const code = authorizationCodeFromInput(authorizationResult);
    if (!code) throw new Error("Paste the authorization code or callback URL.");
    flow.process.write(`${code}\r`);
  }

  await delay(350);
  return publicResult(flow);
}
