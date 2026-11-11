import { homedir } from "node:os";
import { join } from "node:path";
import {
  findCommand,
  managedToolsBin,
  toolEnvironment,
} from "../../skills/managed-tools.js";

/**
 * What an extension's process (and a declarative extension's tool) starts
 * with: the person's ordinary environment (home, language, proxy and CA),
 * never the worker's own credentials.
 */
/** Variables an extension's process gets from the worker's environment. */
const passedVariables = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
];

export function extensionBaseEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of passedVariables)
    if (process.env[name] !== undefined) env[name] = process.env[name];
  for (const [name, value] of Object.entries(process.env))
    if (name.startsWith("LC_") && value !== undefined) env[name] = value;
  env.PATH = toolEnvironment().PATH;
  return env;
}

/** A program named in a manifest: on PATH or in the usual user folders. */
export function findExtensionCommand(named: string): string | undefined {
  return findCommand(named, [
    process.env.FOUNDRY_TOOLS_BIN ?? managedToolsBin(),
    join(homedir(), ".local", "bin"),
    join(homedir(), ".npm-global", "bin"),
    join(homedir(), ".bun", "bin"),
    join(homedir(), ".volta", "bin"),
    join(homedir(), "Library", "pnpm"),
    join(homedir(), ".local", "share", "pnpm"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]);
}
