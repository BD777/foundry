import {
  fixtureAssets,
  fixtureChats,
  fixtureDevice,
  fixtureIssues,
  fixtureProviderHealth,
  fixtureWorkspace,
} from "@bd777/foundry-protocol";
import { emptyWorkspace } from "../api";
import type { FoundryData } from "../api-types";

/** What the app shows before its first read. */
export const emptyFoundryData: FoundryData = {
  workspace: emptyWorkspace,
  workspaces: [],
  devices: [],
  providerHealth: [],
  agentProfiles: [],
  deviceProfiles: [],
  deviceSkillRoots: [],
  promotedSkills: [],
  workspaceSkillBindings: [],
  profiles: [],
  agents: [],
  workspaceFiles: [],
  agentSessions: [],
  skills: [],
  issues: [],
  chats: [],
  assets: [],
};

/** The demo's data (?demo=1), shown while the API is unreachable. */
export const demoFoundryData: FoundryData = {
  ...emptyFoundryData,
  workspace: fixtureWorkspace,
  workspaces: [fixtureWorkspace],
  devices: [fixtureDevice],
  providerHealth: fixtureProviderHealth,
  issues: fixtureIssues,
  chats: fixtureChats,
  assets: fixtureAssets,
};
