import { nativeAccountFingerprint } from "./native-account.js";
import {
  runtimeDescriptor,
  runtimeUpdateState,
} from "./agent-runtime/state.js";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { NativeCli } from "@bd777/foundry-protocol";
import { readJSONFile } from "./storage.js";

type Runtime = "claude" | "codex";

const requireFromHere = createRequire(import.meta.url);

/**
 * The official standalone installers (macOS and Linux), from each project's
 * README: they install for the current user into ~/.local/bin, so they need
 * neither root nor a writable npm prefix.
 */
export const nativeCliInstallCommands: Record<Runtime, string> = {
  claude: "curl -fsSL https://claude.ai/install.sh | bash -s stable",
  codex: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
};

/**
 * How to update the program found at `command`. Claude Code updates itself
 * however it was installed; Codex updates through whatever installed it.
 */
export function nativeCliUpdateCommand(
  runtime: Runtime,
  command: string,
): string {
  if (runtime === "claude") return "claude update";
  let path = command;
  try {
    path = realpathSync(commandPath(command));
  } catch {
    // Not resolvable on disk; fall back to the standalone installer.
  }
  if (path.includes("/node_modules/"))
    return "npm install -g @openai/codex@latest";
  if (path.includes("/Caskroom/")) return "brew upgrade --cask codex";
  if (path.includes(".app/Contents/")) return "Update the Codex or ChatGPT app";
  return nativeCliInstallCommands.codex;
}

/** A bare command name's location on PATH. */
function commandPath(command: string): string {
  if (command.includes("/")) return command;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const candidate = join(dir, command);
    if (dir && existsSync(candidate)) return candidate;
  }
  return command;
}

/**
 * The first Claude Code that brings a session's timers back on resume as
 * fired then. Before it (2.1.289 and earlier), a resumed process holds them
 * as due since they were created and fires each at once.
 */
export const claudeTimerResumeVersion = "2.1.291";

/**
 * The oldest program version Foundry works with: for Claude Code the later
 * of the version the Agent SDK was released with and the one session
 * timers need (claudeTimerResumeVersion); Codex uses the stable native
 * catalog baseline, independent of any SDK wrapper.
 */
export function minimumCliVersion(runtime: Runtime): string | undefined {
  if (runtime === "claude") {
    const sdk = sdkManifest(
      "@anthropic-ai/claude-agent-sdk",
    )?.claudeCodeVersion;
    return sdk && isOlderVersion(claudeTimerResumeVersion, sdk)
      ? sdk
      : claudeTimerResumeVersion;
  }
  return "0.159.1";
}

/** An SDK's package.json; the SDKs do not export it, so look it up by path. */
function sdkManifest(
  name: string,
): { version?: string; claudeCodeVersion?: string } | undefined {
  for (const dir of requireFromHere.resolve.paths(name) ?? []) {
    const manifest = readJSONFile<{
      version?: string;
      claudeCodeVersion?: string;
    }>(join(dir, name, "package.json"));
    if (manifest) return manifest;
  }
  return undefined;
}

/** The first `x.y.z` in a `--version` line (`2.1.288 (Claude Code)`, `codex-cli 0.153.4`). */
export function parseCliVersion(output: string): string | undefined {
  return /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/.exec(
    output,
  )?.[0];
}

/** Whether `version` is older than `minimum`, comparing x.y.z numerically. */
export function isOlderVersion(version: string, minimum: string): boolean {
  const a = version.split("-")[0]!.split(".").map(Number);
  const b = minimum.split("-")[0]!.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return version.includes("-") && !minimum.includes("-");
}

const cache = new Map<Runtime, { until: number; value: NativeCli }>();

export function clearNativeCliCache(): void {
  cache.clear();
  clearDeviceCommands();
}

/**
 * Only protocol fields cross the registration boundary; retry counters stay
 * local. A missing runtime reports only an install the person started, while
 * it runs or after it failed: the scheduler's own notes about a runtime that
 * is not there are not news.
 */
function nativeRuntimeUpdate(
  runtime: Runtime,
  installed: boolean,
): NativeCli["update"] {
  const update = runtimeUpdateState(runtime);
  if (!update) return undefined;
  if (
    !installed &&
    !(update.install && ["updating", "failed"].includes(update.state))
  )
    return undefined;
  const { state, checkedAt, target, sdkTarget, current, detail, nextCheckAt } =
    update;
  return { state, checkedAt, target, sdkTarget, current, detail, nextCheckAt };
}

/** The device's program for a runtime, with its version against the minimum. */
export function nativeCli(runtime: Runtime): NativeCli {
  const cached = cache.get(runtime);
  if (cached && cached.until > Date.now())
    return {
      ...cached.value,
      update: nativeRuntimeUpdate(runtime, cached.value.installed),
    };
  const value = detectNativeCli(runtime);
  cache.set(runtime, { until: Date.now() + 60_000, value });
  return value;
}

function detectNativeCli(runtime: Runtime): NativeCli {
  const installCommand = nativeCliInstallCommands[runtime];
  const found = resolveDeviceCommand(
    runtime === "claude" ? claudeCommandCandidates() : codexCommandCandidates(),
  );
  if (!found)
    return {
      installed: false,
      installCommand,
      update: nativeRuntimeUpdate(runtime, false),
    };
  const version = parseCliVersion(found.versionOutput);
  const minimumVersion = minimumCliVersion(runtime);
  return {
    installed: true,
    version,
    path: commandPath(found.command),
    generation: `${runtimeDescriptor(runtime)?.generation ?? commandPath(found.command)}:${version}:${nativeAccountFingerprint(runtime)}`,
    update: nativeRuntimeUpdate(runtime, true),
    minimumVersion,
    outdated: Boolean(
      version && minimumVersion && isOlderVersion(version, minimumVersion),
    ),
    installCommand,
    updateCommand: nativeCliUpdateCommand(runtime, found.command),
  };
}

