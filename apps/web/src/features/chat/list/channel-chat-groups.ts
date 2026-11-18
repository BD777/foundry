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
 * Orders two server times by instant. The server writes UTC with trimmed
 * fractions in older rows, so text order can disagree within a second. The
 * whole second compares by Date.parse, and the fraction compares as digits
 * padded to nine places. Date.parse runs on whole seconds only: Safari
 * rejects fractions longer than three digits. A missing or unreadable time
 * sorts first.
 */
function compareTimes(left: string, right: string): number {
  const a = timeKey(left);
  const b = timeKey(right);
  if (a.second !== b.second) return a.second < b.second ? -1 : 1;
  if (a.fraction === b.fraction) return 0;
  return a.fraction < b.fraction ? -1 : 1;
}

function timeKey(value: string): { second: number; fraction: string } {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(
    value,
  );
  if (match) {
    return {
      second: Date.parse(`${match[1]}Z`),
      fraction: (match[2] ?? "").padEnd(9, "0"),
    };
  }
  const parsed = Date.parse(value);
  return {
    second: Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed,
    fraction: "",
  };
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
      compareTimes(chatTime(right), chatTime(left)),
    );
    const newest = group.chats[0]?.channelOrigin;
    if (newest) {
      group.sessionKey = newest.sessionKey;
      group.lastAt = newest.lastAt ?? newest.startedAt;
      group.lastSender = newest.lastSender?.name || newest.lastSender?.id;
    }
  }
  return [...groups.values()].sort((left, right) =>
    compareTimes(right.lastAt ?? "", left.lastAt ?? ""),
  );
}
