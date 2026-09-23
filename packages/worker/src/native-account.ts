/**
 * Which account a native agent CLI is signed in as on this machine.
 *
 * Foundry reads only what the CLIs already wrote to disk, and only identity
 * from it — an email or an account id, never a token. This exists so a device
 * page can say *which* login it is looking at, and so "signed in" reflects real
 * credentials instead of the mere presence of a binary.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface NativeAccount {
  /** Human-readable account identity, e.g. an email address. */
  label?: string;
  /** How the CLI authenticates: a subscription login or a raw API key. */
  mode: "login" | "api_key";
}

function codexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME?.trim();
  return home
    ? resolve(home, "auth.json")
    : resolve(homedir(), ".codex", "auth.json");
}

/** Claims of a JWT payload, without verifying the signature: this is display data. */
function jwtClaims(token: string): Record<string, unknown> | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    return decoded && typeof decoded === "object"
      ? (decoded as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringClaim(
  claims: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = claims?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The Codex CLI keeps its session in `auth.json` under `CODEX_HOME`. No file
 * means no login — which is exactly what `codex login status` reports — so this
 * is the honest signal for whether Codex can run.
 */
export function codexAccount(
  env: NodeJS.ProcessEnv = process.env,
): NativeAccount | undefined {
  const path = codexAuthPath(env);
  if (!existsSync(path)) return undefined;
  let parsed: Record<string, unknown>;
  try {
    const decoded: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!decoded || typeof decoded !== "object") return undefined;
    parsed = decoded as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const tokens =
    parsed.tokens && typeof parsed.tokens === "object"
      ? (parsed.tokens as Record<string, unknown>)
      : undefined;
  const idToken = typeof tokens?.id_token === "string" ? tokens.id_token : "";
  if (idToken) {
    const claims = jwtClaims(idToken);
    return {
      label:
        stringClaim(claims, "email") ??
        stringClaim(claims, "preferred_username") ??
        (typeof tokens?.account_id === "string"
          ? tokens.account_id
          : undefined),
      mode: "login",
    };
  }
  const apiKey = parsed.OPENAI_API_KEY;
  if (typeof apiKey === "string" && apiKey.trim()) {
    return { label: "API key", mode: "api_key" };
  }
  return undefined;
}

/**
 * Claude Code stores its credentials in the macOS keychain, so the account is
 * read from the profile it writes beside them. An account without credentials
 * is still reported: the CLI itself decides whether the session is live, and
 * guessing from disk would only invent a second, wrong answer.
 */
export function claudeAccount(
  home: string = homedir(),
): NativeAccount | undefined {
  const path = resolve(home, ".claude.json");
  if (!existsSync(path)) return undefined;
  try {
    const decoded: unknown = JSON.parse(readFileSync(path, "utf8"));
    const account =
      decoded && typeof decoded === "object"
        ? ((decoded as Record<string, unknown>).oauthAccount as
            Record<string, unknown> | undefined)
        : undefined;
    const email = account?.emailAddress;
    if (typeof email === "string" && email.trim()) {
      return { label: email.trim(), mode: "login" };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
