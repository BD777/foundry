import { readClaudeCredentialSource } from "./native-credential-source.js";
import { execFile, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProviderHealth } from "@bd777/foundry-protocol";
import {
  clearNativeCliCache,
  nativeCli,
  nativeCliInstallCommands,
  outdatedNote,
  probeTimeouts,
  resolveClaudeCommand,
  resolveCodexCommand,
  timedOut,
} from "./native-cli.js";
import { nativeLoginEnvironment } from "./native-login-environment.js";
import { claudeAccount, codexAccount } from "./native-account.js";

// `claude auth status` reports an account login as "claude.ai" (current CLIs)
// or "oauth_token"; API keys, key helpers and third-party gateways are not
// an official login.
const claudeAccountAuthMethods = new Set(["claude.ai", "oauth_token"]);

export function isNativeAccountStatus(
  runtime: "claude" | "codex",
  result: { status: number | null; stdout?: string; stderr?: string },
): boolean {
  if (result.status !== 0) return false;
  if (runtime === "codex")
    return /ChatGPT/i.test(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  try {
    const parsed = JSON.parse(result.stdout || "{}") as {
      loggedIn?: boolean;
      authMethod?: string;
    };
    return (
      parsed.loggedIn === true &&
      claudeAccountAuthMethods.has(parsed.authMethod ?? "")
    );
  } catch {
    return false;
  }
}

/** Claude Code renews a claude.ai access token this close to its expiry. */
export const claudeRenewalWindowMs = 5 * 60 * 1000;
// A CLI takes a moment to start; one checked just outside the window can be
// inside it by the time it reads the credentials.
const claudeStartupMarginMs = 60 * 1000;

export interface ClaudeStoredLogin {
  /** When the claude.ai access token expires, in epoch milliseconds. */
  expiresAt: number;
  renewable: boolean;
  subscriptionType?: string;
}

/**
 * The selected native login describes expiry and plan only, never a token.
 * Explicit directories inspect fixtures/files; the default also reads Keychain.
 */
export function claudeStoredLogin(
  configDir?: string,
): ClaudeStoredLogin | undefined {
  let oauth: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(
      configDir === undefined
        ? (readClaudeCredentialSource()?.text ?? "null")
        : readFileSync(resolve(configDir, ".credentials.json"), "utf8"),
    );
    const value =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).claudeAiOauth
        : undefined;
    oauth =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : undefined;
  } catch {
    return undefined;
  }
  if (!oauth || typeof oauth.expiresAt !== "number") return undefined;
  return {
    expiresAt: oauth.expiresAt,
    renewable: typeof oauth.refreshToken === "string" && !!oauth.refreshToken,
    ...(typeof oauth.subscriptionType === "string" && oauth.subscriptionType
      ? { subscriptionType: oauth.subscriptionType }
      : {}),
  };
}

/**
 * The stored login Claude Code would renew on start-up. It starts that
 * renewal without awaiting it, so a command that exits at once (`auth
 * status`, a session opened only to read its catalog) can end after the
 * provider rotated the refresh token but before the new one is saved,
 * signing the device out. Such commands are not run while this is set.
 */
export function claudeRenewalPending(
  now: number = Date.now(),
  login: ClaudeStoredLogin | undefined = claudeStoredLogin(),
): ClaudeStoredLogin | undefined {
  return login?.renewable &&
    login.expiresAt - now <= claudeRenewalWindowMs + claudeStartupMarginMs
    ? login
    : undefined;
}

const cache = new Map<string, { until: number; health: ProviderHealth }>();
/**
 * The last answer each status command gave, kept across clears: a status
 * command that is only slow (Claude Code's took 18 s cold on a busy Mac
 * mini) keeps it instead of reporting a working runtime as unavailable.
 */
const lastAnswers = new Map<string, ProviderHealth>();
const refreshing = new Map<string, number>();
let loginRevision = 0;
let generation = 0;
export function clearNativeLoginHealth(): void {
  cache.clear();
  clearNativeCliCache();
  loginRevision += 1;
  generation += 1;
}

