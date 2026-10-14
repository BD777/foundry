import { join } from "node:path";
import type { DeviceConnectorUse } from "@bd777/foundry-protocol";
import type {
  DeviceHeldAdapter,
  LoginReading,
  SignInStep,
  ToolRun,
} from "./device-held.js";

/**
 * bytedcli (npm @bytedance-dev/bytedcli), the ByteDance internal CLI. Its
 * login is ByteCloud Auth's device-code flow, lasts about 30 days per site
 * and lives in the CLI's data directory on this device; Foundry only runs
 * the CLI's own documented commands with --json:
 *
 *   auth status                      signed in or not, the user name, the
 *                                    site, when the login ends (the output
 *                                    also has an email, never kept)
 *   auth login --begin --no-terminal-qr --qr-image <file>
 *                                    starts (or reuses) the challenge; only
 *                                    the verification page leaves the device
 *   auth login --complete            polls that same challenge, no token
 *   auth logout                      only on the person's explicit request
 *
 * Shapes were read from bytedcli 0.170.0's real output (2026-10-15). Foundry's
 * own runs set BYTEDCLI_NO_AUTO_UPGRADE=1, so reading the status never
 * upgrades the person's CLI, and never inherit BYTEDCLI_PROFILE: they read
 * the device's default login.
 */

interface Envelope {
  status?: unknown;
  data?: Record<string, unknown> | null;
  error?: { message?: unknown; code?: unknown } | null;
}

