import { useEffect } from "react";
import type { ChatThread, DeviceProjection } from "@bd777/foundry-protocol";
import { deviceAwaitedBy } from "../../lib/device-wait";
import { isSessionLive } from "../../lib/session-status";
import { chatUpdateTime, latestChatTime } from "./chat-time";
import {
  activeThreadSession,
  agentSessionTerminalError,
  chatStartedByLabel,
  latestThreadSession,
} from "./chat-model";
import { liveThreadSchedule } from "./chat-schedule-model";
import type { NamedSessions } from "./chat-session-model";
import { chatListStatus, threadAnswerRevision } from "./chat-list-state";
import type { ChatSessionThread } from "./chat-types";
import type { ChatListItem } from "./chat-surface-types";
import { useStableValue } from "./use-stable-value";
import { retainChatLayouts } from "./use-chat-layout";
import {
  useChatReadState,
  useChatTitles,
  useUnreadTabMarker,
} from "./use-chat-list-state";

/**
 * The chat list's rows: the workspace's session chats, then the native
 * chats no Foundry session owns, with their titles, read state and menu
 * actions. `chats` keeps its identity while what the list shows is unchanged.
 */
export function useChatListItems({
  active,
  archivedChats,
  devices,
  namedSessions,
  notify,
  onSelectChat,
  selectedChat,
  selectedId,
  selectedThread,
  threads,
  workspaceId,
}: {
  active: boolean;
  /** The workspace's native chats, in list order. */
  archivedChats: readonly ChatThread[];
  /** Names the offline device a chat's queued session waits for. */
  devices: readonly DeviceProjection[];
  /** The server's names for sessions that started chats the list lacks. */
  namedSessions?: NamedSessions;
  notify: (message: string) => void;
  onSelectChat: (chatId: string) => void;
  selectedChat?: ChatThread;
  selectedId: string;
  selectedThread?: ChatSessionThread;
  threads: readonly ChatSessionThread[];
  workspaceId: string;
}): {
  chats: ChatListItem[];
  titles: ReturnType<typeof useChatTitles>["titles"];
} {
  const titleState = useChatTitles(workspaceId, active, notify);
  // The chat list's layout stays current between its visits: no read then.
  useEffect(() => retainChatLayouts(), []);
  const selectedAnswer = selectedThread
    ? threadAnswerRevision(selectedThread.sessions)
    : (selectedChat?.answerRevision ?? "");
  const readState = useChatReadState(
    workspaceId,
    active,
    selectedId,
    selectedAnswer,
  );
  const menuActions = (id: string) => ({
    onRename: (title: string) => titleState.rename(id, title),
    onAutoRename: () => titleState.recap(id),
    onMarkUnread: () => readState.markUnread(id),
    onNotify: notify,
    renaming: ["queued", "running"].includes(
      titleState.titles[id]?.generationStatus ?? "",
    ),
  });

  const threadTitle = (thread: ChatSessionThread) =>
    titleState.titles[thread.id]?.title || thread.title;
  const sessionChats = threads.map((thread) => {
    const latest = latestThreadSession(thread);
    const terminalError = latest
      ? agentSessionTerminalError(latest)
      : undefined;
    const answer = threadAnswerRevision(thread.sessions);
    const unread = readState.unread(thread.id, answer);
    const awaitedDevice = deviceAwaitedBy(latest, devices);
    return {
      ...menuActions(thread.id),
      id: thread.id,
      onSelect: () => {
        readState.read(thread.id, answer);
        onSelectChat(thread.id);
      },
      runtime: latest?.provider ?? thread.sessions[0]?.provider,
      selected: thread.id === selectedThread?.id,
      title: threadTitle(thread),
      activityAt: latest?.activityAt,
      updateTime: chatUpdateTime(
        latest?.activityAt ??
          latestChatTime([
            ...thread.sessions.flatMap((session) => [
              session.startedAt,
              session.completedAt,
            ]),
          ]),
        latest?.updatedLabel,
      ),
      status: awaitedDevice
        ? ("waiting" as const)
        : chatListStatus(
            Boolean(activeThreadSession(thread)),
            Boolean(terminalError || latest?.status === "failed"),
            unread,
            latest?.status === "blocked",
          ),
      blocked: latest?.status === "blocked",
      blockedReason: latest?.blockedReason,
      waitingFor: awaitedDevice?.label,
      scheduled: Boolean(liveThreadSchedule(thread.sessions)),
      startedBy: chatStartedByLabel(
        thread.sessions[0],
        threads,
        threadTitle,
        namedSessions,
      ),
      unread,
      foundrySessionId: latest?.id ?? thread.id,
      nativeSessionId: latest?.nativeSessionId,
    };
  });
  // The server lists only native chats no Foundry session owns.
  const archiveChats = archivedChats.map((chat) => ({
    ...menuActions(chat.id),
    id: chat.id,
    onSelect: () => {
      readState.read(chat.id, chat.answerRevision ?? "");
      onSelectChat(chat.id);
    },
    runtime: chat.provider,
    selected: chat.id === selectedChat?.id && !selectedThread,
    title: titleState.titles[chat.id]?.title || chat.title,
    activityAt: chat.updatedAt,
    updateTime: chatUpdateTime(chat.updatedAt, chat.updatedLabel),
    status: chatListStatus(
      isSessionLive(chat),
      chat.status === "failed",
      readState.unread(chat.id, chat.answerRevision ?? ""),
      chat.status === "blocked",
    ),
    blocked: chat.status === "blocked",
    unread: readState.unread(chat.id, chat.answerRevision ?? ""),
    foundrySessionId: chat.id,
    nativeSessionId: chat.nativeSessionId,
  }));
  // What the list shows rarely changes while a transcript streams; then it
  // keeps its identity and the list does not render again.
  const chats = useStableValue(
    [...sessionChats, ...archiveChats],
    threads.map((thread) => threadAnswerRevision(thread.sessions)).join("\n"),
  );
  useUnreadTabMarker(chats, selectedId);
  return { chats, titles: titleState.titles };
}
