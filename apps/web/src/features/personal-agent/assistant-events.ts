import type {
  AssistantSettingsSection,
  InterfaceMode,
} from "../../lib/assistant-settings-sections";

/** What the assistant's pages ask of the shell. */
export type AssistantFeatureEvent =
  | { type: "notice.requested"; message: string }
  /** Opens the settings, at a section when given. */
  | { type: "settings.open"; section?: AssistantSettingsSection }
  | { type: "home.open" }
  /** Opens Devices: a computer's settings, or the list to connect one. */
  | { type: "devices.open"; deviceId?: string }
  | { type: "interface.changed"; mode: InterfaceMode };
