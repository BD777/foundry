import { useCallback, useMemo, useState } from "react";
import type { AgentSession, ChatThread } from "@bd777/foundry-protocol";
import {
  chatThreadsFromSessions,
  isChatSession,
  selectedChatThread,
  sessionsHoldChat,
} from "./chat-session-model";
import { mergeLoadedAgentSession } from "../../lib/agent-session-events";
import { useLinkedChatSession } from "./use-linked-chat-session";

/**
 * The chat the selection names among the workspace's sessions. A chat
 * opened by link that the list does not hold (older than it reaches, or not
 * in this workspace) is looked up by id: shown when it is this workspace's,
 * otherwise explained (`linked`) — never another chat instead.
 */
export function useChatSelection({
  nativeChats,
  ready,
  selectedChatId,
  sessions: listedSessions,
  workspaceId,
}: {
  nativeChats: readonly ChatThread[];
  ready: boolean;
  selectedChatId: string;
  sessions: AgentSession[];
  workspaceId: string;
}) {
  const listed = Boolean(
    selectedChatId &&
    (sessionsHoldChat(listedSessions, selectedChatId) ||
      nativeChats.some(
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
  // Archived summaries live outside the shell's active session projection.
  // Retain their loaded windows here; the shell cannot merge details into a
  // session it no longer lists, and the summary already suppresses id lookup.
  const [archiveDetails, setArchiveDetails] = useState<{
    workspaceId: string;
    sessions: Map<string, AgentSession>;
  }>(() => ({ workspaceId, sessions: new Map() }));
  const mergeLinkedDetails = useCallback(
    (loaded: readonly AgentSession[]) => {
      mergeLoaded(loaded);
      const archived = loaded.flatMap((session) => {
        const summary = listedSessions.find(
          (item) =>
            item.id === session.id &&
            item.archivedAt &&
            item.workspaceId === workspaceId,
        );
        return summary && session.workspaceId === workspaceId
          ? [{ session, summary }]
          : [];
      });
      if (!archived.length) return;
      setArchiveDetails((current) => {
        const next = new Map(
          current.workspaceId === workspaceId ? current.sessions : [],
        );
        for (const { session, summary } of archived) {
          const held = next.get(session.id);
          const sameArchive =
            held?.archivedAt === summary.archivedAt &&
            held?.archiveBatchId === summary.archiveBatchId;
          next.set(session.id, {
            ...mergeLoadedAgentSession(sameArchive ? held : undefined, session),
            archivedAt: summary.archivedAt,
            archiveBatchId: summary.archiveBatchId,
          });
        }
        return { workspaceId, sessions: next };
      });
    },
    [mergeLoaded, listedSessions, workspaceId],
  );
  const hydratedSessions = useMemo(
    () =>
      listedSessions.map((summary) => {
        const detail =
          archiveDetails.workspaceId === workspaceId
            ? archiveDetails.sessions.get(summary.id)
            : undefined;
        return summary.archivedAt &&
          detail?.archivedAt === summary.archivedAt &&
          detail.archiveBatchId === summary.archiveBatchId
          ? mergeLoadedAgentSession(detail, summary)
          : summary;
      }),
    [archiveDetails, listedSessions, workspaceId],
  );
  const linkedSession = linked.state === "found" ? linked.session : undefined;
  const sessions = useMemo(
    () =>
      linkedSession &&
      !hydratedSessions.some((session) => session.id === linkedSession.id)
        ? [...hydratedSessions, linkedSession]
        : hydratedSessions,
    [linkedSession, hydratedSessions],
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
    mergeLinkedDetails,
    selectedThread,
    sessions,
    threads,
    unlistedSelection: Boolean(
      selectedThread && !threads.includes(selectedThread),
    ),
  };
}
