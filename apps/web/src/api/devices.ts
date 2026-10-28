import type {
  AgentProfileCheck,
  DeviceFileRead,
  DeviceDiagnostics,
  DevicePairingStatus,
  DeviceProjection,
  DeviceRepairAction,
  DeviceRepairResult,
  DeviceRunnerDetail,
  DeviceRunnerTurn,
  NativeAccountInspection,
  NativeCliInstallResult,
  WorkerRelease,
} from "@bd777/foundry-protocol";
import { apiBaseUrl } from "../lib/api-base-url";
import { forgetWorkspacePreloads } from "./foundry-data";
import { request } from "./http";

const devicePath = (deviceId: string) =>
  `/api/devices/${encodeURIComponent(deviceId)}`;

/**
 * Soft-remove a device: the server tombstones it (history and credentials are
 * kept) and drops its live daemon connection so it cannot reappear.
 */
export async function removeDevice(
  deviceId: string,
): Promise<DeviceProjection> {
  const device = await request<DeviceProjection>(
    "DELETE",
    devicePath(deviceId),
  );
  forgetWorkspacePreloads();
  return device;
}

/** Gives a device the name people see; its hostname stays in `system`. */
export function renameDevice(
  deviceId: string,
  name: string,
): Promise<DeviceProjection> {
  return request("PATCH", devicePath(deviceId), { body: { name } });
}

/** Asks a device's worker for a report on itself (no model requests). */
export function runDeviceDiagnostics(
  deviceId: string,
): Promise<DeviceDiagnostics> {
  return request("POST", `${devicePath(deviceId)}/diagnostics`, { body: {} });
}

/** Runs one repair the person chose on a device's worker. */
export function runDeviceRepair(
  deviceId: string,
  action: DeviceRepairAction,
): Promise<DeviceRepairResult> {
  return request("POST", `${devicePath(deviceId)}/repairs`, {
    body: { action },
  });
}

/** Asks a device's worker to update itself to this server's version. */
export function updateDeviceWorker(
  deviceId: string,
): Promise<{ log?: string }> {
  return request("POST", `${devicePath(deviceId)}/worker/update`, {
    body: {},
  });
}

/** The device's session runner and the turns a "switch now" would stop. */
export function readDeviceRunner(
  deviceId: string,
): Promise<DeviceRunnerDetail> {
  return request("GET", `${devicePath(deviceId)}/worker/runner`);
}

/**
 * The owner's "switch now": stops exactly the reviewed turns (their sessions
 * stay) and switches the runner; refused when another turn started since.
 */
export function switchDeviceRunner(
  deviceId: string,
  turns: DeviceRunnerTurn[],
): Promise<{ switched?: boolean }> {
  return request("POST", `${devicePath(deviceId)}/worker/runner/switch`, {
    body: { turns },
  });
}

/** Run the official installer for Claude Code or Codex on a device. */
export function installDeviceCli(
  deviceId: string,
  runtime: "claude" | "codex",
): Promise<NativeCliInstallResult> {
  return request(
    "POST",
    `${devicePath(deviceId)}/accounts/${runtime}/install`,
    { body: {} },
  );
}

export function inspectDeviceAccount(
  deviceId: string,
  runtime: "claude" | "codex",
  source?: string,
  selection?: {
    profileId: string;
    runtimeGeneration: string;
    refresh?: boolean;
  },
): Promise<NativeAccountInspection> {
  return request(
    "POST",
    `${devicePath(deviceId)}/accounts/${runtime}/inspect`,
    { body: { source, ...selection } },
  );
}

function externalConnectionPath(deviceId: string, profileId: string): string {
  return `${devicePath(deviceId)}/external-connections/${encodeURIComponent(profileId)}`;
}

/**
 * Explicitly check one external connection on its device: a short native
 * conversation that uses model quota. Never called automatically.
 */
export function checkExternalConnection(
  deviceId: string,
  profileId: string,
): Promise<AgentProfileCheck> {
  return request(
    "POST",
    `${externalConnectionPath(deviceId, profileId)}/check`,
    { body: {} },
  );
}

/** Remove one external connection from its device; nothing else changes. */
export function removeExternalConnection(
  deviceId: string,
  profileId: string,
): Promise<{ removed: boolean; profileId: string }> {
  return request("DELETE", externalConnectionPath(deviceId, profileId));
}

/** The server URL a worker on another machine should use. */
export function workerServerURL(): string {
  return apiBaseUrl || window.location.origin;
}

/** Where this server's worker comes from: its own packages, or npm. */
export function getWorkerRelease(): Promise<WorkerRelease> {
  return request("GET", "/api/worker/release", { notifyAuthRequired: false });
}

export function createDevicePairingToken(): Promise<{
  token: string;
  expiresAt: string;
}> {
  return request("POST", "/api/devices/pairing-tokens", {
    body: {},
    notifyAuthRequired: false,
  });
}

/**
 * Where the caller's pairing token stands: "needs_consent" when its worker
 * runs under a system account another person's device already uses.
 */
export function devicePairingStatus(
  token: string,
): Promise<DevicePairingStatus> {
  return request("POST", "/api/devices/pairing-tokens/status", {
    body: { token },
  });
}

/** Continue (share that system account) or cancel a pairing waiting on it. */
export function setDevicePairingConsent(
  token: string,
  accept: boolean,
): Promise<DevicePairingStatus> {
  return request("POST", "/api/devices/pairing-tokens/consent", {
    body: { token, accept },
  });
}

/** The device's owner read that someone else now shares its system account. */
export function dismissSystemAccountNotice(deviceId: string): Promise<void> {
  return request(
    "POST",
    `${devicePath(deviceId)}/system-account-notice/dismiss`,
    { body: {} },
  );
}

/**
 * Sent with every device file request: the server refuses one without it,
 * so a page of another site cannot make the browser open device files.
 */
export const deviceFileIntentHeaders = { "X-Foundry-Intent": "device-file" };

/**
 * A file of the device outside its workspaces, for its owner: what it is
 * and its start (`read`, none for a secret), or its start even for a
 * secret (`reveal`; `copy` when it goes to the clipboard).
 */
export function readDeviceFile(
  deviceId: string,
  path: string,
  mode: "read" | "reveal",
  options: { purpose?: "copy"; signal?: AbortSignal } = {},
): Promise<DeviceFileRead> {
  const params = new URLSearchParams({ path, mode });
  if (options.purpose) params.set("purpose", options.purpose);
  return request("GET", `${devicePath(deviceId)}/files?${params}`, {
    headers: deviceFileIntentHeaders,
    signal: options.signal,
  });
}

/** Turns opening the device's files outside workspaces from chats on or off. */
export function setDeviceOutsideFiles(
  deviceId: string,
  enabled: boolean,
): Promise<{ enabled: boolean }> {
  return request("PUT", `${devicePath(deviceId)}/outside-files`, {
    body: { enabled },
  });
}
