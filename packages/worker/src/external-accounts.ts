import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentSession,
  ExternalAccountMaterial,
  ExternalAccountToken,
} from "@bd777/foundry-protocol";
import { foundryStatePath } from "./state-root.js";
import { registerKnownSecret } from "./secret-redaction.js";
import { postJSON } from "./transport.js";
import { isUtilitySession } from "./utils.js";
import { isVerificationSession } from "./session-roles.js";

/**
 * External accounts on the device (docs: External accounts design §5.5).
 *
 * run_session carries, for each account a session may act as, a minted
 * access token and the app credentials feishu-cli insists on — never the
 * refresh token, which only the server holds and spends. The worker writes
 * them into a Foundry-managed feishu-cli profile under the session's HOME
 * (`~/.feishu-cli/profiles/foundry-<id>/`, the layout feishu-cli reads:
 * config.yaml with app_id/app_secret/base_url, token.json with
 * access_token/token_type/expires_at/scope/app_id), selects it with
 * FEISHU_PROFILE, asks the server for a new token before the current one
 * expires while a session still uses it, and removes the profile when the
 * last session using it ends. Profiles a crashed worker left behind are
 * listed in a manifest under the state root and reaped at the next start.
 * Nothing here logs a token or a secret; both are registered for transcript
 * redaction.
 */

const feishuTool = "feishu-cli";
const profileNamePattern = /^foundry-[A-Za-z0-9_-]{1,56}$/;
/** Re-mint this long before the access token expires. */
const defaultRefreshLeadMs = 15 * 60_000;
/** A failed re-mint is tried again after this long. */
const retryDelayMs = 60_000;
const minimumDelayMs = 5_000;

export interface ExternalAccountsOptions {
  /** The session's HOME: where feishu-cli looks for its profiles. */
  home?: string;
  /** Lists the profiles this worker wrote, for reaping after a crash. */
  manifestPath?: string;
  /** Asks the server for a fresh token for a session that still runs. */
  mint?: (
    accountId: string,
    sessionId: string,
  ) => Promise<ExternalAccountToken>;
  now?: () => number;
  refreshLeadMs?: number;
  log?: (message: string) => void;
}

interface HeldProfile {
  directory: string;
  accountId: string;
  material: ExternalAccountMaterial;
  sessions: Set<string>;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
  stopped: boolean;
  options: ResolvedOptions;
}

type ResolvedOptions = Required<
  Pick<ExternalAccountsOptions, "home" | "manifestPath" | "now" | "log">
> &
  Pick<ExternalAccountsOptions, "mint" | "refreshLeadMs">;

const heldProfiles = new Map<string, HeldProfile>();
const environmentBySession = new Map<string, NodeJS.ProcessEnv>();
const notesBySession = new Map<string, string>();

function resolveOptions(options: ExternalAccountsOptions): ResolvedOptions {
  return {
    home: options.home ?? homedir(),
    manifestPath:
      options.manifestPath ??
      foundryStatePath("external-account-profiles.json"),
    now: options.now ?? Date.now,
    log: options.log ?? ((message) => console.log(message)),
    mint: options.mint,
    refreshLeadMs: options.refreshLeadMs,
  };
}

/** The server's mint route, authenticated as this device. */
export function serverMint(
  serverURL: string,
): (accountId: string, sessionId: string) => Promise<ExternalAccountToken> {
  return async (accountId, sessionId) => {
    const token = await postJSON<ExternalAccountToken>(
      serverURL,
      `/api/external-accounts/${encodeURIComponent(accountId)}/mint`,
      { sessionId },
    );
    if (!token?.accessToken) throw new Error("the server minted no token");
    return token;
  };
}

function profilesRoot(home: string): string {
  return resolve(home, ".feishu-cli", "profiles");
}

/** The managed profile directory for a name, or undefined if it is not one. */
function managedProfileDirectory(
  home: string,
  name: string,
): string | undefined {
  if (!profileNamePattern.test(name)) return undefined;
  return join(profilesRoot(home), name);
}

function isManagedProfileDirectory(directory: string): boolean {
  const name = directory.split(sep).pop() ?? "";
  return (
    profileNamePattern.test(name) &&
    dirname(directory).endsWith(`${sep}.feishu-cli${sep}profiles`)
  );
}

/** Whether a session runs in the person's HOME and may get accounts. */
export function sessionTakesExternalAccounts(session: AgentSession): boolean {
  return (
    !session.issueId &&
    session.role !== "issue_execution" &&
    session.role !== "issue_clarification" &&
    !isUtilitySession(session) &&
    !isVerificationSession(session)
  );
}

