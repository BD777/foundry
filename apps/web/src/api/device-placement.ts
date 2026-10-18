import type { DeviceLabel, DevicePlacement } from "@bd777/foundry-protocol";
import { request } from "./http";

/** The labels and detected facts of the caller's own devices. */
export function listDevicePlacements(): Promise<DevicePlacement[]> {
  return request("GET", "/api/device-placements");
}

/** Replaces a device's labels (its owner only); answers its placement. */
export function setDeviceLabels(
  deviceId: string,
  labels: DeviceLabel[],
): Promise<DevicePlacement> {
  return request("PUT", `/api/devices/${encodeURIComponent(deviceId)}/labels`, {
    body: { labels },
  });
}
