import type { VirtuosoHandle } from "react-virtuoso";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  chatTopRows,
  type ChatRenderedRow,
  type ChatTopRow,
} from "./chat-transcript-index";
import {
  findActiveChatTurnIndexForMessage,
  chatReadingMessageIndex,
  chatTurnReadingInset,
  type ChatTurnAnchor,
} from "./chat-turn-navigation";

const CHAT_TURN_NAV_SCROLLABLE_GAP = 24;

export interface ChatTurnNavigationController {
  activeIndex: number;
  enabled: boolean;
  navigateTo: (anchor: ChatTurnAnchor, align?: "start" | "center") => void;
  onContentResized: () => void;
  /** Rendered rows, numbered by position in the messages. */
  onItemsRendered: (rows: readonly ChatRenderedRow[]) => void;
  /** The rows at the top of the viewport, as of the last settled frame. */
  topRows: () => readonly ChatTopRow[];
}

export function useChatTurnNavigation({
  anchors,
  messageCount,
  readHistory,
  threadKey,
  viewport,
  virtuosoRef,
}: {
  anchors: readonly ChatTurnAnchor[];
  messageCount: number;
  readHistory: () => void;
  threadKey: string;
  viewport: HTMLDivElement | null;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
}): ChatTurnNavigationController {
  const anchorsRef = useRef(anchors);
  const frameRef = useRef<number | null>(null);
  const itemsRef = useRef<readonly ChatRenderedRow[]>([]);
  const topRowsRef = useRef<readonly ChatTopRow[]>([]);
  const [position, setPosition] = useState({
    activeIndex: -1,
    scrollable: false,
  });
  anchorsRef.current = anchors;

  const syncPosition = useCallback((): void => {
    const currentAnchors = anchorsRef.current;
    if (!viewport) return;
    const headerHeight =
      viewport.querySelector<HTMLElement>(
        ".fdy-chat-virtuoso-header, .fdy-chat-virtuoso-header-history",
      )?.offsetHeight ?? 0;
    topRowsRef.current = chatTopRows(
      itemsRef.current,
      viewport.scrollTop - headerHeight,
    );
    const scrollable =
      viewport.scrollHeight >
      viewport.clientHeight + CHAT_TURN_NAV_SCROLLABLE_GAP;
    const atEnd =
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 1;
    const nextActiveIndex = findActiveChatTurnIndexForMessage(
      currentAnchors,
      viewport.scrollTop <= 1
        ? 0
        : chatReadingMessageIndex(
            itemsRef.current,
            viewport.scrollTop +
              chatTurnReadingInset(viewport.clientHeight) -
              headerHeight,
          ),
      atEnd,
    );
    setPosition((current) =>
      current.activeIndex === nextActiveIndex &&
      current.scrollable === scrollable
        ? current
        : { activeIndex: nextActiveIndex, scrollable },
    );
  }, [viewport]);

  const scheduleSync = useCallback((): void => {
    if (frameRef.current !== null) {
      return;
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      syncPosition();
    });
  }, [syncPosition]);

  const onItemsRendered = useCallback(
    (rows: readonly ChatRenderedRow[]): void => {
      itemsRef.current = rows;
      // Virtuoso publishes while committing its own layout. Never read
      // intermediate geometry or synchronously update its parent here.
      scheduleSync();
    },
    [scheduleSync],
  );

  useLayoutEffect(() => {
    const observer = new ResizeObserver(scheduleSync);
    if (viewport) {
      observer.observe(viewport);
      viewport.addEventListener("scroll", scheduleSync, { passive: true });
    }
    scheduleSync();
    return () => {
      observer.disconnect();
      viewport?.removeEventListener("scroll", scheduleSync);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [scheduleSync, threadKey, viewport]);

  useLayoutEffect(() => {
    scheduleSync();
  }, [anchors, messageCount, scheduleSync, threadKey]);

  /**
   * center: a linked message lands mid-view, clear of the bar over the
   * transcript's top, where the eye finds it.
   */
  const navigateTo = useCallback(
    (anchor: ChatTurnAnchor, align: "start" | "center" = "start"): void => {
      const currentStart = chatReadingMessageIndex(
        itemsRef.current,
        viewport?.scrollTop ?? 0,
      );
      if (anchor.messageIndex < messageCount - 1) {
        readHistory();
      }
      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      const behavior =
        reduceMotion || Math.abs(anchor.messageIndex - currentStart) > 4
          ? "auto"
          : "smooth";
      // Virtuoso scrolls to a position in the messages, which anchors use.
      virtuosoRef.current?.scrollToIndex({
        align,
        behavior,
        index: anchor.messageIndex,
      });
    },
    [messageCount, readHistory, viewport, virtuosoRef],
  );

  const topRows = useCallback(() => topRowsRef.current, []);

  return {
    activeIndex: position.activeIndex,
    enabled: position.scrollable && anchors.length >= 2,
    navigateTo,
    onContentResized: scheduleSync,
    onItemsRendered,
    topRows,
  };
}
