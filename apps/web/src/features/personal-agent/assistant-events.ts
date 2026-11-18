import type { ToastTone } from "../../components/ui/toast";
import type {
  AssistantSettingsSection,
  InterfaceMode,
} from "../../lib/assistant-settings-sections";

/** What the assistant's pages ask of the shell. */
export type AssistantFeatureEvent =
  | { type: "notice.requested"; message: string; tone?: ToastTone }
  /** Opens the settings, at a section when given. */
  | { type: "settings.open"; section?: AssistantSettingsSection }
  | { type: "assistants.open" }
  | { type: "assistant.open"; assistantId: string }
  | { type: "assistant.created"; assistantId: string }
  | { type: "assistants.changed" }
  | { type: "home.open" }
  /** Opens Devices: a computer's settings, or the list to connect one. */
  | { type: "devices.open"; deviceId?: string }
  /** Opens the "needs you" list. */
  | { type: "pending.open" }
  /** Opens one "needs you" item where it was found (its chat, Issue or Connectors). */
  | { type: "pending.item"; itemId: string }
  /** Opens 「事项」: the list, or one item's detail when `itemId` is given. */
  | { type: "items.open"; itemId?: string }
  | { type: "interface.changed"; mode: InterfaceMode };
