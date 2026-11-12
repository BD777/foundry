import { i18n } from "../i18n";
import type { NavView } from "../lib/routes";

export interface ViewErrorResetInput {
  selectedAssistantId?: string;
  selectedChatId?: string;
  selectedIssueId?: string;
  selectedDeviceId?: string;
  view: NavView;
  workspaceId: string;
}

/** Identifies the data scope a view render depends on. */
export function viewErrorResetKey({
  selectedAssistantId,
  selectedChatId,
  selectedIssueId,
  selectedDeviceId,
  view,
  workspaceId,
}: ViewErrorResetInput): string {
  const selection =
    view === "assistant" || view === "assistantSettings"
      ? (selectedAssistantId ?? "")
      : view === "chats"
        ? (selectedChatId ?? "")
        : view === "issue"
          ? (selectedIssueId ?? "")
          : view === "devices"
            ? (selectedDeviceId ?? "")
            : "";
  return [
    view === "assistants" ||
    view === "assistant" ||
    view === "assistantSettings" ||
    view === "pending" ||
    view === "devices" ||
    view === "profiles" ||
    view === "connectors" ||
    view === "usage" ||
    view === "resources" ||
    view === "library" ||
    view === "locations"
      ? "global"
      : workspaceId,
    view,
    selection,
  ].join("|");
}

export function viewErrorLabel(view: NavView): string {
  return i18n.t(`shell:views.${view}`);
}
