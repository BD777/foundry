import type { FoundryDataField } from "../api-types";

// What each view shows of the workspace data: what it reads on its Refresh,
// and after a change made on it when it waits for the change to show (a
// saved profile it then selects, a workspace it then lists). Whatever else
// the change touches the server announces (foundry_data_changed names the
// fields), and the live data reads that itself.

/** The Devices page: devices with their workspaces, accounts and skills. */
export const devicesViewFields: readonly FoundryDataField[] = [
  "devices",
  "workspaces",
  "agentProfiles",
  "deviceProfiles",
  "deviceSkillRoots",
  "profiles",
  "providerHealth",
];

/** The Model providers page: server-held providers and their devices. */
export const profilesViewFields: readonly FoundryDataField[] = [
  "profiles",
  "deviceProfiles",
  // Whether each device has the runtime a provider needs.
  "providerHealth",
];

/** The Workspaces page lists the workspaces by device. */
export const workspacesViewFields: readonly FoundryDataField[] = ["workspaces"];

/** A workspace's Skills section. */
export const skillsViewFields: readonly FoundryDataField[] = [
  "workspaceSkillBindings",
  "promotedSkills",
  "devices",
  "providerHealth",
  "builtinSkills",
  "defaultSkillIds",
  "deviceTools",
  "skillBundles",
  "workspaceBundleIds",
  "defaultBundleIds",
  "inheritedSkillIds",
  "offSkillIds",
  "workspaces",
];

/** The skill library. */
export const libraryViewFields: readonly FoundryDataField[] = [
  "promotedSkills",
  "deviceTools",
  "devices",
];

/** A workspace's Assets section. */
export const assetsViewFields: readonly FoundryDataField[] = [
  "assets",
  "workspaceFiles",
  "agents",
  "providerHealth",
  "devices",
];
