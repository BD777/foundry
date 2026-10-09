import { ChevronLeft, LoaderCircle, PanelRight } from "lucide-react";
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
import type { ChatSessionFileItem } from "./chat-types";

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
  const [narrowPane, setNarrowPane] = useState<"list" | "thread">("list");
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
  const showPanel = useCallback(() => {
    closeDetail();
    setContextCardOpen(true);
  }, [closeDetail]);
  const openFileReference = useCallback(
    (reference: ConversationFileReference) => {
      if (reference.kind === "file") {
        const file = sessionFiles.current.find(
          (item) => item.path === reference.path,
        );
        if (file) setSelection(file);
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
    [setSelection, showPanel],
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
  // The tab title names the open chat and marks it while it runs.
  const chatName =
    !threadKey.endsWith(":new") && typeof chatTitle === "string"
      ? chatTitle
      : "";
  const chatRunning = Boolean(props.agentActive);
  useEffect(() => {
    setDocumentChat(
      chatName ? { title: chatName, running: chatRunning } : undefined,
    );
  }, [chatName, chatRunning]);
  useEffect(() => () => setDocumentChat(undefined), []);
  const selectedRuntime =
    props.agentOptions.find((agent) => agent.value === props.selectedAgentId)
      ?.runtime ??
    props.agentOptions[0]?.runtime ??
    "codex";
  useEffect(() => setContextCardOpen(false), [threadKey]);
  const handleNewChat = () => {
    setDraftResetKey((value) => value + 1);
    setNarrowPane("thread");
    onNewChat();
  };
  const disabledAgentDeviceId = props.agentOptions.find(
    (agent) => agent.disabled,
  )?.deviceId;
  return (
    <section className="fdy-chat-screen" data-narrow-pane={narrowPane}>
      <ChatSidebar
        onChatsDeleted={onChatsDeleted}
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
                canControl={!props.readOnlyReason}
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
            onStop={props.onCancelActive}
            attachments={props.attachments}
            attachmentUploading={props.attachmentUploading}
            onAttachmentsAdd={props.onAttachmentsAdd}
            onAttachmentRemove={props.onAttachmentRemove}
            onAttachmentsRestore={props.onAttachmentsRestore}
            onImagePreview={setPreviewImage}
            notice={
              !props.agentActive && props.backgroundRunning ? (
                <Button
                  className="fdy-chat-background-note"
                  onClick={showPanel}
                  size="sm"
                  variant="ghost"
                >
                  <LoaderCircle aria-hidden="true" size={14} />
                  {t("contextCard.backgroundRunningNote", {
                    count: props.backgroundRunning,
                  })}
                </Button>
              ) : undefined
            }
            readOnly={
              props.readOnlyReason ? (
                <Alert title={t("thread.readOnly")}>
                  {props.readOnlyReason}
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
                data={contextCard}
                onClearTurnFilter={() => setTurnFilter(undefined)}
                onClose={() => setContextCardOpen(false)}
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
