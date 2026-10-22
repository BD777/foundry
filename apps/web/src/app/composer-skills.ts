import type { FoundryData } from "../api-types";
import { runtimeMeta } from "../components/ui/runtime-mark";

/**
 * What the composer's "/" menu offers in the current workspace: its selected
 * and default skills, and each agent's own and Foundry built-in skills.
 */
export function workspaceComposerSkills(data: FoundryData) {
  return {
    // The server lists the selected, default, and ready draft skills (workspaceSkills).
    workspace: (data.workspaceSkills ?? []).map((skill) => ({
      value: skill.name,
      label: skill.name,
      description: skill.description,
      tag: (skill as { draft?: boolean }).draft ? "Draft" : undefined,
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
              tag: runtimeMeta(row.provider).productName,
            })),
            builtin: (data.builtinSkills ?? [])
              .filter((skill) => skill.runtime === row.provider)
              .map((skill) => ({
                value: skill.name,
                label: skill.name,
                description: skill.description,
                tag: `${runtimeMeta(row.provider).productName} · Foundry`,
              })),
          },
        ]),
    ),
  };
}
