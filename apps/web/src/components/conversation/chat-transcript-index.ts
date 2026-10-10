import { useState } from "react";

/**
 * How the transcript's rows are numbered for Virtuoso.
 *
 * Virtuoso keeps measured row sizes by index. When older messages are added
 * in front, `firstItemIndex` must drop by the number added: the list then
 * moves each measured size to the row it belongs to and keeps the row being
 * read in place. So rows have two numbers:
 *
 * - their position in `messages`, used by `scrollToIndex`,
 *   `initialTopMostItemIndex`, `heightEstimates` and a row's `data-index`;
 * - `firstItemIndex + position`, which `itemsRendered`, `itemContent` and
 *   `computeItemKey` report.
 *
 * Everything outside the stage works with positions; `chatRenderedRows` is
 * where Virtuoso's numbers become positions.
 */

/** The first row's index for a list that has not grown at the front yet. */
export const CHAT_FIRST_ITEM_INDEX = 1_000_000;

interface ChatIndexedMessage {
  id: string;
}

/**
 * `firstItemIndex` after `next` replaced `previous` (shown with
 * `previousFirstItemIndex`): lower by the number of messages now in front of
 * a message both lists show, higher by the number gone from there. It stays
 * when only later messages changed, and when the lists share no message:
 * nothing shown stays then, so rows are replaced in place.
 */
export function nextChatFirstItemIndex(
  previous: readonly ChatIndexedMessage[],
  previousFirstItemIndex: number,
  next: readonly ChatIndexedMessage[],
): number {
  if (previous.length === 0 || next.length === 0) return CHAT_FIRST_ITEM_INDEX;
  if (previous[0]!.id === next[0]!.id) return previousFirstItemIndex;
  const positions = new Map(next.map((message, index) => [message.id, index]));
  for (let index = 0; index < previous.length; index += 1) {
    const position = positions.get(previous[index]!.id);
    if (position === undefined) continue;
    const first = previousFirstItemIndex - (position - index);
    // Virtuoso needs a positive index; a million older rows cannot occur.
    return first >= 0 ? first : previousFirstItemIndex;
  }
  return previousFirstItemIndex;
}

interface ChatItemIndexState {
  firstItemIndex: number;
  messages: readonly ChatIndexedMessage[];
  threadKey: string;
}

/**
 * The transcript's `firstItemIndex`: `CHAT_FIRST_ITEM_INDEX` for each thread,
 * moved as messages are added or dropped in front. Derived during render, so
 * it always changes together with the messages it numbers.
 */
export function useChatFirstItemIndex(
  threadKey: string,
  messages: readonly ChatIndexedMessage[],
): number {
  const [state, setState] = useState<ChatItemIndexState>(() => ({
    firstItemIndex: CHAT_FIRST_ITEM_INDEX,
    messages,
    threadKey,
  }));
  const sameFront =
    state.threadKey === threadKey &&
    (state.messages.length === 0) === (messages.length === 0) &&
    state.messages[0]?.id === messages[0]?.id;
  if (sameFront) return state.firstItemIndex;
  const firstItemIndex =
    state.threadKey === threadKey
      ? nextChatFirstItemIndex(state.messages, state.firstItemIndex, messages)
      : CHAT_FIRST_ITEM_INDEX;
  setState({ firstItemIndex, messages, threadKey });
  return firstItemIndex;
}

/** A rendered row: its position in `messages` and its offset in the list. */
export interface ChatRenderedRow {
  index: number;
  /** Top of the row in the list, below the list's header. */
  offset: number;
}

/** Virtuoso's rendered items, numbered by position in `messages`. */
export function chatRenderedRows(
  items: readonly { index: number; offset: number; originalIndex?: number }[],
  firstItemIndex: number,
): ChatRenderedRow[] {
  return items.map((item) => ({
    index: item.originalIndex ?? item.index - firstItemIndex,
    offset: item.offset,
  }));
}

/** A row at the top of the viewport: how far the viewport is past its top. */
export interface ChatTopRow {
  index: number;
  inset: number;
}

/**
 * The row at `listTop` (the viewport's top in list coordinates: scroll
 * position minus the header) and the next `count - 1` rows. `rows` are in
 * list order.
 */
export function chatTopRows(
  rows: readonly ChatRenderedRow[],
  listTop: number,
  count = 3,
): ChatTopRow[] {
  let first = 0;
  let low = 0;
  let high = rows.length - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    if (rows[middle]!.offset <= listTop) {
      first = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return rows
    .slice(first, first + count)
    .map((row) => ({ index: row.index, inset: listTop - row.offset }));
}
