import type { AgentSession, DeviceProjection } from "@bd777/foundry-protocol";

/**
 * The device, when it is listed and not connected. Work sent to it waits on
 * the server and starts by itself once the device is back online.
 */
export function offlineDevice(
  deviceId: string | undefined,
  devices: readonly DeviceProjection[],
): DeviceProjection | undefined {
  if (!deviceId) return undefined;
  const device = devices.find((candidate) => candidate.id === deviceId);
  return device && device.status !== "connected" ? device : undefined;
}

/**
 * The offline device a queued session waits for, or undefined when the
 * session is not queued or its device is online (or not listed).
 */
export function deviceAwaitedBy(
  session: Pick<AgentSession, "deviceId" | "status"> | undefined,
  devices: readonly DeviceProjection[],
): DeviceProjection | undefined {
  return session?.status === "queued"
    ? offlineDevice(session.deviceId, devices)
    : undefined;
}
