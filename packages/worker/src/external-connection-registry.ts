/**
 * Registering device-owned external connections (./external-connection.ts).
 * A gateway's own installer calls `foundry-worker connection add`; the
 * Devices page may check or remove an entry. Foundry never installs helpers.
 * Only `connectionType: "external"` entries are ever written or removed here;
 * every other profile in the file is kept exactly as it is.
 */
import {
  externalConnectionAvailable,
  type ExternalConnectionConfig,
} from "./external-connection.js";
import {
  configuredAgentProfiles,
  deviceAgentProfilesPath,
  profileID,
  readAgentProfilesFile,
  type AgentProfileLocalConfig,
} from "./profiles.js";
import {
  currentProviderCheck,
  providerChecksPath,
  readProviderChecks,
} from "./provider-check-state.js";
import { writeJSON } from "./storage.js";
import { safeID } from "./utils.js";

export interface ExternalConnectionInput {
  id: string;
  label: string;
  executable: string;
  args?: string[];
  identity: string;
  model: string;
  models?: string[];
}

export type ExternalConnectionErrorCode =
  "invalid_input" | "id_conflict" | "not_found" | "busy";

/** Exit codes are part of the installer contract (docs/external-connections.md). */
const exitCodes: Record<ExternalConnectionErrorCode, number> = {
  invalid_input: 2,
  id_conflict: 3,
  not_found: 4,
  busy: 5,
};

export class ExternalConnectionError extends Error {
  readonly code: ExternalConnectionErrorCode;
  readonly exitCode: number;
  constructor(code: ExternalConnectionErrorCode, message: string) {
    super(message);
    this.name = "ExternalConnectionError";
    this.code = code;
    this.exitCode = exitCodes[code];
  }
}

export interface ExternalConnectionSummary {
  id: string;
  label: string;
  runtime: "claude";
  model?: string;
  models: string[];
  executable: string;
  args: string[];
  identity: string;
  helperAvailable: boolean;
  check: {
    status: "unchecked" | "passed" | "failed";
    checkedAt?: string;
    message?: string;
  };
}

export interface ExternalConnectionChange {
  ok: true;
  action: "created" | "updated" | "unchanged" | "removed";
  profileId: string;
  connection?: ExternalConnectionSummary;
}

type FileShape = { profiles?: AgentProfileLocalConfig[] } & Record<
  string,
  unknown
>;

function readFile(): FileShape {
  try {
    return readAgentProfilesFile(deviceAgentProfilesPath) as FileShape;
  } catch (error) {
    throw new ExternalConnectionError(
      "invalid_input",
      `${deviceAgentProfilesPath} is not valid JSON; fix it by hand before registering a connection (${String(error)}).`,
    );
  }
}

const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;

/** The profile an input describes, validated as the runtime will use it. */
export function externalConnectionProfile(
  input: ExternalConnectionInput,
): AgentProfileLocalConfig {
  const invalid = (message: string) =>
    new ExternalConnectionError("invalid_input", message);
  const id = input.id?.trim() ?? "";
  if (!id || id.length > 64 || safeID(id) !== id)
    throw invalid(
      "The connection id must be 1-64 lowercase letters, digits or single underscores, e.g. company_connection.",
    );
  const label = input.label?.trim() ?? "";
  if (!label || label.length > 120)
    throw invalid("A label of 1-120 characters is required.");
  const model = input.model?.trim() ?? "";
  const models = [
    ...new Set([model, ...(input.models ?? []).map((item) => item.trim())]),
  ].filter(Boolean);
  if (!model || models.some((item) => !modelPattern.test(item)))
    throw invalid(
      "A default --model is required, and every model must be a plain model name.",
    );
  if (models.length > 32) throw invalid("At most 32 models are allowed.");
  const externalConnection: ExternalConnectionConfig = {
    executable: input.executable,
    ...(input.args?.length ? { args: [...input.args] } : {}),
    identity: input.identity,
  };
  if (!externalConnectionAvailable(externalConnection))
    throw invalid(
      "The helper must be an existing executable file given by absolute path, with a non-empty identity (at most 512 characters) and at most 32 literal arguments.",
    );
  return {
    id,
    label,
    runtime: "claude",
    connectionType: "external",
    model,
    models,
    externalConnection,
  };
}

/**
 * The fields registration owns; anything else a person added is kept,
 * including turning the connection off.
 */
function managed(profile: AgentProfileLocalConfig): string {
  return JSON.stringify({
    label: profile.label,
    runtime: profile.runtime,
    model: profile.model,
    models: profile.models ?? [],
    executable: profile.externalConnection?.executable,
    args: profile.externalConnection?.args ?? [],
    identity: profile.externalConnection?.identity,
  });
}

