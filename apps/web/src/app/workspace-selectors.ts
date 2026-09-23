import type {
  AgentProfileProjection,
  AgentProjection,
  AssetProjection,
  DeviceProjection,
  Issue,
  ProviderHealth,
  SkillPackRef,
  WorkspaceProjection,
} from "@foundry/protocol";

// Providers the local daemon can run. Provider health is always reported for
// this set so Settings and Devices show a stable row order.
const localProviders = ["claude", "codex"] as const;

// Capability skills Foundry always advertises, even before an issue references
// them.
const capabilitySkillIds = [
  "issue-splitting",
  "web-preview-acceptance",
  "baseline-comparison",
  "visual-qa",
];

// Design-led ordering for the skills view; unlisted skills keep their
// discovery order behind the curated ones.
const skillDesignOrder = [
  "baseline-comparison",
  "web-preview-acceptance",
  "visual-qa",
  "issue-splitting",
  "shadcn-ui-cleanup",
];

function isCurrentWorkspace<T extends { workspaceId: string }>(
  item: T,
  workspaceId: string,
): boolean {
  return workspaceId !== "" && item.workspaceId === workspaceId;
}

/**
 * Agents the active workspace can use, strictly scoped to its owning device.
 */
export function currentWorkspaceAgents(
  agents: AgentProjection[],
  workspace: WorkspaceProjection,
): AgentProjection[] {
  const scoped = agents.filter((agent) =>
    isCurrentWorkspace(agent, workspace.id),
  );
  const deviceScoped = workspace.deviceId
    ? scoped.filter((agent) => agent.deviceId === workspace.deviceId)
    : scoped;
  return [...deviceScoped].sort((left, right) => {
    if (left.status !== right.status) {
      return left.status === "healthy" ? -1 : 1;
    }
    if (left.provider !== right.provider) {
      return left.provider.localeCompare(right.provider);
    }
    return (left.profileLabel ?? left.provider).localeCompare(
      right.profileLabel ?? right.provider,
    );
  });
}

function providerHealthFromAgent(agent: AgentProjection): ProviderHealth {
  return {
    authMode: agent.authMode,
    provider: agent.provider,
    secretStored: agent.secretStored,
    status: agent.status,
  };
}

/**
 * Provider health for the scoped agents, preferring a healthy agent over an
 * unhealthy one, then the server-reported row, then an unavailable placeholder.
 */
export function currentProviderHealth(
  providerHealth: ProviderHealth[],
  agents: AgentProjection[],
): ProviderHealth[] {
  const fallback = new Map(
    providerHealth.map((provider) => [provider.provider, provider]),
  );
  const agentHealth = new Map<AgentProjection["provider"], ProviderHealth>();
  for (const agent of agents) {
    const current = agentHealth.get(agent.provider);
    if (!current || agent.status === "healthy") {
      agentHealth.set(agent.provider, providerHealthFromAgent(agent));
    }
  }

  return localProviders.map(
    (provider) =>
      agentHealth.get(provider) ??
      fallback.get(provider) ?? {
        authMode: "missing",
        provider,
        secretStored: "local",
        status: "unavailable",
      },
  );
}

/** Keep only the records that belong to the active workspace. */
export function currentWorkspaceItems<T extends { workspaceId: string }>(
  items: T[],
  workspaceId: string,
): T[] {
  return items.filter((item) => isCurrentWorkspace(item, workspaceId));
}

/** Assets without a workspace are global, so they stay visible everywhere. */
export function currentWorkspaceAssets(
  assets: AssetProjection[],
  workspaceId: string,
): AssetProjection[] {
  return assets.filter(
    (asset) =>
      asset.workspaceId === undefined || asset.workspaceId === workspaceId,
  );
}

/** Skills without a workspace are global, so they stay visible everywhere. */
export function currentWorkspaceSkills(
  skills: SkillPackRef[],
  workspaceId: string,
): SkillPackRef[] {
  return skills.filter(
    (skill) =>
      skill.workspaceId === undefined || skill.workspaceId === workspaceId,
  );
}

/** A missing workspace device must never silently select another machine. */
export function currentDevice(
  devices: DeviceProjection[],
  workspace: WorkspaceProjection,
): DeviceProjection | undefined {
  return workspace.deviceId
    ? devices.find((device) => device.id === workspace.deviceId)
    : devices[0];
}

/** Agents on a device; every agent when no device is resolved yet. */
export function agentsForDevice(
  agents: AgentProjection[],
  deviceId: string | undefined,
): AgentProjection[] {
  return deviceId
    ? agents.filter((agent) => agent.deviceId === deviceId)
    : agents;
}

/** Agent profiles on a device; every profile when no device is resolved yet. */
export function profilesForDevice(
  profiles: AgentProfileProjection[],
  deviceId: string | undefined,
): AgentProfileProjection[] {
  return deviceId
    ? profiles.filter((profile) => profile.deviceId === deviceId)
    : profiles;
}

/**
 * Skills referenced by the loaded issues plus the always-advertised capability
 * skills, deduped by id and ordered for the skills view.
 */
export function uniqueSkills(issues: Issue[]): SkillPackRef[] {
  const seen = new Map<string, SkillPackRef>();
  for (const issue of issues) {
    for (const skill of issue.skills) {
      seen.set(skill.id, skill);
    }
  }
  for (const skillId of capabilitySkillIds) {
    if (!seen.has(skillId)) {
      seen.set(skillId, { id: skillId, name: skillId, version: "0.1.0" });
    }
  }
  return [...seen.values()].sort((a, b) => {
    const aIndex = skillDesignOrder.indexOf(a.id);
    const bIndex = skillDesignOrder.indexOf(b.id);
    return (aIndex === -1 ? 99 : aIndex) - (bIndex === -1 ? 99 : bIndex);
  });
}
