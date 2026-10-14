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
  "entry",
  "limits",
  "activity",
] as const;

export type AssistantSettingsSection =
  (typeof assistantSettingsSections)[number];

export function assistantSettingsSectionFrom(
  value: string | undefined,
): AssistantSettingsSection {
  return (
    assistantSettingsSections.find((section) => section === value) ??
    assistantSettingsSections[0]
  );
}

/** Full: every page. Simple: only the assistant and its settings (§10). */
export type InterfaceMode = "full" | "simple";
