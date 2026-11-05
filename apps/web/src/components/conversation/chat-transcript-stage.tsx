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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { turnRailVars } from "./conversation-layout";
import { ChatMessageRow } from "./chat-message-list";
import { foldSessionTurns } from "./session-turn-folds";
import { SessionTurnsFoldRow } from "./session-turns-fold";
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
/**
 * The transcript's top: its history notice (loading, older messages).
 * `data-chat-header` lets the turn navigation measure it.
 */
interface ChatListContext {
  history?: ReactNode;
}

function ChatListHeader({ context }: { context?: ChatListContext }) {
  return context?.history ? (
    <div className="pt-3" data-chat-header="">
      {context.history}
    </div>
  ) : (
    <div
      aria-hidden="true"
      className="h-5 max-[860px]:h-4"
      data-chat-header=""
    />
  );
}

function ChatListFooter() {
  return <div aria-hidden="true" className="h-[18px] max-[860px]:h-4" />;
}

const CHAT_VIRTUOSO_COMPONENTS = {
  Footer: ChatListFooter,
  Header: ChatListHeader,
} satisfies Components<ChatMessageItem, ChatListContext>;

const NO_FOLDS_OPEN: ReadonlySet<string> = new Set();

function chatMessageKey(_index: number, message: ChatMessageItem): string {
  return message.id;
}

