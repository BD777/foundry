import { nativeWorkIsActive } from "./agent-runtime/updates.js";
import {
  installManagedRuntime,
  nativeUpdateAdapter,
} from "./agent-runtime/adapters.js";
import { tryMaintainRuntime } from "./agent-runtime/maintenance.js";
import { updateAgentRuntime } from "./agent-runtime/update-controller.js";
import {
  runtimeUpdateState,
  saveRuntimeUpdate,
} from "./agent-runtime/state.js";
import { spawn, spawnSync } from "node:child_process";
import type { NativeCliInstallResult } from "@bd777/foundry-protocol";
import { clearNativeLoginHealth } from "./native-login.js";
import {
  clearNativeCliCache,
  nativeCli,
  nativeCliInstallCommands,
} from "./native-cli.js";
import { redactSecrets } from "./secret-redaction.js";

type Runtime = "claude" | "codex";

const logLimit = 200_000;
const timeoutMs = 10 * 60_000;
const managedCommand = "Foundry-managed install (official npm release)";

const runtimeName = (runtime: Runtime) =>
  runtime === "claude" ? "Claude Code" : "Codex";

/** One install per runtime at a time; a second request joins the first. */
const running = new Map<Runtime, Promise<NativeCliInstallResult>>();

export interface InstallNativeCliOptions {
  /**
   * Called when the install starts and again when it ends, so the worker can
   * report the device and every open page shows where it stands.
   */
  onProgress?: () => void;
}

/**
 * Install or update a runtime's program on this device, at the person's
 * request:
 * - missing: a Foundry-managed copy (the official npm release, staged and
 *   validated the way updates are), so later updates are automatic; without
 *   npm, the official per-user installer;
 * - present and Foundry can update it: one update now;
 * - present but owned by something else (a package manager, an app): a
 *   Foundry-managed copy beside it, which Foundry then runs and updates.
 * FOUNDRY_NATIVE_CLI_INSTALL_COMMAND replaces the command for tests.
 */
export function installNativeCli(
  runtime: Runtime,
  options: InstallNativeCliOptions = {},
): Promise<NativeCliInstallResult> {
  const current = running.get(runtime);
  if (current) return current;
  const work = runInstall(runtime, options).finally(() =>
    running.delete(runtime),
  );
  running.set(runtime, work);
  return work;
}

async function runInstall(
  runtime: Runtime,
  { onProgress }: InstallNativeCliOptions,
): Promise<NativeCliInstallResult> {
  const testCommand = process.env.FOUNDRY_NATIVE_CLI_INSTALL_COMMAND?.trim();
  if (testCommand) return officialInstall(runtime, testCommand);
  const cli = nativeCli(runtime);
  if (cli.installed && cli.update?.state !== "external") {
    saveRuntimeUpdate(runtime, {
      state: "checking",
      checkedAt: new Date().toISOString(),
    });
    await updateAgentRuntime(nativeUpdateAdapter(runtime), {
      busy: () => nativeWorkIsActive(runtime),
    });
    clearNativeLoginHealth();
    const update = runtimeUpdateState(runtime);
    return {
      runtime,
      ok: update?.state === "current" || update?.state === "waiting_idle",
      command: "Official stable runtime update",
      log: update?.detail ?? update?.state ?? "",
      cli: nativeCli(runtime),
    };
  }
  const pin =
    runtime === "claude"
      ? process.env.FOUNDRY_CLAUDE_BIN?.trim()
      : process.env.FOUNDRY_CODEX_BIN?.trim() ||
        process.env.CODEX_CLI_PATH?.trim();
  if (pin)
    return {
      runtime,
      ok: false,
      command: managedCommand,
      log: `${runtimeName(runtime)} is pinned to ${pin} on this device (${runtime === "claude" ? "FOUNDRY_CLAUDE_BIN" : "FOUNDRY_CODEX_BIN or CODEX_CLI_PATH"}), so Foundry runs that copy only. Install or update it there, or remove the setting and try again.`,
      cli,
    };
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return {
      runtime,
      ok: false,
      command: nativeCliInstallCommands[runtime],
      log: `Installing from Foundry is supported on macOS and Linux. Run the official installer on this device yourself: ${nativeCliInstallCommands[runtime]}`,
      cli,
    };
  }
  if (!cli.installed && !npmAvailable())
    return officialInstall(runtime, nativeCliInstallCommands[runtime]);
  return managedInstall(runtime, cli.installed, onProgress);
}

