import type {
  DeviceDiagnostics,
  DeviceProjection,
  DeviceRepairAction,
  DeviceRepairResult,
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
): Promise<NativeAccountInspection> {
  return request(
    "POST",
    `${devicePath(deviceId)}/accounts/${runtime}/inspect`,
    { body: { source } },
  );
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
