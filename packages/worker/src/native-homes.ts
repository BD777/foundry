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

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || resolve(home(env), ".claude");
}

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || resolve(home(env), ".codex");
}

/**
 * Where Claude Code keeps `.claude.json` (its account and per-project state):
 * in `CLAUDE_CONFIG_DIR` when set, else the home itself, not `~/.claude`.
 */
export function claudeGlobalConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || home(env);
}
