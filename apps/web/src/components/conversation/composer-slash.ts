import { i18n } from "../../i18n";
import type { FoundryData } from "../../api-types";
import { runtimeMeta } from "../agent-runtime/runtime-mark";
import type { SlashSuggestion } from "../ui/slash-menu";

type Agent = "claude" | "codex";

export interface ComposerSlashSkills {
  /** The workspace's skills: its selection and its owner's defaults. */
  workspace?: SlashSuggestion[];
  /** Each agent's skills, offered while that agent is selected. */
  byAgent?: Partial<
    Record<
      Agent,
      {
        /** The skills the agent ships. */
        official: SlashSuggestion[];
        /** The skills Foundry gives the agent. */
        builtin: SlashSuggestion[];
      }
    >
  >;
}

const lower = (items: SlashSuggestion[]) =>
  new Set(items.map((item) => item.value.toLowerCase()));

/**
 * The composer's "/" menu, one entry per name, as the session resolves it: a
 * workspace skill replaces the agent's own skill of that name, and Foundry's
 * built-in replaces a workspace skill of its name.
 */
export function composerSlashItems(
  skills: ComposerSlashSkills | undefined,
  provider: string | undefined,
): SlashSuggestion[] {
  const own =
    provider === "claude" || provider === "codex"
      ? skills?.byAgent?.[provider]
      : undefined;
  const builtin = own?.builtin ?? [];
  const builtinNames = lower(builtin);
  const workspace = (skills?.workspace ?? []).filter(
    (item) => !builtinNames.has(item.value.toLowerCase()),
  );
  const taken = new Set([...builtinNames, ...lower(workspace)]);
  const official = (own?.official ?? []).filter(
    (item) => !taken.has(item.value.toLowerCase()),
  );
  return [...official, ...builtin, ...workspace];
}

/**
 * What the composer's "/" menu offers in a workspace: its selected
 * and default skills, and each agent's own and Foundry built-in skills.
 */
export function workspaceComposerSkills(
  data: Pick<
    FoundryData,
    "builtinSkills" | "providerHealth" | "workspace" | "workspaceSkills"
  >,
): ComposerSlashSkills {
  return {
    // The server lists the selected, default, and ready draft skills (workspaceSkills).
    workspace: (data.workspaceSkills ?? []).map((skill) => ({
      value: skill.name,
      label: skill.name,
      description: skill.description,
      tag: skill.package
        ? i18n.t("ui:slashMenu.packageTag", { name: skill.package })
        : (skill as { draft?: boolean }).draft
          ? "Draft"
          : undefined,
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
