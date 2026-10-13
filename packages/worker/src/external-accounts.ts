import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentSession,
  ExternalAccountMaterial,
} from "@bd777/foundry-protocol";
import { readDaemonConfig } from "./config.js";
import {
  startFeishuGatewayForwarder,
  type FeishuGatewayForwarder,
} from "./feishu-gateway-forwarder.js";
import { findCommand, managedToolsBin } from "./managed-tools.js";
import { foundryStatePath } from "./state-root.js";
import { registerKnownSecret } from "./secret-redaction.js";
import { isUtilitySession } from "./utils.js";
import { isVerificationSession } from "./session-roles.js";

/**
 * External accounts on the device (docs: External accounts design §5.5).
 *
 * No Feishu credential ever reaches this device. run_session carries, for
 * each account a session may act as, the app id and opaque handles from
 * the server's Feishu gateway: in place of the app secret, of the user
 * access token and of the user refresh token. The worker writes them into a Foundry-managed
 * feishu-cli profile of the session's own, through feishu-cli's documented
 * configuration (`~/.feishu-cli/profiles/<name>/config.yaml` with app_id,
 * app_secret and base_url; token.json; FEISHU_PROFILE), with base_url on
 * this worker's loopback forwarder (feishu-gateway-forwarder.ts), which
 * adds the device credential and sends everything to the gateway. The
 * gateway swaps the handles for the real tokens, answers feishu-cli's
 * refresh with the same stand-ins (the server alone refreshes the real
 * login) and refuses them once the session ends. The profile is removed when the
 * session's run ends; profiles a crashed worker left behind are listed in a
 * manifest under the state root and reaped at the next start.
 */

const feishuTool = "feishu-cli";
const profileNamePattern = /^foundry-[A-Za-z0-9_-]{1,56}$/;

/**
 * The feishu-cli versions the gateway contract was verified against
 * (TestFeishuCLIContractThroughTheGateway in
 * apps/server/internal/httpapi/external_accounts_cli_contract_test.go). Another
 * version may route a call differently; the session is told.
 */
export const verifiedFeishuCliVersions = ["1.41.0"];

export interface ExternalAccountsOptions {
  /** The session's HOME: where feishu-cli looks for its profiles. */
  home?: string;
  /** Lists the profiles this worker wrote, for reaping after a crash. */
  manifestPath?: string;
  /** The Foundry server, which the forwarder sends feishu-cli's calls to. */
  serverURL?: string;
  /** The loopback forwarder for a gateway path; started on first use. */
  forwarder?: (
    gatewayPath: string,
  ) => Promise<Pick<FeishuGatewayForwarder, "baseURL">>;
  /** The installed feishu-cli's version ("1.41.0"); undefined if unknown. */
  feishuCliVersion?: () => string | undefined;
  log?: (message: string) => void;
}

const liveProfiles = new Set<string>();
const environmentBySession = new Map<string, NodeJS.ProcessEnv>();
const notesBySession = new Map<string, string>();
const forwarders = new Map<string, Promise<FeishuGatewayForwarder>>();

/** One forwarder per server and gateway path for this worker's life. */
function sharedForwarder(
  serverURL: string,
  gatewayPath: string,
  log: (message: string) => void,
): Promise<FeishuGatewayForwarder> {
  const key = `${serverURL}\n${gatewayPath}`;
  let started = forwarders.get(key);
  if (!started) {
    started = startFeishuGatewayForwarder({
      serverURL,
      gatewayPath,
      credential: () => readDaemonConfig()?.deviceCredential?.trim(),
      log,
    });
    started.catch(() => forwarders.delete(key));
    forwarders.set(key, started);
  }
  return started;
}

let cachedVersion:
  { path: string; modified: number; version?: string } | undefined;

