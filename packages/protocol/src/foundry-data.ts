// Everything the web reads for one workspace in one projection.

import type { ChatThread } from "./chat.js";
import type { DeviceProjection } from "./device.js";
import type { Issue, Run } from "./issue.js";
import type {
  AgentProfileProjection,
  AgentProjection,
  DeviceProfileBinding,
  ProfileDefinition,
  ProviderHealth,
} from "./profiles.js";
import type { AgentSession } from "./session.js";
import type {
  BuiltinSkill,
  DeviceSkillRoot,
  DeviceTool,
  PromotedSkill,
  SkillBundleSummary,
  SkillPackRef,
  WorkspaceSkillBinding,
} from "./skills.js";
import type {
  AssetProjection,
  WorkspaceFileEntry,
  WorkspaceProjection,
} from "./workspace.js";

export interface FoundryDataProjection {
  runs?: Run[];
  agentProfiles: AgentProfileProjection[];
  agents: AgentProjection[];
  agentSessions: AgentSession[];
  assets: AssetProjection[];
  chats: ChatThread[];
  deviceProfiles: DeviceProfileBinding[];
  deviceSkillRoots: DeviceSkillRoot[];
  devices: DeviceProjection[];
  issues: Issue[];
  profiles: ProfileDefinition[];
  promotedSkills: PromotedSkill[];
  /** Skills Foundry itself gives an agent; sessions on it always have them. */
  builtinSkills?: BuiltinSkill[];
  providerHealth: ProviderHealth[];
  skills: SkillPackRef[];
  workspace: WorkspaceProjection;
  workspaceFiles: WorkspaceFileEntry[];
  workspaceSkillBindings: WorkspaceSkillBinding[];
  /** Library skills the workspace gets from its owner's defaults. */
  defaultSkillIds?: string[];
  /** Skills it gets from defaults or bundles, including ones turned off. */
  inheritedSkillIds?: string[];
  /** Inherited skills this workspace turned off. */
  offSkillIds?: string[];
  /** Which programs library skills need the visible devices have. */
  deviceTools?: DeviceTool[];
  /** The library's bundles, and the ones this workspace uses. */
  skillBundles?: SkillBundleSummary[];
  workspaceBundleIds?: string[];
  /** Its owner's default bundles; workspaceBundleIds holds those still on. */
  defaultBundleIds?: string[];
  workspaces: WorkspaceProjection[];
}
