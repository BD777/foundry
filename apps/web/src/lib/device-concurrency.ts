import type { DeviceProjection } from "@bd777/foundry-protocol";

export type DeviceConcurrencyMode = "adaptive" | "forced";

/** The mode the worker reported, else the owner's last saved choice. */
export function deviceConcurrencyMode(
  device: Pick<DeviceProjection, "runtimeSettings" | "runtimeState">,
): DeviceConcurrencyMode {
  return (
    device.runtimeState?.mode ??
    device.runtimeSettings?.mode ??
    (device.runtimeSettings?.maxConcurrentTasksSource === "owner"
      ? "forced"
      : "adaptive")
  );
}

/** The effective limit when known, else the best configured fallback. */
export function deviceConcurrencyLimit(
  device: Pick<DeviceProjection, "runtimeSettings" | "runtimeState">,
): number | undefined {
  const state = device.runtimeState;
  if (state) return state.limit;
  const settings = device.runtimeSettings;
  if (!settings) return undefined;
  if (settings.mode === "forced") return settings.forcedLimit;
  return (
    settings.hardwareMaxConcurrentTasks ??
    (settings.maxConcurrentTasks || undefined)
  );
}
