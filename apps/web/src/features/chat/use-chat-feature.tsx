import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  AgentProjection,
  AgentSession,
  ChatAttachment,
  ChatThread,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { chatUpdateTime, latestChatTime } from "./chat-time";
import { sessionStillActive, toChatSendError } from "./chat-send-error";
import {
  cancelAgentSession,
  createAgentSession,
  getChat,
  sendAgentSessionMessage,
  uploadChatAttachments,
} from "../../api";
import { runtimeMeta } from "../../components/ui/runtime-mark";
import { i18n } from "../../i18n";
import { composerSlashItems, type ComposerSlashSkills } from "./composer-slash";
import type { SlashSuggestion } from "../../components/ui/slash-menu";
import { shortUnavailableReason } from "../../lib/agent-picker";
import {
  activeThreadSession,
  activeThreadSessionForAgent,
  agentSessionStatusLabel,
  chatComposerChoices,
  agentSessionTerminalError,
  chatMessageItemId,
  chatMessages,
  chatMessagesForThread,
  chatSortValue,
  chatThreadsFromSessions,
  isChatSession,
  isTerminalSession,
  latestCopyableResponseIndex,
  latestThreadSession,
  selectedChatThread,
} from "./chat-model";
import { ChatSurface, type ChatMessageItem } from "./chat-surface";
import {
  chatContextCardForSessions,
  liveThreadSchedule,
  runningBackgroundWork,
} from "./chat-context-model";
import { chatDetailHydrationId } from "./chat-hydration-policy";
import { useChatTranscript } from "./use-chat-transcript";
import { ChatTranscriptHistory } from "./chat-transcript-history";
import { useChatSubagents } from "./use-chat-subagents";
import { withOutbox } from "./chat-outbox";
import { useChatOutbox, usePruneDeliveredOutbox } from "./use-chat-outbox";
import { useStableValue } from "./use-stable-value";
import { useChatRuntime } from "./use-chat-runtime";
import { useChatQueue } from "./use-chat-queue";
import { retainChatLayouts } from "./use-chat-layout";
import { useChatReadState, useChatTitles } from "./use-chat-list-state";
import { useUnreadTabMarker } from "./use-chat-list-state";
import { chatListStatus, threadAnswerRevision } from "./chat-list-state";
import { workspaceDenial } from "../../lib/workspace-access";
import {
  conversationStorageKey,
  conversationStoragePrefixes,
  forgetConversation,
  moveRuntimeChoice,
} from "../../components/conversation/conversation-storage";
import type { ConversationSendOutcome } from "../../components/conversation/conversation-types";

const noSessions: AgentSession[] = [];

export type ChatFeatureEvent =
  | { chatId: string; type: "chat.selected" }
  | { message: string; type: "notice.requested" }
  | { source: string; type: "issue.draft.requested" }
  /** A session started, continued or stopped, as the server answered. */
  | { session: AgentSession; type: "session.answered" }
  | {
      sessions: AgentSession[];
      type: "thread.details.loaded";
      workspaceId: string;
    };

export interface UseChatFeatureInput {
  active: boolean;
  agents: AgentProjection[];
  archivedChats: ChatThread[];
  deviceOnline: boolean;
  onEvent: (event: ChatFeatureEvent) => Promise<void> | void;
  profiles: AgentProfileProjection[];
  selectedChatId: string;
  sessions: AgentSession[];
  /** The composer "/" menu: workspace skills and each agent's own. */
  slashSkills?: ComposerSlashSkills;
  workspaceId: string;
  workspace?: WorkspaceProjection;
}

/**
 * Persistent controller for the Chat feature. It is called by the app shell so
 * drafts and attachments survive route changes, while every Chat-only state
 * remains private to this module.
 */
