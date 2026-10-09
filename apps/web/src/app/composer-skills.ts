import type { FoundryData } from "../api-types";

// i18n-ignore: runtime product names
const agentNames = { claude: "Claude Code", codex: "Codex" } as const;

/**
 * What the composer's "/" menu offers in the current workspace: its selected
 * and default skills, and each agent's own and Foundry built-in skills.
 */
export function workspaceComposerSkills(data: FoundryData) {
  const workspaceIds = new Set([
    ...data.workspaceSkillBindings.map((binding) => binding.skillId),
    ...(data.defaultSkillIds ?? []),
  ]);
  return {
    workspace: data.promotedSkills
      .filter((skill) => workspaceIds.has(skill.id))
      .map((skill) => ({
        value: skill.name,
        label: skill.name,
        description: skill.description,
      })),
    byAgent: Object.fromEntries(
      data.providerHealth
        .filter((row) => row.deviceId === data.workspace.deviceId)
        .map((row) => [
          row.provider,
          {
            official: (row.officialSkills ?? []).map((skill) => ({
              value: skill.name,
              label: skill.name,
              description: skill.description,
              tag: agentNames[row.provider],
            })),
            builtin: (data.builtinSkills ?? [])
              .filter((skill) => skill.runtime === row.provider)
              .map((skill) => ({
                value: skill.name,
                label: skill.name,
                description: skill.description,
                tag: `${agentNames[row.provider]} · Foundry`,
              })),
          },
        ]),
    ),
  };
}
