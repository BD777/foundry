import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PersonalAgentItem,
  PersonalAgentItemDetail,
  PersonalAgentItemList,
  PersonalAgentItemOwner,
  PersonalAgentItemPlanChoice,
  PersonalAgentItemReport,
  PersonalAgentItemStatus,
  PersonalAgentOperation,
} from "@bd777/foundry-protocol";
import {
  deletePersonalAgentItem,
  getPersonalAgentItem,
  getPersonalAgentItemReport,
  listPersonalAgentItems,
  listPersonalAgentOperations,
  updatePersonalAgentItem,
  type PersonalAgentItemsQuery,
} from "../../api";
import { serverErrorText } from "../../lib/errors";
import { onStreamEvent } from "../../stream";
import { assistantSessionEventTypes } from "./assistant-session-events";

const refreshDelayMs = 400;

/** How many items one page of the list asks for; 「加载更多」 asks for the next. */
export const itemsPageSize = 50;

interface LiveRead<T> {
  value?: T;
  error: string;
  reload: () => Promise<void>;
}

/**
 * A read that follows its key: the value shown belongs to the current key
 * only, a late answer for an older key is dropped, and the read repeats when
 * one of the assistant's sessions starts or ends. `load` undefined reads nothing.
 */
function useLiveRead<T>(
  load: (() => Promise<T>) | undefined,
  loadKey: string,
): LiveRead<T> {
  const [state, setState] = useState<{
    key: string;
    value?: T;
    error: string;
  }>({ key: "", error: "" });
  const loadRef = useRef(load);
  const sequence = useRef(0);
  useEffect(() => {
    loadRef.current = load;
  });

  const reload = useCallback(async () => {
    const current = loadRef.current;
    const mine = ++sequence.current;
    if (!current) return;
    try {
      const value = await current();
      if (mine === sequence.current)
        setState({ key: loadKey, value, error: "" });
    } catch (reason) {
      if (mine === sequence.current)
        setState({ key: loadKey, error: serverErrorText(reason) });
    }
  }, [loadKey]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void reload(), refreshDelayMs);
    };
    const stops = assistantSessionEventTypes.map((type) =>
      onStreamEvent(type, () => schedule(), { onResync: schedule }),
    );
    return () => {
      window.clearTimeout(timer);
      stops.forEach((stop) => stop());
    };
  }, [reload]);

  const current = state.key === loadKey;
  return {
    value: current ? state.value : undefined,
    error: current ? state.error : "",
    reload,
  };
}

/** One page of the person's items; `query` undefined reads nothing. */
export function usePersonalItems(
  assistantId: string | undefined,
  query: PersonalAgentItemsQuery | undefined,
): LiveRead<PersonalAgentItemList> {
  return useLiveRead(
    query ? () => listPersonalAgentItems(assistantId, query) : undefined,
    JSON.stringify([assistantId ?? "", query ?? null]),
  );
}

export interface PagedPersonalItems {
  items: PersonalAgentItem[];
  total: number;
  hasMore: boolean;
  /** Set while the first page of a new query is on its way. */
  loading: boolean;
  error: string;
  /** Asks for the next page, after the last one shown. */
  loadMore: () => Promise<void>;
  /** Reads again from the top, keeping as many pages as were shown. */
  reload: () => Promise<void>;
}

/**
 * The person's items as pages: each page ends where `nextOffset` says the
 * next one starts, so the list has no fixed cap. A reload reads the pages
 * shown again; a stale answer never replaces a newer one.
 */