/** A sentence for a health row when the program is older than needed. */
export function outdatedNote(
  runtime: Runtime,
  cli: NativeCli,
): string | undefined {
  if (!cli.outdated) return undefined;
  const name = runtime === "claude" ? "Claude Code" : "Codex";
  return `${name} ${cli.version} is older than the ${cli.minimumVersion} Foundry needs. Update it on this device: ${cli.updateCommand}`;
}

/**
 * Candidate Claude Code CLI locations, in priority order. The native
 * installer puts the CLI in `~/.local/bin/claude`, which launchd-managed
 * daemons do not inherit through PATH, so it is probed explicitly.
 */
export function claudeCommandCandidates(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  if (env.FOUNDRY_CLAUDE_BIN?.trim()) return [env.FOUNDRY_CLAUDE_BIN.trim()];
  return [
    env.FOUNDRY_CLAUDE_BIN,
    runtimeDescriptor("claude")?.executable,
    "claude",
    resolve(home, ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
  ].filter((value): value is string => Boolean(value));
}

export function resolveClaudeCommand(): string {
  const found = resolveDeviceCommand(claudeCommandCandidates());
  if (!found)
    throw new Error(
      "Claude Code CLI is not available on PATH or in common install locations",
    );
  return found.command;
}

/**
 * Candidate Codex CLI locations, in priority order. The ChatGPT desktop app
 * ships the CLI inside its bundle, which is the only copy on many machines, so
 * every lookup has to share this list rather than keep its own.
 */
export function codexCommandCandidates(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const pinned = env.FOUNDRY_CODEX_BIN?.trim() || env.CODEX_CLI_PATH?.trim();
  if (pinned) return [pinned];
  return [
    env.FOUNDRY_CODEX_BIN,
    env.CODEX_CLI_PATH,
    runtimeDescriptor("codex")?.executable,
    "codex",
    resolve(home, ".local/bin/codex"),
    "/opt/homebrew/bin/codex",
    // The ChatGPT desktop app (which hosts Codex) ships its CLI under
    // Contents/Resources/codex-cli/bin, as seen in ChatGPT.app with
    // codex-cli 0.160.1; a per-user install lives under ~/Applications.
    ...["/Applications", resolve(home, "Applications")].flatMap((apps) =>
      ["ChatGPT.app", "Codex.app"].map((app) =>
        resolve(apps, app, "Contents/Resources/codex-cli/bin/codex"),
      ),
    ),
  ].filter((value): value is string => Boolean(value));
}

export function resolveCodexCommand(): string {
  const found = resolveDeviceCommand(codexCommandCandidates());
  if (!found)
    throw new Error(
      "Codex CLI is not available on PATH or in common install locations",
    );
  return found.command;
}

/** A device program that runs, and what its `--version` printed. */
export interface DeviceCommand {
  command: string;
  versionOutput: string;
}

const deviceCommands = new Map<
  string,
  { until: number; found: DeviceCommand | undefined }
>();

/**
 * The first candidate that runs `--version`. Every lookup of the device's
 * Claude Code and Codex goes through here, so they all agree on which program
 * Foundry runs; the answer is kept for a minute because each probe starts the
 * program. Only the first lookup waits for the probe: an older answer is
 * returned while a fresh one is probed in the background, because a blocking
 * probe of a slow program at every registration kept the worker from
 * answering the server.
 */
export function resolveDeviceCommand(
  candidates: string[],
): DeviceCommand | undefined {
  const key = JSON.stringify([candidates, process.env.PATH]);
  const cached = deviceCommands.get(key);
  if (cached && cached.until > Date.now()) return cached.found;
  if (cached) {
    refreshDeviceCommand(key, candidates);
    return cached.found;
  }
  let found: DeviceCommand | undefined;
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 10_000,
    });
    if (result.status === 0) {
      found = {
        command: candidate,
        versionOutput: `${result.stdout ?? ""}${result.stderr ?? ""}`,
      };
      break;
    }
  }
  deviceCommands.set(key, { until: Date.now() + 60_000, found });
  return found;
}

const refreshing = new Set<string>();
let deviceCommandsGeneration = 0;

function probeVersion(candidate: string): Promise<DeviceCommand | undefined> {
  return new Promise((resolveProbe) => {
    execFile(
      candidate,
      ["--version"],
      { encoding: "utf8", timeout: 10_000 },
      (error, stdout, stderr) =>
        resolveProbe(
          error
            ? undefined
            : { command: candidate, versionOutput: `${stdout}${stderr}` },
        ),
    );
  });
}

function refreshDeviceCommand(key: string, candidates: string[]): void {
  if (refreshing.has(key)) return;
  refreshing.add(key);
  const generation = deviceCommandsGeneration;
  void (async () => {
    let found: DeviceCommand | undefined;
    for (const candidate of candidates) {
      found = await probeVersion(candidate);
      if (found) break;
    }
    // A clear while probing (an install or update) makes this answer stale.
    if (generation === deviceCommandsGeneration)
      deviceCommands.set(key, { until: Date.now() + 60_000, found });
  })().finally(() => refreshing.delete(key));
}

export function clearDeviceCommands(): void {
  deviceCommandsGeneration += 1;
  deviceCommands.clear();
}