export function useChatFeature({
  active,
  agents,
  archivedChats,
  deviceOnline,
  onEvent,
  profiles,
  selectedChatId,
  sessions,
  slashSkills,
  workspaceId,
  workspace,
}: UseChatFeatureInput): ReactElement {
  const { i18n: activeI18n } = useTranslation();
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const emit = useCallback(
    (event: ChatFeatureEvent): Promise<void> =>
      Promise.resolve(onEventRef.current(event)),
    [],
  );

  const [activeSessionOverride, setActiveSessionOverride] =
    useState<AgentSession>();
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const [chatDetail, setChatDetail] = useState<ChatThread>();
  const [respondingSessionId, setRespondingSessionId] = useState("");
  const [contextPanelVisible, setContextPanelVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const previousWorkspaceIdRef = useRef(workspaceId);

  const chatSessions = useMemo(
    () => sessions.filter(isChatSession),
    [sessions],
  );
  const threads = useMemo(
    () => chatThreadsFromSessions(chatSessions),
    [chatSessions],
  );
  // A session Chats does not list (one working for an Issue, or started
  // by an agent) still opens by id, read-only, so its transcript is
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
  const unlistedSelection = Boolean(
    selectedThread && !threads.includes(selectedThread),
  );
  const threadSessions = selectedThread?.sessions ?? noSessions;
  const transcript = useChatTranscript({
    onLoaded: (loaded) =>
      void emit({
        sessions: loaded,
        type: "thread.details.loaded",
        workspaceId,
      }),
    sessions: threadSessions,
    threadId: selectedThread?.id,
    workspaceId,
  });
  const subagents = useChatSubagents({
    panelVisible: contextPanelVisible,
    sessions: threadSessions,
    workspaceId,
  });
  const subagentsBySession = subagents.bySession;
  const outbox = useChatOutbox(workspaceId);
  const sortedArchivedChats = useMemo(
    () =>
      archivedChats
        .filter((chat) => !chat.workspaceId || chat.workspaceId === workspaceId)
        .sort((left, right) => chatSortValue(left) - chatSortValue(right)),
    [archivedChats, workspaceId],
  );
  const selectedChatSummary = useMemo(() => {
    if (!selectedChatId) {
      return undefined;
    }
    return sortedArchivedChats.find((chat) => chat.id === selectedChatId);
  }, [selectedChatId, sortedArchivedChats]);
  const selectedChat = useMemo(() => {
    if (
      chatDetail &&
      chatDetail.id === selectedChatSummary?.id &&
      (!selectedChatSummary.workspaceId ||
        chatDetail.workspaceId === selectedChatSummary.workspaceId)
    ) {
      return chatDetail;
    }
    return selectedChatSummary;
  }, [chatDetail, selectedChatSummary]);
  const conversationThreadKey = `${workspaceId}:${selectedThread?.id ?? selectedChat?.id ?? "new"}`;
  const activeSession = useMemo(() => {
    const liveSession = activeThreadSession(selectedThread);
    if (liveSession) {
      return liveSession;
    }
    if (!activeSessionOverride || isTerminalSession(activeSessionOverride)) {
      return undefined;
    }
    const selectedThreadId = selectedThread?.id ?? selectedChatId;
    return activeSessionOverride.threadId === selectedThreadId ||
      activeSessionOverride.id === selectedThreadId ||
      activeSessionOverride.nativeSessionId === selectedThreadId
      ? activeSessionOverride
      : undefined;
  }, [activeSessionOverride, selectedChatId, selectedThread]);

  const notify = useCallback(
    (message: string): Promise<void> =>
      emit({ message, type: "notice.requested" }),
    [emit],
  );
  const {
    agentOptions,
    claudeEffort,
    claudePermissionMode,
    codexApprovalPolicy,
    codexReasoningEffort,
    codexSandboxMode,
    codexSpeed,
    modelLoadFailed,
    modelLoading,
    modelOptions,
    modelValue,
    resetOverride,
    retryModels,
    selectedAgent,
    selectAgent,
    updateOverride,
  } = useChatRuntime({
    active,
    agents,
    onNotice: notify,
    profiles,
    selectedChat,
    selectedChatId,
    selectedThread,
    threadKey: conversationThreadKey,
    workspaceId,
  });
  const composerChoices = (agent: AgentProjection) =>
    chatComposerChoices(
      agent,
      {
        claudeEffort,
        claudePermissionMode,
        codexApprovalPolicy,
        codexReasoningEffort,
        codexSandboxMode,
        codexSpeed,
        model: modelValue,
      },
      { selectedChat, thread: selectedThread },
    );
  // A new or native chat's queued messages wait in the composer for a session.
  const queue = useChatQueue({
    workspaceId,
    chatId:
      selectedThread && !unlistedSelection ? selectedThread.id : undefined,
    runSettings: () => (selectedAgent ? composerChoices(selectedAgent) : {}),
    onSent: (chatId, items) =>
      items.forEach((item) =>
        outbox.add({
          at: item.updatedAt || new Date().toISOString(),
          attachments: item.attachments,
          id: item.id,
          inputId: item.id,
          sessionId: item.sentSessionId,
          state: "accepted",
          text: item.text,
          threadId: chatId,
        }),
      ),
  });
  useEffect(() => {
    if (previousWorkspaceIdRef.current === workspaceId) {
      return;
    }
    previousWorkspaceIdRef.current = workspaceId;
    setActiveSessionOverride(undefined);
    setAttachments([]);
    setAttachmentUploading(false);
    setChatDetail(undefined);
    setRespondingSessionId("");
  }, [workspaceId]);

  useEffect(() => {
    if (!activeSessionOverride) {
      return;
    }
    const projected = sessions.find(
      (session) => session.id === activeSessionOverride.id,
    );
    if (projected && isTerminalSession(projected)) {
      setActiveSessionOverride(undefined);
    }
  }, [activeSessionOverride, sessions]);

  useEffect(() => {
    if (!selectedChatSummary) {
      setChatDetail(undefined);
      return;
    }
    const hydrationId = chatDetailHydrationId({
      hydratedChatId: chatDetail?.id,
      selectedSummary: selectedChatSummary,
      threadSelected: Boolean(selectedThread),
    });
    if (!hydrationId) {
      return;
    }
    const controller = new AbortController();
    void getChat(hydrationId, { signal: controller.signal })
      .then((chat) => {
        if (!controller.signal.aborted) {
          setChatDetail(chat);
        }
      })
      .catch(() => {
        // The summary remains usable for the chat list and composer, and an
        // aborted read belongs to a selection the user already left.
      });
    return () => {
      controller.abort();
    };
  }, [chatDetail?.id, selectedChatSummary, selectedThread, workspaceId]);

  useEffect(() => {
    if (!respondingSessionId) {
      return;
    }
    const session = sessions.find((item) => item.id === respondingSessionId);
    if (!session || !isTerminalSession(session)) {
      return;
    }
    setRespondingSessionId("");
    void emit({
      message:
        session.status === "failed"
          ? i18n.t("chat:notices.agentFailed", {
              agent:
                session.profileLabel ?? runtimeMeta(session.provider).label,
            })
          : "",
      type: "notice.requested",
    });
  }, [emit, respondingSessionId, sessions]);

  const projection = useMemo(
    () =>
      withOutbox(
        selectedThread
          ? chatMessagesForThread(selectedThread, {
              suppressedResponseFingerprints: subagents.responseFingerprints,
            })
          : chatMessages(selectedChat),
        outbox.entries,
        selectedThread?.id,
      ),
    [
      outbox.entries,
      selectedChat,
      selectedThread,
      subagents.responseFingerprints,
    ],
  );
  const viewMessages = projection.messages;
  usePruneDeliveredOutbox(outbox, projection.delivered);
  const messages = useMemo((): ChatMessageItem[] => {
    const latestResponseIndex = latestCopyableResponseIndex(viewMessages);
    let latestEditableUserIndex = -1;
    if (!activeSession) {
      for (let index = viewMessages.length - 1; index >= 0; index -= 1) {
        const message = viewMessages[index];
        if (
          message &&
          message.role === "user" &&
          (message.kind === undefined || message.kind === "message") &&
          message.text.trim() !== ""
        ) {
          latestEditableUserIndex = index;
          break;
        }
      }
    }
    return viewMessages.map((message, index) => ({
      ...message,
      copyAlways: index === latestResponseIndex,
      copyText:
        typeof message.text === "string" &&
        (message.kind === undefined || message.kind === "message") &&
        message.text.trim() !== ""
          ? message.text
          : undefined,
      editable: index === latestEditableUserIndex,
      editText: index === latestEditableUserIndex ? message.text : undefined,
      id: chatMessageItemId(message, index),
      onTurnIntoIssue: message.idea
        ? () =>
            void emit({
              source: message.idea ?? "",
              type: "issue.draft.requested",
            })
        : undefined,
    }));
  }, [activeSession, emit, viewMessages]);
  // The side panel follows the transcript a moment later, and only renders
  // again when what it shows changed.
  const contextSessions = useDeferredValue(threadSessions);
  const contextCard = useStableValue(
    useMemo(
      () =>
        chatContextCardForSessions(
          contextSessions,
          subagentsBySession,
          workspace,
        ),
      // The timer labels are written in the viewer's language.
      [contextSessions, subagentsBySession, workspace, activeI18n.language],
    ),
  );
  const backgroundWork = useMemo(
    () => runningBackgroundWork(contextCard),
    [contextCard],
  );
  const schedule = useMemo(
    () => liveThreadSchedule(threadSessions),
    [threadSessions],
  );

  const addAttachments = useCallback(
    async (files: File[]): Promise<void> => {
      if (files.length === 0) {
        return;
      }
      if (!workspaceId) {
        await emit({
          message: i18n.t("chat:notices.attachNeedsWorkspace"),
          type: "notice.requested",
        });
        return;
      }
      try {
        setAttachmentUploading(true);
        const uploaded = await uploadChatAttachments({ files, workspaceId });
        setAttachments((current) => [...current, ...uploaded]);
        const firstUpload = uploaded[0];
        await emit({
          message:
            uploaded.length === 1 && firstUpload
              ? i18n.t("chat:notices.attachedOne", { name: firstUpload.name })
              : i18n.t("chat:notices.attachedMany", {
                  count: uploaded.length,
                }),
          type: "notice.requested",
        });
      } catch {
        await emit({
          message: i18n.t("chat:notices.attachFailed"),
          type: "notice.requested",
        });
      } finally {
        setAttachmentUploading(false);
      }
    },
    [emit, workspaceId],
  );

  const removeAttachment = useCallback((id: string): void => {
    setAttachments((current) =>
      current.filter((attachment) => attachment.id !== id),
    );
  }, []);

  const restoreAttachments = useCallback((restored: ChatAttachment[]): void => {
    setAttachments((current) => {
      const existingIds = new Set(current.map((attachment) => attachment.id));
      const additions = restored.filter(
        (attachment) => !existingIds.has(attachment.id),
      );
      return additions.length > 0 ? [...current, ...additions] : current;
    });
  }, []);

  async function send(
    draft: string,
    queuedAttachments?: ChatAttachment[],
    options?: { idempotencyKey?: string },
  ): Promise<ConversationSendOutcome> {
    if (!deviceOnline) {
      await emit({
        message: i18n.t("chat:notices.offlineSend"),
        type: "notice.requested",
      });
      return false;
    }
    const prompt = draft.trim();
    const effectiveAttachments = queuedAttachments ?? attachments;
    if (!prompt && effectiveAttachments.length === 0) {
      await emit({
        message: i18n.t("chat:notices.emptyPrompt"),
        type: "notice.requested",
      });
      return false;
    }
    if (attachmentUploading) {
      await emit({
        message: i18n.t("chat:notices.uploading"),
        type: "notice.requested",
      });
      return false;
    }
    if (!workspaceId || !selectedAgent) {
      await emit({
        message: i18n.t("chat:notices.noAgent"),
        type: "notice.requested",
      });
      return false;
    }
    if (selectedAgent.status !== "healthy") {
      await emit({
        message: i18n.t("chat:notices.agentNotReady", {
          agent:
            selectedAgent.profileLabel ??
            runtimeMeta(selectedAgent.provider).label,
        }),
        type: "notice.requested",
      });
      return false;
    }

    try {
      setSubmitting(true);
      if (activeSession) {
        await emit({
          message: i18n.t("chat:notices.stillResponding", {
            agent:
              activeSession.profileLabel ??
              runtimeMeta(activeSession.provider).label,
          }),
          type: "notice.requested",
        });
        return false;
      }
      const activeSameProfile = activeThreadSessionForAgent(
        selectedThread,
        selectedAgent,
      );
      if (activeSameProfile) {
        await emit({
          message: i18n.t("chat:notices.alreadyResponding", {
            agent:
              selectedAgent.profileLabel ??
              runtimeMeta(selectedAgent.provider).label,
          }),
          type: "notice.requested",
        });
        return false;
      }
      // An open Foundry chat is one session: the message continues it. An
      // open native chat is adopted by the new session; the server tells
      // each native session what it has not seen.
      const continuedSession = selectedThread
        ? latestThreadSession(selectedThread)
        : undefined;
      const chatForSend = selectedThread ? undefined : selectedChat;
      const submittedAttachmentIds = new Set(
        effectiveAttachments.map((attachment) => attachment.id),
      );
      // One id for this message: its Idempotency-Key, its input id and its
      // outbox entry, which tells the composer once the transcript shows it.
      const clientId = options?.idempotencyKey ?? crypto.randomUUID();
      const message = {
        ...composerChoices(selectedAgent),
        attachments: effectiveAttachments,
        inputId: clientId,
        prompt,
      };
      let session: AgentSession;
      outbox.add({
        at: new Date().toISOString(),
        attachments: effectiveAttachments,
        id: clientId,
        sessionId: continuedSession?.id,
        state: "pending",
        text: prompt,
        threadId: selectedThread?.id,
      });
      try {
        session = continuedSession
          ? await sendAgentSessionMessage(
              continuedSession.id,
              // A turn that started meanwhile (a queued message went first)
              // must not take this one as a steer: it is queued instead.
              { ...message, requireIdle: true },
              clientId,
            )
          : await createAgentSession(
              {
                ...message,
                chatId: chatForSend?.id,
                source: "chat",
                workspaceId,
              },
              clientId,
            );
      } catch (reason) {
        outbox.remove(clientId);
        // The turn started meanwhile: the message waits for it to end.
        if (continuedSession && sessionStillActive(reason)) return "queue";
        // Surface a safe, specific cause in the composer Alert. Throwing lets
        // useConversationInput retain the draft/attachments and require an
        // explicit retry (no auto-replay); busy protection is in its finally.
        throw toChatSendError(reason);
      }
      // The message is persisted server-side from here on. View-sync failures
      // must not look like an unsent draft, or the user could replay a session
      // that was already created.
      outbox.accept(clientId, {
        inputId: session.input?.id,
        sessionId: session.id,
        threadId: session.threadId || session.nativeSessionId || session.id,
      });
      setActiveSessionOverride(session);
      setRespondingSessionId(session.id);
      // A new chat or an adopted native chat is now this session's thread;
      // its unsent draft, queued messages and runtime choice move with it.
      const sessionThreadKey = `${workspaceId}:${session.threadId || session.nativeSessionId || session.id}`;
      moveRuntimeChoice(conversationThreadKey, sessionThreadKey);
      if (!queuedAttachments) {
        setAttachments((current) =>
          current.filter(
            (attachment) => !submittedAttachmentIds.has(attachment.id),
          ),
        );
      }
      try {
        await emit({ session, type: "session.answered" });
        await emit({
          chatId: session.threadId ?? session.nativeSessionId ?? session.id,
          type: "chat.selected",
        });
        await emit({
          message: i18n.t("chat:notices.responding", {
            agent:
              selectedAgent.profileLabel ??
              runtimeMeta(selectedAgent.provider).label,
          }),
          type: "notice.requested",
        });
      } catch {
        // Already persisted; a later snapshot/refresh projects the session.
      }
      return { threadKey: sessionThreadKey };
    } finally {
      setSubmitting(false);
    }
  }

  async function steer(
    draft: string,
    sessionId?: string,
    steeredAttachments: ChatAttachment[] = [],
  ): Promise<boolean> {
    if (!deviceOnline) {
      await emit({
        message: i18n.t("chat:notices.offlineSteer"),
        type: "notice.requested",
      });
      return false;
    }
    const message = draft.trim();
    if (!message && steeredAttachments.length === 0) {
      await emit({
        message: i18n.t("chat:notices.emptySteer"),
        type: "notice.requested",
      });
      return false;
    }
    const targetSession =
      (sessionId
        ? sessions.find((session) => session.id === sessionId)
        : undefined) ??
      (sessionId === activeSessionOverride?.id
        ? activeSessionOverride
        : undefined) ??
      activeSession;
    if (!targetSession) {
      await emit({
        message: i18n.t("chat:notices.noSteerTarget"),
        type: "notice.requested",
      });
      return false;
    }
    try {
      await sendAgentSessionMessage(targetSession.id, {
        prompt: message,
        attachments: steeredAttachments.length ? steeredAttachments : undefined,
      });
      // The steer reaches the transcript as the device's event.
      await emit({
        message: i18n.t("chat:notices.steered"),
        type: "notice.requested",
      });
      return true;
    } catch (error) {
      await emit({
        message:
          error instanceof Error
            ? error.message
            : i18n.t("chat:notices.steerFailed"),
        type: "notice.requested",
      });
      return false;
    }
  }

  async function cancel(sessionId?: string): Promise<void> {
    const targetSession =
      (sessionId
        ? sessions.find((session) => session.id === sessionId)
        : undefined) ??
      (sessionId === activeSessionOverride?.id
        ? activeSessionOverride
        : undefined) ??
      activeSession;
    if (!targetSession) {
      await emit({
        message: i18n.t("chat:notices.noStopTarget"),
        type: "notice.requested",
      });
      return;
    }
    if (!deviceOnline) {
      await emit({
        message: i18n.t("chat:notices.offlineStop"),
        type: "notice.requested",
      });
      return;
    }
    try {
      const session = await cancelAgentSession(targetSession.id);
      setActiveSessionOverride(undefined);
      setRespondingSessionId("");
      await emit({ session, type: "session.answered" });
      await emit({
        chatId: session.threadId ?? session.nativeSessionId ?? session.id,
        type: "chat.selected",
      });
      await emit({
        message: i18n.t("chat:notices.stopped"),
        type: "notice.requested",
      });
    } catch (error) {
      await emit({
        message:
          error instanceof Error
            ? error.message
            : i18n.t("chat:notices.stopFailed"),
        type: "notice.requested",
      });
    }
  }

  const titleState = useChatTitles(workspaceId, active, notify);
  // The chat list's layout stays current between its visits: no read then.
  useEffect(() => retainChatLayouts(), []);
  const selectedId = selectedThread?.id ?? selectedChat?.id ?? "";
  const selectionRef = useRef({ workspaceId, selectedId });
  selectionRef.current = { workspaceId, selectedId };
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

  const sessionChats = threads.map((thread) => {
    const latest = latestThreadSession(thread);
    const terminalError = latest
      ? agentSessionTerminalError(latest)
      : undefined;
    const answer = threadAnswerRevision(thread.sessions);
    const unread = readState.unread(thread.id, answer);
    return {
      ...menuActions(thread.id),
      id: thread.id,
      onSelect: () => {
        readState.read(thread.id, answer);
        void emit({ chatId: thread.id, type: "chat.selected" });
      },
      runtime: latest?.provider ?? thread.sessions[0]?.provider,
      selected: thread.id === selectedThread?.id,
      title: titleState.titles[thread.id]?.title || thread.title,
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
      status: chatListStatus(
        Boolean(activeThreadSession(thread)),
        Boolean(terminalError || latest?.status === "failed"),
        unread,
        latest?.status === "blocked",
      ),
      blocked: latest?.status === "blocked",
      blockedReason: latest?.blockedReason,
      spawned: Boolean(latest?.parentSessionId),
      unread,
      foundrySessionId: latest?.id ?? thread.id,
      nativeSessionId: latest?.nativeSessionId,
    };
  });
  // The server lists only native chats no Foundry session owns.
  const archiveChats = sortedArchivedChats.map((chat) => ({
    ...menuActions(chat.id),
    id: chat.id,
    onSelect: () => {
      readState.read(chat.id, chat.answerRevision ?? "");
      void emit({ chatId: chat.id, type: "chat.selected" });
    },
    runtime: chat.provider,
    selected: chat.id === selectedChat?.id && !selectedThread,
    title: titleState.titles[chat.id]?.title || chat.title,
    activityAt: chat.updatedAt,
    updateTime: chatUpdateTime(chat.updatedAt, chat.updatedLabel),
    status: chatListStatus(
      chat.status === "running" || chat.status === "queued",
      chat.status === "failed",
      readState.unread(chat.id, chat.answerRevision ?? ""),
      chat.status === "blocked",
    ),
    blocked: chat.status === "blocked",
    unread: readState.unread(chat.id, chat.answerRevision ?? ""),
    foundrySessionId: chat.id,
    nativeSessionId: chat.nativeSessionId,
  }));
  const history = useMemo(
    () => (
      <ChatTranscriptHistory
        onLoadEarlier={transcript.loadEarlier}
        onRetry={transcript.retry}
        state={transcript.state}
      />
    ),
    [transcript.loadEarlier, transcript.retry, transcript.state],
  );
  // What the list shows rarely changes while a transcript streams; then it
  // keeps its identity and the list does not render again.
  const listChats = useStableValue(
    [...sessionChats, ...archiveChats],
    threads.map((thread) => threadAnswerRevision(thread.sessions)).join("\n"),
  );
  useUnreadTabMarker(listChats, selectedId);

  return (
    <ChatSurface
      readOnlyReason={
        unlistedSelection
          ? i18n.t("chat:thread.workingForIssue")
          : workspaceDenial(workspace, "member")
      }
      onChatsDeleted={async (ids) => {
        ids.forEach((id) => {
          const key = conversationStorageKey(
            conversationStoragePrefixes.chat,
            `${workspaceId}:${id}`,
          );
          if (key) forgetConversation(key);
        });
        if (selectionRef.current.workspaceId !== workspaceId) return;
        if (ids.includes(selectionRef.current.selectedId)) {
          setActiveSessionOverride(undefined);
          setChatDetail(undefined);
          await emit({ chatId: "", type: "chat.selected" });
        }
      }}
      workspaceId={workspaceId}
      agentActive={Boolean(activeSession)}
      agentActiveSessionId={activeSession?.id}
      agentOptions={agentOptions}
      attachmentUploading={attachmentUploading}
      attachments={attachments}
      chats={listChats}
      chatTitle={
        titleState.titles[selectedId]?.title ||
        selectedThread?.title ||
        selectedChat?.title ||
        i18n.t("chat:list.newChat")
      }
      contextCard={contextCard}
      history={history}
      onReachHistoryStart={transcript.loadEarlier}
      onContextPanelVisibleChange={setContextPanelVisible}
      onRetrySubagents={subagents.failed ? subagents.retry : undefined}
      backgroundWork={backgroundWork}
      schedule={schedule}
      claudeEffort={claudeEffort}
      claudePermissionMode={claudePermissionMode}
      codexApprovalPolicy={codexApprovalPolicy}
      codexReasoningEffort={codexReasoningEffort}
      codexSandboxMode={codexSandboxMode}
      codexSpeed={codexSpeed}
      modelLoading={modelLoading}
      modelOptions={modelOptions}
      modelLoadFailed={modelLoadFailed}
      modelValue={modelValue}
      messages={messages}
      slashSkills={composerSlashItems(slashSkills, selectedAgent?.provider)}
      onAgentChange={selectAgent}
      onAttachmentsAdd={(files) => void addAttachments(files)}
      onAttachmentRemove={removeAttachment}
      onAttachmentsRestore={restoreAttachments}
      onCancelActive={cancel}
      onClaudeEffortChange={(value) => updateOverride({ claudeEffort: value })}
      onClaudePermissionModeChange={(value) =>
        updateOverride({ claudePermissionMode: value })
      }
      onCodexApprovalPolicyChange={(value) =>
        updateOverride({ codexApprovalPolicy: value })
      }
      onCodexReasoningEffortChange={(value) =>
        updateOverride({ codexReasoningEffort: value })
      }
      onCodexSandboxModeChange={(value) =>
        updateOverride({ codexSandboxMode: value })
      }
      onCodexSpeedChange={(value) => updateOverride({ codexSpeed: value })}
      onModelChange={(value) => updateOverride({ model: value })}
      onNewChat={() => {
        setAttachments([]);
        void emit({ chatId: "", type: "chat.selected" });
      }}
      onResetControls={resetOverride}
      onRetryModels={retryModels}
      onSend={send}
      onSteer={steer}
      queue={queue}
      selectedAgentId={selectedAgent?.id ?? ""}
      sendDisabled={
        !deviceOnline || !selectedAgent || selectedAgent.status !== "healthy"
      }
      sendDisabledReason={
        !deviceOnline
          ? i18n.t("agents:picker.deviceOffline")
          : selectedAgent && selectedAgent.status !== "healthy"
            ? shortUnavailableReason(
                selectedAgent.status,
                selectedAgent.statusDetail,
              )
            : undefined
      }
      sending={submitting}
      threadKey={conversationThreadKey}
    />
  );
}
