import type {
  DeviceProfileBinding,
  ProfileDefinition,
} from "@foundry/protocol";

export function isModelConnection(profile: ProfileDefinition): boolean {
  return (
    profile.authMode !== "official" && profile.connectionType !== "local_login"
  );
}

/** Changing one connection never drops another connection or a legacy binding. */
export function connectionSelection(
  bindings: DeviceProfileBinding[],
  deviceId: string,
  profileId: string,
  enabled: boolean,
): string[] {
  const ids = new Set(
    bindings
      .filter((row) => row.deviceId === deviceId && row.enabled)
      .map((row) => row.profileId),
  );
  if (enabled) ids.add(profileId);
  else ids.delete(profileId);
  return [...ids];
}

/**
 * The complete id set one Save writes for a device: the dialog's selections
 * plus every enabled binding the picker cannot show (legacy official bindings,
 * profiles that vanished from the list). Replacing the set with only the
 * visible selections would silently drop those.
 */
export function deviceConnectionSelection(
  bindings: DeviceProfileBinding[],
  deviceId: string,
  selectableIds: string[],
  selectedIds: string[],
): string[] {
  const selectable = new Set(selectableIds);
  const ids = new Set(
    bindings
      .filter(
        (row) =>
          row.deviceId === deviceId &&
          row.enabled &&
          !selectable.has(row.profileId),
      )
      .map((row) => row.profileId),
  );
  for (const id of selectedIds) ids.add(id);
  return [...ids];
}

export function connectionUsage(
  profile: ProfileDefinition,
  bindings: DeviceProfileBinding[],
): string {
  // A sealed key is optional: internal gateways can authenticate themselves,
  // so a connection without one is described neutrally, never as a warning.
  const keyLabel = profile.hasCredential ? "Configured" : "No key configured";
  const count = new Set(
    bindings
      .filter((row) => row.profileId === profile.id && row.enabled)
      .map((row) => row.deviceId),
  ).size;
  return count
    ? `${keyLabel} · ${count} device${count === 1 ? "" : "s"}`
    : `${keyLabel} · Not assigned`;
}
