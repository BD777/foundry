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

const viewLabels: Record<NavView, string> = {
  account: "Account",
  members: "Members",
  assets: "Assets",
  chats: "Chats",
  devices: "Devices",
  locations: "Working location",
  issue: "Issue detail",
  issues: "Issues",
  profiles: "Model connections",
  settings: "Settings",
  skills: "Skills",
  feishu: "Feishu Bot",
  sharing: "Sharing",
  workspace: "Workspace",
};

export function viewErrorLabel(view: NavView): string {
  return viewLabels[view];
}
