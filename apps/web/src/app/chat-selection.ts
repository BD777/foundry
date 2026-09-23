/**
 * Chat selection precedence for a freshly loaded payload.
 *
 * `App` derives the chat identities (chats, chat sessions, and the threads
 * grouped from those sessions) with the chat feature's public helpers and
 * passes them here, so the reconciliation rules stay pure and testable while
 * thread grouping stays owned by the chat feature.
 */
export interface LoadedChatSelection {
  chats: Array<{ id: string }>;
  chatSessions: Array<{ id: string }>;
  chatThreads: Array<{ id: string }>;
  /** The chat the chat feature prefers when no thread exists. */
  preferredChatId: string;
}

/** The chat to open when nothing valid is selected yet. */
export function firstLoadedChatId(loaded: LoadedChatSelection): string {
  return loaded.chatThreads[0]?.id ?? loaded.preferredChatId;
}

/**
 * Keep the current selection when it still resolves after a load -- as a chat,
 * as a thread derived from agent sessions, or as a raw session -- otherwise
 * fall back to the first loaded chat.
 */
export function resolveLoadedChatSelection(
  loaded: LoadedChatSelection,
  current: string,
): string {
  const stillLoaded =
    loaded.chats.some((chat) => chat.id === current) ||
    loaded.chatThreads.some((thread) => thread.id === current) ||
    loaded.chatSessions.some((session) => session.id === current);
  return stillLoaded ? current : firstLoadedChatId(loaded);
}
