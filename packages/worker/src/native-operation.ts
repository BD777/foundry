import { nativeLoginEnvironment } from "./native-login-environment.js";
import { foundryStatePath } from "./state-root.js";
import { markPrivateInputOwner } from "./private-input-owners.js";
/** A metadata operation owns its generated config, never the original login/history. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentProfileLocalConfig } from "./profiles.js";
import {
  isolatedClaudeEnvironment,
  isolatedCodexEnvironment,
  nativeExecutionPaths,
} from "./runtime-isolation.js";
export function prepareNativeOperation(
  profile: AgentProfileLocalConfig,
  env: NodeJS.ProcessEnv,
  cwd: string,
) {
  const ownerId = `metadata:${randomUUID()}`;
  const dataHome = env.FOUNDRY_EXECUTION_SESSION_ROOT
    ? join(
        env.FOUNDRY_EXECUTION_SESSION_ROOT,
        "native-operation-data",
        randomUUID(),
      )
    : foundryStatePath("native-operation-data", randomUUID());
  const common = new Set([
    "PATH",
    "HOME",
    "USER",
    "USERPROFILE",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TERM",
    "COLORTERM",
    "NO_COLOR",
    "FORCE_COLOR",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "FOUNDRY_EXECUTION_SESSION_ROOT",
    "FOUNDRY_NATIVE_CODEX_SOURCE_HOME",
    "FOUNDRY_NATIVE_CLAUDE_SOURCE_HOME",
    "FOUNDRY_NATIVE_CLAUDE_CREDENTIAL_NAMESPACE",
    "FOUNDRY_NATIVE_CLAUDE_CONFIG_HOME",
    "FOUNDRY_NATIVE_CLAUDE_GLOBAL_HOME",
    "FOUNDRY_CODEX_AUTH_SOURCE",
  ]);
  const provider =
    profile.runtime === "codex"
      ? [
          "CODEX_API_KEY",
          "OPENAI_API_KEY",
          "OPENAI_BASE_URL",
          "OPENAI_API_BASE",
          "CODEX_BASE_URL",
        ]
      : [
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "ANTHROPIC_BASE_URL",
          "ANTHROPIC_API_BASE_URL",
          "CLAUDE_CODE_OAUTH_TOKEN",
        ];
  for (const name of provider) common.add(name);
  if (typeof profile.codexProviderConfig?.env_key === "string")
    common.add(profile.codexProviderConfig.env_key);
  for (const name of Object.values(
    profile.codexProviderConfig?.env_http_headers ?? {},
  ))
    if (typeof name === "string") common.add(name);
  const base = Object.fromEntries(
    Object.entries(env).filter(([key]) => common.has(key)),
  );
  mkdirSync(dataHome, { recursive: true, mode: 0o700 });
  markPrivateInputOwner(dataHome, "native-operation-data");
  let prepared: NodeJS.ProcessEnv;
  try {
    prepared = (
      profile.runtime === "codex"
        ? isolatedCodexEnvironment
        : isolatedClaudeEnvironment
    )(
      profile,
      {
        ...base,
        ...(profile.connectionType === "local_login"
          ? nativeLoginEnvironment(profile.runtime)
          : {}),
        FOUNDRY_NATIVE_CODEX_DATA_HOME: dataHome,
        FOUNDRY_NATIVE_CLAUDE_DATA_HOME: dataHome,
      },
      cwd,
      ownerId,
    );
  } catch (error) {
    rmSync(dataHome, { recursive: true, force: true });
    throw error;
  }
  const paths = nativeExecutionPaths(prepared);
  let released = false;
  return {
    env: prepared,
    toJSON: () => ({ runtime: profile.runtime, ownerId }),
    dispose: () => {
      if (released) return;
      released = true;
      if (!paths) {
        rmSync(dataHome, { recursive: true, force: true });
        return;
      }
      const record = JSON.parse(
        readFileSync(
          join(paths.configHome, ".foundry-native-execution.json"),
          "utf8",
        ),
      );
      if (record.ownerId !== ownerId || record.configHome !== paths.configHome)
        throw new Error(
          "Native metadata input ownership changed before cleanup.",
        );
      rmSync(paths.configHome, { recursive: true, force: true });
      rmSync(dataHome, { recursive: true, force: true });
    },
  };
}
