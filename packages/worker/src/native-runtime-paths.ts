/** Native login/data sources and execution homes are different inputs. */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

export type NativeRuntime = "claude" | "codex";

export interface NativeSourcePaths {
  /** Original CLI login store; never the generated execution configuration. */
  credentialHome: string;
  /** Claude's identity metadata is outside ~/.claude unless explicitly set. */
  globalConfigHome: string;
  /** Transcript/index source, retained when an execution home changes. */
  dataHome: string;
}

export interface NativeExecutionPaths {
  version: 1;
  runtime: NativeRuntime;
  ownerId: string;
  workspacePath: string;
  sources: NativeSourcePaths;
  configHome: string;
}

export const nativeSourceKeys = [
  "FOUNDRY_NATIVE_CODEX_SOURCE_HOME",
  "FOUNDRY_NATIVE_CLAUDE_SOURCE_HOME",
  "FOUNDRY_NATIVE_CLAUDE_GLOBAL_HOME",
  "FOUNDRY_CODEX_AUTH_SOURCE",
] as const;

/** Compatibility for service definitions made by the first isolation release.
 * This guard must not be used for transcript or usage lookup. */
export function isManagedNativeRuntimePath(path: string | undefined): boolean {
  if (!path) return false;
  if (/[/\\]\.foundry[^/\\]*[/\\]native-runtime[/\\]/.test(path)) return true;
  try {
    const record = JSON.parse(
      readFileSync(resolve(path, ".foundry-native-execution.json"), "utf8"),
    );
    return (
      record.version === 1 &&
      record.configHome === path &&
      ["claude", "codex"].includes(record.runtime)
    );
  } catch {
    return false;
  }
}

export function nativeSourcePaths(
  runtime: NativeRuntime,
  env: NodeJS.ProcessEnv,
): NativeSourcePaths {
  const home = env.HOME?.trim() || homedir();
  const custom = (
    runtime === "codex" ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR
  )?.trim();
  let recorded: NativeExecutionPaths | undefined;
  if (custom) {
    try {
      const saved = JSON.parse(
        readFileSync(resolve(custom, ".foundry-native-execution.json"), "utf8"),
      );
      if (
        saved.version === 1 &&
        saved.runtime === runtime &&
        saved.configHome === custom &&
        typeof saved.sources?.credentialHome === "string"
      )
        recorded = saved;
    } catch {
      /* A normal native source has no Foundry execution marker. */
    }
  }
  const original =
    runtime === "codex"
      ? env.FOUNDRY_NATIVE_CODEX_SOURCE_HOME?.trim() ||
        env.FOUNDRY_CODEX_AUTH_SOURCE?.trim()
      : env.FOUNDRY_NATIVE_CLAUDE_SOURCE_HOME?.trim();
  // Older managed environments did not carry a source locator. Keep that
  // migration fallback here; new prepared environments always carry one.
  const legacyManaged =
    custom && /[/\\]\.foundry[^/\\]*[/\\]native-runtime[/\\]/.test(custom);
  const source =
    original ||
    recorded?.sources.credentialHome ||
    (custom && !legacyManaged
      ? custom
      : resolve(home, runtime === "codex" ? ".codex" : ".claude"));
  return {
    credentialHome: source,
    dataHome: source,
    globalConfigHome:
      runtime === "claude"
        ? env.FOUNDRY_NATIVE_CLAUDE_GLOBAL_HOME?.trim() ||
          recorded?.sources.globalConfigHome ||
          (custom && !legacyManaged ? custom : home)
        : source,
  };
}

/** The directory the running CLI actually sees, including sandboxed homes. */
export function nativeExecutionHome(
  runtime: NativeRuntime,
  env: NodeJS.ProcessEnv,
): string {
  return (
    (runtime === "codex" ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR)?.trim() ||
    nativeSourcePaths(runtime, env).dataHome
  );
}

/** Explicit per-profile native homes replace inherited execution source locators. */
export function withNativeSourceOverrides(
  base: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env = { ...base, ...overrides };
  if (overrides.CODEX_HOME && !overrides.FOUNDRY_NATIVE_CODEX_SOURCE_HOME) {
    env.FOUNDRY_NATIVE_CODEX_SOURCE_HOME = overrides.CODEX_HOME;
    delete env.FOUNDRY_CODEX_AUTH_SOURCE;
  }
  if (
    overrides.CLAUDE_CONFIG_DIR &&
    !overrides.FOUNDRY_NATIVE_CLAUDE_SOURCE_HOME
  ) {
    env.FOUNDRY_NATIVE_CLAUDE_SOURCE_HOME = overrides.CLAUDE_CONFIG_DIR;
    env.FOUNDRY_NATIVE_CLAUDE_GLOBAL_HOME = overrides.CLAUDE_CONFIG_DIR;
  }
  return env;
}

/** Persist original sources into services, never a session-owned execution home. */
export function nativeServiceHome(
  runtime: NativeRuntime,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const selected = (
    runtime === "codex" ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR
  )?.trim();
  if (!selected) return undefined;
  if (!isManagedNativeRuntimePath(selected)) return selected;
  const source = nativeSourcePaths(runtime, env).credentialHome;
  const explicit =
    runtime === "codex"
      ? env.FOUNDRY_NATIVE_CODEX_SOURCE_HOME || env.FOUNDRY_CODEX_AUTH_SOURCE
      : env.FOUNDRY_NATIVE_CLAUDE_SOURCE_HOME;
  // Legacy definitions without a recoverable source are omitted for migration.
  if (
    !explicit &&
    source ===
      resolve(env.HOME || homedir(), runtime === "codex" ? ".codex" : ".claude")
  )
    return undefined;
  return source !== selected && !isManagedNativeRuntimePath(source)
    ? source
    : undefined;
}
