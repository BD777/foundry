import { join } from "node:path";
import type {
  ConnectorAuthorizationState,
  DeviceConnectorUse,
} from "@bd777/foundry-protocol";
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
  runEnvironment: {
    BYTEDCLI_NO_AUTO_UPGRADE: "1",
    BYTEDCLI_OPEN_QR_IMAGE: "0",
  },
  clearEnvironment: [
    "BYTEDCLI_PROFILE",
    "BYTEDCLI_MEEGO_BROWSER",
    "BYTEDCLI_MEEGO_COOKIE",
  ],

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

  async readAuthorizations(run, version) {
    const base = {
      id: "feishu_web_session",
      revision: 1,
      checkedAt: new Date().toISOString(),
      verification: "local_state" as const,
    };
    if (!sessionFlowSupported(version))
      return [{ ...base, status: "unavailable", reason: "cli_upgrade" }];
    try {
      const result = await run(["--json", "--site", "cn", "meego", "status"], {
        timeoutMs: 20_000,
      });
      return [parseMeegoAuthorization(result.stdout, base.checkedAt)];
    } catch {
      return [
        {
          ...base,
          status: "unknown",
          verification: "not_checked",
          reason: "check_failed",
        },
      ];
    }
  },

  async beginAuthorization(run, scratch, group) {
    if (group.id !== "feishu_web_session" || group.revision !== 1)
      throw new Error("Unsupported authorization capability.");
    const version = await this.readVersion(run);
    if (!sessionFlowSupported(version))
      throw new Error(
        "Update bytedcli to 0.174.0 or newer for this authorization.",
      );
    const args = [
      "--json",
      "--site",
      "cn",
      "auth",
      "login",
      "--begin",
      "--session",
      "--feishu",
      "--no-terminal-qr",
      "--qr-image",
      join(scratch, "sign-in.png"),
    ];
    const deadline = Date.now() + 45_000;
    let result = await run(args, { timeoutMs: 30_000 });
    let envelope: Envelope | undefined;
    try {
      envelope = parseEnvelope(result.stdout);
    } catch {
      /* Report the safe no-JSON error below. */
    }
    // 0.174.0 can fail while reusing a saved Feishu session to obtain SSO:
    // its authorize-page parser expects flow/user/scope fields. The documented
    // explicit QR method skips ONLY reuse, with a fresh jar; it never logs out.
    // Retry exactly once, before any challenge exists, in this operation.
    const data = record(envelope?.data);
    if (
      envelope?.status !== "success" &&
      envelope?.error?.code === "FEISHU_WEB_SESSION_AUTHORIZE_PARSE_FAILED" &&
      !data?.complete_token &&
      !data?.qr_image_path &&
      deadline - Date.now() > 1000
    ) {
      result = await run([...args, "--session-method", "qr"], {
        timeoutMs: Math.min(25_000, deadline - Date.now()),
      });
    }
    return parseSessionAuthorization(result.stdout, "begin", result.code);
  },

  async pollAuthorization(run, group, continuation) {
    if (
      group.id !== "feishu_web_session" ||
      typeof continuation !== "string" ||
      !/^[a-zA-Z0-9._-]{16,128}$/.test(continuation)
    )
      return { status: "expired" };
    const result = await run(
      ["--json", "--site", "cn", "auth", "login", "--complete", continuation],
      { timeoutMs: 45_000 },
    );
    return parseSessionAuthorization(result.stdout, "poll", result.code).step;
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
    const meego = use.state?.authorizations?.find(
      (a) => a.id === "feishu_web_session" && a.revision === 1,
    );
    const capability =
      meego?.status === "ready"
        ? "Meego GoAPI native Feishu Web session: ready (local credential state, business permissions untested). Use the existing session; no new authorization is needed."
        : meego?.status === "needs_auth" || meego?.status === "expired"
          ? `Meego GoAPI native Feishu Web session: ${meego.status === "expired" ? "expired" : "missing"}. If the task needs Meego GoAPI, ask the person to authorize only the Meego Web session in Foundry (Connectors → ${use.label} → Meego Web session).`
          : "Meego GoAPI native Feishu Web session: status unverified. Check its status with a read-only native CLI command before asking for authorization; unverified does not mean missing.";
    return `- ${use.label} (\`${command}\`, ByteDance's internal CLI) is available to this session with this device's own sign-in (${who}); the credential stays on this device. Use it as it is, without --profile. Do not run \`${use.command} auth login\`, \`auth logout\`, \`auth clear\`, \`auth export\`, \`auth import\` or \`auth set-*\`. This is the base ByteCloud login. ${capability} Foundry server-held Feishu OAuth does not supply Meego's native Web session. If a service actually reports missing authorization (including MEEGO_GOAPI_AUTH_REQUIRED), name that exact sub-authorization when asking the person to authorize it in Foundry, preserving the existing base login. Never repeat a business write to test authorization.`;
  },
};

