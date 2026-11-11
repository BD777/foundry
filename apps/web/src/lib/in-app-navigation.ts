import {
  isAppPath,
  parseAppRoute,
  pathForAppRoute,
  type AppRoute,
} from "./routes";
import { issuesEnabled } from "./feature-flags";
import { foundryIdKind } from "./foundry-ids";
import type { AssistantSettingsSection } from "./assistant-settings-sections";
import { edgeAccessConnectorTab, type ConnectorType } from "./connector-types";

export function workspaceIdFromLocation(): string {
  if (typeof window === "undefined") return "";
  return (
    new URLSearchParams(window.location.search).get("workspace")?.trim() ?? ""
  );
}

export function searchWithWorkspace(
  workspaceId: string,
  query: Record<string, string> = {},
): string {
  const params = new URLSearchParams(
    typeof window === "undefined" ? "" : window.location.search,
  );
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
  { replace = false }: { replace?: boolean } = {},
): void {
  const path = pathForAppRoute(route);
  const url = `${path}${searchWithWorkspace(workspaceId || workspaceIdFromLocation(), query)}${window.location.hash}`;
  showAppUrl(url, replace);
}

/**
 * Shows `url` through the history/popstate contract; `replace` corrects the
 * entry shown (the same place, resolved) instead of adding one.
 */
