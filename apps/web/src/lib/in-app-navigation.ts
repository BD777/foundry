import { navigateAppRoute } from "../app/navigation";

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

/** Opens a workspace's Feishu Bot tab through the same contract. */
export function navigateToWorkspaceFeishuBot(workspaceId: string): void {
  navigateAppRoute({ view: "feishu" }, workspaceId);
}

/** Opens the workspace's Skills page through the same contract. */
export function navigateToSkills(): void {
  navigateAppRoute({ view: "skills" });
}

/** Opens the page on what the built-in Foundry skill gives agents. */
export function navigateToFoundrySkill(): void {
  navigateAppRoute({ view: "foundrySkill" });
}