function npmAvailable(): boolean {
  return (
    spawnSync("npm", ["--version"], { stdio: "ignore", timeout: 15_000 })
      .status === 0
  );
}

/**
 * Stage and activate a Foundry-managed copy. While it runs the runtime's
 * update state says so (reported even though the runtime is still missing),
 * and a failure stays there with its reason until the next attempt.
 */
async function managedInstall(
  runtime: Runtime,
  replacing: boolean,
  onProgress?: () => void,
): Promise<NativeCliInstallResult> {
  const name = runtimeName(runtime);
  const startedAt = new Date().toISOString();
  // A copy in use is switched only between sessions, as updates are.
  const release = replacing ? await tryMaintainRuntime(runtime) : () => {};
  if (!release)
    return {
      runtime,
      ok: false,
      command: managedCommand,
      log: `Sessions are still using ${name} on this device. Try again when they have finished.`,
      cli: nativeCli(runtime),
    };
  saveRuntimeUpdate(runtime, {
    state: "updating",
    checkedAt: startedAt,
    detail: `Installing ${name} (Foundry-managed copy)…`,
    install: true,
  });
  clearNativeCliCache();
  onProgress?.();
  try {
    const version = await installManagedRuntime(runtime);
    saveRuntimeUpdate(runtime, {
      state: "current",
      checkedAt: new Date().toISOString(),
      current: version,
      target: version,
      nextCheckAt: Date.now() + 6 * 60 * 60_000,
    });
    return {
      runtime,
      ok: true,
      command: managedCommand,
      log: `Installed ${name} ${version}. Foundry keeps it up to date.`,
      cli: refreshed(runtime),
    };
  } catch (error) {
    // A failed npm run's message carries its stderr.
    const log = redactSecrets(String(error)).slice(-logLimit);
    const reason = installFailureReason(log);
    saveRuntimeUpdate(runtime, {
      state: "failed",
      checkedAt: new Date().toISOString(),
      detail: reason,
      install: true,
      // The scheduler leaves the failure in place for the person to see.
      nextCheckAt: Date.now() + 6 * 60 * 60_000,
    });
    return {
      runtime,
      ok: false,
      command: managedCommand,
      log,
      cli: refreshed(runtime),
    };
  } finally {
    release();
    onProgress?.();
  }
}

/**
 * One readable sentence for why an install failed: npm's first own error
 * line (not its key/value lines, stack or pointer to a debug log), else the
 * first line of the failure.
 */
export function installFailureReason(log: string): string {
  const lines = log
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const npm = lines
    .filter((line) => /^npm (?:error|ERR!)/.test(line))
    .map((line) => line.replace(/^npm (?:error|ERR!)\s*/, ""))
    // Key/value lines (code, syscall, errno…) and the log pointer say less.
    .filter(
      (line) =>
        line &&
        !/complete log of this run|^(?:code|syscall|errno|path|dest)\s|^at\s|^[{}]/i.test(
          line,
        ),
    );
  return (npm[0] ?? lines[0] ?? "").slice(0, 500);
}

/** The program is there now (or still missing): read it again. */
function refreshed(runtime: Runtime) {
  clearNativeLoginHealth();
  clearNativeCliCache();
  return nativeCli(runtime);
}

async function officialInstall(
  runtime: Runtime,
  command: string,
): Promise<NativeCliInstallResult> {
  const { ok, log } = await new Promise<{ ok: boolean; log: string }>(
    (done) => {
      let output = "";
      const append = (chunk: Buffer) => {
        if (output.length < logLimit) output += chunk.toString("utf8");
      };
      const child = spawn("/bin/sh", ["-c", command], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        output += `\nStopped after ${timeoutMs / 60_000} minutes.`;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", (error) => {
        clearTimeout(timer);
        done({ ok: false, log: `${output}\n${error.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ ok: code === 0, log: output.slice(-logLimit) });
      });
    },
  );
  const cli = refreshed(runtime);
  return { runtime, ok: ok && cli.installed, command, log, cli };
}
