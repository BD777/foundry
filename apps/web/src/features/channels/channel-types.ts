import type { ToastTone } from "../../components/ui/toast";
import type { ComponentType } from "react";
import { FeishuBotFeature } from "./feishu-bot-feature";

/**
 * Entry points a workspace can be reached through besides web Chats. Each
 * type is a section of the workspace's Channels tab; another channel (Slack,
 * email, a webhook) is one more type here, its copy under
 * `channels:types.<type>` and its section component below.
 */
export const channelTypes = ["feishu_bot"] as const;
export type ChannelType = (typeof channelTypes)[number];

export interface ChannelSectionProps {
  workspaceId: string;
  workspaceName?: string;
  /** Names other workspaces: where a chat moved here was paired. */
  workspaceNameOf?: (workspaceId: string) => string | undefined;
  /** The signed-in account: a direct chat it paired is its own. */
  currentUserId?: string;
  onNotice?: (message: string, tone?: ToastTone) => void;
  /** Opens Connectors, where the apps channels run on are managed. */
  onOpenConnectors?: () => void;
}

export const channelSections: Record<
  ChannelType,
  ComponentType<ChannelSectionProps>
> = {
  feishu_bot: FeishuBotFeature,
};