/** Changes when a native login may have changed, so the device reports it. */
export function nativeLoginRevision(): number {
  return loginRevision;
}

/**
 * Native CLI status only: no inference and no provider HTTP health probes.
 * Only the first read waits for the CLI; an older answer is returned while a
 * fresh one is read in the background.
 */
export function nativeLoginHealth(runtime: "claude" | "codex"): ProviderHealth {
  const cached = cache.get(runtime);
  if (cached && cached.until > Date.now()) return cached.health;
  if (cached) {
    refreshLoginHealth(runtime);
    return cached.health;
  }
  return readNativeLoginHealth(runtime);
}

/** nativeLoginHealth read now; a different answer than before counts as a change. */
export function readNativeLoginHealth(
  runtime: "claude" | "codex",
): ProviderHealth {
  const step = loginStatusStep(runtime);
  if (step.health) return remember(runtime, step.health);
  const answer = statusAnswer(
    runtime,
    spawnSync(step.command, step.args, {
      ...step.options,
      timeout: probeTimeouts(5000).first,
    }),
  );
  if (answer) {
    lastAnswers.set(answerKey(runtime, step.command), answer);
    return remember(runtime, answer);
  }
  refreshLoginHealth(runtime);
  return remember(runtime, unansweredHealth(runtime, step.command));
}

