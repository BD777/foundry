import { ChatArchiveFeedback } from "./archive/chat-archive-feedback";
import { sidebarWorkCounts } from "./context/chat-work-state";
import { ChevronLeft, MessagesSquare, PanelRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { ImagePreview } from "../../components/conversation/local-image";
import type { ChatSurfaceProps } from "./chat-surface-types";
import { ChatContextCard } from "./context/chat-context-card";
import { ChatDetailPanel } from "./detail/chat-detail-panel";
import {
  ChatScreen,
  ChatThread,
  ChatThreadTitle,
  ConversationHeader,
} from "../../components/conversation/conversation-frame";
import { ChatDetailSplitPane } from "../../components/conversation/chat-detail-split-pane";
import { Conversation } from "../../components/conversation/conversation";
import { conversationStoragePrefixes } from "../../components/conversation/conversation-storage";
import type { ParsedImageTag } from "../../components/conversation/conversation-types";
import { chatComposer } from "./composer/chat-surface-composer";
import { ChatSidebar } from "./list/chat-thread-view";
import {
  ChatDeviceNote,
  ChatReadOnlyNotice,
  ChatWorkCountNote,
  ChatWorkNote,
} from "./thread/chat-thread-notices";
import { useChatContextPanel } from "./context/use-chat-context-panel";
import { useChatDocumentTitle } from "./use-chat-document-title";
import { useOnlyMine } from "./thread/only-mine";
import { useSessionWork } from "./context/use-session-work";
import { readPageQuery, replacePageQuery } from "../../lib/page-query";
import { cn } from "../../lib/cn";

export type {
  ChatAgentOption,
  ChatListItem,
  ChatMessageItem,
  ChatSurfaceProps,
} from "./chat-surface-types";

/*
 * The context card floats inset from the header and the bottom edge; the
 * card keeps its content height and the rail scrolls it as a whole. The
 * card's ring and shadow lie outside its box and a scrolling rail clips
 * whatever crosses its padding edge, so the rail leaves room on every side
 * (4px on the left, where the thread's own edge is). Below 1360px it is a
 * card over the conversation, shown by `data-open`, and clips nothing.
 */
const contextRailClass = cn(
  "min-h-0 w-[310px] min-w-0 flex-none overflow-y-auto pt-4.5 pr-4.5 pb-5 pl-1",
  "max-[1360px]:absolute max-[1360px]:top-3 max-[1360px]:right-3 max-[1360px]:bottom-3 max-[1360px]:z-8",
  "max-[1360px]:w-[min(320px,calc(100%-24px))] max-[1360px]:origin-top-right max-[1360px]:translate-x-3 max-[1360px]:scale-[0.985]",
  "max-[1360px]:invisible max-[1360px]:overflow-visible max-[1360px]:p-0 max-[1360px]:opacity-0 max-[1360px]:pointer-events-none",
  "max-[1360px]:[transition:opacity_0.16s_ease,translate_0.2s_ease,scale_0.2s_ease,visibility_0s_linear_0.2s]",
  "max-[1360px]:data-[open=true]:visible max-[1360px]:data-[open=true]:translate-x-0 max-[1360px]:data-[open=true]:scale-100",
  "max-[1360px]:data-[open=true]:opacity-100 max-[1360px]:data-[open=true]:pointer-events-auto max-[1360px]:data-[open=true]:[transition-delay:0s]",
);

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
  const { pendingCounts } = props;
  const listChats = useMemo(
    () =>
      chats.map((chat) => ({
        ...chat,
        pendingCount:
          pendingCounts?.[chat.foundrySessionId || chat.id] ?? undefined,
        onSelect: () => {
          setNarrowPane("thread");
          chat.onSelect();
        },
      })),
    [chats, pendingCounts],
  );
  // A link to one of the chat's messages (?message=, see
  // navigateToChatMessage): the transcript scrolls to it, then it is dropped.
  const [focusMessageId, setFocusMessageId] = useState(() =>
    readPageQuery("message"),
  );
  useEffect(() => {
    const read = () => setFocusMessageId(readPageQuery("message"));
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  const messageFocused = useCallback(() => {
    replacePageQuery({ message: "" });
    setFocusMessageId("");
  }, []);
  const [previewImage, setPreviewImage] = useState<ParsedImageTag>();
  const [draftResetKey, setDraftResetKey] = useState(0);
  const panel = useChatContextPanel(props);
  const { detail } = panel;
  const work = useSessionWork(contextCard?.status?.sessionId);
  const workCounts = sidebarWorkCounts(work.list?.items ?? []);
  const workNotice =
    workCounts.timers || workCounts.agents ? (
      <ChatWorkCountNote
        agents={workCounts.agents}
        onOpen={panel.toggle}
        timers={workCounts.timers}
      />
    ) : undefined;
  useChatDocumentTitle(
    !threadKey.endsWith(":new") && typeof chatTitle === "string"
      ? chatTitle
      : "",
    Boolean(props.agentActive),
    Boolean(
      props.backgroundWork?.taskIds.length ||
      props.backgroundWork?.subagentIds.length ||
      props.backgroundWork?.timerRun,
    ),
  );
  // Stable, so the memoized chat list does not render for transcript events.
  const latestCallbacks = useRef({
    onChatsDeleted,
    onNewChat,
    onArchive: props.onArchive,
  });
  latestCallbacks.current = {
    onChatsDeleted,
    onNewChat,
    onArchive: props.onArchive,
  };
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
  const handleArchive = useCallback<NonNullable<ChatSurfaceProps["onArchive"]>>(
    (input) => latestCallbacks.current.onArchive?.(input) ?? Promise.resolve(),
    [],
  );
  const showList = () => setNarrowPane("list");
  const [onlyMine, setOnlyMine] = useOnlyMine();
  const [foldedTurns, setFoldedTurns] = useState(0);
  return (
    <ChatScreen className="group/chat" data-narrow-pane={narrowPane}>
      <ChatArchiveFeedback archiveToast={props.archiveToast} />
      <div className="flex min-h-0 min-w-0 flex-1 data-[list-resizing=true]:cursor-col-resize data-[list-resizing=true]:select-none max-[860px]:flex-col">
        <ChatSidebar
          onChatsDeleted={handleChatsDeleted}
          archiveCount={props.archiveCount}
          onArchive={props.onArchive ? handleArchive : undefined}
          key={workspaceId}
          workspaceId={workspaceId}
          chats={listChats}
          onNewChat={handleNewChat}
          readOnly={Boolean(props.readOnlyReason)}
        />

        <ChatThread className="max-[860px]:group-data-[narrow-pane=list]/chat:hidden">
          <ChatThreadHeader
            foldedTurns={foldedTurns}
            onlyMine={onlyMine}
            onOnlyMineChange={setOnlyMine}
            contextOpen={contextCard ? panel.open : undefined}
            onBack={showList}
            onToggleContext={panel.toggle}
            title={chatTitle}
          />
          <ChatDetailSplitPane
            detail={
              panel.liveSelection ? (
                <ChatDetailPanel
                  canControl={
                    !props.readOnlyReason &&
                    !props.threadNotice &&
                    !props.archiveBanner
                  }
                  error={detail.error}
                  onRetry={detail.retry}
                  retrying={detail.retrying}
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
              focusMessageId={focusMessageId}
              onMessageFocused={messageFocused}
              fileActions={contextCard ? panel.fileActions : undefined}
              history={props.history}
              onReachHistoryStart={props.onReachHistoryStart}
              threadKey={props.threadKey}
              messages={props.messages}
              onlyMine={onlyMine}
              onFoldedTurnsChange={setFoldedTurns}
              attention={props.threadAttention}
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
                props.offlineDevice ? (
                  <>
                    <ChatDeviceNote
                      device={props.offlineDevice.label}
                      onCancel={
                        props.offlineDevice.waitingSessionId &&
                        props.onCancelActive
                          ? () =>
                              props.onCancelActive?.(
                                props.offlineDevice?.waitingSessionId,
                              )
                          : undefined
                      }
                    />
                    {workNotice}
                  </>
                ) : work.list ? (
                  workNotice
                ) : panel.backgroundNote || panel.schedule ? (
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
                props.archiveBanner ? (
                  props.archiveBanner
                ) : props.readOnlyReason || props.threadNotice ? (
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
                className={contextRailClass}
                data-open={panel.open ? "true" : "false"}
              >
                <ChatContextCard
                  accountUsage={props.accountUsage}
                  usageCompletion={props.usageCompletion}
                  work={work}
                  canControl={
                    !props.readOnlyReason &&
                    !props.threadNotice &&
                    !props.archiveBanner
                  }
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
        </ChatThread>
      </div>
      {previewImage ? (
        <ImagePreview
          image={previewImage}
          onClose={() => setPreviewImage(undefined)}
        />
      ) : null}
    </ChatScreen>
  );
}

/**
 * The open chat's title, the narrow screens' way back to the list, and the
 * context panel toggle (`contextOpen` undefined: the chat has no panel).
 */
function ChatThreadHeader({
  contextOpen,
  foldedTurns,
  onBack,
  onlyMine,
  onOnlyMineChange,
  onToggleContext,
  title,
}: {
  contextOpen: boolean | undefined;
  /** Turns the person did not start, folded or hidden now. */
  foldedTurns: number;
  onlyMine: boolean;
  onOnlyMineChange: (onlyMine: boolean) => void;
  onBack: () => void;
  onToggleContext: () => void;
  title: ReactNode;
}) {
  const { t } = useTranslation("chat");
  return (
    <ConversationHeader>
      <Button
        className="hidden flex-none pl-1 max-[860px]:inline-flex"
        onClick={onBack}
        size="sm"
        variant="ghost"
      >
        <ChevronLeft size={16} />
        {t("list.title")}
      </Button>
      <ChatThreadTitle title={title} />
      <div className="inline-flex flex-none items-center gap-2">
        {foldedTurns > 0 || onlyMine ? (
          <Button
            aria-pressed={onlyMine}
            className="data-[active=true]:bg-control-ghost-hover data-[active=true]:text-ink"
            data-active={onlyMine ? "true" : "false"}
            onClick={() => onOnlyMineChange(!onlyMine)}
            size="sm"
            title={t(onlyMine ? "onlyMine.offHint" : "onlyMine.onHint")}
            variant="ghost"
          >
            <MessagesSquare aria-hidden="true" size={14} />
            <span className="max-[600px]:sr-only">
              {onlyMine && foldedTurns > 0
                ? t("onlyMine.hidden", { count: foldedTurns })
                : t("onlyMine.label")}
            </span>
          </Button>
        ) : null}
        {contextOpen !== undefined ? (
          <Button
            aria-label={
              contextOpen ? t("contextCard.hide") : t("contextCard.show")
            }
            className="hidden max-[1360px]:inline-flex data-[active=true]:bg-control-ghost-hover data-[active=true]:text-ink"
            data-active={contextOpen ? "true" : "false"}
            onClick={onToggleContext}
            size="icon"
            variant="ghost"
          >
            <PanelRight size={16} />
          </Button>
        ) : null}
      </div>
    </ConversationHeader>
  );
}
