import {
  ChevronLeft,
  ChevronRight,
  Clock,
  LoaderCircle,
  PanelRight,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import {
  ImagePreviewOverlay,
  type ParsedImageTag,
} from "./chat-message-content";
import type { ChatSurfaceProps } from "./chat-surface-types";
import { ChatContextCard } from "./chat-context-card";
import { backgroundWorkNote } from "./chat-context-model";
import { scheduledNote } from "./chat-schedule-model";
import { useSharedNow } from "./use-shared-now";
import { ChatDetailPanel } from "./chat-detail-panel";
import { ChatDetailSplitPane } from "./chat-detail-split-pane";
import { Conversation } from "../../components/conversation/conversation";
import { conversationStoragePrefixes } from "../../components/conversation/conversation-storage";
import { AgentPickerFooter } from "../../components/ui/agent-picker-footer";
import { navigateToDeviceAgents } from "../../lib/in-app-navigation";
import { setDocumentChat } from "../../lib/document-title";
import type {
  ConversationFileActions,
  ConversationFileReference,
} from "../../components/conversation/conversation-types";
import { ChatSidebar } from "./chat-thread-view";
import { useChatContextDetail } from "./use-chat-context-detail";
import { useMediaQuery } from "./use-media-query";

/** Where the context rail sits beside the chat (see 90-responsive.css). */
const contextRailQuery = "(min-width: 1361px)";
import type { ChatSessionFileItem } from "./chat-types";
import { pendingSessionFile } from "./pending-file-references";

export type {
  ChatAgentOption,
  ChatListItem,
  ChatMessageItem,
  ChatSurfaceProps,
} from "./chat-surface-types";

/** Chat navigation and inspector only; Conversation owns the complete interaction. */
export function ChatSurface(props: ChatSurfaceProps) {
  const {
    workspaceId,
    onChatsDeleted,
    chats,
    chatTitle,
    contextCard,
    onNewChat,
    threadKey,
  } = props;
  const { t } = useTranslation("chat");
  const [contextCardOpen, setContextCardOpen] = useState(false);
  // Narrow screens show one pane at a time: the list, or the open chat.
  const [narrowPane, setNarrowPane] = useState<"list" | "thread">(
    props.selectedChatId ? "thread" : "list",
  );
  useEffect(() => {
    if (props.selectedChatId) setNarrowPane("thread");
  }, [props.selectedChatId]);
  const listChats = useMemo(
    () =>
      chats.map((chat) => ({
        ...chat,
        onSelect: () => {
          setNarrowPane("thread");
          chat.onSelect();
        },
      })),
    [chats],
  );
  const [previewImage, setPreviewImage] = useState<ParsedImageTag>();
  const [draftResetKey, setDraftResetKey] = useState(0);
  const contextDetail = useChatContextDetail(threadKey);
  // An answer's "N files" chip shows only its turn's files.
  const [turnFilter, setTurnFilter] = useState<string>();
  const [reveal, setReveal] = useState<{ ids: string[] }>();
  useEffect(() => {
    setTurnFilter(undefined);
    setReveal(undefined);
  }, [threadKey]);
  const { close: closeDetail, setSelection } = contextDetail;
  // A background task's row changes as it runs; its panel follows it.
  const selection = contextDetail.selection;
  const liveSelection =
    selection?.kind === "background-task"
      ? (contextCard?.background.find((item) => item.id === selection.id) ??
        selection)
      : selection;
  // Read at click time: the links stay stable while files stream in.
  const sessionFiles = useRef<ChatSessionFileItem[]>([]);
  sessionFiles.current = [
    ...(contextCard?.changes ?? []),
    ...(contextCard?.files ?? []),
  ];
  // A pending file's panel turns into the file once the session records it.
  const recordedPending =
    selection?.kind === "session-file" && selection.pending
      ? sessionFiles.current.find((item) => item.path === selection.path)
      : undefined;
  useEffect(() => {
    if (recordedPending) setSelection(recordedPending);
  }, [recordedPending, setSelection]);
  const showPanel = useCallback(() => {
    closeDetail();
    setContextCardOpen(true);
  }, [closeDetail]);
  // An idle chat whose agent still works: the note names what keeps running
  // and opens the panel on those rows.
  const backgroundWork = props.agentActive ? undefined : props.backgroundWork;
  const backgroundNote = backgroundWork
    ? backgroundWorkNote(backgroundWork)
    : undefined;
  const revealBackgroundWork = useCallback(() => {
    if (!backgroundWork) return;
    setReveal({
      ids: [
        ...(backgroundWork.timerRun ? [backgroundWork.timerRun.id] : []),
        ...backgroundWork.taskIds,
        ...backgroundWork.subagentIds,
      ],
    });
    showPanel();
  }, [backgroundWork, showPanel]);
  // Otherwise timers its agent holds: the note says when it wakes next and
  // opens the panel on them.
  const schedule =
    props.agentActive || backgroundNote ? undefined : props.schedule;
  const timerIds = useMemo(
    () => contextCard?.timers.map((item) => item.id) ?? [],
    [contextCard],
  );
  const revealTimers = useCallback(() => {
    setReveal({ ids: timerIds });
    showPanel();
  }, [timerIds, showPanel]);
  const openFileReference = useCallback(
    (reference: ConversationFileReference) => {
      if (reference.kind === "file") {
        const file = sessionFiles.current.find(
          (item) => item.path === reference.path,
        );
        // Not recorded yet: the session that named it reads it, or says so.
        if (file) setSelection(file);
        else if (reference.pending && reference.sessionId)
          setSelection(
            pendingSessionFile(reference, reference.sessionId, workspaceId),
          );
        return;
      }
      const folder = `${reference.path.replace(/\/+$/, "")}/`;
      setTurnFilter(undefined);
      setReveal({
        ids: sessionFiles.current
          .filter((item) => item.path.startsWith(folder))
          .map((item) => item.id),
      });
      showPanel();
    },
    [setSelection, showPanel, workspaceId],
  );
  const fileActions = useMemo<ConversationFileActions>(
    () => ({
      open: openFileReference,
      showTurn: (turnId) => {
        setTurnFilter(turnId);
        showPanel();
      },
    }),
    [openFileReference, showPanel],
  );
  // The tab names the open chat and marks it while it runs, or while the
  // note above says its agent still works in the background.
  const chatName =
    !threadKey.endsWith(":new") && typeof chatTitle === "string"
      ? chatTitle
      : "";
  const chatRunning = Boolean(props.agentActive);
  const chatBackground = Boolean(backgroundNote);
  useEffect(() => {
    setDocumentChat(
      chatName
        ? { title: chatName, running: chatRunning, background: chatBackground }
        : undefined,
    );
  }, [chatName, chatRunning, chatBackground]);
  useEffect(() => () => setDocumentChat(undefined), []);
  const selectedRuntime =
    props.agentOptions.find((agent) => agent.value === props.selectedAgentId)
      ?.runtime ??
    props.agentOptions[0]?.runtime ??
    "codex";
  useEffect(() => setContextCardOpen(false), [threadKey]);
  // Wide screens show the panel beside the chat; narrow ones on request.
  const widePanel = useMediaQuery(contextRailQuery);
  const panelVisible = Boolean(
    contextCard && !contextDetail.selection && (widePanel || contextCardOpen),
  );
  const { onContextPanelVisibleChange } = props;
  useEffect(() => {
    onContextPanelVisibleChange?.(panelVisible);
  }, [onContextPanelVisibleChange, panelVisible]);
  // Stable, so the memoized chat list does not render for transcript events.
  const latestCallbacks = useRef({ onChatsDeleted, onNewChat });
  latestCallbacks.current = { onChatsDeleted, onNewChat };
  const clearTurnFilter = useCallback(() => setTurnFilter(undefined), []);
  const closeContextCard = useCallback(() => setContextCardOpen(false), []);
  const handleNewChat = useCallback(() => {
    setDraftResetKey((value) => value + 1);
    setNarrowPane("thread");
    latestCallbacks.current.onNewChat();
  }, []);
  const handleChatsDeleted = useCallback(
    (ids: string[]) =>
      latestCallbacks.current.onChatsDeleted?.(ids) ?? Promise.resolve(),
    [],
  );
  const disabledAgentDeviceId = props.agentOptions.find(
    (agent) => agent.disabled,
  )?.deviceId;
  return (
    <section className="fdy-chat-screen" data-narrow-pane={narrowPane}>
      <ChatSidebar
        onChatsDeleted={handleChatsDeleted}
        key={workspaceId}
        workspaceId={workspaceId}
        chats={listChats}
        onNewChat={handleNewChat}
        readOnly={Boolean(props.readOnlyReason)}
      />

      <div className="fdy-chat-thread">
        <div className="fdy-chat-thread-header">
          <Button
            className="fdy-chat-back"
            onClick={() => setNarrowPane("list")}
            size="sm"
            variant="ghost"
          >
            <ChevronLeft size={16} />
            {t("list.title")}
          </Button>
          <div className="fdy-chat-thread-title">
            <strong>{chatTitle}</strong>
          </div>
          <div className="fdy-chat-thread-actions">
            {contextCard ? (
              <Button
                aria-label={
                  contextCardOpen
                    ? t("contextCard.hide")
                    : t("contextCard.show")
                }
                className="fdy-chat-context-toggle"
                data-active={contextCardOpen ? "true" : "false"}
                onClick={() => setContextCardOpen((current) => !current)}
                size="icon"
                variant="ghost"
              >
                <PanelRight size={16} />
              </Button>
            ) : null}
          </div>
        </div>
        <ChatDetailSplitPane
          detail={
            liveSelection ? (
              <ChatDetailPanel
                canControl={!props.readOnlyReason && !props.threadNotice}
                error={contextDetail.error}
                file={contextDetail.file}
                loading={contextDetail.loading}
                onClose={contextDetail.close}
                onImagePreview={setPreviewImage}
                selection={liveSelection}
                transcript={contextDetail.transcript}
              />
            ) : undefined
          }
          detailLabel={contextDetail.selection?.label ?? t("detail.label")}
        >
          <Conversation
            fileActions={contextCard ? fileActions : undefined}
            history={props.history}
            onReachHistoryStart={props.onReachHistoryStart}
            threadKey={props.threadKey}
            messages={props.messages}
            active={props.agentActive}
            activeExecutionId={props.agentActiveSessionId}
            sending={props.sending}
            disabled={props.sendDisabled}
            disabledReason={props.sendDisabledReason}
            draftResetKey={draftResetKey}
            storageKeyPrefix={conversationStoragePrefixes.chat}
            onSend={props.onSend}
            onSteer={props.onSteer}
            serverQueue={props.queue}
            onStop={props.onCancelActive}
            attachments={props.attachments}
            attachmentUploading={props.attachmentUploading}
            onAttachmentsAdd={props.onAttachmentsAdd}
            onAttachmentRemove={props.onAttachmentRemove}
            onAttachmentsRestore={props.onAttachmentsRestore}
            onImagePreview={setPreviewImage}
            notice={
              backgroundNote ? (
                <Button
                  className="fdy-chat-background-note"
                  onClick={revealBackgroundWork}
                  size="sm"
                  variant="ghost"
                >
                  <LoaderCircle aria-hidden="true" size={14} />
                  {backgroundNote}
                </Button>
              ) : schedule ? (
                <ScheduledNote
                  onClick={revealTimers}
                  schedule={schedule}
                  wakes={props.scheduleWakes}
                />
              ) : undefined
            }
            readOnly={
              props.readOnlyReason ? (
                <Alert title={t("thread.readOnly")}>
                  {props.readOnlyReason}
                </Alert>
              ) : props.threadNotice ? (
                <Alert
                  title={props.threadNotice.title}
                  tone={props.threadNotice.tone}
                >
                  <p>{props.threadNotice.message}</p>
                  {props.threadNotice.action ? (
                    <Button
                      className="fdy-chat-thread-notice-action"
                      onClick={() => {
                        const action = props.threadNotice?.action;
                        if (action?.showsList) setNarrowPane("list");
                        action?.onSelect();
                      }}
                      size="sm"
                      variant="secondary"
                    >
                      {props.threadNotice.action.label}
                      <ChevronRight aria-hidden="true" size={14} />
                    </Button>
                  ) : null}
                </Alert>
              ) : undefined
            }
            composer={{
              mode: "selectable",
              agentOptions: props.agentOptions,
              slashItems: props.slashSkills,
              agentPickerFooter: (
                <AgentPickerFooter
                  deviceId={disabledAgentDeviceId}
                  onManage={navigateToDeviceAgents}
                />
              ),
              agentValue: props.selectedAgentId,
              onAgentChange: props.onAgentChange,
              runtimeControls: {
                // A verifier keeps its sandbox; a message cannot change it.
                showPermissions: !props.contextCard?.status?.verification,
                selectedRuntime,
                claudeEffort: props.claudeEffort,
                claudePermissionMode: props.claudePermissionMode,
                codexApprovalPolicy: props.codexApprovalPolicy,
                codexReasoningEffort: props.codexReasoningEffort,
                codexSandboxMode: props.codexSandboxMode,
                codexSpeed: props.codexSpeed,
                modelLoadFailed: props.modelLoadFailed ?? false,
                modelLoading: props.modelLoading ?? false,
                modelOptions: props.modelOptions,
                modelValue: props.modelValue,
                onClaudeEffortChange: props.onClaudeEffortChange,
                onClaudePermissionModeChange:
                  props.onClaudePermissionModeChange,
                onCodexApprovalPolicyChange: props.onCodexApprovalPolicyChange,
                onCodexReasoningEffortChange:
                  props.onCodexReasoningEffortChange,
                onCodexSandboxModeChange: props.onCodexSandboxModeChange,
                onCodexSpeedChange: props.onCodexSpeedChange,
                onModelChange: props.onModelChange,
                onResetControls: props.onResetControls,
                onRetryModels: props.onRetryModels,
              },
            }}
          />

          {contextCard && !contextDetail.selection ? (
            <div
              className="fdy-chat-context-rail"
              data-open={contextCardOpen ? "true" : "false"}
            >
              <ChatContextCard
                chatKey={threadKey}
                data={contextCard}
                onClearTurnFilter={clearTurnFilter}
                onClose={closeContextCard}
                onRetrySubagents={props.onRetrySubagents}
                onSelect={contextDetail.setSelection}
                reveal={reveal}
                turnFilter={turnFilter}
              />
            </div>
          ) : null}
        </ChatDetailSplitPane>
      </div>
      {previewImage ? (
        <ImagePreviewOverlay
          image={previewImage}
          onClose={() => setPreviewImage(undefined)}
        />
      ) : null}
    </section>
  );
}

/** The next wake-up of an idle chat's timers, kept current by the minute. */
function ScheduledNote(props: {
  onClick: () => void;
  schedule: NonNullable<ChatSurfaceProps["schedule"]>;
  wakes: ChatSurfaceProps["scheduleWakes"];
}) {
  const { i18n } = useTranslation();
  const minute = Math.floor(useSharedNow(true) / 60_000);
  const note = useMemo(
    () =>
      scheduledNote(
        props.schedule,
        new Date(minute * 60_000),
        props.wakes?.wakes,
        props.wakes?.busy,
      ),
    // The note is written in the viewer's language.
    [props.schedule, props.wakes, minute, i18n.language],
  );
  return (
    <Button
      className="fdy-chat-background-note"
      onClick={props.onClick}
      size="sm"
      variant="ghost"
    >
      <Clock aria-hidden="true" size={14} />
      {note}
    </Button>
  );
}
