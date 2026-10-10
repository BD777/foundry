import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { ChatTopRow } from "./chat-transcript-index";

/** How long rows added in front may still move the row being read. */
const CHAT_PREPEND_SETTLE_MS = 1500;

interface ChatReadingAnchor {
  id: string;
  /** How far the viewport's top is past the row's top. */
  inset: number;
}

/**
 * Keeps the row being read in place when older messages are added in front.
 *
 * Virtuoso moves the list by one estimated height per new row and corrects
 * the difference only while the person scrolls up. When they are not
 * scrolling, the row that was at the top goes back to where it was each time
 * the list's height changes while the new rows are measured, until that
 * settles, the person scrolls, or something else moves the list on purpose
 * (`release`). Rows are found again by message: older events can regroup the
 * first rows, so the first of the top rows that still exists is used.
 */
export function useChatPrependAnchor({
  firstItemIndex,
  messages,
  personScrolling,
  topRows,
  virtuosoRef,
}: {
  firstItemIndex: number;
  messages: readonly { id: string }[];
  personScrolling: () => boolean;
  topRows: () => readonly ChatTopRow[];
  virtuosoRef: RefObject<VirtuosoHandle | null>;
}): { listResized: () => void; release: () => void } {
  const shownRef = useRef({ firstItemIndex, messages });
  const pendingRef = useRef<{
    anchors: ChatReadingAnchor[];
    until: number;
  } | null>(null);

  const listResized = useCallback((): void => {
    const pending = pendingRef.current;
    if (!pending) return;
    if (performance.now() > pending.until || personScrolling()) {
      pendingRef.current = null;
      return;
    }
    const shown = shownRef.current.messages;
    for (const anchor of pending.anchors) {
      const index = shown.findIndex((message) => message.id === anchor.id);
      if (index < 0) continue;
      virtuosoRef.current?.scrollToIndex({
        align: "start",
        index,
        offset: anchor.inset,
      });
      return;
    }
    pendingRef.current = null;
  }, [personScrolling, virtuosoRef]);

  const release = useCallback((): void => {
    pendingRef.current = null;
  }, []);

  useLayoutEffect(() => {
    const shown = shownRef.current;
    shownRef.current = { firstItemIndex, messages };
    if (firstItemIndex === shown.firstItemIndex) return undefined;
    // Another chat, or rows dropped in front: nothing to keep.
    if (firstItemIndex > shown.firstItemIndex) {
      pendingRef.current = null;
      return undefined;
    }
    // Several pages in a row keep the rows read before the first of them.
    const anchors =
      pendingRef.current?.anchors ??
      topRows().flatMap((row) => {
        const id = shown.messages[row.index]?.id;
        return id ? [{ id, inset: row.inset }] : [];
      });
    if (anchors.length === 0 || personScrolling()) {
      pendingRef.current = null;
      return undefined;
    }
    pendingRef.current = {
      anchors,
      until: performance.now() + CHAT_PREPEND_SETTLE_MS,
    };
    // Virtuoso has applied its estimate when this frame runs.
    const frame = window.requestAnimationFrame(listResized);
    return () => window.cancelAnimationFrame(frame);
  }, [firstItemIndex, listResized, messages, personScrolling, topRows]);

  return { listResized, release };
}