function summary(profile: AgentProfileLocalConfig): ExternalConnectionSummary {
  const id = profileID(profile);
  const check = currentProviderCheck(id, profile, []);
  return {
    id,
    label: profile.label ?? id,
    runtime: "claude",
    model: profile.model,
    models: profile.models ?? (profile.model ? [profile.model] : []),
    executable: profile.externalConnection?.executable ?? "",
    args: profile.externalConnection?.args ?? [],
    identity: profile.externalConnection?.identity ?? "",
    helperAvailable: externalConnectionAvailable(profile.externalConnection),
    check: check
      ? {
          status: check.status,
          checkedAt: check.checkedAt,
          ...(check.message ? { message: check.message } : {}),
        }
      : { status: "unchecked" },
  };
}

function refuseOtherProfile(id: string): void {
  // Built-in logins and profiles found in the native agent configuration
  // share the id space; registering over one would hide it.
  const other = configuredAgentProfiles("").find(
    (profile) => profileID(profile) === id,
  );
  if (other && other.connectionType !== "external")
    throw new ExternalConnectionError(
      "id_conflict",
      `${id} is already used by a ${other.connectionType ?? "local_login"} profile on this device; choose another id.`,
    );
}

/**
 * Adds or updates one external connection. The same input again changes
 * nothing; a changed helper, identity or model leaves the stored check
 * behind (its fingerprint no longer matches), so it reads as unchecked.
 */
export function addExternalConnection(
  input: ExternalConnectionInput,
): ExternalConnectionChange {
  const next = externalConnectionProfile(input);
  const id = next.id!;
  const file = readFile();
  const profiles = Array.isArray(file.profiles) ? file.profiles : [];
  const index = profiles.findIndex((profile) => profileID(profile) === id);
  const existing = index >= 0 ? profiles[index] : undefined;
  if (existing && existing.connectionType !== "external")
    throw new ExternalConnectionError(
      "id_conflict",
      `${id} is already used by a ${existing.connectionType ?? "local_login"} profile in ${deviceAgentProfilesPath}; choose another id.`,
    );
  if (!existing) refuseOtherProfile(id);
  if (existing && managed(existing) === managed(next))
    return {
      ok: true,
      action: "unchanged",
      profileId: id,
      connection: summary(existing),
    };
  const merged: AgentProfileLocalConfig = { ...existing, ...next };
  const updated = [...profiles];
  if (existing) updated[index] = merged;
  else updated.push(merged);
  writeJSON(deviceAgentProfilesPath, { ...file, profiles: updated });
  return {
    ok: true,
    action: existing ? "updated" : "created",
    profileId: id,
    connection: summary(merged),
  };
}

/** Removes one external connection and its check result, nothing else. */
export function removeExternalConnection(id: string): ExternalConnectionChange {
  if (checking.has(id))
    throw new ExternalConnectionError(
      "busy",
      `${id} is being checked; remove it after the check finishes.`,
    );
  const file = readFile();
  const profiles = Array.isArray(file.profiles) ? file.profiles : [];
  const matches = profiles.filter((profile) => profileID(profile) === id);
  if (!matches.length)
    throw new ExternalConnectionError(
      "not_found",
      `No external connection ${id} is registered on this device.`,
    );
  if (matches.some((profile) => profile.connectionType !== "external"))
    throw new ExternalConnectionError(
      "id_conflict",
      `${id} is not an external connection; it is left unchanged.`,
    );
  writeJSON(deviceAgentProfilesPath, {
    ...file,
    profiles: profiles.filter((profile) => profileID(profile) !== id),
  });
  forgetCheck(id);
  return { ok: true, action: "removed", profileId: id };
}

function forgetCheck(id: string) {
  const checks = readProviderChecks();
  if (!(id in checks)) return;
  delete checks[id];
  writeJSON(providerChecksPath(), checks);
}

const checking = new Set<string>();

/**
 * Runs the explicit check of one connection. A second check of it meanwhile
 * is refused, and so is removing it in this process. A removal from another
 * process (the CLI) during the check drops the result it leaves behind.
 */
export async function withExternalCheck<T>(
  id: string,
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  if (checking.has(id))
    throw new ExternalConnectionError(
      "busy",
      `${label} is already being checked.`,
    );
  checking.add(id);
  try {
    return await run();
  } finally {
    checking.delete(id);
    const profiles = readFile().profiles;
    if (
      !(Array.isArray(profiles) ? profiles : []).some(
        (profile) => profileID(profile) === id,
      )
    )
      forgetCheck(id);
  }
}

export function listExternalConnections(): ExternalConnectionSummary[] {
  const profiles = readFile().profiles;
  return (Array.isArray(profiles) ? profiles : [])
    .filter((profile) => profile.connectionType === "external")
    .map(summary);
}

/** The registered external connection with this id, for an explicit check. */
export function registeredExternalConnection(
  id: string,
): AgentProfileLocalConfig {
  const profile = configuredAgentProfiles("").find(
    (item) => profileID(item) === id,
  );
  if (!profile || profile.connectionType !== "external")
    throw new ExternalConnectionError(
      "not_found",
      `No external connection ${id} is registered on this device.`,
    );
  return profile;
}
