import type {
  AgentConnectionType,
  AgentProfileProjection,
  AgentSession,
  DeviceProfileBinding,
  DeviceProjection,
  ProfileDefinition,
  ProviderHealth,
  ProviderStatus,
} from "@foundry/protocol";
import type { BadgeTone } from "./asset-meta";

export interface ResolvedProfileStatus {
  status: ProviderStatus;
  statusDetail?: string;
  /**
   * Set when no device is allowed to run this profile. It is a `missing_auth`
   * status so every existing consumer keeps working, but the reason is not
   * authentication and the badge must not claim it is.
   */
  unbound?: boolean;
}

/** Whether any device is allowed to run this profile. */
function enabledOnAnyDevice(
  deviceProfiles: DeviceProfileBinding[],
  profileId: string,
): boolean {
  return deviceProfiles.some(
    (binding) => binding.enabled && binding.profileId === profileId,
  );
}

export interface ResolveServerProfileStatusOptions {
  device?: DeviceProjection;
  /**
   * Every device binding the server knows about, not only this device's. A
   * profile no device is allowed to run cannot run anywhere, and the snapshot
   * already carries the whole set.
   */
  deviceProfiles?: DeviceProfileBinding[];
  profile: ProfileDefinition;
  projection?: AgentProfileProjection;
  providerHealth: ProviderHealth[];
}

/**
 * Mirrors the control-plane derivation for a server profile resolved onto one
 * device. The projection wins when the server already resolved this profile
 * for this device; otherwise the same rules run locally so a profile that is
 * not enabled yet still shows an honest preview badge.
 */
export function resolveServerProfileStatus({
  device,
  deviceProfiles,
  profile,
  projection,
  providerHealth,
}: ResolveServerProfileStatusOptions): ResolvedProfileStatus {
  // Checked before the projection, because a profile no device may run has no
  // projection to consult. Without this an unbound profile that carries a
  // sealed credential reads as healthy while a run would quietly fall back to
  // the daemon's own configuration instead.
  if (deviceProfiles && !enabledOnAnyDevice(deviceProfiles, profile.id)) {
    return {
      status: "missing_auth",
      statusDetail:
        "Not enabled on any device yet. Choose the devices that may run it on the Device page.",
      unbound: true,
    };
  }
  if (projection) {
    return { status: projection.status, statusDetail: projection.statusDetail };
  }
  if (device?.status !== "connected") {
    return { status: "unavailable", statusDetail: "Device is offline." };
  }
  const health = providerHealth.find(
    (row) =>
      row.provider === profile.runtime &&
      (!row.deviceId || row.deviceId === device.id),
  );
  if (health?.status === "unavailable") {
    return {
      status: "unavailable",
      statusDetail:
        health.statusDetail ?? "Runtime is unavailable on this device.",
    };
  }
  if (profile.authMode === "official") {
    return health?.status === "healthy"
      ? { status: "healthy" }
      : {
          status: "missing_auth",
          statusDetail: "Authorize this profile on the device.",
        };
  }
  // Custom API/gateway profiles do not need a sealed key — internal proxies
  // can authenticate themselves — so they are configured and selectable once
  // the device is reachable. This mirrors the control plane; "healthy" means
  // configured, not verified online, and nothing here probes the provider.
  return { status: "healthy" };
}

export interface SecretsSummaryOptions {
  detectedProfiles: AgentProfileProjection[];
  enabledProfiles: ProfileDefinition[];
}

/**
 * Where the credentials this device can actually use are sealed. Profiles with
 * no credential at all hold no secret and are ignored.
 */
export function secretsSummaryLabel({
  detectedProfiles,
  enabledProfiles,
}: SecretsSummaryOptions): string {
  let serverHeld = 0;
  let localHeld = 0;
  for (const profile of enabledProfiles) {
    if (profile.authMode === "official") {
      localHeld += 1;
      continue;
    }
    if (profile.hasCredential) {
      serverHeld += 1;
    }
  }
  for (const profile of detectedProfiles) {
    if (profile.secretStored === "server" || profile.serverCredential) {
      serverHeld += 1;
      continue;
    }
    if (profile.authMode !== "missing") {
      localHeld += 1;
    }
  }
  if (serverHeld === 0 && localHeld === 0) {
    return "None stored";
  }
  if (localHeld === 0) {
    return "Server";
  }
  if (serverHeld === 0) {
    return "Local";
  }

  return "Mixed";
}

export function connectionTypeLabel(
  connectionType: AgentConnectionType,
): string {
  const labels: Record<AgentConnectionType, string> = {
    anthropic_compatible: "Anthropic-compatible",
    custom_command: "Custom command",
    env: "Environment",
    local_login: "Local login",
    openai_compatible: "OpenAI-compatible",
  };

  return labels[connectionType];
}

/**
 * Why a daemon-discovered profile cannot become a server profile. Remote
 * endpoint profiles return undefined: those are the promotable ones. Local
 * login profiles read differently depending on whether the machine is already
 * signed in, because "signed in here" is wrong for a profile still waiting for
 * its first login.
 */
export function promotionBlockReason(
  connectionType: AgentConnectionType,
  authMode: ProviderHealth["authMode"] = "local_config",
): string | undefined {
  if (connectionType === "local_login") {
    return authMode === "missing"
      ? "Not signed in yet. Official logins are per machine and never move to the server."
      : "Signed in on this machine. Official logins are per machine and never move to the server.";
  }
  if (connectionType === "env") {
    return "Backed by an environment variable that only exists on this machine.";
  }
  if (connectionType === "custom_command") {
    return "Runs a local command that only exists on this machine.";
  }

  return undefined;
}

export function statusTone(
  status:
    | AgentProfileProjection["status"]
    | AgentSession["status"]
    | DeviceProjection["status"]
    | ProviderHealth["status"],
): BadgeTone {
  if (
    status === "connected" ||
    status === "healthy" ||
    status === "completed"
  ) {
    return "online";
  }
  if (
    status === "missing_auth" ||
    status === "queued" ||
    status === "running"
  ) {
    return "warn";
  }
  if (status === "failed" || status === "unavailable") {
    return "error";
  }

  return "neutral";
}

export function providerStatusLabel(status: ProviderStatus): string {
  const labels: Record<ProviderStatus, string> = {
    healthy: "Configured",
    missing_auth: "Needs auth",
    unavailable: "Unavailable",
  };

  return labels[status];
}

export interface ProfileBadge {
  label: string;
  tone: BadgeTone;
}

/**
 * The badge a profile earns for how usable it is, or nothing when it is simply
 * working. A row that needs no attention says so by carrying no badge, which
 * leaves the ones that do need attention visible at a glance.
 */
export function profileBadge(
  resolved: ResolvedProfileStatus,
): ProfileBadge | undefined {
  if (resolved.status === "healthy") return undefined;
  if (resolved.unbound) return { label: "Not enabled", tone: "warn" };

  return {
    label: providerStatusLabel(resolved.status),
    tone: statusTone(resolved.status),
  };
}

export function authModeLabel(mode: ProviderHealth["authMode"]): string {
  const labels: Record<ProviderHealth["authMode"], string> = {
    env: "Environment",
    local_config: "Local config",
    missing: "Not configured",
  };

  return labels[mode];
}
