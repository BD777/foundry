import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { codexHome as deviceCodexHome } from "../native-homes.js";
import { foundryStatePath } from "../state-root.js";
import {
  sandboxCredentialCopies,
  writeSandboxCredentials,
} from "./provider-credentials.js";

/** The one private-state subdir a sandboxed agent may read skill files from. */
export function skillSetsReadRoot(): string {
  return foundryStatePath("skill-sets");
}

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
  // Provider authentication stays private and is never staged in the
  // candidate. The sandbox gets the device's access tokens, never a refresh
  // token: providers rotate those, and a refresh in here would sign the
  // device out (provider-credentials.ts). Codex's settings come along.
  const codexConfig = resolve(deviceCodexHome(), "config.toml");
  if (existsSync(codexConfig))
    copyFileSync(codexConfig, resolve(codexHome, "config.toml"));
  writeSandboxCredentials(
    sandboxCredentialCopies({
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeHome,
    }),
  );
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