function writePrivateFile(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function configYaml(material: ExternalAccountMaterial): string {
  return [
    "# Written by Foundry for one external account; removed when no Foundry session uses it.",
    "# Do not edit: Foundry rewrites it. Re-authorize in Foundry, not with feishu-cli auth login.",
    `app_id: ${yamlString(material.clientId)}`,
    `app_secret: ${yamlString(material.clientSecret ?? "")}`,
    ...(material.baseUrl ? [`base_url: ${yamlString(material.baseUrl)}`] : []),
    "",
  ].join("\n");
}

function tokenJson(
  material: Pick<ExternalAccountMaterial, "clientId">,
  token: Pick<
    ExternalAccountToken,
    "accessToken" | "tokenType" | "expiresAt" | "scope"
  >,
): string {
  // No refresh_token: feishu-cli then uses the access token as is and
  // reports it expired instead of spending a refresh token it lacks.
  return `${JSON.stringify(
    {
      access_token: token.accessToken,
      token_type: token.tokenType || "Bearer",
      expires_at: localTimestamp(token.expiresAt),
      scope: token.scope ?? "",
      app_id: material.clientId,
    },
    null,
    2,
  )}\n`;
}

/**
 * An RFC 3339 time in this machine's offset, the way feishu-cli writes its
 * own token.json (Go's time.Time in local time); `auth status` shows a UTC
 * one with the local offset label, which reads as hours off.
 */
function localTimestamp(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  const offset = -at.getTimezoneOffset();
  const local = new Date(at.getTime() + offset * 60_000);
  const sign = offset >= 0 ? "+" : "-";
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${local.toISOString().slice(0, 19)}${sign}${hours}:${minutes}`;
}

function readManifest(path: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      profiles?: unknown;
    };
    return Array.isArray(parsed.profiles)
      ? parsed.profiles.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
  } catch {
    return [];
  }
}

function writeManifest(path: string, profiles: string[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFile(
    path,
    `${JSON.stringify({ profiles: [...new Set(profiles)].sort() }, null, 2)}\n`,
  );
}

function updateManifest(
  path: string,
  change: (profiles: string[]) => string[],
): void {
  writeManifest(path, change(readManifest(path)));
}

function writeProfile(held: HeldProfile): void {
  mkdirSync(held.directory, { recursive: true, mode: 0o700 });
  writePrivateFile(
    join(held.directory, "config.yaml"),
    configYaml(held.material),
  );
  writePrivateFile(
    join(held.directory, "token.json"),
    tokenJson(held.material, held.material),
  );
}

function scheduleRefresh(held: HeldProfile): void {
  if (held.timer) clearTimeout(held.timer);
  held.timer = undefined;
  const { mint, now } = held.options;
  if (!mint || held.stopped || !Number.isFinite(held.expiresAt)) return;
  const lead = held.options.refreshLeadMs ?? defaultRefreshLeadMs;
  arm(held, Math.max(minimumDelayMs, held.expiresAt - lead - now()));
}

function arm(held: HeldProfile, delay: number): void {
  held.timer = setTimeout(() => void refresh(held), delay);
  held.timer.unref?.();
}

async function refresh(held: HeldProfile): Promise<void> {
  held.timer = undefined;
  const sessionId = held.sessions.values().next().value as string | undefined;
  const { mint, log, now } = held.options;
  if (!sessionId || !mint || heldProfiles.get(held.directory) !== held) return;
  try {
    const token = await mint(held.accountId, sessionId);
    if (heldProfiles.get(held.directory) !== held) return;
    registerKnownSecret(token.accessToken);
    held.material = {
      ...held.material,
      accessToken: token.accessToken,
      tokenType: token.tokenType,
      expiresAt: token.expiresAt,
      scope: token.scope ?? held.material.scope,
    };
    held.expiresAt = Date.parse(token.expiresAt);
    writePrivateFile(
      join(held.directory, "token.json"),
      tokenJson(held.material, token),
    );
    log(
      `External account ${held.accountId}: renewed its feishu-cli token until ${token.expiresAt}.`,
    );
    scheduleRefresh(held);
  } catch (error) {
    const status = /returned (\d{3})/.exec(
      error instanceof Error ? error.message : "",
    )?.[1];
    // Refused for good (gone, no longer permitted, revoked or needs re-auth):
    // the session keeps the token it has until it expires.
    if (status === "403" || status === "404" || status === "409") {
      held.stopped = true;
      log(
        `External account ${held.accountId}: the server no longer renews it (HTTP ${status}); its token lapses at ${held.material.expiresAt}.`,
      );
      return;
    }
    log(
      `External account ${held.accountId}: could not renew its token (${status ? `HTTP ${status}` : "no answer"}); trying again.`,
    );
    if (now() < held.expiresAt) arm(held, retryDelayMs);
  }
}

export interface MaterializedAccounts {
  /** Names of the profiles written for the session. */
  profiles: string[];
  release(): void;
}

/**
 * Writes the session's accounts into managed tool profiles and selects the
 * first for its processes. Returns the release to call when the session's
 * run ends, whatever the outcome.
 */
export function materializeSessionAccounts(
  session: AgentSession,
  materials: ExternalAccountMaterial[] | undefined,
  options: ExternalAccountsOptions = {},
): MaterializedAccounts {
  const usable = (materials ?? []).filter(
    (material) =>
      material.tool === feishuTool &&
      Boolean(material.accessToken) &&
      profileNamePattern.test(material.profileName),
  );
  if (
    !session.id ||
    usable.length === 0 ||
    !sessionTakesExternalAccounts(session)
  )
    return { profiles: [], release: () => {} };
  const resolved = resolveOptions(options);
  const written: HeldProfile[] = [];
  for (const material of usable) {
    registerKnownSecret(material.accessToken);
    registerKnownSecret(material.clientSecret);
    const directory = managedProfileDirectory(
      resolved.home,
      material.profileName,
    );
    if (!directory) continue;
    const existing = heldProfiles.get(directory);
    const held: HeldProfile = existing ?? {
      directory,
      accountId: material.accountId,
      material,
      sessions: new Set(),
      expiresAt: Date.parse(material.expiresAt),
      stopped: false,
      options: resolved,
    };
    held.material = material;
    held.expiresAt = Date.parse(material.expiresAt);
    held.stopped = false;
    try {
      updateManifest(resolved.manifestPath, (profiles) => [
        ...profiles,
        directory,
      ]);
      writeProfile(held);
    } catch (error) {
      resolved.log(
        `External account ${material.accountId}: could not write its feishu-cli profile (${error instanceof Error ? error.message : String(error)}).`,
      );
      continue;
    }
    held.sessions.add(session.id);
    heldProfiles.set(directory, held);
    scheduleRefresh(held);
    written.push(held);
  }
  const [selected] = written;
  if (!selected) return { profiles: [], release: () => {} };
  environmentBySession.set(session.id, {
    FEISHU_PROFILE: selected.material.profileName,
  });
  notesBySession.set(session.id, accountNote(written));
  let released = false;
  return {
    profiles: written.map((held) => held.material.profileName),
    release: () => {
      if (released) return;
      released = true;
      environmentBySession.delete(session.id);
      notesBySession.delete(session.id);
      for (const held of written) releaseProfile(held, session.id);
    },
  };
}

function releaseProfile(held: HeldProfile, sessionId: string): void {
  held.sessions.delete(sessionId);
  if (held.sessions.size > 0 || heldProfiles.get(held.directory) !== held)
    return;
  heldProfiles.delete(held.directory);
  if (held.timer) clearTimeout(held.timer);
  held.timer = undefined;
  try {
    rmSync(held.directory, { recursive: true, force: true });
    updateManifest(held.options.manifestPath, (profiles) =>
      profiles.filter((profile) => profile !== held.directory),
    );
  } catch (error) {
    held.options.log(
      `External account ${held.accountId}: could not remove its feishu-cli profile (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

function accountNote(held: HeldProfile[]): string {
  const [selected, ...others] = held.map((entry) => {
    const who = entry.material.displayName
      ? `${entry.material.label} (${entry.material.displayName})`
      : entry.material.label;
    return `${who}: feishu-cli profile ${entry.material.profileName}`;
  });
  return `- Feishu account Foundry connected for this session: ${selected}, already selected by FEISHU_PROFILE${others.length ? `; also available with --profile: ${others.join("; ")}` : ""}. Use it as is: do not run feishu-cli auth login, auth logout or profile use. If it lacks a scope or has expired, ask the person to re-authorize it in Foundry (External accounts).`;
}

/** FEISHU_PROFILE for a session that has an account; empty otherwise. */
export function sessionExternalAccountEnvironment(
  sessionId: string | undefined,
): NodeJS.ProcessEnv {
  return (sessionId && environmentBySession.get(sessionId)) || {};
}

/** The device-notes line naming a session's accounts (never a secret). */
export function sessionExternalAccountNote(
  sessionId: string | undefined,
): string {
  return (sessionId && notesBySession.get(sessionId)) || "";
}

/**
 * Removes the profiles an earlier worker process wrote and never removed
 * (it crashed or was killed mid-session). Only directories the manifest
 * lists, and only Foundry-managed profile names, are touched.
 */
export function reapExternalAccountProfiles(
  options: Pick<ExternalAccountsOptions, "manifestPath" | "log"> = {},
): string[] {
  const manifestPath =
    options.manifestPath ?? foundryStatePath("external-account-profiles.json");
  const listed = readManifest(manifestPath).filter(
    (directory) => !heldProfiles.has(directory),
  );
  const reaped: string[] = [];
  for (const directory of listed) {
    if (!isManagedProfileDirectory(directory)) continue;
    try {
      if (existsSync(directory)) {
        rmSync(directory, { recursive: true, force: true });
        reaped.push(directory);
      }
    } catch (error) {
      options.log?.(
        `Could not remove the leftover feishu-cli profile ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (listed.length > 0)
    try {
      updateManifest(manifestPath, (profiles) =>
        profiles.filter((profile) => heldProfiles.has(profile)),
      );
    } catch {
      // The next start reads the same list and tries again.
    }
  return reaped;
}
