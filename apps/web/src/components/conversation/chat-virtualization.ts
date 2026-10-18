import type { ChatMessageItem } from "./conversation-types";

/**
 * Virtuoso viewport settings for the transcript.
 *
 * The browser scrolls on its compositor while Virtuoso mounts rows on the
 * main thread, synchronously inside the scroll event. A fast scroll keeps
 * moving while a batch of rows mounts; once it passes the rows already
 * rendered the person sees blank space, and the next batch covers the whole
 * window, so it takes longer still. So rows are kept rendered:
 *
 * - `increaseViewportBy`: at least this far past both edges; mounting more
 *   starts once less than this is left ahead.
 * - `overscan.main`: that batch also covers this much further ahead, in the
 *   scroll direction only (`reverse: 0`): rows the person scrolls away from
 *   are never mounted extra.
 * - `minOverscanItemCount`: a couple of rows past the pixel buffer, for rows
 *   taller than it; more would make every batch longer.
 */
export const CHAT_VIRTUOSO_VIEWPORT = {
  increaseViewportBy: { bottom: 1200, top: 1200 },
  minOverscanItemCount: { bottom: 2, top: 2 },
  overscan: { main: 600, reverse: 0 },
} as const;

/** A row as Virtuoso's `itemsRendered` reports it. */
interface ChatVirtuosoItem {
  data?: { id: string };
  /** Top of the row in the list. */
  offset: number;
  /** Position in `messages`. */
  originalIndex?: number;
}

/**
 * How far the row at the viewport's top (`topIndex`, a position in
 * `messages`) moved in the list between two of Virtuoso's layouts that both
 * start at the first message.
 *
 * Virtuoso keeps the rows being read in place when rows above them change
 * size (a row mounted at its estimate, then measured), except while it
 * renders the very first message: then it moves nothing, and everything
 * below shifts by the difference. That is the one change to compensate;
 * anything else Virtuoso does itself (or, for rows added in front,
 * `useChatPrependAnchor`).
 */
export function chatFirstRowsShift(
  previous: readonly ChatVirtuosoItem[],
  current: readonly ChatVirtuosoItem[],
  topIndex: number,
): number {
  const first = previous[0];
  if (
    topIndex <= 0 ||
    first?.originalIndex !== 0 ||
    current[0]?.originalIndex !== 0 ||
    first.data?.id !== current[0].data?.id
  ) {
    return 0;
  }
  const before = previous.find((item) => item.originalIndex === topIndex);
  const id = before?.data?.id;
  const after = id ? current.find((item) => item.data?.id === id) : undefined;
  return before && after ? after.offset - before.offset : 0;
}

export function estimateChatMessageHeight(
  message: ChatMessageItem | undefined,
): number {
  if (!message) {
    return 80;
  }
  // Collapsed rows have one height, row spacing included (measured).
  if (message.kind === "boundary") {
    return 43;
  }
  if (message.kind === "process") {
    return 56;
  }
  if (message.kind === "tool") {
    return 38;
  }
  if (message.kind === "failure") {
    return 76;
  }

  const text = typeof message.text === "string" ? message.text : "";
  const explicitLines = text.split(/\r?\n/).length;
  const charactersPerLine = message.role === "user" ? 48 : 72;
  const wrappedLines = Math.ceil(text.length / charactersPerLine);
  const structuralBlocks = (
    text.match(/^(?:\s*$|#{1,6}\s|[-*+]\s|\d+\.\s|```|\|)/gm) ?? []
  ).length;
  const attachmentHeight = message.attachments?.length ? 180 : 0;

  return Math.max(
    64,
    48 +
      Math.max(explicitLines, wrappedLines) * 24 +
      structuralBlocks * 6 +
      attachmentHeight,
  );
}
