import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  chatIsUnread,
  chatReadView,
  loadChatReadState,
  saveChatReadState,
  type ChatListStatus,
} from "./chat-list-state";
import { setDocumentUnread } from "../../lib/document-title";
import {
  backgroundReadTimeoutMs,
  foundryStreamEpoch,
  foundryStreamOpened,
  listChatTitles,
  recapChatTitle,
  renameChat,
  subscribeFoundryEvents,
  type ChatTitleMetadata,
} from "../../api";
import { i18n } from "../../i18n";
import { singleFlight } from "../../lib/single-flight";

export function useChatReadState(
  workspaceId: string,
  active: boolean,
  selectedId: string,
  revision: string,
) {
  const [bucket, setBucket] = useState(() => ({
    workspaceId,
    entries: loadChatReadState(workspaceId),
  }));
  const [visible, setVisible] = useState(
    () => document.visibilityState === "visible",
  );
  const lastViewRef = useRef("");
  useEffect(() => {
    setBucket({ workspaceId, entries: loadChatReadState(workspaceId) });
  }, [workspaceId]);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const read = useCallback(
    (id: string, answer: string, explicit = true) => {
      setBucket((current) => {
        if (current.workspaceId !== workspaceId) return current;
        const previous = current.entries[id];
        if (!explicit && previous?.forced) return current;
        if (previous?.revision === answer && !previous.forced) return current;
        return {
          ...current,
          entries: { ...current.entries, [id]: { revision: answer } },
        };
      });
    },
    [workspaceId],
  );
  useEffect(() => {
    if (bucket.workspaceId !== workspaceId) return;
    const view = chatReadView({ workspaceId, active, visible, selectedId });
    const entering = view !== lastViewRef.current;
    lastViewRef.current = view;
    if (view) read(selectedId, revision, entering);
  }, [active, visible, selectedId, revision, read, bucket.workspaceId]);
  useEffect(() => {
    if (workspaceId && bucket.workspaceId === workspaceId)
      saveChatReadState(workspaceId, bucket.entries);
  }, [workspaceId, bucket]);
  return {
    read,
    unread: (id: string, answer: string) =>
      chatIsUnread(
        bucket.workspaceId === workspaceId ? bucket.entries[id] : undefined,
        answer,
      ),
    markUnread: (id: string) =>
      setBucket((current) =>
        current.workspaceId === workspaceId
          ? {
              ...current,
              entries: {
                ...current.entries,
                [id]: {
                  revision: current.entries[id]?.revision ?? "",
                  forced: true,
                },
              },
            }
          : current,
      ),
  };
}

/**
 * Marks the tab title while the chat open in this tab has a finished answer
 * the person has not seen (it finished while the tab was hidden). Other
 * chats' unread answers show only as the list's blue dots.
 */
export function useUnreadTabMarker(
  chats: readonly { id: string; status: ChatListStatus }[],
  openChatId: string,
) {
  const openUnread = chats.some(
    (chat) => chat.id === openChatId && chat.status === "unread",
  );
  useEffect(() => setDocumentUnread(openUnread), [openUnread]);
  useEffect(() => () => setDocumentUnread(false), []);
}

/** A workspace's chat titles, by chat. */
interface ChatTitleList {
  items: Record<string, ChatTitleMetadata>;
  /**
   * The stream epoch it was read at (see foundryStreamEpoch); -1 once an
   * event said it changed without saying how.
   */
  epoch: number;
}

/** What chat_titles_changed carries: the changed chats' entries. */
interface ChatTitlesChange {
  titles?: ChatTitleMetadata[];
  removed?: string[];
}

function withTitles(
  items: Record<string, ChatTitleMetadata>,
  change: ChatTitlesChange,
): Record<string, ChatTitleMetadata> {
  const next = { ...items };
  for (const chatId of change.removed ?? []) delete next[chatId];
  for (const title of change.titles ?? []) next[title.chatId] = title;
  return next;
}

/**
 * The workspace's chat titles: read once when the chat list first shows
 * (after the stream opened), then kept from chat_titles_changed, which
 * carries the changed chats. Read again, when shown, only after an event
 * that does not say what changed or a resync newer than the read. Lists of
 * workspaces shown before are kept the same way.
 */
