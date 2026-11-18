import { useCallback, useEffect, useRef, useState } from "react";
import {
  answerIssueQuestion,
  answerPendingItem,
  decidePendingItem,
  enqueueChatMessage,
  isAbortError,
  listPendingItems,
  retryPendingItem,
  setPendingItemState,
  type PendingItem,
  type PendingItemList,
} from "../../api";
import { issuesEnabled } from "../../lib/feature-flags";
import { pendingReplyRoute, pendingReplyText } from "./pending-model";

/** How often the list is read again while the page is visible. */
const pendingPollMs = 20_000;

export interface PendingItems {
  list?: PendingItemList;
  /** The last read failed; the previous list, if any, is still shown. */
  failed: boolean;
  refresh: () => void;
  changeState: (
    item: PendingItem,
    state: "open" | "done" | "dismissed",
  ) => Promise<void>;
  /** Sends the reply to the item's chat, or answers its Issue. */
  reply: (item: PendingItem, text: string) => Promise<void>;
  /** Asks for one more attempt of an unprocessed assistant message. */
  retry: (item: PendingItem) => Promise<void>;
  /** Allows or refuses the connector write an item stands for (DEV-265). */
  decide: (item: PendingItem, allow: boolean) => Promise<void>;
}

/**
 * The person's pending items for the whole app: the sidebar count, the
 * Pending page and each chat's count read the same list. It is read when
 * the app opens, every 20 s while the tab is visible, when the tab comes
 * back, and whenever something asks (a chat's turn ended).
 */
export function usePendingItems(enabled = true): PendingItems {
  const [list, setList] = useState<PendingItemList>();
  const [failed, setFailed] = useState(false);
  const controller = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    if (!enabled) return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    listPendingItems({ signal: current.signal })
      .then((value) => {
        if (current.signal.aborted) return;
        setList(shownList(value));
        setFailed(false);
      })
      .catch((reason: unknown) => {
        if (!current.signal.aborted && !isAbortError(reason)) setFailed(true);
      });
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, pendingPollMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      controller.current?.abort();
    };
  }, [enabled, refresh]);

  const changeState = useCallback<PendingItems["changeState"]>(
    async (item, state) => {
      const changed = await setPendingItemState(item.id, state);
      setList((shown) => shown && withItem(shown, { ...item, ...changed }));
      refresh();
    },
    [refresh],
  );

  const reply = useCallback<PendingItems["reply"]>(
    async (item, text) => {
      const route = pendingReplyRoute(item);
      if (route === "issue" && item.issueId && item.eventId) {
        await answerIssueQuestion(item.issueId, item.eventId, text.trim());
      } else if (route === "answer") {
        await answerPendingItem(item.id, text.trim(), crypto.randomUUID());
      } else if (route === "chat" && item.sessionId) {
        // As the composer answers an Agent's question: into a running turn
        // at once, or the chat's next message when nothing runs.
        const result = await enqueueChatMessage(
          item.sessionId,
          {
            text: pendingReplyText(item, text),
            runSettings: {},
            steer: true,
          },
          crypto.randomUUID(),
        );
        if (!result.ok) throw new Error(result.error);
      }
      refresh();
    },
    [refresh],
  );

  const retry = useCallback<PendingItems["retry"]>(
    async (item) => {
      await retryPendingItem(item.id, crypto.randomUUID());
      refresh();
    },
    [refresh],
  );

  const decide = useCallback<PendingItems["decide"]>(
    async (item, allow) => {
      await decidePendingItem(item.id, allow);
      refresh();
    },
    [refresh],
  );

  return { list, failed, refresh, changeState, reply, retry, decide };
}

/** The list the app shows: without Issues' items while Issues are off. */
function shownList(list: PendingItemList): PendingItemList {
  return issuesEnabled
    ? list
    : recounted(
        list.items.filter((item) => !item.issueId),
        list.assistants,
      );
}

/** The list with one item replaced and its counts recounted. */
function withItem(list: PendingItemList, item: PendingItem): PendingItemList {
  return recounted(
    list.items.map((shown) => (shown.id === item.id ? item : shown)),
    list.assistants,
  );
}

/** `items` with their open counts. */
function recounted(
  items: PendingItem[],
  assistants: PendingItemList["assistants"],
): PendingItemList {
  const bySession: Record<string, number> = {};
  let open = 0;
  let assistantOpen = 0;
  for (const shown of items) {
    if (shown.state !== "open") continue;
    if (shown.handler === "assistant") {
      assistantOpen += 1;
      continue;
    }
    open += 1;
    if (shown.sessionId && !shown.issueId)
      bySession[shown.sessionId] = (bySession[shown.sessionId] ?? 0) + 1;
  }
  return { items, assistants, open, assistantOpen, bySession };
}
