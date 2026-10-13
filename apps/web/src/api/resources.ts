import type {
  DeviceResource,
  ResourceBackendInstallResult,
  ResourceLease,
  ResourceList,
  ResourceOperationList,
  ResourceSourceSettings,
  ResourceTypeId,
} from "@bd777/foundry-protocol";
import { request, type RequestOptions } from "./http";

const devicePath = (deviceId: string) =>
  `/api/devices/${encodeURIComponent(deviceId)}`;
const resourcePath = (resourceId: string) =>
  `/api/resources/${encodeURIComponent(resourceId)}`;

export interface RefreshedDeviceResources {
  resources: DeviceResource[];
  /** System settings panes the device opened for its person. */
  opened: string[];
}

/**
 * Has a device detect its resources again; with requestAccess, it first asks
 * the person at the device for access to that resource.
 */
export function refreshDeviceResources(
  deviceId: string,
  requestAccess?: string,
): Promise<RefreshedDeviceResources> {
  return request("POST", `${devicePath(deviceId)}/resources/refresh`, {
    body: requestAccess ? { requestAccess } : {},
  });
}

export interface ResourceListQuery {
  type?: ResourceTypeId;
  device?: string;
  /** Lists instances no longer reported too. */
  includeGone?: boolean;
}

/** The resource inventory: instances (by type, source, name) and sources. */
export function listResources(
  query: ResourceListQuery = {},
  options: RequestOptions = {},
): Promise<ResourceList> {
  const params = new URLSearchParams();
  if (query.type) params.set("type", query.type);
  if (query.device) params.set("device", query.device);
  if (query.includeGone) params.set("includeGone", "1");
  const search = params.toString();
  return request("GET", `/api/resources${search ? `?${search}` : ""}`, options);
}

/** Ends the lease a session holds on an instance; its screen is reset. */
export function releaseResource(
  resourceId: string,
): Promise<{ lease: ResourceLease }> {
  return request("POST", `${resourcePath(resourceId)}/release`, { body: {} });
}

/** "Let it finish": postpones once the preemption a waiting session caused. */
export function extendResourceLease(
  resourceId: string,
): Promise<{ lease: ResourceLease }> {
  return request("POST", `${resourcePath(resourceId)}/extend`, { body: {} });
}

/** Ends every lease on a device's resources and resets them. */
export function stopDeviceResources(
  deviceId: string,
): Promise<{ released: number }> {
  return request("POST", `${devicePath(deviceId)}/resources/stop`, {
    body: {},
  });
}

export interface SavedResourceSourceSettings extends ResourceSourceSettings {
  /**
   * The device enforces it already; false while it is offline or its
   * worker is too old (it gets the setting when it reconnects).
   */
  applied: boolean;
}

/**
 * Saves what a device's owner allows sessions to do with its resources.
 * Turning remote commands off ends any lease on its compute resource.
 */
export function saveDeviceResourceSettings(
  deviceId: string,
  settings: ResourceSourceSettings,
): Promise<SavedResourceSourceSettings> {
  return request("PUT", `${devicePath(deviceId)}/resources/settings`, {
    body: settings,
  });
}

/** The latest operations sessions ran on an instance, newest first. */
export function listResourceOperations(
  resourceId: string,
  limit = 50,
  options: RequestOptions = {},
): Promise<ResourceOperationList> {
  return request(
    "GET",
    `${resourcePath(resourceId)}/operations?limit=${limit}`,
    options,
  );
}

/**
 * Runs a backend's official installer on one device (the person chose it);
 * it may take minutes.
 */
export function installResourceBackend(
  deviceId: string,
  backend: string,
): Promise<ResourceBackendInstallResult> {
  return request("POST", `${devicePath(deviceId)}/resources/install`, {
    body: { backend },
  });
}
