import type { DeviceProjection } from "@bd777/foundry-protocol";

/** How a device's connection should read and behave in the UI. */
export type DeviceConnection = "online" | "reconnecting" | "offline";

export function deviceConnection(
  device: Pick<DeviceProjection, "status"> | undefined,
): DeviceConnection {
  if (device?.status === "connected") return "online";
  if (device?.status === "reconnecting") return "reconnecting";
  return "offline";
}
