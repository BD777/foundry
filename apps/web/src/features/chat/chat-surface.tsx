import { PanelRight, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
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
  const [contextCardOpen, setContextCardOpen] = useState(false);
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
    onNewChat();
  };
  const disabledAgentDeviceId = props.agentOptions.find(
    (agent) => agent.disabled,
  )?.deviceId;
  return (
    <section className="fdy-chat-screen">
      <ChatSidebar
        onChatsDeleted={onChatsDeleted}
        key={workspaceId}
        workspaceId={workspaceId}
        chats={chats}
        onNewChat={handleNewChat}
        readOnly={Boolean(props.readOnlyReason)}
      />

      <div className="fdy-chat-thread">
        <div className="fdy-chat-thread-header">
          <div className="fdy-chat-thread-title">
            <strong>{chatTitle}</strong>
          </div>
          <div className="fdy-chat-thread-actions">
            {contextCard ? (
              <Button
                aria-label={
                  contextCardOpen ? "Hide chat details" : "Show chat details"
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
            <Badge className="fdy-readonly-badge" dot={false} tone="slate">
              <Terminal size={12} />
              CLI session
            </Badge>
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
          detailLabel={contextDetail.selection?.label ?? "Chat detail"}
        >
          <Conversation
            threadKey={props.threadKey}
            messages={props.messages}
            active={props.agentActive}
            activeExecutionId={props.agentActiveSessionId}
            sending={props.sending}
            disabled={props.sendDisabled}
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
                <Alert title="Read-only access">{props.readOnlyReason}</Alert>
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
