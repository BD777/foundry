import type { ExternalProviderApp } from "./external-accounts.js";

export type FeishuBotStatus =
  "unconfigured" | "connecting" | "connected" | "error";

/** What a route matches: the workspace's pairing codes, a group, or a
 * person's direct chat with the bot. */
export type FeishuRouteKind = "pairing" | "chat" | "p2p";

/** One way a Connectors Feishu app's events reach a workspace. */
export interface FeishuBotRoute {
  id: string;
  /** The Connectors app (xapp_…). */
  appId: string;
  workspaceId: string;
  kind: FeishuRouteKind;
  chatId?: string;
  chatName?: string;
  /** When the name was last asked of Feishu. */
  chatNameCheckedAt?: string;
  /** Why that check failed; the name shown is the one before. */
  chatNameError?: string;
  /** Account the bot acts as in the chat: whoever generated the pairing
   * code the chat used. */
  boundUserId?: string;
  pairingCodeExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** A workspace's Feishu Bot: a Connectors app plus the chats routed to the
 * workspace, and how the server's connection to the app stands. */
export interface WorkspaceFeishuBot {
  workspaceId: string;
  /** The Connectors app the bot runs on; absent when none is picked. */
  app?: ExternalProviderApp;
  status: FeishuBotStatus;
  statusDetail?: string;
  /** When the server last received an event of the app. */
  lastEventAt?: string;
  chats: FeishuBotRoute[];
  /** When the current pairing code lapses. */
  pairingCodeExpiresAt?: string;
  /** Feishu apps the caller may run the bot on (only in answers to them). */
  choices?: ExternalProviderApp[];
}

export interface SelectWorkspaceFeishuBotInput {
  appId: string;
}

export interface FeishuPairingCodeResult {
  workspaceId: string;
  pairingCode: string;
  pairingCodeExpiresAt: string;
}

/** What uses one Connectors Feishu app. */
/** One workspace whose bot runs on the app. */
export interface FeishuAppWorkspaceUse {
  workspaceId: string;
  name: string;
  chats: number;
}

export interface FeishuAppUse {
  appId: string;
  workspaces: FeishuAppWorkspaceUse[];
  /** Workspaces the caller cannot see. */
  otherWorkspaces?: number;
  /** Agent event subscriptions open on the app. */
  subscriptions: number;
  status: FeishuBotStatus;
  statusDetail?: string;
  lastEventAt?: string;
}
