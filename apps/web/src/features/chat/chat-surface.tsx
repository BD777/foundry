import { ChevronLeft, PanelRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { ImagePreviewOverlay } from "../../components/conversation/image-preview-overlay";
import type { ChatSurfaceProps } from "./chat-surface-types";
import { ChatContextCard } from "./chat-context-card";
import { ChatDetailPanel } from "./chat-detail-panel";
import { ChatDetailSplitPane } from "../../components/conversation/chat-detail-split-pane";
import { Conversation } from "../../components/conversation/conversation";
import { conversationStoragePrefixes } from "../../components/conversation/conversation-storage";
import type { ParsedImageTag } from "../../components/conversation/conversation-types";
import { chatComposer } from "./chat-surface-composer";
import { ChatSidebar } from "./chat-thread-view";
import { ChatReadOnlyNotice, ChatWorkNote } from "./chat-thread-notices";
import { useChatContextPanel } from "./use-chat-context-panel";
import { useChatDocumentTitle } from "./use-chat-document-title";

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
  const panel = useChatContextPanel(props);
  const { detail } = panel;
  useChatDocumentTitle(
    !threadKey.endsWith(":new") && typeof chatTitle === "string"
      ? chatTitle
      : "",
    Boolean(props.agentActive),
    Boolean(panel.backgroundNote),
  );
  // Stable, so the memoized chat list does not render for transcript events.
  const latestCallbacks = useRef({ onChatsDeleted, onNewChat });
  latestCallbacks.current = { onChatsDeleted, onNewChat };
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
  const showList = () => setNarrowPane("list");
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
        <ChatThreadHeader
          contextOpen={contextCard ? panel.open : undefined}
          onBack={showList}
          onToggleContext={panel.toggle}
          title={chatTitle}
        />
        <ChatDetailSplitPane
          detail={
            panel.liveSelection ? (
              <ChatDetailPanel
                canControl={!props.readOnlyReason && !props.threadNotice}
                error={detail.error}
                file={detail.file}
                loading={detail.loading}
                onClose={detail.close}
                onImagePreview={setPreviewImage}
                selection={panel.liveSelection}
                transcript={detail.transcript}
              />
            ) : undefined
          }
          detailLabel={detail.selection?.label ?? t("detail.label")}
        >
          <Conversation
            fileActions={contextCard ? panel.fileActions : undefined}
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
              panel.backgroundNote || panel.schedule ? (
                <ChatWorkNote
                  backgroundNote={panel.backgroundNote}
                  onRevealBackgroundWork={panel.revealBackgroundWork}
                  onRevealTimers={panel.revealTimers}
                  schedule={panel.schedule}
                  wakes={props.scheduleWakes}
                />
              ) : undefined
            }
            readOnly={
              props.readOnlyReason || props.threadNotice ? (
                <ChatReadOnlyNotice
                  onShowList={showList}
                  readOnlyReason={props.readOnlyReason}
                  threadNotice={props.threadNotice}
                />
              ) : undefined
            }
            composer={chatComposer(props)}
          />

          {contextCard && !detail.selection ? (
            <div
              className="fdy-chat-context-rail"
              data-open={panel.open ? "true" : "false"}
            >
              <ChatContextCard
                chatKey={threadKey}
                data={contextCard}
                onClearTurnFilter={panel.clearTurnFilter}
                onClose={panel.close}
                onRetrySubagents={props.onRetrySubagents}
                onSelect={detail.setSelection}
                reveal={panel.reveal}
                turnFilter={panel.turnFilter}
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

/**
 * The open chat's title, the narrow screens' way back to the list, and the
 * context panel toggle (`contextOpen` undefined: the chat has no panel).
 */
function ChatThreadHeader({
  contextOpen,
  onBack,
  onToggleContext,
  title,
}: {
  contextOpen: boolean | undefined;
  onBack: () => void;
  onToggleContext: () => void;
  title: ReactNode;
}) {
  const { t } = useTranslation("chat");
  return (
    <div className="fdy-chat-thread-header">
      <Button
        className="fdy-chat-back"
        onClick={onBack}
        size="sm"
        variant="ghost"
      >
        <ChevronLeft size={16} />
        {t("list.title")}
      </Button>
      <div className="fdy-chat-thread-title">
        <strong>{title}</strong>
      </div>
      <div className="fdy-chat-thread-actions">
        {contextOpen !== undefined ? (
          <Button
            aria-label={
              contextOpen ? t("contextCard.hide") : t("contextCard.show")
            }
            className="fdy-chat-context-toggle"
            data-active={contextOpen ? "true" : "false"}
            onClick={onToggleContext}
            size="icon"
            variant="ghost"
          >
            <PanelRight size={16} />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