function sessionFlowSupported(version?: string): boolean {
  const parts = version?.split(".").map(Number);
  return (
    !!parts &&
    (parts[0]! > 0 || parts[1]! > 174 || (parts[1] === 174 && parts[2]! >= 0))
  );
}

export function parseMeegoAuthorization(
  stdout: string,
  checkedAt: string,
): ConnectorAuthorizationState {
  const base = {
    id: "feishu_web_session",
    revision: 1,
    checkedAt,
    verification: "local_state" as const,
  };
  const envelope = parseEnvelope(stdout);
  if (envelope.status !== "success")
    return {
      ...base,
      status: "unknown",
      verification: "not_checked",
      reason: "check_failed",
    };
  const provider = record(record(record(envelope.data)?.providers)?.goapi);
  switch (provider?.state) {
    case "ready":
      return { ...base, status: "ready" };
    case "missing":
      return { ...base, status: "needs_auth" };
    case "bootstrap_available":
      return { ...base, status: "unknown", reason: "bootstrap_available" };
    default:
      return {
        ...base,
        status: "unknown",
        verification: "not_checked",
        reason: "check_failed",
      };
  }
}

/** Whitelist only challenge metadata. complete_token never enters a public step. */
export function parseSessionAuthorization(
  stdout: string,
  phase: "begin" | "poll" = "begin",
  exitCode?: number,
): {
  step: SignInStep;
  continuation?: string;
} {
  let envelope: Envelope;
  try {
    envelope = parseEnvelope(stdout);
  } catch {
    return {
      step: {
        status: "failed",
        error: `[CLI_NO_JSON; ${phase}${Number.isInteger(exitCode) ? `; exit ${exitCode}` : ""}] The native sign-in command returned no readable response. Check the device's CLI and network; the base login was not signed out.`,
      },
    };
  }
  if (envelope.status !== "success") {
    const rawCode = text(envelope.error?.code) ?? "";
    const code = /^[A-Z][A-Z0-9_]{2,95}$/.test(rawCode)
      ? rawCode
      : "AUTH_UNKNOWN_ERROR";
    return {
      step: {
        status:
          code.includes("EXPIRED") || code.includes("NOT_FOUND")
            ? "expired"
            : code.includes("DENIED")
              ? "denied"
              : "failed",
        error: `[${code}; ${phase}${Number.isInteger(exitCode) ? `; exit ${exitCode}` : ""}] ${authorizationFailureMessage(code)}`,
      },
    };
  }
  const data = record(envelope.data) ?? {};
  if (data.login_status === "pending") {
    const token = text(data.complete_token);
    if (!token || !/^[a-zA-Z0-9._-]{16,128}$/.test(token))
      return {
        step: {
          status: "failed",
          error: "The device returned no usable authorization continuation.",
        },
      };
    return {
      step: {
        status: "pending",
        ...(text(data.qr_image_path)
          ? { challenge: { kind: "qr_image" as const } }
          : {}),
      },
      continuation: token,
    };
  }
  if (data.login_status === "expired") return { step: { status: "expired" } };
  if (["success", "completed", "ready"].includes(String(data.login_status))) {
    return {
      step:
        data.feishu_web_session_ready === true &&
        data.meego_goapi_session_ready === true
          ? { status: "complete" }
          : {
              status: "failed",
              error:
                "The native Web session was not confirmed ready for this capability. Check its status and retry.",
            },
    };
  }
  return {
    step: {
      status: "failed",
      error: "The device returned an unknown authorization status.",
    },
  };
}

function authorizationFailureMessage(code: string): string {
  if (code === "FEISHU_WEB_SESSION_AUTHORIZE_PARSE_FAILED")
    return "Feishu's authorization page is incompatible with this CLI. Keep the base login. If a fresh QR attempt also fails, update bytedcli or report this code to its maintainer.";
  if (code.includes("QR_INIT"))
    return "The sign-in service could not issue a QR code. Check access from this device, then retry this capability. The base login is unchanged.";
  if (code.includes("EXPIRED") || code.includes("NOT_FOUND"))
    return "This authorization challenge expired or is no longer available. Start this capability's authorization again.";
  if (code.includes("DENIED"))
    return "The provider denied this authorization. The base login is unchanged.";
  if (
    code.includes("QR_NOT_SUPPORTED") ||
    code.includes("INTERACTIVE_BROWSER") ||
    code.includes("CONFIRMATION_REQUIRED")
  )
    return "The native CLI requires a supported local approval step for this account or site. The Web flow cannot complete that step; the base login is unchanged.";
  if (/NETWORK|TIMEOUT|ECONN|ETIMEDOUT|ENOTFOUND|CERT/.test(code))
    return "This device could not reach or verify the sign-in service. Check its network and proxy configuration before retrying this capability.";
  return "The native authorization failed with this provider code. Check the device's sign-in service or CLI support; the base login is unchanged.";
}
