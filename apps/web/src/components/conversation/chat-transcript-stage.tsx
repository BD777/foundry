import { Virtuoso, type Components, type VirtuosoHandle } from "react-virtuoso";
import { ArrowDown } from "lucide-react";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";
import type { ParsedImageTag } from "./chat-message-content";
import { ChatMessageRow } from "./chat-message-list";
import type { ChatMessageItem } from "./conversation-types";
import { buildChatTurnAnchors } from "./chat-turn-navigation";
import { ChatTurnNavigator } from "./chat-turn-navigator";
import { ChatTurnMenu } from "./chat-turn-menu";
import {
  CHAT_VIRTUOSO_MIN_OVERSCAN_ITEMS,
  CHAT_VIRTUOSO_OVERSCAN_PX,
  estimateChatMessageHeight,
} from "./chat-virtualization";
import type { ChatScrollFollowController } from "./use-chat-scroll-follow";
import { useChatTurnNavigation } from "./use-chat-turn-navigation";

const CHAT_INITIAL_LOCATION = {
  align: "end" as const,
  index: "LAST" as const,
};
const CHAT_INCREASE_VIEWPORT = {
  bottom: CHAT_VIRTUOSO_OVERSCAN_PX,
  top: CHAT_VIRTUOSO_OVERSCAN_PX,
};
const CHAT_OVERSCAN = {
  main: CHAT_VIRTUOSO_OVERSCAN_PX,
  reverse: CHAT_VIRTUOSO_OVERSCAN_PX,
};
const CHAT_MIN_OVERSCAN_ITEMS = {
  bottom: CHAT_VIRTUOSO_MIN_OVERSCAN_ITEMS,
  top: CHAT_VIRTUOSO_MIN_OVERSCAN_ITEMS,
};
function ChatListHeader() {
  return <div aria-hidden="true" className="fdy-chat-virtuoso-header" />;
}

function ChatListFooter() {
  return <div aria-hidden="true" className="fdy-chat-virtuoso-footer" />;
}

const CHAT_VIRTUOSO_COMPONENTS = {
  Footer: ChatListFooter,
  Header: ChatListHeader,
} satisfies Components<ChatMessageItem, unknown>;

function chatMessageKey(_index: number, message: ChatMessageItem): string {
  return message.id;
}

export const ChatTranscriptStage = memo(function ChatTranscriptStage({
  messages,
  onEditMessage,
  onImagePreview,
  scrollController,
  showScrollToLatest,
  threadKey,
}: {
  messages: ChatMessageItem[];
  onEditMessage?: (text: string) => void;
  onImagePreview?: (image: ParsedImageTag) => void;
  scrollController: ChatScrollFollowController;
  showScrollToLatest: boolean;
  threadKey: string;
}) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const { contentRef, contentResized, readHistory, viewportRef } =
    scrollController;
  const anchors = useMemo(() => buildChatTurnAnchors(messages), [messages]);
  const heightEstimates = useMemo(
    () => messages.map(estimateChatMessageHeight),
    [messages],
  );
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
  const { onContentResized } = navigation;
  const handleTotalHeightChanged = useCallback((): void => {
    const viewport = viewportRef.current;
    contentRef.current =
      viewport?.querySelector<HTMLDivElement>(
        '[data-testid="virtuoso-item-list"]',
      ) ?? null;
    contentResized();
    onContentResized();
  }, [contentRef, contentResized, onContentResized, viewportRef]);
  const renderMessage = useCallback(
    (_index: number, message: ChatMessageItem) => (
      <div className="fdy-chat-virtuoso-row">
        <ChatMessageRow
          message={message}
          onEditMessage={onEditMessage}
          onImagePreview={onImagePreview}
        />
      </div>
    ),
    [onEditMessage, onImagePreview],
  );

  return (
    <div className="fdy-chat-message-stage" data-turn-count={anchors.length}>
      {navigation.enabled ? (
        <ChatTurnMenu
          activeIndex={navigation.activeIndex}
          anchors={anchors}
          key={`menu:${threadKey}`}
          onNavigate={navigation.navigateTo}
        />
      ) : null}
      <Virtuoso<ChatMessageItem, unknown>
        alignToBottom
        atBottomThreshold={24}
        className="fdy-chat-messages fdy-chat-virtuoso"
        components={CHAT_VIRTUOSO_COMPONENTS}
        computeItemKey={chatMessageKey}
        data={messages}
        defaultItemHeight={96}
        heightEstimates={heightEstimates}
        increaseViewportBy={CHAT_INCREASE_VIEWPORT}
        initialTopMostItemIndex={CHAT_INITIAL_LOCATION}
        itemContent={renderMessage}
        itemsRendered={navigation.onItemsRendered}
        key={virtuosoKey}
        minOverscanItemCount={CHAT_MIN_OVERSCAN_ITEMS}
        overscan={CHAT_OVERSCAN}
        ref={virtuosoRef}
        scrollerRef={bindScroller}
        totalListHeightChanged={handleTotalHeightChanged}
      />
      {navigation.enabled ? (
        <ChatTurnNavigator
          activeIndex={navigation.activeIndex}
          anchors={anchors}
          key={`rail:${threadKey}`}
          onNavigate={navigation.navigateTo}
        />
      ) : null}
      <Button
        aria-label="Scroll to latest message"
        className="fdy-chat-scroll-latest"
        data-visible={showScrollToLatest ? "true" : "false"}
        onClick={() => scrollController.followLatest("smooth")}
        size="icon"
        tabIndex={showScrollToLatest ? 0 : -1}
        variant="icon"
      >
        <ArrowDown size={19} strokeWidth={1.8} />
      </Button>
    </div>
  );
});
