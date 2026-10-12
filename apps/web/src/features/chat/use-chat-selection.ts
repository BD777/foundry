import { useMemo } from "react";
import type { AgentSession, ChatThread } from "@bd777/foundry-protocol";
import {
  chatThreadsFromSessions,
  isChatSession,
  selectedChatThread,
  sessionsHoldChat,
} from "./chat-session-model";
import { useLinkedChatSession } from "./use-linked-chat-session";

/**
 * The chat the selection names among the workspace's sessions. A chat
 * opened by link that the list does not hold (older than it reaches, or not
 * in this workspace) is looked up by id: shown when it is this workspace's,
 * otherwise explained (`linked`) — never another chat instead.
 */
export function useChatSelection({
  archivedChats,
  ready,
  selectedChatId,
  sessions: listedSessions,
  workspaceId,
}: {
  archivedChats: readonly ChatThread[];
  ready: boolean;
  selectedChatId: string;
  sessions: AgentSession[];
  workspaceId: string;
}) {
  const listed = Boolean(
    selectedChatId &&
    (sessionsHoldChat(listedSessions, selectedChatId) ||
      archivedChats.some(
        (chat) =>
          chat.id === selectedChatId &&
          (!chat.workspaceId || chat.workspaceId === workspaceId),
      )),
  );
  const { linked, mergeLoaded } = useLinkedChatSession({
    id: selectedChatId,
    listed,
    ready,
    workspaceId,
  });
  const linkedSession = linked.state === "found" ? linked.session : undefined;
  const sessions = useMemo(
    () =>
      linkedSession &&
      !listedSessions.some((session) => session.id === linkedSession.id)
        ? [...listedSessions, linkedSession]
        : listedSessions,
    [linkedSession, listedSessions],
  );
  const threads = useMemo(
    () => chatThreadsFromSessions(sessions.filter(isChatSession)),
    [sessions],
  );
  // A session Chats does not list (one working for an Issue, see
  // isChatSession) still opens by id, read-only, so its transcript is
  // reachable from wherever it is shown.
  const selectedThread = useMemo(
    () =>
      selectedChatThread(threads, selectedChatId) ??
      selectedChatThread(
        chatThreadsFromSessions(
          sessions.filter(
            (session) =>
              !isChatSession(session) && session.id === selectedChatId,
          ),
        ),
        selectedChatId,
      ),
    [selectedChatId, sessions, threads],
  );
  return {
    linked,
    mergeLinkedDetails: mergeLoaded,
    selectedThread,
    sessions,
    threads,
    unlistedSelection: Boolean(
      selectedThread && !threads.includes(selectedThread),
    ),
  };
}
