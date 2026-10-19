/** Private credential reads. Values never enter manifests, arguments or diagnostics. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { nativeSourcePaths } from "./native-runtime-paths.js";
import { registerKnownSecret } from "./secret-redaction.js";
export function claudeKeychainLocation(env: NodeJS.ProcessEnv = process.env): {
  service: string;
  account: string;
} {
  const namespace = nativeSourcePaths("claude", env).credentialNamespace ?? "";
  let account = env.USER || userInfo().username;
  if (!/^[a-zA-Z0-9._-]+$/.test(account)) account = "claude-code-user";
  const suffix = namespace
    ? "-" +
      createHash("sha256")
        .update(namespace.normalize("NFC"))
        .digest("hex")
        .slice(0, 8)
    : "";
  return { service: `Claude Code-credentials${suffix}`, account };
}
function keychainRead(service: string, account: string): string | undefined {
  try {
    return (
      execFileSync(
        "/usr/bin/security",
        ["find-generic-password", "-a", account, "-w", "-s", service],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5000,
        },
      ).trim() || undefined
    );
  } catch (error) {
    if ((error as { status?: number }).status === 44) return undefined;
    throw new Error(
      "The selected native Keychain credential could not be read. Unlock or authorize it on this Mac; another login was not substituted.",
    );
  }
}
export function readClaudeCredentialSource(
  env: NodeJS.ProcessEnv = process.env,
  ports: { platform?: NodeJS.Platform; keychain?: typeof keychainRead } = {},
): { kind: "file" | "keychain"; id: string; text: string } | undefined {
  const source = nativeSourcePaths("claude", env),
    file = join(source.credentialHome, ".credentials.json");
  let text: string | undefined,
    kind: "file" | "keychain" = "file",
    id = file;
  if ((ports.platform ?? process.platform) === "darwin") {
    if (
      env.USE_STAGING_OAUTH ||
      env.USE_LOCAL_OAUTH ||
      env.CLAUDE_LOCAL_OAUTH_API_BASE
    )
      throw new Error(
        "Custom native OAuth environments need an explicit supported credential source.",
      );
    const location = claudeKeychainLocation(env);
    text = (ports.keychain ?? keychainRead)(location.service, location.account);
    if (text) {
      kind = "keychain";
      id = `keychain:${location.service}:${location.account}`;
    }
  }
  if (text === undefined) {
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (
        ["ENOENT", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        return undefined;
      throw new Error("The selected native credential file could not be read.");
    }
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      "The selected native credential source contains invalid data.",
    );
  }
  for (const key of ["accessToken", "refreshToken"]) {
    const value = data?.claudeAiOauth?.[key];
    if (typeof value === "string" && value) registerKnownSecret(value);
  }
  return { kind, id, text };
}
