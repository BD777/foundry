import {
  Columns2,
  LayoutDashboard,
  KeyRound,
  Library,
  MessageSquareText,
  Monitor,
  Plug,
  Server,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import type { SidebarNavSection } from "../components/ui/app-shell";
import {
  assistantSettingsSectionFrom,
  type AssistantSettingsSection,
  type InterfaceMode,
} from "../lib/assistant-settings-sections";
import { connectorTypes, type ConnectorType } from "../lib/connector-types";
import { noWorkspaceSelected } from "../api";
import type { shell } from "../i18n/locales/en/shell";

/** A sidebar label: a key of the shell namespace's `nav`. */
export type NavLabel = keyof typeof shell.nav;
import type { FoundryThemeMode } from "../components/ui/app-shell";

export type NavView =
  | "assistant"
  | "assistantSettings"
  | "account"
  | "members"
  | "issues"
  | "issue"
  | "chats"
  | "assets"
  | "skills"
  | "foundrySkill"
  | "channels"
  | "sharing"
  | "settings"
  | "profiles"
  | "connectors"
  | "workspaceConnectors"
  | "library"
  | "workspace"
  | "locations"
  | "devices"
  | "resources";

export type SidebarView = Exclude<NavView, "issue">;

export type DevicePairingMode = "auto" | "offline" | "online";

function connectorTabFrom(value: string | undefined): ConnectorType {
  return connectorTypes.find((type) => type === value) ?? connectorTypes[0];
}

export interface AppRoute {
  selectedDeviceId?: string;
  deviceSection?:
    "resources" | "agents" | "skills" | "settings" | "diagnostics";
  connectorTab?: ConnectorType;
  /** The open section of the assistant's settings. */
  assistantSection?: AssistantSettingsSection;
  chatView?: "active" | "archived";
  selectedChatId?: string;
  selectedIssueId?: string;
  view: NavView;
}

const activeWorkspaceStorageKey = "foundry.activeWorkspaceId";
const themeStorageKey = "foundry.themeMode";
const interfaceModeStorageKey = "foundry.interfaceMode";
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
    // Opening Foundry lands on the assistant (docs/personal-agent.md §10);
    // the shell turns back to the workspace when the person chose so.
    case undefined:
      return { view: "assistant" };
    case "assistant":
      return id === "settings"
        ? {
            view: "assistantSettings",
            assistantSection: assistantSettingsSectionFrom(segments[2]),
          }
        : { view: "assistant" };
    case "locations":
      // /locations/<device> brings that device's workspaces into view.
      return id
        ? { view: "locations", selectedDeviceId: decodePathSegment(id) }
        : { view: "locations" };
    case "account":
      return { view: "account" };
    case "members":
      return { view: "members" };
    case "assets":
      return { view: "assets" };
    case "chats":
      return id === "archived"
        ? { view: "chats", chatView: "archived" }
        : { view: "chats", selectedChatId: decodePathSegment(id) };
    case "devices":
      // A device's workspaces moved to /locations; old links still land there.
      if (id && segments[2] === "workspaces")
        return { view: "locations", selectedDeviceId: decodePathSegment(id) };
      return id
        ? {
            view: "devices",
            selectedDeviceId: decodePathSegment(id),
            deviceSection:
              segments[2] === "resources" ||
              segments[2] === "skills" ||
              segments[2] === "settings" ||
              segments[2] === "diagnostics"
                ? segments[2]
                : "agents",
          }
        : { view: "devices" };
    case "issues":
      return id
        ? { view: "issue", selectedIssueId: decodePathSegment(id) }
        : { view: "issues" };
    case "model-providers":
    // Earlier names of the Model providers page.
    case "profiles":
    case "connections":
      return { view: "profiles" };
    case "connectors":
      return { view: "connectors", connectorTab: connectorTabFrom(id) };
    case "resources":
      return { view: "resources" };
    // The page was "External accounts"; its accounts are the Feishu tab now.
    case "external-accounts":
      return { view: "connectors", connectorTab: "feishu" };
    case "runs":
      return { view: "issues" };
    case "settings":
      return { view: "settings" };
    case "skill-library":
      return { view: "library" };
    case "skills":
      return { view: "skills" };
    // The Channels tab was "Feishu Bot" at /feishu and /workspace/feishu.
    case "channels":
    case "feishu":
      return { view: "channels" };
    case "workspace":
      // /workspace/skills/foundry: what the built-in foundry skill gives agents.
      if (id === "skills" && segments[2] === "foundry")
        return { view: "foundrySkill" };
      if (
        id === "settings" ||
        id === "assets" ||
        id === "skills" ||
        id === "channels" ||
        id === "sharing"
      )
        return { view: id };
      if (id === "feishu") return { view: "channels" };
      // The tab was "Accounts" at /workspace/accounts.
      if (id === "connectors" || id === "accounts")
        return { view: "workspaceConnectors" };
      return { view: "workspace" };
    default:
      return { view: "workspace" };
  }
}