/** Reads the status again without blocking, waiting longer for a slow CLI. */
function refreshLoginHealth(runtime: "claude" | "codex"): void {
  if (refreshing.get(runtime) === generation) return;
  const started = generation;
  refreshing.set(runtime, started);
  void (async () => {
    const step = loginStatusStep(runtime);
    let health: ProviderHealth;
    if (step.health !== undefined) health = step.health;
    else {
      const answer = statusAnswer(
        runtime,
        await new Promise<StatusRun>((done) =>
          execFile(
            step.command,
            step.args,
            { ...step.options, timeout: probeTimeouts(5000).background },
            (error, stdout, stderr) =>
              done({
                status: !error
                  ? 0
                  : typeof error.code === "number"
                    ? error.code
                    : null,
                stdout: String(stdout),
                stderr: String(stderr),
                ...(error && typeof error.code !== "number" ? { error } : {}),
              }),
          ),
        ),
      );
      // A clear while reading (a sign-in or sign-out) makes this answer stale.
      if (started !== generation) return;
      if (answer) lastAnswers.set(answerKey(runtime, step.command), answer);
      health = answer ?? unansweredHealth(runtime, step.command);
    }
    if (started === generation) remember(runtime, health);
  })()
    .catch((error: unknown) =>
      console.error(
        `Reading the ${runtime} login status failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
    .finally(() => {
      if (refreshing.get(runtime) === started) refreshing.delete(runtime);
    });
}

function remember(
  runtime: "claude" | "codex",
  health: ProviderHealth,
): ProviderHealth {
  const previous = cache.get(runtime)?.health;
  const cli = nativeCli(runtime);
  const note = outdatedNote(runtime, cli);
  const value: ProviderHealth = {
    ...health,
    cli,
    ...(note
      ? {
          statusDetail: health.statusDetail
            ? `${health.statusDetail} ${note}`
            : note,
        }
      : {}),
  };
  cache.set(runtime, { until: Date.now() + 60000, health: value });
  if (
    previous &&
    (previous.status !== value.status ||
      previous.accountLabel !== value.accountLabel)
  )
    loginRevision += 1;
  return value;
}

function answerKey(runtime: "claude" | "codex", command: string): string {
  return JSON.stringify([runtime, command]);
}

/** A status command that started but gave no answer keeps the last one. */
function unansweredHealth(
  runtime: "claude" | "codex",
  command: string,
): ProviderHealth {
  return (
    lastAnswers.get(answerKey(runtime, command)) ?? {
      provider: runtime,
      status: "unavailable",
      authMode: "missing",
      secretStored: "local",
      statusDetail:
        "The native CLI is slow to answer on this device; Foundry is still reading its login status.",
    }
  );
}

interface StatusRun {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

type StatusStep =
  | { health: ProviderHealth; command?: undefined }
  | {
      health?: undefined;
      command: string;
      args: string[];
      options: {
        encoding: "utf8";
        maxBuffer: number;
        env: NodeJS.ProcessEnv;
      };
    };

/** The status command to run, or the answer when none needs to run. */
function loginStatusStep(runtime: "claude" | "codex"): StatusStep {
  const missing: ProviderHealth = {
    provider: runtime,
    status: "missing_auth",
    authMode: "missing",
    secretStored: "local",
  };
  let command: string;
  try {
    command =
      runtime === "claude" ? resolveClaudeCommand() : resolveCodexCommand();
  } catch {
    // Not installed at all: say what to install, not that a check failed.
    return {
      health: {
        ...missing,
        status: "unavailable",
        statusDetail: installHint(runtime),
      },
    };
  }
  if (runtime === "claude" && claudeRenewalPending())
    return {
      health: {
        ...missing,
        status: "healthy",
        authMode: "local_config",
        accountLabel: claudeAccount()?.label,
        statusDetail:
          "Claude Code's stored login is due for renewal; it renews on its next request. Online account validity has not been verified.",
      },
    };
  return {
    command,
    args:
      runtime === "claude" ? ["auth", "status", "--json"] : ["login", "status"],
    options: {
      encoding: "utf8",
      maxBuffer: 65536,
      env: { ...process.env, ...nativeLoginEnvironment(runtime) },
    },
  };
}

/**
 * What a finished status command says, or nothing when it gave no answer:
 * stopped for taking too long, or ended by a signal. Only a program that
 * cannot start, or one that answered, changes the reported status.
 */
function statusAnswer(
  runtime: "claude" | "codex",
  run: StatusRun,
): ProviderHealth | undefined {
  const missing: ProviderHealth = {
    provider: runtime,
    status: "missing_auth",
    authMode: "missing",
    secretStored: "local",
  };
  if (
    run.error &&
    (timedOut(run.error) || (run.error as { signal?: unknown }).signal)
  )
    return undefined;
  if (run.error)
    return {
      ...missing,
      status: "unavailable",
      statusDetail:
        (run.error as NodeJS.ErrnoException).code === "ENOENT"
          ? installHint(runtime)
          : "The native CLI status check did not complete. Retry after checking the device.",
    };
  if (run.status === null) return undefined;
  try {
    const signedIn = isNativeAccountStatus(runtime, run);
    return {
      ...missing,
      status: signedIn ? "healthy" : "missing_auth",
      authMode: signedIn ? "local_config" : "missing",
      // Identity only: CLI login status remains authoritative, and this
      // does not promote a local login into online account verification.
      accountLabel: signedIn
        ? runtime === "codex"
          ? codexAccount()?.label
          : JSON.parse(run.stdout || "{}").email?.trim() ||
            claudeAccount()?.label
        : undefined,
      statusDetail: signedIn
        ? "Native CLI reports a local login. Online account validity has not been verified."
        : `No official login in the worker's ${runtime === "codex" ? process.env.CODEX_HOME || "~/.codex" : process.env.CLAUDE_CONFIG_DIR || "~/.claude"} configuration. Other apps may use a different configuration.`,
    };
  } catch {
    return {
      ...missing,
      status: "unavailable",
      statusDetail:
        "The native CLI could not report login status. Check its installation on this device.",
    };
  }
}

/** How to install a runtime's native CLI on a device that lacks it. */
function installHint(runtime: "claude" | "codex"): string {
  return runtime === "claude"
    ? `Claude Code is not installed on this device. Install it from this device's page in Foundry, or run ${nativeCliInstallCommands.claude}; then sign in with \`claude\` and check again.`
    : `Codex is not installed on this device. Install it from this device's page in Foundry, or run ${nativeCliInstallCommands.codex}; then sign in with \`codex login\` and check again.`;
}
