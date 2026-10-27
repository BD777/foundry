import type { AgentSession, ChatThread } from "@bd777/foundry-protocol";
import type { ArchivedChat } from "./chat-archive-banner";

/** A successful restore leaves Archived immediately, even if the refresh fails. */
export function archivedChatRows(
  chats: readonly ChatThread[],
  sessions: readonly AgentSession[],
  restored: ReadonlySet<string>,
  titles: Readonly<Record<string, { title?: string }>>,
): ArchivedChat[] {
  return [
    ...chats,
    ...sessions
      .filter((session) => !chats.some((chat) => chat.id === session.id))
      .map((session) => ({
        ...session,
        title: titles[session.id]?.title || session.title || session.id,
      })),
  ].filter((chat) => !restored.has(chat.id));
}
