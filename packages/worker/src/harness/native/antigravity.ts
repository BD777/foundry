import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writePrivateJSONAtomic } from "../../platform/storage.js";
import {
  foundryStatePath,
  foundryToolsRoot,
} from "../../platform/state-root.js";

/** The official installer places its self-updating binary in this directory. */
export function antigravityBinDir(): string {
  return join(foundryToolsRoot(), "antigravity", "bin");
}

export function antigravityHome(profileId = "antigravity_local"): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(profileId))
    throw new Error("Invalid Antigravity profile ID.");
  return foundryStatePath("native-runtime", "antigravity", profileId);
}

/** One launch recipe for the terminal login, ACP operations and Chat. agy
 * interprets app-data-dir relative to gemini-dir, even for absolute values. */
export function antigravityInvocation(profileId: string) {
  const home = antigravityHome(profileId);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TMPDIR",
    "USER",
    "LOGNAME",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "SSH_AUTH_SOCK",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "SystemRoot",
    "TEMP",
    "TMP",
  ])
    if (process.env[key]) env[key] = process.env[key];
  env.HOME = home;
  return {
    command: join(antigravityBinDir(), "agy"),
    args: [
      "acp",
      "--gemini-dir",
      join(home, ".gemini"),
      "--app-data-dir",
      "antigravity-cli",
    ],
    env,
  };
}

// agy may share the OS login across local surfaces. Remember only the profile
// selected in the terminal login, never account identifiers or credentials.
export function antigravityLoginBinding():
  { profileId: string; generation: string } | undefined {
  const path = foundryStatePath("antigravity-login-profile.json");
  try {
    const profile = JSON.parse(readFileSync(path, "utf8"));
    return typeof profile?.profileId === "string" &&
      typeof profile.generation === "string"
      ? profile
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

export function antigravityBoundProfile(): string | undefined {
  return antigravityLoginBinding()?.profileId;
}

export function bindAntigravityProfile(profileId?: string): void {
  const path = foundryStatePath("antigravity-login-profile.json");
  if (profileId)
    writePrivateJSONAtomic(path, { profileId, generation: randomUUID() });
  else rmSync(path, { force: true });
}

export function requireAntigravityLogin(profileId: string): void {
  if (antigravityBoundProfile() !== profileId)
    throw new Error("Sign in to this Antigravity profile on this device.");
}
