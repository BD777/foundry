import { ChevronLeft, PanelRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import { AgentPickerFooter } from "../../components/ui/agent-picker-footer";
import { navigateToDeviceAgents } from "../../lib/in-app-navigation";
import { ChatSidebar } from "./chat-thread-view";
import { useChatContextDetail } from "./use-chat-context-detail";

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
            contextDetail.selection ? (
              <ChatDetailPanel
                error={contextDetail.error}
                file={contextDetail.file}
                loading={contextDetail.loading}
                onClose={contextDetail.close}
                onImagePreview={setPreviewImage}
                selection={contextDetail.selection}
                transcript={contextDetail.transcript}
              />
            ) : undefined
          }
          detailLabel={contextDetail.selection?.label ?? t("detail.label")}
        >
          <Conversation
            threadKey={props.threadKey}
            messages={props.messages}
            active={props.agentActive}
            activeExecutionId={props.agentActiveSessionId}
            sending={props.sending}
            disabled={props.sendDisabled}
            disabledReason={props.sendDisabledReason}
            draftResetKey={draftResetKey}
            onSend={props.onSend}
            onSteer={props.onSteer}
            onStop={props.onCancelActive}
            attachments={props.attachments}
            attachmentUploading={props.attachmentUploading}
            onAttachmentsAdd={props.onAttachmentsAdd}
            onAttachmentRemove={props.onAttachmentRemove}
            onAttachmentsRestore={props.onAttachmentsRestore}
            onImagePreview={setPreviewImage}
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
                onClose={() => setContextCardOpen(false)}
                onSelect={contextDetail.setSelection}
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