/** The version of the feishu-cli sessions find first on PATH. */
export function installedFeishuCliVersion(): string | undefined {
  const managed = join(managedToolsBin(), feishuTool);
  const path = existsSync(managed) ? managed : findCommand(feishuTool);
  if (!path) return undefined;
  let modified = 0;
  try {
    modified = statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
  if (cachedVersion?.path === path && cachedVersion.modified === modified)
    return cachedVersion.version;
  let version: string | undefined;
  try {
    const output = execFileSync(path, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    version = /v?(\d+\.\d+\.\d+)/.exec(output)?.[1];
  } catch {
    version = undefined;
  }
  cachedVersion = { path, modified, version };
  return version;
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

function configYaml(
  material: ExternalAccountMaterial,
  appHandle: string,
  baseURL: string,
): string {
  return [
    "# Written by Foundry for one session; removed when the session's run ends.",
    "# app_secret and the token are Foundry stand-ins, not Feishu credentials:",
    "# calls go through Foundry (base_url), which holds the real ones.",
    `app_id: ${yamlString(material.clientId)}`,
    `app_secret: ${yamlString(appHandle)}`,
    `base_url: ${yamlString(baseURL)}`,
    "",
  ].join("\n");
}

function tokenJson(
  material: ExternalAccountMaterial,
  userHandle: string,
  refreshHandle: string | undefined,
): string {
  // The refresh stand-in keeps `auth status` healthy and lets feishu-cli
  // refresh through the gateway; no expiry: the gateway decides.
  return `${JSON.stringify(
    {
      access_token: userHandle,
      ...(refreshHandle ? { refresh_token: refreshHandle } : {}),
      token_type: "Bearer",
      expires_at: localTimestamp(material.expiresAt),
      scope: material.scope ?? "",
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

export interface MaterializedAccounts {
  /** Names of the profiles written for the session. */
  profiles: string[];
  release(): void;
}

const nothing: MaterializedAccounts = { profiles: [], release: () => {} };

function usableMaterial(material: ExternalAccountMaterial): boolean {
  const gateway = material.gateway;
  return (
    material.tool === feishuTool &&
    Boolean(material.clientId) &&
    Boolean(gateway?.path?.startsWith("/")) &&
    Boolean(gateway?.appHandle) &&
    Boolean(gateway?.userHandle) &&
    profileNamePattern.test(material.profileName)
  );
}

/**
 * Writes the session's accounts into its own feishu-cli profiles and
 * selects the first for its processes. Returns the release to call when the
 * session's run ends, whatever the outcome.
 */
export async function materializeSessionAccounts(
  session: AgentSession,
  materials: ExternalAccountMaterial[] | undefined,
  options: ExternalAccountsOptions = {},
): Promise<MaterializedAccounts> {
  const usable = (materials ?? []).filter(usableMaterial);
  if (
    !session.id ||
    usable.length === 0 ||
    !sessionTakesExternalAccounts(session)
  )
    return nothing;
  const home = options.home ?? homedir();
  const manifestPath =
    options.manifestPath ?? foundryStatePath("external-account-profiles.json");
  const log = options.log ?? ((message) => console.log(message));
  const forwarder =
    options.forwarder ??
    ((gatewayPath: string) => {
      if (!options.serverURL)
        throw new Error("no Foundry server to forward to");
      return sharedForwarder(options.serverURL, gatewayPath, log);
    });
  const written: Array<{
    directory: string;
    material: ExternalAccountMaterial;
  }> = [];
  for (const material of usable) {
    const gateway = material.gateway!;
    registerKnownSecret(gateway.appHandle);
    registerKnownSecret(gateway.userHandle);
    if (gateway.refreshHandle) registerKnownSecret(gateway.refreshHandle);
    const directory = managedProfileDirectory(home, material.profileName);
    if (!directory) continue;
    try {
      const { baseURL } = await forwarder(gateway.path);
      updateManifest(manifestPath, (profiles) => [...profiles, directory]);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writePrivateFile(
        join(directory, "config.yaml"),
        configYaml(material, gateway.appHandle, baseURL),
      );
      writePrivateFile(
        join(directory, "token.json"),
        tokenJson(material, gateway.userHandle, gateway.refreshHandle),
      );
    } catch (error) {
      log(
        `External account ${material.accountId}: could not set up its feishu-cli profile (${error instanceof Error ? error.message : String(error)}).`,
      );
      rmSync(directory, { recursive: true, force: true });
      continue;
    }
    liveProfiles.add(directory);
    written.push({ directory, material });
  }
  const [selected] = written;
  if (!selected) return nothing;
  environmentBySession.set(session.id, {
    FEISHU_PROFILE: selected.material.profileName,
  });
  const version = (options.feishuCliVersion ?? installedFeishuCliVersion)();
  if (version && !verifiedFeishuCliVersions.includes(version))
    log(
      `feishu-cli ${version} on this device is not a version Foundry verified its Feishu gateway with (${verifiedFeishuCliVersions.join(", ")}).`,
    );
  notesBySession.set(
    session.id,
    accountNote(
      written.map((entry) => entry.material),
      version,
    ),
  );
  let released = false;
  return {
    profiles: written.map((entry) => entry.material.profileName),
    release: () => {
      if (released) return;
      released = true;
      environmentBySession.delete(session.id);
      notesBySession.delete(session.id);
      for (const entry of written)
        removeProfile(
          entry.directory,
          manifestPath,
          entry.material.accountId,
          log,
        );
    },
  };
}

function removeProfile(
  directory: string,
  manifestPath: string,
  accountId: string,
  log: (message: string) => void,
): void {
  liveProfiles.delete(directory);
  try {
    rmSync(directory, { recursive: true, force: true });
    updateManifest(manifestPath, (profiles) =>
      profiles.filter((profile) => profile !== directory),
    );
  } catch (error) {
    log(
      `External account ${accountId}: could not remove its feishu-cli profile (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

function accountNote(
  materials: ExternalAccountMaterial[],
  version: string | undefined,
): string {
  const [selected, ...others] = materials.map((material) => {
    const who = material.displayName
      ? `${material.label} (${material.displayName})`
      : material.label;
    return `${who}: feishu-cli profile ${material.profileName}`;
  });
  const lines = [
    `- Feishu account Foundry connected for this session: ${selected}, already selected by FEISHU_PROFILE${others.length ? `; also available with --profile: ${others.join("; ")}` : ""}. feishu-cli reaches Feishu through Foundry, as the person or as the app's bot: this device holds no app secret or token (the profile's app_secret and token are stand-ins that stop working when this session ends). Do not run feishu-cli auth login, auth logout or profile use. If it lacks a scope or the login expired, ask the person to re-authorize it in Foundry (Connectors → Feishu).`,
    "- Not available through Foundry: `feishu-cli auth token --as bot`, `feishu-cli doctor`'s token check and `feishu-cli markdown fetch --as bot` ask Feishu's accounts server for a bot token directly, which a stand-in cannot pass; use the bot through other commands, or markdown fetch as the user. A call Foundry refuses says why in its message (\"Foundry gateway: …\").",
  ];
  if (version && !verifiedFeishuCliVersions.includes(version))
    lines.push(
      `- feishu-cli on this device is ${version}; Foundry verified its Feishu gateway with ${verifiedFeishuCliVersions.join(", ")}. If a Feishu command fails in an unexpected way, tell the person.`,
    );
  return lines.join("\n");
}

/** FEISHU_PROFILE for a session that has an account; empty otherwise. */
export function sessionExternalAccountEnvironment(
  sessionId: string | undefined,
): NodeJS.ProcessEnv {
  return (sessionId && environmentBySession.get(sessionId)) || {};
}

/** The device-notes lines naming a session's accounts (never a handle). */
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
    (directory) => !liveProfiles.has(directory),
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
        profiles.filter((profile) => liveProfiles.has(profile)),
      );
    } catch {
      // The next start reads the same list and tries again.
    }
  return reaped;
}
