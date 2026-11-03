import type { DeviceProjection } from "@bd777/foundry-protocol";

/** Devices the caller owns: candidates for configuring work. */
export function ownedDeviceCandidates(
  devices: DeviceProjection[],
): DeviceProjection[] {
  return devices.filter((device) => device.owned);
}
