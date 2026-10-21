import type {
  AgentModelOption,
  AgentProfileProjection,
  AgentRuntimeSettings,
  DeviceProfileBinding,
  ProfileDefinition,
  PromoteProfileInput,
  SaveProfileInput,
  SetDeviceProfilesInput,
} from "@bd777/foundry-protocol";
import type {
  CreateAgentProfileInput,
  SaveAgentRuntimeSettingsInput,
} from "../api-types";
import { request } from "./http";

/** The signed-in person's visible account catalog, independent of browsing location. */
export function listAgentProfiles(): Promise<AgentProfileProjection[]> {
  return request("GET", "/api/agent-profiles");
}

export function createAgentProfile(
  input: CreateAgentProfileInput,
): Promise<AgentProfileProjection> {
  return request("POST", "/api/agent-profiles", { body: input });
}

/**
 * Model catalogs this page read or is reading, by profile and the fields that
 * decide its catalog, so every view asking about one profile shares one read.
 * A catalog does not change while the page is open; failures are not kept.
 */
const agentModelCatalogs = new Map<string, Promise<AgentModelOption[]>>();

/**
 * Asks the profile's device for its model catalog. With `reuse`, a catalog
 * this page read (or is reading) for the same profile answers instead, and
 * the server may answer from its own copy; an explicit refresh asks the
 * device again and keeps the new answer. A request carrying a typed API key
 * is never kept: the key stays in its form.
 */
export function listAgentModels(
  profile: CreateAgentProfileInput,
  {
    reuse = false,
    catalogIdentity,
  }: { reuse?: boolean; catalogIdentity?: string } = {},
): Promise<AgentModelOption[]> {
  const body = reuse ? { profile } : { profile, refresh: true };
  if (profile.apiKey)
    return request("POST", "/api/agent-profiles/models", { body });
  const key = JSON.stringify(
    [
      catalogIdentity,
      profile.deviceId,
      profile.id,
      profile.runtime,
      profile.configScope,
      profile.connectionType,
      profile.baseUrl,
      profile.model,
      profile.label,
    ].map((field) => field?.trim() ?? ""),
  );
  const known = agentModelCatalogs.get(key);
  if (reuse && known) return known;
  const read = request<AgentModelOption[]>(
    "POST",
    "/api/agent-profiles/models",
    { body },
  );
  agentModelCatalogs.set(key, read);
  read.catch(() => {
    if (agentModelCatalogs.get(key) === read) agentModelCatalogs.delete(key);
  });
  return read;
}

export function createProfile(
  input: SaveProfileInput,
): Promise<ProfileDefinition> {
  return request("POST", "/api/profiles", { body: input });
}

export function updateProfile(
  id: string,
  input: SaveProfileInput,
): Promise<ProfileDefinition> {
  return request("PUT", `/api/profiles/${encodeURIComponent(id)}`, {
    body: input,
  });
}

export function deleteProfile(id: string): Promise<ProfileDefinition> {
  return request("DELETE", `/api/profiles/${encodeURIComponent(id)}`);
}

export function clearProfileCredential(id: string): Promise<ProfileDefinition> {
  return request(
    "POST",
    `/api/profiles/${encodeURIComponent(id)}/credential/clear`,
  );
}

export function promoteProfile(
  input: PromoteProfileInput,
): Promise<ProfileDefinition> {
  return request("POST", "/api/profiles/promote", { body: input });
}

export function setDeviceProfiles(
  input: SetDeviceProfilesInput,
): Promise<DeviceProfileBinding[]> {
  return request(
    "PUT",
    `/api/devices/${encodeURIComponent(input.deviceId)}/profiles`,
    { body: input },
  );
}

export function saveAgentRuntimeSettings(
  input: SaveAgentRuntimeSettingsInput,
): Promise<AgentRuntimeSettings> {
  return request("POST", "/api/devices/runtime-settings", { body: input });
}

/** Explicit person-only override of Foundry’s remembered suspension. */
export function resumeNativeAccount(
  deviceId: string,
  profileId: string,
  holdId: string,
): Promise<{ resumed: boolean }> {
  return request("POST", "/api/agent-profiles/resume-account", {
    body: { deviceId, profileId, holdId },
  });
}
