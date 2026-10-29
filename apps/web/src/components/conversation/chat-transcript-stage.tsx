import {
  Virtuoso,
  type Components,
  type ListItem,
  type VirtuosoHandle,
} from "react-virtuoso";
import { ArrowDown } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { ChatMessageRow } from "./chat-message-list";
import type {
  ChatMessageItem,
  ConversationFileActions,
  ParsedImageTag,
} from "./conversation-types";
import {
  buildChatTurnAnchors,
  type ChatTurnAnchor,
} from "./chat-turn-navigation";
import { ChatTurnNavigator } from "./chat-turn-navigator";
import { ChatTurnMenu } from "./chat-turn-menu";
import {
  chatRenderedRows,
  useChatFirstItemIndex,
} from "./chat-transcript-index";
import {
  CHAT_VIRTUOSO_VIEWPORT,
  chatFirstRowsShift,
  estimateChatMessageHeight,
} from "./chat-virtualization";
import type { ChatScrollFollowController } from "./use-chat-scroll-follow";
import { useChatPrependAnchor } from "./use-chat-prepend-anchor";
import { useChatTurnNavigation } from "./use-chat-turn-navigation";

const CHAT_INITIAL_LOCATION = {
  align: "end" as const,
  index: "LAST" as const,
};
/** The transcript's top: its history notice (loading, older messages). */
interface ChatListContext {
  history?: ReactNode;
}

function ChatListHeader({ context }: { context?: ChatListContext }) {
  return context?.history ? (
    <div className="fdy-chat-virtuoso-header-history">{context.history}</div>
  ) : (
    <div aria-hidden="true" className="fdy-chat-virtuoso-header" />
  );
}

function ChatListFooter() {
  return <div aria-hidden="true" className="fdy-chat-virtuoso-footer" />;
}

const CHAT_VIRTUOSO_COMPONENTS = {
  Footer: ChatListFooter,
  Header: ChatListHeader,
} satisfies Components<ChatMessageItem, ChatListContext>;

function chatMessageKey(_index: number, message: ChatMessageItem): string {
  return message.id;
}

