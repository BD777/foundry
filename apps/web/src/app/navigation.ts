import type { FoundryThemeMode } from "../components/ui/app-shell";

export type NavView =
  | "account"
  | "members"
  | "issues"
  | "issue"
  | "chats"
  | "assets"
  | "skills"
  | "feishu"
  | "sharing"
  | "settings"
  | "profiles"
  | "workspace"
  | "locations"
  | "devices";

export type SidebarView = Exclude<NavView, "issue">;

export type DevicePairingMode = "auto" | "offline" | "online";

export interface AppRoute {
  selectedDeviceId?: string;
  deviceSection?: "workspaces" | "agents" | "skills" | "settings";
  selectedChatId?: string;
  selectedIssueId?: string;
  view: NavView;
}

const activeWorkspaceStorageKey = "foundry.activeWorkspaceId";
const themeStorageKey = "foundry.themeMode";
const sidebarCollapsedStorageKey = "foundry.sidebarCollapsed";

export function initialDevicePairingMode(): DevicePairingMode {
  const value = new URLSearchParams(window.location.search).get("device");
  return value === "offline" || value === "online" ? value : "auto";
}

function decodePathSegment(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

export function parseAppRoute(pathname: string): AppRoute {
  const segments = pathname.split("/").filter(Boolean);
  const [section, id] = segments;
  switch (section) {
    case "locations":
      return { view: "locations" };
    case "account":
      return { view: "account" };
    case "members":
      return { view: "members" };
    case "assets":
      return { view: "assets" };
    case "chats":
      return { view: "chats", selectedChatId: decodePathSegment(id) };
    case "devices":
      return id
        ? {
            view: "devices",
            selectedDeviceId: decodePathSegment(id),
            deviceSection:
              segments[2] === "agents" ||
              segments[2] === "skills" ||
              segments[2] === "settings"
                ? segments[2]
                : "workspaces",
          }
        : { view: "devices" };
    case "issues":
      return id
        ? { view: "issue", selectedIssueId: decodePathSegment(id) }
        : { view: "issues" };
    case "profiles":
    case "connections":
      return { view: "profiles" };
    case "runs":
      return { view: "issues" };
    case "settings":
      return { view: "settings" };
    case "skills":
      return { view: "skills" };
    case "feishu":
      return { view: "feishu" };
    case "workspace":
      if (
        id === "settings" ||
        id === "assets" ||
        id === "skills" ||
        id === "feishu" ||
        id === "sharing"
      )
        return { view: id };
      return { view: "workspace" };
    default:
      return { view: "issues" };
  }
}

export function pathForAppRoute(route: AppRoute): string {
  switch (route.view) {
    case "locations":
      return "/locations";
    case "account":
      return "/account";
    case "members":
      return "/members";
    case "assets":
      return "/workspace/assets";
    case "chats":
      return route.selectedChatId
        ? `/chats/${encodePathSegment(route.selectedChatId)}`
        : "/chats";
    case "devices":
      return route.selectedDeviceId
        ? `/devices/${encodePathSegment(route.selectedDeviceId)}/${route.deviceSection ?? "workspaces"}`
        : "/devices";
    case "issue":
      return route.selectedIssueId
        ? `/issues/${encodePathSegment(route.selectedIssueId)}`
        : "/issues";
    case "issues":
      return "/issues";
    case "profiles":
      return "/connections";
    case "settings":
      return "/workspace/settings";
    case "skills":
      return "/workspace/skills";
    case "feishu":
      return "/workspace/feishu";
    case "sharing":
      return "/workspace/sharing";
    case "workspace":
      return "/workspace";
  }
}

/**
 * Imperative in-app navigation for surfaces that own no shell state (the
 * composer pickers). Goes through the same history/popstate contract as the
 * back button, so the app shell parses the existing route — no new route.
 */
export function navigateAppRoute(route: AppRoute): void {
  const path = pathForAppRoute(route);
  const url = `${path}${searchWithWorkspace(workspaceIdFromLocation())}${window.location.hash}`;
  if (
    url ===
    `${window.location.pathname}${window.location.search}${window.location.hash}`
  ) {
    return;
  }
  window.history.pushState(null, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function workspaceIdFromLocation(): string {
  return (
    new URLSearchParams(window.location.search).get("workspace")?.trim() ?? ""
  );
}

function storedWorkspaceId(): string {
  try {
    return window.localStorage.getItem(activeWorkspaceStorageKey)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function initialWorkspaceId(fallback: string): string {
  return workspaceIdFromLocation() || storedWorkspaceId() || fallback;
}

export function searchWithWorkspace(workspaceId: string): string {
  const params = new URLSearchParams(window.location.search);
  if (workspaceId) {
    params.set("workspace", workspaceId);
  } else {
    params.delete("workspace");
  }
  const value = params.toString();
  return value ? `?${value}` : "";
}

export function persistWorkspaceId(workspaceId: string): void {
  try {
    if (workspaceId) {
      window.localStorage.setItem(activeWorkspaceStorageKey, workspaceId);
    } else {
      window.localStorage.removeItem(activeWorkspaceStorageKey);
    }
  } catch {
    return;
  }
}

export function storedThemeMode(): FoundryThemeMode {
  try {
    return window.localStorage.getItem(themeStorageKey) === "dark"
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

export function persistThemeMode(themeMode: FoundryThemeMode): void {
  try {
    window.localStorage.setItem(themeStorageKey, themeMode);
  } catch {
    return;
  }
}

export function storedSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(sidebarCollapsedStorageKey) === "true";
  } catch {
    return false;
  }
}

export function persistSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(sidebarCollapsedStorageKey, String(collapsed));
  } catch {
    return;
  }
}