function showAppUrl(url: string, replace: boolean): void {
  if (
    url ===
    `${window.location.pathname}${window.location.search}${window.location.hash}`
  ) {
    return;
  }
  if (replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * The app page an address names: a link to this origin (or a root path
 * such as `/chats/sess_1`) whose path is one of the app's pages, as the
 * path and search to show. Without `workspace` it opens in the one shown.
 */
export function appUrlFor(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return undefined;
  }
  if (url.origin !== window.location.origin) return undefined;
  if (!isAppPath(url.pathname)) return undefined;
  const params = new URLSearchParams(url.search);
  const shown = workspaceIdFromLocation();
  if (!params.get("workspace") && shown) params.set("workspace", shown);
  const search = params.toString();
  return `${pathForAppRoute(parseAppRoute(url.pathname))}${search ? `?${search}` : ""}${url.hash}`;
}

/** Whether the address shows the page of Issue `issueId`. */
export function addressNamesIssue(issueId: string): boolean {
  const route = parseAppRoute(window.location.pathname);
  return Boolean(
    issueId && route.view === "issue" && route.selectedIssueId === issueId,
  );
}

/**
 * Inward navigation surface for feature code: opens the existing
 * Devices → device → Agents management page through the shell's normal
 * popstate contract (no new route), as the back button does.
 */
export function navigateToDeviceAgents(deviceId: string): void {
  navigateAppRoute({
    deviceSection: "agents",
    selectedDeviceId: deviceId,
    view: "devices",
  });
}

/** Opens a device's Resources section through the same contract. */
export function navigateToDeviceResources(deviceId: string): void {
  navigateAppRoute({
    deviceSection: "resources",
    selectedDeviceId: deviceId,
    view: "devices",
  });
}

/** Opens a device's execution settings through the shell's normal route. */
export function navigateToDeviceSettings(deviceId: string): void {
  navigateAppRoute({
    deviceSection: "settings",
    selectedDeviceId: deviceId,
    view: "devices",
  });
}

/** A real, copyable link to a device's execution settings. */
export function deviceSettingsHref(deviceId: string): string {
  return `${pathForAppRoute({
    deviceSection: "settings",
    selectedDeviceId: deviceId,
    view: "devices",
  })}${searchWithWorkspace(workspaceIdFromLocation())}`;
}

/** Opens the Resources page, filtered to one device's resources when given. */
export function navigateToResources(deviceId = "", type = ""): void {
  navigateAppRoute({ view: "resources" }, undefined, {
    device: deviceId,
    type,
  });
}

/**
 * Opens a session's transcript in Chats through the same contract: in the
 * workspace shown, or in `workspaceId`.
 */
export function navigateToChat(sessionId: string, workspaceId?: string): void {
  navigateAppRoute({ selectedChatId: sessionId, view: "chats" }, workspaceId);
}

/**
 * Opens a chat at one of its messages (`?message=`): the transcript scrolls
 * to it and marks it for a moment. Without one it opens the chat.
 */
export function navigateToChatMessage(
  sessionId: string,
  workspaceId?: string,
  messageId?: string,
): void {
  navigateAppRoute({ selectedChatId: sessionId, view: "chats" }, workspaceId, {
    message: messageId ?? "",
  });
}

/** A real link for opening/copying a chat while ordinary clicks stay in-app. */
export function chatHref(sessionId: string, workspaceId?: string): string {
  const path = pathForAppRoute({ selectedChatId: sessionId, view: "chats" });
  return workspaceId
    ? `${path}?workspace=${encodeURIComponent(workspaceId)}`
    : path;
}

/**
 * A chat opened by a link that is in another workspace: shows it there,
 * correcting the address in place (the link named the chat, not where).
 */
export function openChatInItsWorkspace(
  sessionId: string,
  workspaceId: string,
): void {
  navigateAppRoute(
    { selectedChatId: sessionId, view: "chats" },
    workspaceId,
    undefined,
    { replace: true },
  );
}

/** The page a Foundry id opens; native chats and other text have none. */
function routeForFoundryId(id: string): AppRoute | undefined {
  switch (foundryIdKind(id)) {
    case "session":
      return { selectedChatId: id, view: "chats" };
    case "issue":
      return issuesEnabled ? { selectedIssueId: id, view: "issue" } : undefined;
    case "device":
      return { selectedDeviceId: id, view: "devices" };
    // /locations/<workspace> brings that workspace's device group into view.
    case "workspace":
      return { selectedDeviceId: id, view: "locations" };
    default:
      return undefined;
  }
}

/**
 * A Foundry id's page as a link: no workspace, as the page resolves the
 * object's own (a chat or Issue opens in its workspace).
 */
export function foundryIdHref(id: string): string | undefined {
  const route = routeForFoundryId(id);
  return route ? pathForAppRoute(route) : undefined;
}

/** Whether `href` is one of the app's pages on this origin. */
export function isAppHref(href: string): boolean {
  return appUrlFor(href) !== undefined;
}

/**
 * Opens a link to one of the app's pages (same origin) in place; false
 * when `href` leads elsewhere, to open as an ordinary link.
 */
export function openAppHref(href: string): boolean {
  const url = appUrlFor(href);
  if (url === undefined) return false;
  showAppUrl(url, false);
  return true;
}

/** Opens an Issue's page through the same contract, in `workspaceId` when given. */
export function navigateToIssue(issueId: string, workspaceId?: string): void {
  if (!issuesEnabled) return;
  navigateAppRoute({ selectedIssueId: issueId, view: "issue" }, workspaceId);
}

/** Opens a workspace's Channels tab through the same contract. */
export function navigateToWorkspaceChannels(workspaceId: string): void {
  navigateAppRoute({ view: "channels" }, workspaceId);
}

/** Opens the Connectors page on one connector type's tab. */
export function navigateToConnectors(type: ConnectorType): void {
  navigateAppRoute({ view: "connectors", connectorTab: type }, undefined, {
    repository: "",
    skill: "",
  });
}

/** A real link to one connector's tab, without a previous package target. */
export function connectorsHref(type: ConnectorType): string {
  return `${pathForAppRoute({
    view: "connectors",
    connectorTab: type,
  })}${searchWithWorkspace(workspaceIdFromLocation(), {
    repository: "",
    skill: "",
  })}`;
}

/**
 * Opens a device connector's tab asking to grant scopes on one device
 * (DEV-136): `/connectors/<kind>?device=<id>&grant=<scope,scope>`. The tab
 * reads it once (takeConnectorGrant) and opens that device's picker with
 * the scopes preselected; nothing is granted until the person confirms.
 */
export function navigateToConnectorGrant(
  type: ConnectorType,
  deviceId: string,
  scopes: string[],
): void {
  navigateAppRoute({ view: "connectors", connectorTab: type }, undefined, {
    device: deviceId,
    grant: scopes.join(","),
  });
}

/**
 * The scopes a link asked to grant on this device, removed from the URL as
 * they are read; another device's request stays for that device's row.
 */
export function takeConnectorGrant(forDevice: string): string[] | undefined {
  const params = new URLSearchParams(window.location.search);
  const deviceId = params.get("device") ?? "";
  if (deviceId !== forDevice) return undefined;
  const scopes = (params.get("grant") ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(scope));
  if (!params.has("device") && !params.has("grant")) return undefined;
  params.delete("device");
  params.delete("grant");
  const search = params.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`,
  );
  return scopes.length ? scopes : undefined;
}

/** Opens the workspace's Skills page through the same contract. */
export function navigateToSkills(): void {
  navigateAppRoute({ view: "skills" });
}

/** Opens the Skill Library, where bundles and their versions are managed. */
export function navigateToSkillLibrary(): void {
  navigateAppRoute({ view: "library" });
}

/** The Skill Library page, where bundles and their versions are managed. */
export function skillLibraryHref(): string {
  return `${pathForAppRoute({ view: "library" })}${searchWithWorkspace(workspaceIdFromLocation())}`;
}

/**
 * One followed repository in the Skill Library, optionally with one of its
 * skills selected. The library reads these page parameters once.
 */
export function skillLibraryRepositoryHref(
  repositoryId: string,
  skillId?: string,
): string {
  return `${pathForAppRoute({ view: "library" })}${searchWithWorkspace(
    workspaceIdFromLocation(),
    { repository: repositoryId, skill: skillId ?? "" },
  )}`;
}

/** Opens the page on what the built-in Foundry skill gives agents. */
export function navigateToFoundrySkill(): void {
  navigateAppRoute({ view: "foundrySkill" });
}

/** Opens Model providers with one provider's editor open. */
export function navigateToModelProvider(profileId: string): void {
  navigateAppRoute({ view: "profiles", providerTab: "endpoints" }, undefined, {
    provider: profileId,
  });
}

/** Opens Model providers, filtered to one device when one is named. */
export function navigateToModelProviders({
  deviceId,
}: { deviceId?: string } = {}): void {
  navigateAppRoute(
    { view: "profiles" },
    undefined,
    deviceId ? { device: deviceId } : undefined,
  );
}

/** Opens the assistant's settings at one section. */
export function navigateToAssistantSettings(
  section: AssistantSettingsSection,
): void {
  navigateAppRoute({ view: "assistantSettings", assistantSection: section });
}

/**
 * Opens the Edge Access add dialog, scoped to the upstream address a failed
 * connector probe named.
 */
export function navigateToEdgeAccessCredential(
  host: string,
  pathPrefix?: string,
): void {
  navigateAppRoute(
    { view: "connectors", connectorTab: edgeAccessConnectorTab },
    undefined,
    { edgeHost: host, edgePath: pathPrefix ?? "" },
  );
}

/** Reads and removes the one-shot Edge Access prefill parameters. */
export function takeEdgeAccessPrefill():
  { host: string; pathPrefix?: string } | undefined {
  if (typeof window === "undefined") return undefined;
  const params = new URLSearchParams(window.location.search);
  const host = params.get("edgeHost")?.trim() ?? "";
  const pathPrefix = params.get("edgePath")?.trim() ?? "";
  if (!params.has("edgeHost") && !params.has("edgePath")) return undefined;
  params.delete("edgeHost");
  params.delete("edgePath");
  const search = params.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`,
  );
  return host ? { host, ...(pathPrefix ? { pathPrefix } : {}) } : undefined;
}

/** Opens the workspace’s archived conversations. */
export function navigateToArchivedChats(): void {
  navigateAppRoute({ view: "chats", chatView: "archived" });
}
