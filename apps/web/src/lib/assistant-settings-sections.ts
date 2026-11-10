/**
 * The sections of the assistant's settings page (docs/personal-agent.md
 * §11), in the order the page shows them; /assistant/settings/<section>.
 */
export const assistantSettingsSections = [
  "status",
  "style",
  "memory",
  "rules",
  "places",
  "models",
  "connectors",
  "entry",
  "limits",
  "activity",
] as const;

export type AssistantSettingsSection =
  (typeof assistantSettingsSections)[number];

export const assistantSettingsGroups = [
  {
    id: "assistant",
    sections: ["status", "style", "memory", "rules"],
  },
  {
    id: "work",
    sections: ["places", "models", "connectors"],
  },
  {
    id: "reachLimits",
    sections: ["entry", "limits", "activity"],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  sections: readonly AssistantSettingsSection[];
}>;

export type AssistantSettingsGroup =
  (typeof assistantSettingsGroups)[number]["id"];

export function assistantSettingsSectionValue(
  value: string | undefined,
): AssistantSettingsSection | undefined {
  return assistantSettingsSections.find((section) => section === value);
}

/** Full: every page. Simple: only the assistant and its settings (§10). */
export type InterfaceMode = "full" | "simple";
