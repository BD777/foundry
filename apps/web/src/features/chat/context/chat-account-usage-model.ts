import type {
  AgentProfileProjection,
  DeviceProjection,
} from "@bd777/foundry-protocol";

export interface AccountUsageTarget {
  deviceId: string;
  profileId: string;
  runtime: "claude" | "codex";
  generation: string;
  online: boolean;
}

export function accountUsageTarget(
  profile: AgentProfileProjection | undefined,
  devices: readonly DeviceProjection[],
): AccountUsageTarget | undefined {
  if (
    !profile ||
    profile.connectionType !== "local_login" ||
    profile.baseUrl ||
    profile.origin !== "device" ||
    !profile.runtimeGeneration
  )
    return;
  const device = devices.find((row) => row.id === profile.deviceId);
  // Device ownership is distinct from workspace membership or execution access.
  if (device?.owned !== true || device.status === "removed") return;
  return {
    deviceId: device.id,
    profileId: profile.id,
    runtime: profile.runtime,
    generation: profile.runtimeGeneration,
    online: device.status === "connected",
  };
}
export function accountUsageKey(target: AccountUsageTarget): string {
  return JSON.stringify([
    target.deviceId,
    target.profileId,
    target.runtime,
    target.generation,
  ]);
}
