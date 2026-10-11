import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { foundryStatePath } from "../state-root.js";

/** The one private-state subdir a sandboxed agent may read skill files from. */
export function skillSetsReadRoot(): string {
  return foundryStatePath("skill-sets");
}

/**
 * The environment of an agent working inside a sandbox (an Issue's
 * execution or clarification, a verifier): its home, temporary space and
 * native session records live in a private scratch directory that holds a
 * copy of the provider login, never in the workspace. Foundry's own
 * credentials are not passed on.
 */
export function isolatedAgentEnvironment(scratch: string): NodeJS.ProcessEnv {
  const codexHome = resolve(scratch, "codex");
  const claudeHome = resolve(scratch, "claude");
  const temp = resolve(scratch, "tmp");
  for (const directory of [codexHome, claudeHome, temp])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Provider authentication stays private and is never staged in the candidate.
  for (const [source, target] of [
    [
      resolve(
        process.env.CODEX_HOME ?? resolve(homedir(), ".codex"),
        "auth.json",
      ),
      resolve(codexHome, "auth.json"),
    ],
    [
      resolve(
        process.env.CODEX_HOME ?? resolve(homedir(), ".codex"),
        "config.toml",
      ),
      resolve(codexHome, "config.toml"),
    ],
    [
      resolve(
        process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), ".claude"),
        ".credentials.json",
      ),
      resolve(claudeHome, ".credentials.json"),
    ],
  ]) {
    // The device's login is the source of truth, copied on every launch:
    // providers rotate refresh tokens, and a copy kept from an earlier run
    // (or one its CLI signed out after a failed refresh) never works again.
    if (source && target && existsSync(source)) copyFileSync(source, target);
  }
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (/FOUNDRY.*(?:TOKEN|PAIRING|CONTROL|CREDENTIAL)/i.test(key))
      delete inherited[key];
  }
  return {
    ...inherited,
    HOME: scratch,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    TMPDIR: temp,
    CLAUDE_CODE_TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    FOUNDRY_EXECUTION_SESSION_ROOT: resolve(scratch, "sessions"),
    // The person's claude.ai connectors (mail, drive, calendar) are outside
    // the Issue; an execution reaches only its candidate and Foundry's tools.
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  };
}
