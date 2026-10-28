import {
  appUrlFor,
  navigateAppRoute,
  navigateToAppUrl,
  pathForAppRoute,
  type AppRoute,
} from "../app/navigation";
import { foundryIdKind } from "./foundry-ids";
import type { AssistantSettingsSection } from "./assistant-settings-sections";
import type { ConnectorType } from "./connector-types";

/**
 * Inward navigation surface for feature code: opens the existing
 * Devices → device → Agents management page through the shell's normal
 * popstate contract (no new route). Features cannot import the app layer
 * directly, so this lib wrapper is the allowed entry point.
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
      return { selectedIssueId: id, view: "issue" };
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
  return navigateToAppUrl(href);
}

/** Opens an Issue's page through the same contract. */
export function navigateToIssue(issueId: string): void {
  navigateAppRoute({ selectedIssueId: issueId, view: "issue" });
}

/** Opens a workspace's Channels tab through the same contract. */
export function navigateToWorkspaceChannels(workspaceId: string): void {
  navigateAppRoute({ view: "channels" }, workspaceId);
}

/** Opens the Connectors page on one connector type's tab. */
export function navigateToConnectors(type: ConnectorType): void {
  navigateAppRoute({ view: "connectors", connectorTab: type });
}

/** Opens the workspace's Skills page through the same contract. */
export function navigateToSkills(): void {
  navigateAppRoute({ view: "skills" });
}

/** Opens the page on what the built-in Foundry skill gives agents. */
export function navigateToFoundrySkill(): void {
  navigateAppRoute({ view: "foundrySkill" });
}

/** Opens Model providers with one provider's editor open. */
export function navigateToModelProvider(profileId: string): void {
  navigateAppRoute({ view: "profiles" }, undefined, { provider: profileId });
}

/** Opens the assistant's settings at one section. */
export function navigateToAssistantSettings(
  section: AssistantSettingsSection,
): void {
  navigateAppRoute({ view: "assistantSettings", assistantSection: section });
}

/** Opens the workspace’s archived conversations. */
export function navigateToArchivedChats(): void {
  navigateAppRoute({ view: "chats", chatView: "archived" });
}
