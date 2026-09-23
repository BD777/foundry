export type FeishuBotStatus =
  "unconfigured" | "connecting" | "connected" | "error";

export interface WorkspaceFeishuConfig {
  workspaceId: string;
  appId: string;
  hasAppSecret: boolean;
  chatId?: string;
  chatName?: string;
  /** Account the bot acts as in its group: whoever generated the pairing code the group used. */
  boundUserId?: string;
  pairingCodeExpiresAt?: string;
  status: FeishuBotStatus;
  statusDetail?: string;
  updatedAt?: string;
}

export interface SaveWorkspaceFeishuConfigInput {
  workspaceId: string;
  appId: string;
  appSecret?: string;
}

export interface FeishuPairingCodeResult {
  workspaceId: string;
  pairingCode: string;
  pairingCodeExpiresAt: string;
}

export interface UnbindFeishuGroupInput {
  workspaceId: string;
}