export function usePagedPersonalItems(
  assistantId: string | undefined,
  query: PersonalAgentItemsQuery | undefined,
): PagedPersonalItems {
  const loadKey = JSON.stringify([assistantId ?? "", query ?? null]);
  const [state, setState] = useState<{
    key: string;
    pages: PersonalAgentItemList[];
    error: string;
  }>({ key: "", pages: [], error: "" });
  const current = state.key === loadKey ? state : undefined;
  const pageCount = current?.pages.length ?? 1;
  const latest = useRef({ assistantId, query, pageCount });
  useEffect(() => {
    latest.current = { assistantId, query, pageCount };
  });
  const sequence = useRef(0);

  const readPage = (offset: number) => {
    const { assistantId: who, query: filter } = latest.current;
    if (!filter) throw new Error("no query");
    return listPersonalAgentItems(who, {
      ...filter,
      limit: itemsPageSize,
      offset,
    });
  };

  const readPages = useCallback(
    async (keep: number) => {
      const mine = ++sequence.current;
      if (!latest.current.query) return;
      try {
        const pages: PersonalAgentItemList[] = [];
        let offset: number | undefined = 0;
        do {
          const page = await readPage(offset);
          pages.push(page);
          offset = page.nextOffset;
        } while (offset !== undefined && pages.length < keep);
        if (mine === sequence.current)
          setState({ key: loadKey, pages, error: "" });
      } catch (reason) {
        if (mine === sequence.current)
          setState((before) => ({
            key: loadKey,
            pages: before.key === loadKey ? before.pages : [],
            error: serverErrorText(reason),
          }));
      }
    },
    [loadKey],
  );

  useEffect(() => {
    void readPages(1);
  }, [readPages]);

  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => void readPages(latest.current.pageCount),
        refreshDelayMs,
      );
    };
    const stops = assistantSessionEventTypes.map((type) =>
      onStreamEvent(type, () => schedule(), { onResync: schedule }),
    );
    return () => {
      window.clearTimeout(timer);
      stops.forEach((stop) => stop());
    };
  }, [readPages]);

  const lastPage = current?.pages[current.pages.length - 1];
  const nextOffset = lastPage?.nextOffset;
  const loadMore = useCallback(async () => {
    if (nextOffset === undefined) return;
    const mine = ++sequence.current;
    try {
      const page = await readPage(nextOffset);
      if (mine === sequence.current)
        setState((before) =>
          before.key === loadKey
            ? { ...before, pages: [...before.pages, page] }
            : before,
        );
    } catch (reason) {
      if (mine === sequence.current)
        setState((before) => ({ ...before, error: serverErrorText(reason) }));
    }
  }, [loadKey, nextOffset]);

  return {
    items: current ? current.pages.flatMap((page) => page.items) : [],
    total: current?.pages[0]?.total ?? 0,
    hasMore: nextOffset !== undefined,
    loading: !current,
    error: current?.error ?? state.error,
    loadMore,
    reload: () => readPages(pageCount),
  };
}

/** One item with its timeline; `itemId` undefined reads nothing. */
export function usePersonalItemDetail(
  assistantId: string | undefined,
  itemId: string | undefined,
): LiveRead<PersonalAgentItemDetail> {
  return useLiveRead(
    itemId ? () => getPersonalAgentItem(assistantId, itemId) : undefined,
    JSON.stringify([assistantId ?? "", itemId ?? null]),
  );
}

/** The deterministic review of a range; `range` undefined reads nothing. */
export function usePersonalItemReport(
  assistantId: string | undefined,
  range: { from: string; to: string } | undefined,
): LiveRead<PersonalAgentItemReport> {
  return useLiveRead(
    range
      ? () => getPersonalAgentItemReport(assistantId, range.from, range.to)
      : undefined,
    JSON.stringify([assistantId ?? "", range ?? null]),
  );
}

/** The assistant's runs; a plan shows the latest one of its item. */
export function usePersonalOperations(
  assistantId: string | undefined,
): LiveRead<PersonalAgentOperation[]> {
  return useLiveRead(
    () => listPersonalAgentOperations(assistantId),
    JSON.stringify(["operations", assistantId ?? ""]),
  );
}

/**
 * The person's edits, the archive switch and the delete. Each call changes
 * one fact and the caller reloads what it shows; failures reach the caller.
 */
export const personalItemActions = {
  setStatus(
    assistantId: string | undefined,
    item: PersonalAgentItem,
    status: PersonalAgentItemStatus,
  ): Promise<PersonalAgentItem> {
    return updatePersonalAgentItem(assistantId, item.id, {
      revision: item.revision,
      status,
    });
  },
  setOwner(
    assistantId: string | undefined,
    item: PersonalAgentItem,
    owner: PersonalAgentItemOwner,
  ): Promise<PersonalAgentItem> {
    return updatePersonalAgentItem(assistantId, item.id, {
      revision: item.revision,
      owner,
    });
  },
  setText(
    assistantId: string | undefined,
    item: PersonalAgentItem,
    text: string,
  ): Promise<PersonalAgentItem> {
    return updatePersonalAgentItem(assistantId, item.id, {
      revision: item.revision,
      text,
    });
  },
  /** The person's choice of route, project and dependencies; the server merges it. */
  setPlan(
    assistantId: string | undefined,
    item: PersonalAgentItem,
    plan: PersonalAgentItemPlanChoice,
  ): Promise<PersonalAgentItem> {
    return updatePersonalAgentItem(assistantId, item.id, {
      revision: item.revision,
      plan,
    });
  },
  /** Archives a closed item, or brings it back; the server refuses an open one. */
  setArchived(
    assistantId: string | undefined,
    item: PersonalAgentItem,
    archived: boolean,
  ): Promise<PersonalAgentItem> {
    return updatePersonalAgentItem(assistantId, item.id, {
      revision: item.revision,
      archived,
    });
  },
  remove(assistantId: string | undefined, item: PersonalAgentItem) {
    return deletePersonalAgentItem(assistantId, item.id);
  },
};
