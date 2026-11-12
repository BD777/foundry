import {
  assistantSettingsSectionValue,
  type AssistantSettingsSection,
} from "./assistant-settings-sections";
import {
  connectorTypeFrom,
  defaultConnectorType,
  type ConnectorType,
} from "./connector-types";
import { providerTabFrom, type ProviderTab } from "./provider-tabs";

export type NavView =
  | "assistants"
  | "assistant"
  | "assistantSettings"
  | "pending"
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
  | "usage"
  | "workspaceConnectors"
  | "library"
  | "workspace"
  | "locations"
  | "devices"
  | "resources";

export type SidebarView = Exclude<NavView, "issue">;

export interface AppRoute {
  assistantId?: string;
  selectedDeviceId?: string;
  deviceSection?:
    "resources" | "agents" | "skills" | "settings" | "diagnostics";
  connectorTab?: ConnectorType;
  /** The open tab of Model providers. */
  providerTab?: ProviderTab;
  /** The open section of the assistant's settings. */
  assistantSection?: AssistantSettingsSection;
  chatView?: "active" | "archived";
  selectedChatId?: string;
  selectedIssueId?: string;
  view: NavView;
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
    case "assistants": {
      if (!id) return { view: "assistants" };
      const assistantSection = assistantSettingsSectionValue(segments[3]);
      return segments[2] === "settings"
        ? {
            view: "assistantSettings",
            assistantId: decodePathSegment(id),
            ...(assistantSection ? { assistantSection } : {}),
          }
        : { view: "assistant", assistantId: decodePathSegment(id) };
    }
    // Legacy aliases resolve to the default assistant in the app shell.
    case "assistant": {
      const assistantSection = assistantSettingsSectionValue(segments[2]);
      return id === "settings"
        ? {
            view: "assistantSettings",
            ...(assistantSection ? { assistantSection } : {}),
          }
        : { view: "assistant" };
    }
    case "locations":
      // /locations/<device> brings that device's workspaces into view.
      return id
        ? { view: "locations", selectedDeviceId: decodePathSegment(id) }
        : { view: "locations" };
    case "pending":
      return { view: "pending" };
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
      return { view: "profiles", providerTab: providerTabFrom(id) };
    // Earlier names of the Model providers page.
    case "profiles":
    case "connections":
      return { view: "profiles", providerTab: providerTabFrom(undefined) };
    case "connectors":
      return { view: "connectors", connectorTab: connectorTypeFrom(id) };
    case "usage":
      return { view: "usage" };
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
      return route.assistantId
        ? `/assistants/${encodePathSegment(route.assistantId)}`
        : "/assistant";
    case "assistantSettings":
      return route.assistantId
        ? `/assistants/${encodePathSegment(route.assistantId)}/settings${route.assistantSection ? `/${route.assistantSection}` : ""}`
        : route.assistantSection
          ? `/assistant/settings/${route.assistantSection}`
          : "/assistant/settings";
    case "assistants":
      return "/assistants";
    case "locations":
      return route.selectedDeviceId
        ? `/locations/${encodePathSegment(route.selectedDeviceId)}`
        : "/locations";
    case "pending":
      return "/pending";
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
      return `/model-providers/${route.providerTab ?? providerTabFrom(undefined)}`;
    case "connectors":
      return `/connectors/${route.connectorTab ?? defaultConnectorType}`;
    case "usage":
      return "/usage";
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

// The first path segments parseAppRoute knows; any other path on this
// origin (an API, a file) is not a page of the app.
const appSections = new Set([
  "",
  "assistant",
  "assistants",
  "pending",
  "locations",
  "account",
  "members",
  "assets",
  "chats",
  "devices",
  "issues",
  "model-providers",
  "profiles",
  "connections",
  "connectors",
  "usage",
  "resources",
  "external-accounts",
  "runs",
  "settings",
  "skill-library",
  "skills",
  "channels",
  "feishu",
  "workspace",
]);

/** Whether a path on this origin is one of the app's pages, not an API or a file. */
export function isAppPath(pathname: string): boolean {
  return appSections.has(pathname.split("/")[1] ?? "");
}

/** Where opening Foundry lands: the assistant, unless the person turned it off. */
export function isLandingPath(pathname: string): boolean {
  return pathname.split("/").filter(Boolean).length === 0;
}
