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
  ChatThread,
  DeviceProjection,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { accountUsageTarget } from "./chat-account-usage-model";
import { getChat } from "../../api";
import { i18n } from "../../i18n";
import { composerSlashItems, type ComposerSlashSkills } from "./composer-slash";
import { shortUnavailableReason } from "../../lib/agent-picker";
import { chatComposerChoices, chatSortValue } from "./chat-model";
import {
  chatHasQueue,
  chatSessionLink,
  sessionLinkView,
  unlistedLinkedSessionIds,
} from "./chat-session-model";
import { useSessionLinks } from "./use-session-links";
import { chatMessageItems, chatViewMessages } from "./chat-message-items";
import { ChatSurface } from "./chat-surface";
import {
  chatContextCardForSessions,
  runningBackgroundWork,
} from "./chat-context-model";
import { liveThreadSchedule, threadScheduleWakes } from "./chat-schedule-model";
import { chatDetailHydrationId } from "./chat-hydration-policy";
import { useChatTranscript } from "./use-chat-transcript";
import { useNativeChatHistory } from "./use-native-chat-history";
import { useChatSelection } from "./use-chat-selection";
import { selectedChatNotices } from "./chat-thread-notice";
import { ChatTranscriptHistory } from "./chat-transcript-history";
import { useChatSubagents } from "./use-chat-subagents";
import { useChatOutbox, usePruneDeliveredOutbox } from "./use-chat-outbox";
import { useStableValue } from "./use-stable-value";
import { useChatRuntime } from "./use-chat-runtime";
import { useChatQueue } from "./use-chat-queue";
import { useChatListItems } from "./use-chat-list-items";
import { useChatAttachments } from "./use-chat-attachments";
import { useChatSend } from "./use-chat-send";
import { workspaceDenial } from "../../lib/workspace-access";
import { deviceAwaitedBy } from "../../lib/device-wait";
import {
  conversationStorageKey,
  conversationStoragePrefixes,
  forgetConversation,
} from "../../components/conversation/conversation-storage";

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
  /** The workspace's device, named while it is offline. */
  device?: DeviceProjection;
  deviceOnline: boolean;
  /** Every listed device: the one a queued session waits for is named. */
  devices: readonly DeviceProjection[];
  onEvent: (event: ChatFeatureEvent) => Promise<void> | void;
  profiles: AgentProfileProjection[];
  /** Not switching workspace: a chat the list lacks is looked up by id. */
  ready?: boolean;
  selectedChatId: string;
  sessions: AgentSession[];
  /** The composer "/" menu: workspace skills and each agent's own. */
  slashSkills?: ComposerSlashSkills;
  workspaceId: string;
  workspace?: WorkspaceProjection;
  /** The workspaces the person may open, to name another one's chat. */
  workspaces?: readonly WorkspaceProjection[];
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
  device,
  deviceOnline,
  devices,
  onEvent,
  profiles,
  ready = true,
  selectedChatId,
  sessions: listedSessions,
  slashSkills,
  workspaceId,
  workspace,
  workspaces,
}: UseChatFeatureInput): ReactElement {
  const { i18n: activeI18n } = useTranslation();
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const emit = useCallback(
    (event: ChatFeatureEvent): Promise<void> =>
      Promise.resolve(onEventRef.current(event)),
    [],
  );

  const [chatDetail, setChatDetail] = useState<ChatThread>();
  const [contextPanelVisible, setContextPanelVisible] = useState(false);
  const previousWorkspaceIdRef = useRef(workspaceId);

  const selection = useChatSelection({
    archivedChats,
    ready: active && ready,
    selectedChatId,
    sessions: listedSessions,
    workspaceId,
  });
  const { selectedThread, sessions, threads, unlistedSelection } = selection;
  const threadSessions = selectedThread?.sessions ?? noSessions;
  const transcript = useChatTranscript({
    onLoaded: (loaded) => {
      selection.mergeLinkedDetails(loaded);
      void emit({
        sessions: loaded,
        type: "thread.details.loaded",
        workspaceId,
      });
    },
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
  // An open native chat pages back through its device instead.
  const nativeHistory = useNativeChatHistory(
    selectedThread ? undefined : selectedChat,
  );
  const history = selectedThread || !selectedChat ? transcript : nativeHistory;

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
      selectedThread &&
      !unlistedSelection &&
      chatHasQueue(selectedThread.id, threadSessions)
        ? selectedThread.id
        : undefined,
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
  const attachments = useChatAttachments({ notify, workspaceId });
  const chatSend = useChatSend({
    attachments,
    composerChoices,
    deviceOnline,
    devices,
    emit,
    notify,
    outbox,
    selectedAgent,
    selectedChat,
    selectedChatId,
    selectedThread,
    sessions,
    threadKey: conversationThreadKey,
    workspaceId,
  });
  const { activeSession } = chatSend;
  const awaitedDevice = deviceAwaitedBy(activeSession, devices);
  useEffect(() => {
    if (previousWorkspaceIdRef.current === workspaceId) {
      return;
    }
    previousWorkspaceIdRef.current = workspaceId;
    chatSend.reset();
    attachments.reset();
    setChatDetail(undefined);
  }, [workspaceId]);

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

  const projection = useMemo(
    () =>
      chatViewMessages({
        chat: nativeHistory.chat ?? selectedChat,
        devices,
        outbox: outbox.entries,
        suppressedResponseFingerprints: subagents.responseFingerprints,
        thread: selectedThread,
      }),
    [
      devices,
      nativeHistory.chat,
      outbox.entries,
      selectedChat,
      selectedThread,
      subagents.responseFingerprints,
    ],
  );
  const viewMessages = projection.messages;
  usePruneDeliveredOutbox(outbox, projection.delivered);
  const agentActive = Boolean(activeSession);
  // The sessions the chats name: those that started them, and those that
  // sent the open chat a message; the list names those it holds.
  const senderIds = useMemo(
    () =>
      viewMessages.flatMap((message) =>
        message.sentBySessionId ? [message.sentBySessionId] : [],
      ),
    [viewMessages],
  );
  const namedSessions = useSessionLinks(
    useMemo(
      () => unlistedLinkedSessionIds(threads, senderIds),
      [senderIds, threads],
    ),
  );
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
  const scheduleWakes = useMemo(
    () => threadScheduleWakes(threadSessions),
    [threadSessions],
  );

  const selectedId = selectedThread?.id ?? selectedChat?.id ?? "";
  const selectionRef = useRef({ workspaceId, selectedId });
  selectionRef.current = { workspaceId, selectedId };
  const list = useChatListItems({
    active,
    archivedChats: sortedArchivedChats,
    devices,
    namedSessions,
    notify,
    onSelectChat: (chatId) => void emit({ chatId, type: "chat.selected" }),
    selectedChat,
    selectedId,
    selectedThread,
    threads,
    workspaceId,
  });
  const listTitles = list.titles;
  const linkOf = useCallback(
    (id: string) =>
      chatSessionLink(
        id,
        threads,
        (thread) => listTitles[thread.id]?.title || thread.title,
        namedSessions,
      ),
    [listTitles, namedSessions, threads],
  );
  const messages = useMemo(
    () =>
      chatMessageItems(viewMessages, {
        agentActive,
        onTurnIntoIssue: (source) =>
          void emit({ source, type: "issue.draft.requested" }),
        senderOf: (sessionId) => sessionLinkView(sessionId, linkOf(sessionId)),
      }),
    [agentActive, emit, linkOf, viewMessages],
  );
  // The side panel links the session that started the open chat.
  const parentSessionId = selectedThread?.sessions[0]?.parentSessionId;
  const parentLink = parentSessionId ? linkOf(parentSessionId) : undefined;
  const panelCard = useMemo(
    () =>
      contextCard && parentSessionId
        ? {
            ...contextCard,
            startedBy: sessionLinkView(parentSessionId, parentLink),
          }
        : contextCard,
    [
      contextCard,
      parentSessionId,
      parentLink?.sessionId,
      parentLink?.title,
      parentLink?.workspaceId,
    ],
  );
  const historyRow = useMemo(
    () => (
      <ChatTranscriptHistory
        onLoadEarlier={history.loadEarlier}
        onRetry={transcript.retry}
        state={history.state}
      />
    ),
    [history.loadEarlier, history.state, transcript.retry],
  );

  const notices = selectedChatNotices({
    ...selection,
    selectedChat,
    selectedChatId,
    showChats: () => void emit({ chatId: "", type: "chat.selected" }),
    workspaces,
  });

  return (
    <ChatSurface
      readOnlyReason={workspaceDenial(workspace, "member")}
      selectedChatId={selectedChatId}
      threadNotice={notices.thread}
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
          chatSend.clearActiveSession();
          setChatDetail(undefined);
          await emit({ chatId: "", type: "chat.selected" });
        }
      }}
      workspaceId={workspaceId}
      agentActive={agentActive}
      agentActiveSessionId={activeSession?.id}
      agentOptions={agentOptions}
      attachmentUploading={attachments.uploading}
      attachments={attachments.attachments}
      chats={list.chats}
      chatTitle={
        list.titles[selectedId]?.title ||
        selectedThread?.title ||
        selectedChat?.title ||
        notices.linked?.title ||
        i18n.t("chat:list.newChat")
      }
      accountUsage={accountUsageTarget(
        profiles.find(
          (profile) =>
            profile.id === selectedAgent?.profileId &&
            profile.deviceId === selectedAgent?.deviceId,
        ),
        devices,
      )}
      usageCompletion={threadSessions
        .map((session) => `${session.id}:${session.status}`)
        .join("|")}
      contextCard={notices.linked ? undefined : panelCard}
      history={historyRow}
      onReachHistoryStart={history.loadEarlier}
      onContextPanelVisibleChange={setContextPanelVisible}
      onRetrySubagents={subagents.failed ? subagents.retry : undefined}
      backgroundWork={backgroundWork}
      schedule={schedule}
      scheduleWakes={scheduleWakes}
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
      onAttachmentsAdd={(files) => void attachments.add(files)}
      onAttachmentRemove={attachments.remove}
      onAttachmentsRestore={attachments.restore}
      onCancelActive={chatSend.cancel}
      offlineDevice={
        awaitedDevice && activeSession
          ? {
              label: awaitedDevice.label,
              waitingSessionId: activeSession.id,
            }
          : deviceOnline
            ? undefined
            : {
                label: device?.label || i18n.t("chat:thread.deviceFallback"),
              }
      }
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
        attachments.clear();
        void emit({ chatId: "", type: "chat.selected" });
      }}
      onResetControls={resetOverride}
      onRetryModels={retryModels}
      onSend={chatSend.send}
      onSteer={
        activeSession?.provider !== "codex" ||
        device?.capabilities?.includes("codex_active_steer")
          ? chatSend.steer
          : undefined
      }
      queue={queue}
      selectedAgentId={selectedAgent?.id ?? ""}
      // Offline, a message waits for the device: only a missing agent, or
      // an unready one on an online device, keeps it from being sent.
      sendDisabled={
        !selectedAgent || (deviceOnline && selectedAgent.status !== "healthy")
      }
      sendDisabledReason={
        !selectedAgent
          ? deviceOnline
            ? undefined
            : i18n.t("agents:picker.deviceOffline")
          : deviceOnline && selectedAgent.status !== "healthy"
            ? shortUnavailableReason(
                selectedAgent.status,
                selectedAgent.statusDetail,
              )
            : undefined
      }
      sending={chatSend.submitting}
      threadKey={conversationThreadKey}
    />
  );
}
