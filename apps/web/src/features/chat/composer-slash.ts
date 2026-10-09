import type { SlashSuggestion } from "../../components/ui/slash-menu";

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
