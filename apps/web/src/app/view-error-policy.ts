import { i18n } from "../i18n";
import type { NavView } from "./navigation";

export interface ViewErrorResetInput {
  selectedChatId?: string;
  selectedIssueId?: string;
  selectedDeviceId?: string;
  view: NavView;
  workspaceId: string;
}

/** Identifies the data scope a view render depends on. */
export function viewErrorResetKey({
  selectedChatId,
  selectedIssueId,
  selectedDeviceId,
  view,
  workspaceId,
}: ViewErrorResetInput): string {
  const selection =
    view === "chats"
      ? (selectedChatId ?? "")
      : view === "issue"
        ? (selectedIssueId ?? "")
        : view === "devices"
          ? (selectedDeviceId ?? "")
          : "";
  return [
    view === "devices" || view === "profiles" || view === "locations"
      ? "global"
      : workspaceId,
    view,
    selection,
  ].join("|");
}

export function viewErrorLabel(view: NavView): string {
  return i18n.t(`shell:views.${view}`);
}
