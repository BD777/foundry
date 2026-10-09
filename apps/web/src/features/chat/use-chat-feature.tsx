import {
  useCallback,
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
  AgentSubagentSummary,
  ChatAttachment,
  ChatThread,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { chatUpdateTime, latestChatTime } from "./chat-time";
import { toChatSendError } from "./chat-send-error";
import {
  cancelAgentSession,
  createAgentSession,
  getAgentSessionThread,
  getChat,
  listAgentSubagents,
  sendAgentSessionMessage,
  uploadChatAttachments,
} from "../../api";
import { runtimeMeta } from "../../components/ui/runtime-mark";
import { i18n } from "../../i18n";
import { composerSlashItems, type ComposerSlashSkills } from "./composer-slash";
import type { SlashSuggestion } from "../../components/ui/slash-menu";
import { agentSessionNeedsDetails } from "../../lib/agent-session-events";
import { shortUnavailableReason } from "../../lib/agent-picker";
import {
  activeThreadSession,
  activeThreadSessionForAgent,
  agentSessionStatusLabel,
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
  profileTransitionNoteForSend,
  selectedChatThread,
} from "./chat-model";
import { ChatSurface, type ChatMessageItem } from "./chat-surface";
import {
  chatContextCardForSessions,
  runningBackgroundWork,
} from "./chat-context-model";
import {
  chatDetailHydrationId,
  sessionThreadHydrationId,
  sessionThreadHydrationRevision,
  subagentDiscoveryRevision,
  subagentDiscoverySessionIds,
} from "./chat-hydration-policy";
import { hydrateSessionThreadWithRetry } from "./chat-transcript-hydration";
import { useChatRuntime } from "./use-chat-runtime";
import { useChatReadState, useChatTitles } from "./use-chat-list-state";
import { chatListStatus, threadAnswerRevision } from "./chat-list-state";
import { workspaceDenial } from "../../lib/workspace-access";
import {
  conversationStorageKey,
  conversationStoragePrefixes,
  forgetConversation,
  moveRuntimeChoice,
} from "../../components/conversation/conversation-storage";
import type { ConversationSendOutcome } from "../../components/conversation/conversation-types";

export type ChatFeatureEvent =
  | { chatId: string; type: "chat.selected" }
  | { message: string; type: "notice.requested" }
  | { source: string; type: "issue.draft.requested" }
  | { type: "data.refresh.requested" }
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
  const [subagentsBySession, setSubagentsBySession] = useState<
    Record<string, AgentSubagentSummary[]>
  >({});
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
  const sessionsNeedingDetails = useMemo(
    () => (selectedThread?.sessions ?? []).filter(agentSessionNeedsDetails),
    [selectedThread],
  );
  const detailHydrationId = sessionThreadHydrationId(
    selectedThread?.id,
    sessionsNeedingDetails.map((session) => session.id),
  );
  const detailHydrationRevision = sessionThreadHydrationRevision(
    selectedThread?.id,
    sessionsNeedingDetails,
  );
  const discoverableSessionIds = useMemo(
    () => subagentDiscoverySessionIds(selectedThread?.sessions ?? []),
    [selectedThread],
  );
  const subagentRevision = useMemo(
    () => subagentDiscoveryRevision(selectedThread?.sessions ?? []),
    [selectedThread],
  );
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
    setSubagentsBySession({});
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
    if (!detailHydrationId || !workspaceId) {
      return;
    }
    const controller = new AbortController();
    void hydrateSessionThreadWithRetry({
      load: (signal) =>
        getAgentSessionThread(detailHydrationId, workspaceId, { signal }),
      onLoaded: (loadedSessions) =>
        emit({
          sessions: loadedSessions,
          type: "thread.details.loaded",
          workspaceId,
        }),
      signal: controller.signal,
    });
    return () => {
      controller.abort();
    };
  }, [detailHydrationId, detailHydrationRevision, emit, workspaceId]);

  useEffect(() => {
    if (discoverableSessionIds.length === 0) {
      return;
    }
    const controller = new AbortController();
    void Promise.all(
      discoverableSessionIds.map(async (sessionId) => {
        try {
          return [
            sessionId,
            await listAgentSubagents(sessionId, {
              signal: controller.signal,
            }),
          ] as const;
        } catch {
          return [sessionId, [] as AgentSubagentSummary[]] as const;
        }
      }),
    )
      .then((entries) => {
        if (!controller.signal.aborted) {
          setSubagentsBySession((current) => ({
            ...current,
            ...Object.fromEntries(entries),
          }));
        }
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [subagentRevision, workspaceId]);

  const suppressedSubagentResponses = useMemo(
    () =>
      new Set(
        Object.values(subagentsBySession)
          .flatMap((subagents) =>
            subagents.flatMap((subagent) => subagent.responseTexts),
          )
          .map((text) => text.trim())
          .filter(Boolean),
      ),
    [subagentsBySession],
  );

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

  const viewMessages = useMemo(
    () =>
      selectedThread
        ? chatMessagesForThread(selectedThread, {
            suppressedResponseTexts: suppressedSubagentResponses,
          })
        : chatMessages(selectedChat),
    [selectedChat, selectedThread, suppressedSubagentResponses],
  );
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
  const contextCard = useMemo(
    () =>
      chatContextCardForSessions(
        selectedThread?.sessions ?? [],
        subagentsBySession,
        workspace,
      ),
    // The timer labels are written in the viewer's language.
    [selectedThread, subagentsBySession, workspace, activeI18n.language],
  );
  const backgroundRunning = useMemo(
    () => runningBackgroundWork(selectedThread?.sessions ?? []),
    [selectedThread],
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
      const message = {
        agentId: selectedAgent.id,
        attachments: effectiveAttachments,
        claudeEffort:
          selectedAgent.provider === "claude" && claudeEffort
            ? claudeEffort
            : undefined,
        claudePermissionMode:
          selectedAgent.provider === "claude"
            ? claudePermissionMode
            : undefined,
        codexApprovalPolicy:
          selectedAgent.provider === "codex" ? codexApprovalPolicy : undefined,
        codexReasoningEffort:
          selectedAgent.provider === "codex" && codexReasoningEffort
            ? codexReasoningEffort
            : undefined,
        codexSandboxMode:
          selectedAgent.provider === "codex" ? codexSandboxMode : undefined,
        codexSpeed: selectedAgent.provider === "codex" ? codexSpeed : undefined,
        model: modelValue || undefined,
        profileId: selectedAgent.profileId,
        profileTransitionNote: profileTransitionNoteForSend({
          agent: selectedAgent,
          selectedChat: chatForSend,
          thread: selectedThread,
        }),
        prompt,
        provider: selectedAgent.provider,
      };
      let session: AgentSession;
      try {
        session = continuedSession
          ? await sendAgentSessionMessage(
              continuedSession.id,
              message,
              options?.idempotencyKey,
            )
          : await createAgentSession(
              {
                ...message,
                chatId: chatForSend?.id,
                source: "chat",
                workspaceId,
              },
              options?.idempotencyKey,
            );
      } catch (reason) {
        // Surface a safe, specific cause in the composer Alert. Throwing lets
        // useConversationInput retain the draft/attachments and require an
        // explicit retry (no auto-replay); busy protection is in its finally.
        throw toChatSendError(reason);
      }
      // The message is persisted server-side from here on. View-sync failures
      // must not look like an unsent draft, or the user could replay a session
      // that was already created.
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
        await emit({ type: "data.refresh.requested" });
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
      await emit({ type: "data.refresh.requested" });
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
      await emit({ type: "data.refresh.requested" });
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

  const namingRevision = sessions
    .filter((session) => session.source === "naming")
    .map((session) => `${session.id}:${session.status}`)
    .join("|");
  const titleState = useChatTitles(workspaceId, active, namingRevision, notify);
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
  const menuActions = (id: string) => {
    return {
      onRename: (title: string) => titleState.rename(id, title),
      onAutoRename: () => titleState.recap(id),
      onMarkUnread: () => readState.markUnread(id),
      onNotify: notify,
      renaming: ["queued", "running"].includes(
        titleState.titles[id]?.generationStatus ?? "",
      ),
    };
  };

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
        await emit({ type: "data.refresh.requested" });
      }}
      workspaceId={workspaceId}
      agentActive={Boolean(activeSession)}
      agentActiveSessionId={activeSession?.id}
      agentOptions={agentOptions}
      attachmentUploading={attachmentUploading}
      attachments={attachments}
      chats={[...sessionChats, ...archiveChats]}
      chatTitle={
        titleState.titles[selectedId]?.title ||
        selectedThread?.title ||
        selectedChat?.title ||
        i18n.t("chat:list.newChat")
      }
      contextCard={contextCard}
      backgroundRunning={backgroundRunning}
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
