import type { ChatListItem } from "../chat-surface-types";

/**
 * The chats that wait for the person: those with open pending items (a
 * question, a failed run, something only the person can do), most first,
 * otherwise in list order. An unread answer alone does not count: most
 * finished chats are never opened again, so it says little.
 */
export function chatsNeedingMe(chats: readonly ChatListItem[]): ChatListItem[] {
  return chats
    .map((chat, index) => ({ chat, index, count: chat.pendingCount ?? 0 }))
    .filter((entry) => entry.count > 0)
    .sort((left, right) => right.count - left.count || left.index - right.index)
    .map((entry) => entry.chat);
}
