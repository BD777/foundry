/**
 * Where the native agent CLIs keep their configuration, sessions and logins
 * for a process with this environment: `CLAUDE_CONFIG_DIR` / `CODEX_HOME`
 * when set, else the default directory under the process's home.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

function home(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || homedir();
}

/**
 * Foundry's isolated runtime sandboxes under `native-runtime` hold ephemeral
 * execution settings without live credentials. They must never be treated as
 * the machine's native configuration home or captured into service definitions.
 */
export function isManagedNativeRuntimePath(path: string | undefined): boolean {
  if (!path) return false;
  return /[/\\]native-runtime(?:[/\\]|$)/.test(path);
}

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.CLAUDE_CONFIG_DIR?.trim();
  if (custom && !isManagedNativeRuntimePath(custom)) return custom;
  return resolve(home(env), ".claude");
}

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.CODEX_HOME?.trim();
  if (custom && !isManagedNativeRuntimePath(custom)) return custom;
  return resolve(home(env), ".codex");
}

/**
 * Where Claude Code keeps `.claude.json` (its account and per-project state):
 * in `CLAUDE_CONFIG_DIR` when set, else the home itself, not `~/.claude`.
 */
export function claudeGlobalConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const custom = env.CLAUDE_CONFIG_DIR?.trim();
  if (custom && !isManagedNativeRuntimePath(custom)) return custom;
  return home(env);
}