export function pathForAppRoute(route: AppRoute): string {
  switch (route.view) {
    case "assistant":
      return "/assistant";
    case "assistantSettings":
      return `/assistant/settings/${route.assistantSection ?? assistantSettingsSectionFrom(undefined)}`;
    case "locations":
      return route.selectedDeviceId
        ? `/locations/${encodePathSegment(route.selectedDeviceId)}`
        : "/locations";
    case "account":
      return "/account";
    case "members":
      return "/members";
    case "assets":
      return "/workspace/assets";
    case "chats":
      return route.chatView === "archived"
        ? "/chats/archived"
        : route.selectedChatId
          ? `/chats/${encodePathSegment(route.selectedChatId)}`
          : "/chats";
    case "devices":
      return route.selectedDeviceId
        ? `/devices/${encodePathSegment(route.selectedDeviceId)}/${route.deviceSection ?? "agents"}`
        : "/devices";
    case "issue":
      return route.selectedIssueId
        ? `/issues/${encodePathSegment(route.selectedIssueId)}`
        : "/issues";
    case "issues":
      return "/issues";
    case "profiles":
      return "/model-providers";
    case "connectors":
      return `/connectors/${route.connectorTab ?? connectorTypes[0]}`;
    case "resources":
      return "/resources";
    case "workspaceConnectors":
      return "/workspace/connectors";
    case "library":
      return "/skill-library";
    case "settings":
      return "/workspace/settings";
    case "skills":
      return "/workspace/skills";
    case "foundrySkill":
      return "/workspace/skills/foundry";
    case "channels":
      return "/workspace/channels";
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
 * `workspaceId` opens the route in that workspace instead of the one shown;
 * `query` sets the page's own parameters (a filter), "" removing one.
 */
export function navigateAppRoute(
  route: AppRoute,
  workspaceId?: string,
  query?: Record<string, string>,
): void {
  const path = pathForAppRoute(route);
  const url = `${path}${searchWithWorkspace(workspaceId || workspaceIdFromLocation(), query)}${window.location.hash}`;
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
  const stored = storedWorkspaceId();
  return (
    workspaceIdFromLocation() ||
    (stored === noWorkspaceSelected ? "" : stored) ||
    fallback
  );
}

/**
 * The workspace a data read asks for: the one shown; with none shown, none
 * when the person has no workspace selected (it stays so across reloads),
 * else nothing, and the server shows the first there is (a first visit, the
 * first folder added).
 */
export function workspaceToRead(activeWorkspaceId: string): string {
  if (activeWorkspaceId) return activeWorkspaceId;
  return storedWorkspaceId() === noWorkspaceSelected ? noWorkspaceSelected : "";
}

/**
 * Remembers that no workspace is selected (the current one was removed):
 * reads, here and after a reload, show none until Switch picks one.
 */
export function clearWorkspaceSelection(): void {
  try {
    window.localStorage.setItem(activeWorkspaceStorageKey, noWorkspaceSelected);
  } catch {
    return;
  }
}

export function searchWithWorkspace(
  workspaceId: string,
  query: Record<string, string> = {},
): string {
  const params = new URLSearchParams(window.location.search);
  if (workspaceId) {
    params.set("workspace", workspaceId);
  } else {
    params.delete("workspace");
  }
  for (const [name, value] of Object.entries(query)) {
    if (value) params.set(name, value);
    else params.delete(name);
  }
  const value = params.toString();
  return value ? `?${value}` : "";
}

/**
 * Remembers the workspace a read showed. A read that showed none while
 * workspaces exist (`workspaceCount`, when it read the list) leaves none
 * selected; with none left, the next folder added is shown again.
 */
export function persistWorkspaceId(
  workspaceId: string,
  workspaceCount?: number,
): void {
  try {
    if (workspaceId) {
      window.localStorage.setItem(activeWorkspaceStorageKey, workspaceId);
    } else if (workspaceCount === undefined) {
      return;
    } else if (workspaceCount > 0) {
      window.localStorage.setItem(
        activeWorkspaceStorageKey,
        noWorkspaceSelected,
      );
    } else {
      window.localStorage.removeItem(activeWorkspaceStorageKey);
    }
  } catch {
    return;
  }
}

/** Where opening Foundry lands: the assistant, unless the person turned it off. */
export function isLandingPath(pathname: string): boolean {
  return pathname.split("/").filter(Boolean).length === 0;
}

/**
 * The interface this browser chose before the choice moved to the
 * assistant's settings (simpleInterface); read once to carry it over.
 */
export function storedInterfaceMode(): InterfaceMode | undefined {
  try {
    const value = window.localStorage.getItem(interfaceModeStorageKey);
    return value === "simple" || value === "full" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function forgetStoredInterfaceMode(): void {
  try {
    window.localStorage.removeItem(interfaceModeStorageKey);
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

/** Pages that scroll as a whole; the others (chats, Issues) scroll their parts. */
const pageViews = new Set<string>([
  "assistantSettings",
  "account",
  "members",
  "assets",
  "skills",
  "foundrySkill",
  "settings",
  "channels",
  "sharing",
  "workspace",
  "devices",
  "locations",
  "profiles",
  "connectors",
  "resources",
  "workspaceConnectors",
  "library",
]);

/** Views that show the selected workspace; they need one to show anything. */
export const workspaceScopedViews = new Set<NavView>([
  "workspace",
  "chats",
  "issues",
  "issue",
  "assets",
  "skills",
  "settings",
  "channels",
  "workspaceConnectors",
  "sharing",
]);

export function scrollModeForView(view: string): "page" | "contained" {
  return pageViews.has(view) ? "page" : "contained";
}

const assistantNavSection: SidebarNavSection<SidebarView> = {
  id: "assistant",
  label: "assistantSection",
  items: [
    { id: "assistant", label: "assistant", icon: Sparkles },
    {
      id: "assistantSettings",
      label: "assistantSettings",
      icon: SlidersHorizontal,
    },
  ],
};

/**
 * The sidebar: the selected workspace, then the global assistant and
 * management. Labels are keys of the shell namespace's `nav`; the shell
 * translates them.
 */
export const navSections: Array<SidebarNavSection<SidebarView>> = [
  {
    id: "workspace",
    label: "workspace",
    items: [
      { id: "workspace", label: "overview", icon: LayoutDashboard },
      { id: "issues", label: "issues", icon: Columns2 },
      { id: "chats", label: "chats", icon: MessageSquareText },
    ],
  },
  { ...assistantNavSection, dividerBefore: true },
  {
    id: "manage",
    label: "manage",
    items: [
      { id: "devices", label: "devices", icon: Monitor },
      { id: "resources", label: "resources", icon: Server },
      { id: "library", label: "library", icon: Library },
      { id: "profiles", label: "profiles", icon: KeyRound },
      { id: "connectors", label: "connectors", icon: Plug },
    ],
  },
];

/**
 * The simple interface's sidebar: the assistant and its settings; the
 * account entries join the empty "manage" section (withAccountNav).
 */
export const simpleNavSections: Array<SidebarNavSection<SidebarView>> = [
  assistantNavSection,
  { id: "manage", label: "manage", items: [] },
];
