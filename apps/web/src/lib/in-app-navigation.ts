import { navigateAppRoute } from "../app/navigation";
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
