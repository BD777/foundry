import type { DeviceProjection } from "@bd777/foundry-protocol";

/**
 * A device removed from Foundry. The server still sends it so history can
 * name it, but it does not exist anywhere a device is listed or offered.
 */
export function isRemovedDevice(device?: DeviceProjection): boolean {
  return device?.status === "removed";
}

/** The devices that exist: everything the Devices page lists. */
export function liveDevices(devices: DeviceProjection[]): DeviceProjection[] {
  return devices.filter((device) => !isRemovedDevice(device));
}
