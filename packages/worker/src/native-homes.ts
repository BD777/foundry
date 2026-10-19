/** Compatibility accessors for original native login/identity sources.
 * Transcript and usage readers use nativeExecutionHome instead. */
import { nativeSourcePaths } from "./native-runtime-paths.js";
export { isManagedNativeRuntimePath } from "./native-runtime-paths.js";

/**
 * Foundry's isolated runtime sandboxes under `native-runtime` hold ephemeral
 * execution settings without live credentials. They must never be treated as
 * the machine's native configuration home or captured into service definitions.
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return nativeSourcePaths("claude", env).credentialHome;
}

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return nativeSourcePaths("codex", env).credentialHome;
}

/**
 * Where Claude Code keeps `.claude.json` (its account and per-project state):
 * in `CLAUDE_CONFIG_DIR` when set, else the home itself, not `~/.claude`.
 */
export function claudeGlobalConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return nativeSourcePaths("claude", env).globalConfigHome;
}
