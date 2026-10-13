import type {
  FeishuAppUse,
  FeishuPairingCodeResult,
  SelectWorkspaceFeishuBotInput,
  WorkspaceFeishuBot,
} from "@bd777/foundry-protocol";
import { request } from "./http";

const feishuPath = (workspaceId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/feishu`;

export function getWorkspaceFeishuBot(
  workspaceId: string,
): Promise<WorkspaceFeishuBot> {
  return request("GET", feishuPath(workspaceId));
}

export function saveWorkspaceFeishuBot(
  workspaceId: string,
  input: SelectWorkspaceFeishuBotInput,
): Promise<WorkspaceFeishuBot> {
  return request("POST", feishuPath(workspaceId), { body: input });
}

export function generateFeishuPairingCode(
  workspaceId: string,
): Promise<FeishuPairingCodeResult> {
  return request("POST", `${feishuPath(workspaceId)}/pair-code`, { body: {} });
}

export function refreshFeishuChatName(
  workspaceId: string,
  routeId: string,
): Promise<WorkspaceFeishuBot> {
  return request(
    "POST",
    `${feishuPath(workspaceId)}/chats/${encodeURIComponent(routeId)}/refresh-name`,
    { body: {} },
  );
}

export function unbindFeishuChat(
  workspaceId: string,
  routeId: string,
): Promise<WorkspaceFeishuBot> {
  return request(
    "DELETE",
    `${feishuPath(workspaceId)}/chats/${encodeURIComponent(routeId)}`,
  );
}

export function deleteWorkspaceFeishuBot(workspaceId: string): Promise<void> {
  return request("DELETE", feishuPath(workspaceId));
}

export function getFeishuAppUses(): Promise<FeishuAppUse[]> {
  return request("GET", "/api/feishu/app-uses");
}
