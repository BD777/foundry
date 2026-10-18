import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { nativeSourceKeys } from "../native-runtime-paths.js";
/**
 * The environment of an agent working inside a sandbox (an Issue's
 * execution or clarification, a verifier): its home, temporary space and
 * native session records live in a private scratch directory that holds the
 * provider logins' access tokens, never in the workspace. Foundry's own
 * credentials are not passed on.
 */
export function isolatedAgentEnvironment(scratch: string): NodeJS.ProcessEnv {
  const codexHome = resolve(scratch, "codex");
  const claudeHome = resolve(scratch, "claude");
  const temp = resolve(scratch, "tmp");
  for (const directory of [codexHome, claudeHome, temp])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Authentication is selected only after the runtime and profile are known.
  const inherited = { ...process.env };
  for (const key of nativeSourceKeys) delete inherited[key];
  for (const key of Object.keys(inherited)) {
    if (/FOUNDRY.*(?:TOKEN|PAIRING|CONTROL|CREDENTIAL)/i.test(key))
      delete inherited[key];
  }
  return {
    ...inherited,
    HOME: scratch,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    FOUNDRY_RUNTIME_CONFIG_ISOLATED: "1",
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
