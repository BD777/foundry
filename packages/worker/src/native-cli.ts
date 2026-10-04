import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { NativeCli } from "@bd777/foundry-protocol";
import { resolveClaudeCommand, resolveCodexCommand } from "./utils.js";

type Runtime = "claude" | "codex";

const requireFromHere = createRequire(import.meta.url);

/** The official ways to install each program (macOS and Linux). */
export const nativeCliInstallCommands: Record<Runtime, string> = {
  claude: "curl -fsSL https://claude.ai/install.sh | bash",
  codex: "npm install -g @openai/codex",
};

/** The official ways to update each program. */
export const nativeCliUpdateCommands: Record<Runtime, string> = {
  claude: "claude update",
  codex: "npm install -g @openai/codex@latest",
};

/**
 * The oldest program version the bundled SDK speaks to: the Claude Code
 * version the Agent SDK was released with, and the Codex release line of the
 * Codex SDK. Unknown when the SDK is not installed (the npx bootstrap).
 */
export function minimumCliVersion(runtime: Runtime): string | undefined {
  if (runtime === "claude") {
    return sdkManifest("@anthropic-ai/claude-agent-sdk")?.claudeCodeVersion;
  }
  const [major, minor] = (
    sdkManifest("@openai/codex-sdk")?.version ?? ""
  ).split(".");
  return major && minor ? `${major}.${minor}.0` : undefined;
}

/** An SDK's package.json; the SDKs do not export it, so look it up by path. */
function sdkManifest(
  name: string,
): { version?: string; claudeCodeVersion?: string } | undefined {
  for (const dir of requireFromHere.resolve.paths(name) ?? []) {
    const path = join(dir, name, "package.json");
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  }
  return undefined;
}

/** The first `x.y.z` in a `--version` line (`2.1.288 (Claude Code)`, `codex-cli 0.153.4`). */
export function parseCliVersion(output: string): string | undefined {
  return /(\d+)\.(\d+)\.(\d+)/.exec(output)?.[0];
}

/** Whether `version` is older than `minimum`, comparing x.y.z numerically. */
export function isOlderVersion(version: string, minimum: string): boolean {
  const a = version.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

const cache = new Map<Runtime, { until: number; value: NativeCli }>();

export function clearNativeCliCache(): void {
  cache.clear();
}

/** The device's program for a runtime, with its version against the minimum. */
export function nativeCli(runtime: Runtime): NativeCli {
  const cached = cache.get(runtime);
  if (cached && cached.until > Date.now()) return cached.value;
  const value = detectNativeCli(runtime);
  cache.set(runtime, { until: Date.now() + 60_000, value });
  return value;
}

function detectNativeCli(runtime: Runtime): NativeCli {
  const commands = {
    installCommand: nativeCliInstallCommands[runtime],
    updateCommand: nativeCliUpdateCommands[runtime],
  };
  let command: string;
  try {
    command =
      runtime === "claude" ? resolveClaudeCommand() : resolveCodexCommand();
  } catch {
    return { installed: false, ...commands };
  }
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const version = parseCliVersion(
    `${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
  const minimumVersion = minimumCliVersion(runtime);
  return {
    installed: true,
    version,
    minimumVersion,
    outdated: Boolean(
      version && minimumVersion && isOlderVersion(version, minimumVersion),
    ),
    ...commands,
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