export const ChatTranscriptStage = memo(function ChatTranscriptStage({
  active,
  fileActions,
  history,
  onReachHistoryStart,
  messages,
  onAnswerQuestion,
  onEditMessage,
  onImagePreview,
  scrollController,
  showScrollToLatest,
  threadKey,
  focusMessageId,
  onMessageFocused,
}: {
  /** A turn runs now: answers to questions go into it. */
  active?: boolean;
  fileActions?: ConversationFileActions;
  /** Shown above the first message: loading state, older messages. */
  history?: ReactNode;
  /** The person scrolled to the first message. */
  onReachHistoryStart?: () => void;
  messages: ChatMessageItem[];
  onAnswerQuestion?: (text: string, key: string) => Promise<string | undefined>;
  onEditMessage?: (text: string) => void;
  onImagePreview?: (image: ParsedImageTag) => void;
  scrollController: ChatScrollFollowController;
  showScrollToLatest: boolean;
  threadKey: string;
  /** A message a link opened the chat at: scrolled to once it is loaded. */
  focusMessageId?: string;
  /** The focused message was shown; the link's request is done. */
  onMessageFocused?: () => void;
}) {
  const { t } = useTranslation("conversation");
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const [atHistoryStart, setAtHistoryStart] = useState(false);
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const {
    contentRef,
    contentResized,
    readHistory,
    readingHistory,
    viewportRef,
  } = scrollController;
  useEffect(() => {
    // Initial measurement can report the top before following the latest
    // message. Only the person reading history should request older pages.
    if (atHistoryStart && showScrollToLatest && readingHistory())
      onReachHistoryStart?.();
  }, [atHistoryStart, onReachHistoryStart, readingHistory, showScrollToLatest]);
  const renderedRef = useRef<readonly ListItem<ChatMessageItem>[]>([]);
  const anchors = useMemo(() => buildChatTurnAnchors(messages), [messages]);
  const heightEstimates = useMemo(
    () => messages.map(estimateChatMessageHeight),
    [messages],
  );
  const listContext = useMemo<ChatListContext>(() => ({ history }), [history]);
  const firstItemIndex = useChatFirstItemIndex(threadKey, messages);
  const virtuosoKey = `${threadKey}:${messages.length === 0 ? "empty" : "ready"}`;
  const navigation = useChatTurnNavigation({
    anchors,
    messageCount: messages.length,
    readHistory,
    threadKey,
    viewport,
    virtuosoRef,
  });
  const bindScroller = useCallback(
    (node: HTMLElement | null | Window): void => {
      viewportRef.current = node instanceof HTMLDivElement ? node : null;
      setViewport(viewportRef.current);
    },
    [viewportRef],
  );
  const { onContentResized, onItemsRendered, topRows } = navigation;
  const handleItemsRendered = useCallback(
    (items: ListItem<ChatMessageItem>[]): void => {
      const shift = chatFirstRowsShift(
        renderedRef.current,
        items,
        topRows()[0]?.index ?? 0,
      );
      renderedRef.current = items;
      // Virtuoso measures rows before paint
      // (`skipAnimationFrameInResizeObserver`), and its compensation for the
      // other rows, like this one, runs right there: no frame shows the
      // shifted rows.
      if (shift !== 0 && readingHistory()) {
        virtuosoRef.current?.scrollBy({ top: shift });
      }
      onItemsRendered(chatRenderedRows(items, firstItemIndex));
    },
    [firstItemIndex, onItemsRendered, readingHistory, topRows],
  );
  const prependAnchor = useChatPrependAnchor({
    firstItemIndex,
    messages,
    personScrolling: scrollController.personScrolling,
    topRows,
    virtuosoRef,
  });
  const { navigateTo } = navigation;
  const { listResized, release: releasePrependAnchor } = prependAnchor;
  const navigateToTurn = useCallback(
    (anchor: ChatTurnAnchor, align?: "start" | "center"): void => {
      releasePrependAnchor();
      navigateTo(anchor, align);
    },
    [navigateTo, releasePrependAnchor],
  );
  // A link to a message scrolls to it once the transcript holds it, and
  // marks it for a moment so the eye finds it.
  const [focusedId, setFocusedId] = useState("");
  useEffect(() => {
    if (!focusMessageId) return;
    // Rows of a session's transcript name their message
    // "agent-session:<session>:<message id>".
    const messageIndex = messages.findIndex(
      (message) =>
        message.id === focusMessageId ||
        message.id.endsWith(`:${focusMessageId}`),
    );
    if (messageIndex < 0) return;
    const row = messages[messageIndex]!;
    navigateToTurn(
      { accessibleLabel: "", id: row.id, messageIndex, query: "" },
      "center",
    );
    setFocusedId(row.id);
    onMessageFocused?.();
  }, [focusMessageId, messages, navigateToTurn, onMessageFocused]);
  useEffect(() => {
    if (!focusedId) return;
    const timer = window.setTimeout(() => setFocusedId(""), 2400);
    return () => window.clearTimeout(timer);
  }, [focusedId]);
  const handleTotalHeightChanged = useCallback((): void => {
    const viewport = viewportRef.current;
    contentRef.current =
      viewport?.querySelector<HTMLDivElement>(
        '[data-testid="virtuoso-item-list"]',
      ) ?? null;
    contentResized();
    onContentResized();
    listResized();
  }, [contentRef, contentResized, listResized, onContentResized, viewportRef]);
  const renderMessage = useCallback(
    (_index: number, message: ChatMessageItem) => (
      <div
        className="fdy-chat-virtuoso-row"
        data-focused={message.id === focusedId ? "true" : undefined}
      >
        <ChatMessageRow
          active={active}
          fileActions={fileActions}
          message={message}
          onAnswerQuestion={onAnswerQuestion}
          onEditMessage={onEditMessage}
          onImagePreview={onImagePreview}
        />
      </div>
    ),
    [
      active,
      fileActions,
      focusedId,
      onAnswerQuestion,
      onEditMessage,
      onImagePreview,
    ],
  );

  return (
    <div className="fdy-chat-message-stage" data-turn-count={anchors.length}>
      {navigation.enabled ? (
        <ChatTurnMenu
          activeIndex={navigation.activeIndex}
          anchors={anchors}
          key={`menu:${threadKey}`}
          onNavigate={navigateToTurn}
        />
      ) : null}
      <Virtuoso<ChatMessageItem, ChatListContext>
        alignToBottom
        atBottomThreshold={24}
        atTopStateChange={setAtHistoryStart}
        className="fdy-chat-messages fdy-chat-virtuoso"
        components={CHAT_VIRTUOSO_COMPONENTS}
        computeItemKey={chatMessageKey}
        context={listContext}
        data={messages}
        defaultItemHeight={96}
        firstItemIndex={firstItemIndex}
        heightEstimates={heightEstimates}
        increaseViewportBy={CHAT_VIRTUOSO_VIEWPORT.increaseViewportBy}
        initialTopMostItemIndex={CHAT_INITIAL_LOCATION}
        itemContent={renderMessage}
        itemsRendered={handleItemsRendered}
        key={virtuosoKey}
        minOverscanItemCount={CHAT_VIRTUOSO_VIEWPORT.minOverscanItemCount}
        overscan={CHAT_VIRTUOSO_VIEWPORT.overscan}
        ref={virtuosoRef}
        scrollerRef={bindScroller}
        skipAnimationFrameInResizeObserver
        totalListHeightChanged={handleTotalHeightChanged}
      />
      {navigation.enabled ? (
        <ChatTurnNavigator
          activeIndex={navigation.activeIndex}
          anchors={anchors}
          key={`rail:${threadKey}`}
          onNavigate={navigateToTurn}
        />
      ) : null}
      <Button
        aria-label={t("turns.scrollToLatest")}
        className="fdy-chat-scroll-latest"
        data-visible={showScrollToLatest ? "true" : "false"}
        onClick={() => {
          releasePrependAnchor();
          scrollController.followLatest("smooth");
        }}
        size="icon"
        tabIndex={showScrollToLatest ? 0 : -1}
        variant="icon"
      >
        <ArrowDown size={19} strokeWidth={1.8} />
      </Button>
    </div>
  );
});
