import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatThread, TranscriptMessage } from "@bd777/foundry-protocol";
import { getNativeChatHistory } from "../../api";
import type { TranscriptLoadState } from "./chat-transcript-loader";

/** What was read of a native chat's earlier log, oldest page first. */
export interface NativeChatHistory {
  chatId: string;
  /** The chat's own transcriptBefore the pages were read back from. */
  from: number;
  transcript: TranscriptMessage[];
  /** Where the oldest page read starts; 0 at the log's start. */
  before: number;
}

/**
 * The chat as it reads with the earlier pages before what it carries. A
 * step at a page's edge can appear in both: the later copy stays.
 */
export function withNativeChatHistory(
  chat: ChatThread,
  history: NativeChatHistory | undefined,
): ChatThread {
  if (
    !history ||
    history.chatId !== chat.id ||
    history.from !== chat.transcriptBefore
  )
    return chat;
  const later = new Set((chat.transcript ?? []).map((message) => message.id));
  const earlier: TranscriptMessage[] = [];
  for (const message of [...history.transcript].reverse()) {
    if (later.has(message.id)) continue;
    later.add(message.id);
    earlier.unshift(message);
  }
  return {
    ...chat,
    transcript: [...earlier, ...(chat.transcript ?? [])],
    transcriptBefore: history.before,
  };
}

/**
 * A native chat carries its log's latest part; scrolling back reads the
 * earlier part from its device a page at a time, as a session pages its
 * events. Nothing is stored: the chat's log stays the record.
 */
export function useNativeChatHistory(chat: ChatThread | undefined): {
  chat: ChatThread | undefined;
  state: TranscriptLoadState;
  loadEarlier: () => void;
} {
  const [history, setHistory] = useState<NativeChatHistory>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const shown = useMemo(
    () => (chat ? withNativeChatHistory(chat, history) : undefined),
    [chat, history],
  );
  const latest = useRef(shown);
  latest.current = shown;
  const request = useRef<AbortController>(undefined);
  const key = chat ? `${chat.id}\n${chat.transcriptBefore ?? 0}` : "";
  useEffect(() => {
    // Another chat, or this one's latest part moved: what was read goes.
    setHistory(undefined);
    setLoading(false);
    setFailed(false);
    return () => {
      request.current?.abort();
      request.current = undefined;
    };
  }, [key]);

  const loadEarlier = useCallback(() => {
    const current = latest.current;
    const before = current?.transcriptBefore ?? 0;
    if (!current || before <= 0 || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setFailed(false);
    const from = chat?.transcriptBefore ?? 0;
    void getNativeChatHistory(current.id, before, { signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted) return;
        setHistory((previous) => ({
          chatId: current.id,
          from,
          transcript: [
            ...page.transcript,
            ...(previous?.chatId === current.id ? previous.transcript : []),
          ],
          before: page.before,
        }));
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (request.current === controller) request.current = undefined;
        if (!controller.signal.aborted) setLoading(false);
      });
  }, [chat?.transcriptBefore]);

  const before = shown?.transcriptBefore ?? 0;
  const state = useMemo<TranscriptLoadState>(
    () => ({
      loading: false,
      slow: false,
      failed: false,
      earlier: shown && before > 0 ? { [shown.id]: String(before) } : {},
      loadingEarlier: loading,
      earlierFailed: failed,
    }),
    [before, failed, loading, shown],
  );
  return { chat: shown, state, loadEarlier };
}
