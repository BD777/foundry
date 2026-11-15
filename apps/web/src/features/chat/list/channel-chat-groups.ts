import type { MessageChannelOriginSummary } from "@bd777/foundry-protocol";
import type { ChatListItem } from "../chat-surface-types";

/** A channel workspace's sessions of one source conversation (DEV-234). */
export interface ChannelChatGroup {
  key: string;
  conversation: MessageChannelOriginSummary["conversation"];
  source: string;
  /** The conversation's latest sender and time, from its newest session. */
  lastSender?: string;
  lastAt?: string;
  /** The newest session's conversation key, for "next session". */
  sessionKey: string;
  /** Newest first. */
  chats: ChatListItem[];
}

function chatTime(chat: ChatListItem): string {
  return (
    chat.activityAt ??
    chat.channelOrigin?.lastAt ??
    chat.channelOrigin?.startedAt ??
    ""
  );
}

/**
 * A channel workspace's chats grouped by source conversation, groups and
 * their sessions newest first. Sessions without an origin (not a channel
 * turn) are left out.
 */
export function channelChatGroups(
  chats: readonly ChatListItem[],
): ChannelChatGroup[] {
  const groups = new Map<string, ChannelChatGroup>();
  for (const chat of chats) {
    const origin = chat.channelOrigin;
    if (!origin) continue;
    const key = origin.conversation.id || origin.sessionKey || chat.id;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        conversation: origin.conversation,
        source: origin.source,
        sessionKey: origin.sessionKey,
        chats: [],
      };
      groups.set(key, group);
    }
    group.chats.push(chat);
  }
  for (const group of groups.values()) {
    group.chats.sort((left, right) =>
      chatTime(right).localeCompare(chatTime(left)),
    );
    const newest = group.chats[0]?.channelOrigin;
    if (newest) {
      group.sessionKey = newest.sessionKey;
      group.lastAt = newest.lastAt ?? newest.startedAt;
      group.lastSender = newest.lastSender?.name || newest.lastSender?.id;
    }
  }
  return [...groups.values()].sort((left, right) =>
    (right.lastAt ?? "").localeCompare(left.lastAt ?? ""),
  );
}