/** The JSON envelope bytedcli prints last on stdout. */
export function parseEnvelope(stdout: string): Envelope {
  const lines = stdout.split("\n").map((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as Envelope;
      if (parsed && typeof parsed === "object" && "status" in parsed)
        return parsed;
    } catch {
      continue;
    }
  }
  try {
    const parsed = JSON.parse(stdout) as Envelope;
    if (parsed && typeof parsed === "object" && "status" in parsed)
      return parsed;
  } catch {
    // Not JSON: fall through.
  }
  throw new Error("bytedcli did not answer in JSON");
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** An error envelope as a message: bytedcli's code and message, no output. */
function envelopeError(envelope: Envelope, action: string): Error {
  const code = text(envelope.error?.code);
  const message = text(envelope.error?.message) ?? "no message";
  return new Error(
    `bytedcli ${action} failed${code ? ` (${code})` : ""}: ${message.slice(0, 200)}`,
  );
}

/**
 * The login `bytedcli --json auth status` describes. Identity is the user
 * name the CLI shows; an email is never taken. The expiry is the login's
 * (login_expires_at, else ByteCloud Auth's refresh token expiry), not the
 * two-hour access token's.
 */
export function parseAuthStatus(stdout: string): LoginReading {
  const envelope = parseEnvelope(stdout);
  if (envelope.status !== "success")
    throw envelopeError(envelope, "auth status");
  const data = record(envelope.data) ?? {};
  const byteCloud = record(data.bytecloud_auth) ?? {};
  const signedIn =
    data.authenticated === true &&
    (byteCloud.status === undefined || byteCloud.status === "ready");
  if (!signedIn) return { signedIn: false };
  const identity = record(byteCloud.identity);
  let name = text(identity?.username);
  if (name?.includes("@")) name = name.slice(0, name.indexOf("@"));
  const site = text(byteCloud.site);
  const expiry =
    text(data.login_expires_at) ?? text(byteCloud.refreshTokenExpiresAt);
  const expiresAt =
    expiry && !Number.isNaN(Date.parse(expiry))
      ? new Date(Date.parse(expiry)).toISOString()
      : undefined;
  return {
    signedIn: true,
    ...(name ? { identity: name } : {}),
    ...(site ? { sites: [site] } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

/** A `auth login --begin` or `--complete` answer as a sign-in step. */
export function parseLoginStep(stdout: string): SignInStep {
  const envelope = parseEnvelope(stdout);
  if (envelope.status !== "success") {
    const code = text(envelope.error?.code) ?? "";
    if (code === "BYTECLOUD_AUTH_LOGIN_DENIED")
      return { status: "denied", error: "The sign-in was denied." };
    if (code === "BYTECLOUD_AUTH_LOGIN_EXPIRED") return { status: "expired" };
    return {
      status: "failed",
      error: envelopeError(envelope, "auth login").message,
    };
  }
  const data = record(envelope.data) ?? {};
  const status = text(data.login_status);
  const verificationUrl = text(data.verification_uri_complete);
  switch (status) {
    case "pending":
      return {
        status: "pending",
        ...(verificationUrl ? { verificationUrl } : {}),
      };
    case "success":
    case "completed":
    case "ready":
      return { status: "complete" };
    case "expired":
      return { status: "expired" };
    default:
      return {
        status: "failed",
        error: `bytedcli answered an unknown login status ${status ?? "(none)"}`,
      };
  }
}

const versionPattern = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;

function dateOnly(value: string | undefined): string | undefined {
  return value ? value.slice(0, 10) : undefined;
}

export const bytedcliAdapter: DeviceHeldAdapter = {
  name: "bytedcli",
  runEnvironment: { BYTEDCLI_NO_AUTO_UPGRADE: "1" },
  clearEnvironment: ["BYTEDCLI_PROFILE"],

  async readVersion(run: ToolRun) {
    const result = await run(["--version"], { timeoutMs: 20_000 });
    return versionPattern.exec(result.stdout)?.[1];
  },

  async readLogin(run: ToolRun) {
    const result = await run(["--json", "auth", "status"], {
      timeoutMs: 30_000,
    });
    return parseAuthStatus(result.stdout);
  },

  async beginSignIn(run: ToolRun, scratch: string) {
    const result = await run(
      [
        "--json",
        "auth",
        "login",
        "--begin",
        "--no-terminal-qr",
        "--qr-image",
        join(scratch, "sign-in.png"),
      ],
      { timeoutMs: 45_000 },
    );
    const step = parseLoginStep(result.stdout);
    if (step.status === "pending" && !step.verificationUrl)
      return {
        status: "failed",
        error: "bytedcli started a sign-in without a page to approve it on",
      };
    return step;
  },

  async pollSignIn(run: ToolRun) {
    const result = await run(["--json", "auth", "login", "--complete"], {
      timeoutMs: 45_000,
    });
    return parseLoginStep(result.stdout);
  },

  async signOut(run: ToolRun) {
    const result = await run(["--json", "auth", "logout"], {
      timeoutMs: 30_000,
    });
    const envelope = parseEnvelope(result.stdout);
    if (envelope.status !== "success")
      throw envelopeError(envelope, "auth logout");
  },

  sessionNote(
    use: DeviceConnectorUse,
    command: string,
    reading: LoginReading | undefined,
  ) {
    if (use.access === "none")
      return `- ${use.label} on this device holds its owner's sign-in, which this session may not use: Foundry pointed BYTEDCLI_PROFILE at an empty profile for it. Do not sign in or change that variable; if the task needs ${use.label}, ask the device's owner to allow it in the workspace's Connectors.`;
    const who = reading?.signedIn
      ? [
          reading.identity ? `signed in as ${reading.identity}` : "signed in",
          reading.sites?.length ? `site ${reading.sites.join(", ")}` : "",
          reading.expiresAt ? `until ${dateOnly(reading.expiresAt)}` : "",
        ]
          .filter(Boolean)
          .join(", ")
      : "its sign-in status was not read yet";
    return `- ${use.label} (\`${command}\`, ByteDance's internal CLI) is available to this session with this device's own sign-in (${who}); the credential stays on this device. Use it as it is, without --profile. Do not run \`${use.command} auth login\`, \`auth logout\`, \`auth clear\`, \`auth export\`, \`auth import\` or \`auth set-*\`. If it reports the login expired or missing, ask the person to sign in again in Foundry (Connectors → ${use.label}).`;
  },
};