export const ChatTranscriptStage = memo(function ChatTranscriptStage({
  active,
  fileActions,
  history,
  onReachHistoryStart,
  messages,
  onlyMine = false,
  onFoldedTurnsChange,
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
  /** "Only my conversation": turns the person did not start are hidden. */
  onlyMine?: boolean;
  /** How many turns the person did not start are folded or hidden now. */
  onFoldedTurnsChange?: (count: number) => void;
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
  // Turns the person did not start fold into a row; the folds the person
  // opened stay open while the chat is shown.
  const [openFolds, setOpenFolds] = useState<{
    threadKey: string;
    ids: ReadonlySet<string>;
  }>({ threadKey, ids: NO_FOLDS_OPEN });
  const openFoldIds =
    openFolds.threadKey === threadKey ? openFolds.ids : NO_FOLDS_OPEN;
  const folded = useMemo(
    () => foldSessionTurns(messages, openFoldIds, { onlyMine }),
    [messages, openFoldIds, onlyMine],
  );
  const rows = folded.rows;
  useEffect(() => {
    onFoldedTurnsChange?.(folded.foldedTurns);
  }, [folded.foldedTurns, onFoldedTurnsChange]);
  const toggleFold = useCallback(
    (id: string, open?: boolean): void => {
      setOpenFolds((current) => {
        const ids = new Set(
          current.threadKey === threadKey ? current.ids : NO_FOLDS_OPEN,
        );
        if (open ?? !ids.has(id)) ids.add(id);
        else ids.delete(id);
        return { threadKey, ids };
      });
    },
    [threadKey],
  );
  const anchors = useMemo(() => buildChatTurnAnchors(rows), [rows]);
  const heightEstimates = useMemo(
    () => rows.map(estimateChatMessageHeight),
    [rows],
  );
  const listContext = useMemo<ChatListContext>(() => ({ history }), [history]);
  const firstItemIndex = useChatFirstItemIndex(threadKey, rows);
  const virtuosoKey = `${threadKey}:${rows.length === 0 ? "empty" : "ready"}`;
  const navigation = useChatTurnNavigation({
    anchors,
    messageCount: rows.length,
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
    messages: rows,
    personScrolling: scrollController.personScrolling,
    topRows,
    virtuosoRef,
  });
  const { navigateTo } = navigation;
  const { listResized, release: releasePrependAnchor } = prependAnchor;
  // A fold the person opens or closes stays where it was on screen: its
  // turns unfold below it, even while the transcript follows the latest.
  const foldInPlace = useRef<{ id: string; offset: number } | null>(null);
  const toggleFoldInPlace = useCallback(
    (id: string, trigger: HTMLElement): void => {
      const viewport = viewportRef.current;
      if (viewport)
        foldInPlace.current = {
          id,
          offset:
            trigger.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top,
        };
      readHistory();
      releasePrependAnchor();
      toggleFold(id);
    },
    [readHistory, releasePrependAnchor, toggleFold, viewportRef],
  );
  useLayoutEffect(() => {
    const pending = foldInPlace.current;
    if (!pending) return;
    foldInPlace.current = null;
    const index = rows.findIndex((row) => row.id === pending.id);
    if (index >= 0)
      virtuosoRef.current?.scrollToIndex({
        align: "start",
        index,
        offset: -pending.offset,
      });
  }, [rows]);
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
    const named = (message: ChatMessageItem) =>
      message.id === focusMessageId ||
      message.id.endsWith(`:${focusMessageId}`);
    const messageIndex = rows.findIndex(named);
    if (messageIndex < 0) {
      // A folded message: its fold opens, and the next pass scrolls to it.
      const hidden = messages.find(named);
      const fold = hidden ? folded.foldOf.get(hidden.id) : undefined;
      if (fold) toggleFold(fold, true);
      return;
    }
    const row = rows[messageIndex]!;
    navigateToTurn(
      { accessibleLabel: "", id: row.id, messageIndex, query: "" },
      "center",
    );
    setFocusedId(row.id);
    onMessageFocused?.();
  }, [
    focusMessageId,
    folded,
    messages,
    navigateToTurn,
    onMessageFocused,
    rows,
    toggleFold,
  ]);
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
        className="mx-auto w-full max-w-[calc(var(--fdy-chat-content-max)_+_2*var(--fdy-chat-content-padding))] min-w-0 px-(--fdy-chat-content-padding) pb-[22px] data-[focused=true]:rounded-lg data-[focused=true]:bg-accent-soft data-[focused=true]:transition-[background-color] data-[focused=true]:duration-[600ms]"
        data-focused={message.id === focusedId ? "true" : undefined}
      >
        {message.kind === "session-turns" && message.sessionTurns ? (
          <SessionTurnsFoldRow
            fold={message.sessionTurns}
            onToggle={(trigger) => toggleFoldInPlace(message.id, trigger)}
          />
        ) : (
          <ChatMessageRow
            active={active}
            fileActions={fileActions}
            message={message}
            onAnswerQuestion={onAnswerQuestion}
            onEditMessage={onEditMessage}
            onImagePreview={onImagePreview}
          />
        )}
      </div>
    ),
    [
      active,
      fileActions,
      focusedId,
      onAnswerQuestion,
      onEditMessage,
      onImagePreview,
      toggleFoldInPlace,
    ],
  );

  return (
    <div
      className={cn(
        "fdy-chat-message-stage relative grid min-h-0 flex-1 grid-cols-[var(--fdy-chat-turn-gutter)_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)]",
        turnRailVars,
      )}
      data-turn-count={anchors.length}
    >
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
        className="fdy-chat-messages col-start-2 row-start-2 h-full min-h-0 w-full min-w-0 flex-1 overscroll-y-contain [scrollbar-color:var(--fdy-scroll-thumb)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-2.5 [&::-webkit-scrollbar-thumb]:rounded-md [&::-webkit-scrollbar-thumb]:border-[3px] [&::-webkit-scrollbar-thumb]:border-solid [&::-webkit-scrollbar-thumb]:border-transparent [&::-webkit-scrollbar-thumb]:bg-(--fdy-scroll-thumb) [&::-webkit-scrollbar-thumb]:bg-clip-content"
        components={CHAT_VIRTUOSO_COMPONENTS}
        computeItemKey={chatMessageKey}
        context={listContext}
        data={rows}
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
        className="invisible absolute bottom-[5px] left-[calc(50%_+_var(--fdy-chat-turn-gutter)/2)] z-4 grid size-[38px] pointer-events-none place-items-center rounded-full bg-surface p-0 text-ink opacity-0 shadow-card [transform:translate(-50%,8px)_scale(0.94)] transition-[opacity,transform,visibility,background-color,box-shadow] [transition-delay:0s,0s,0.24s,0s,0s] [transition-duration:0.18s,0.24s,0s,0.16s,0.16s] [transition-timing-function:ease,cubic-bezier(0.22,1,0.36,1),linear,ease,ease] motion-reduce:transition-none data-[visible=true]:visible data-[visible=true]:pointer-events-auto data-[visible=true]:opacity-100 data-[visible=true]:[transform:translate(-50%,0)_scale(1)] data-[visible=true]:[transition-delay:0s] data-[visible=true]:hover:bg-panel data-[visible=true]:hover:shadow-raised data-[visible=true]:hover:[transform:translate(-50%,-1px)_scale(1)] data-[visible=true]:active:[transform:translate(-50%,1px)_scale(0.97)] focus-visible:shadow-panel-focus focus-visible:outline-none"
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