export function useChatTitles(
  workspaceId: string,
  active: boolean,
  notify: (message: string) => void,
) {
  const [lists, setLists] = useState<Record<string, ChatTitleList>>({});
  const listsRef = useRef(lists);
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;
  const activeRef = useRef(active);
  activeRef.current = active;
  /**
   * Changes heard while a read runs, applied over its answer; `stale` when
   * one did not say what changed.
   */
  const readingRef = useRef(
    new Set<{
      workspaceId: string;
      changes: ChatTitlesChange[];
      stale: boolean;
    }>(),
  );
  /** A first read waiting for the stream to open: it reads after a resync. */
  const waitingRef = useRef<{ workspaceId: string }>(undefined);
  const watchedJobsRef = useRef(new Set<string>());
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const keep = useCallback((id: string, list: ChatTitleList) => {
    listsRef.current = { ...listsRef.current, [id]: list };
    setLists(listsRef.current);
  }, []);
  /**
   * Follows naming jobs while the list shows: one seen queued or running
   * that failed is told once.
   */
  const watch = useCallback(
    (id: string, titles: Iterable<ChatTitleMetadata>) => {
      if (!activeRef.current || workspaceRef.current !== id) return;
      for (const title of titles) {
        if (!title.generationSessionId) continue;
        if (["queued", "running"].includes(title.generationStatus ?? ""))
          watchedJobsRef.current.add(title.generationSessionId);
        else if (
          title.generationStatus === "failed" &&
          watchedJobsRef.current.delete(title.generationSessionId)
        )
          notifyRef.current(
            title.generationError || i18n.t("chat:autoName.failedRetry"),
          );
      }
    },
    [],
  );
  const change = useCallback(
    (id: string, heard: ChatTitlesChange) => {
      for (const read of readingRef.current)
        if (read.workspaceId === id) read.changes.push(heard);
      const list = listsRef.current[id];
      if (list) keep(id, { ...list, items: withTitles(list.items, heard) });
      watch(id, heard.titles ?? []);
    },
    [keep, watch],
  );
  const read = useCallback(
    async (signal: AbortSignal) => {
      if (!workspaceId) return;
      const reading = {
        workspaceId,
        changes: [] as ChatTitlesChange[],
        stale: false,
      };
      const epoch = foundryStreamEpoch();
      readingRef.current.add(reading);
      try {
        const titles = await listChatTitles(workspaceId, { signal });
        const items = reading.changes.reduce(
          withTitles,
          Object.fromEntries(titles.map((title) => [title.chatId, title])),
        );
        keep(workspaceId, { items, epoch: reading.stale ? -1 : epoch });
        watch(workspaceId, Object.values(items));
      } finally {
        readingRef.current.delete(reading);
      }
    },
    [workspaceId, keep, watch],
  );
  // A read that stalls fails after backgroundReadTimeoutMs.
  const refresh = useMemo(
    () => singleFlight(read, { timeoutMs: backgroundReadTimeoutMs }),
    [read],
  );
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!active || !workspaceId) return;
    const held = listsRef.current[workspaceId];
    if (held && held.epoch === foundryStreamEpoch()) {
      watch(workspaceId, Object.values(held.items));
      return;
    }
    const waiting = { workspaceId };
    waitingRef.current = waiting;
    void foundryStreamOpened().then(() => {
      if (waitingRef.current !== waiting) return;
      waitingRef.current = undefined;
      const list = listsRef.current[workspaceId];
      if (!list || list.epoch !== foundryStreamEpoch())
        void refresh().catch(() => {});
    });
    return () => {
      if (waitingRef.current === waiting) waitingRef.current = undefined;
    };
  }, [active, workspaceId, refresh, watch]);
  useEffect(
    () =>
      subscribeFoundryEvents(
        (event) => {
          if (event.type !== "chat_titles_changed") return;
          const { workspaceId: id, titles, removed } = event.payload;
          if (titles || removed) {
            change(id, { titles, removed });
            return;
          }
          // Said to have changed: what is held is read again when shown.
          for (const read of readingRef.current)
            if (read.workspaceId === id) read.stale = true;
          const list = listsRef.current[id];
          if (list) keep(id, { ...list, epoch: -1 });
          if (id === workspaceRef.current && activeRef.current)
            void refreshRef.current().catch(() => {});
        },
        {
          // Held lists are older than the new epoch now; the one shown is
          // read again unless its first read is still waiting to start.
          onResync: () => {
            const id = workspaceRef.current;
            if (!id || !activeRef.current || waitingRef.current) return;
            void refreshRef.current().catch(() => {});
          },
        },
      ),
    [change, keep],
  );
  const rename = useCallback(
    async (id: string, title: string) => {
      const result = await renameChat(id, workspaceId, title);
      change(workspaceId, { titles: [result] });
    },
    [workspaceId, change],
  );
  const recap = useCallback(
    async (id: string) => {
      try {
        // The job's state arrives as its chat's title changes.
        const job = await recapChatTitle(id, workspaceId);
        watchedJobsRef.current.add(job.id);
        notifyRef.current(i18n.t("chat:autoName.generating"));
      } catch (error) {
        notifyRef.current(
          error instanceof Error
            ? error.message
            : i18n.t("chat:autoName.failed"),
        );
      }
    },
    [workspaceId],
  );
  return {
    titles: lists[workspaceId]?.items ?? {},
    rename,
    recap,
  };
}
