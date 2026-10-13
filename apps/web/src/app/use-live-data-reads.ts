import { useEffect, useRef, useState } from "react";
import { foundryStreamEpoch } from "../stream";
import type { FoundryDataField } from "../api-types";
import { foundryDataPageFields } from "./foundry-data-projection";

/** While the stream is down, workspace data is read this often instead. */
export const streamDownRefreshIntervalMs = 5_000;
/** The longest wait before a read that keeps failing is made again. */
export const failedReadRetryCapMs = 5 * 60_000;

/** A read of workspace data: the default set (`all`) and named fields. */
export interface FoundryDataRead {
  all: boolean;
  fields: readonly FoundryDataField[];
}

/** How a read went; one that did not apply leaves its page fields to read. */
export type FoundryDataReadOutcome = "applied" | "failed" | "skipped" | void;

/** Reads workspace data and keeps which of it is current at which epoch. */
export interface LiveDataReads {
  /**
   * Reads the default set (`all`) and the given fields, adding the shown
   * page fields not current at this epoch to a whole read.
   */
  read: (all: boolean, fields?: readonly FoundryDataField[]) => Promise<void>;
  /** Whether a whole read has been made. */
  started: () => boolean;
  /** When the last read started (ms since the epoch). */
  lastReadAt: () => number;
  /**
   * Whether a field an event changed is to be read. A page field no view
   * shows is not: it is read when one shows it again.
   */
  wants: (field: FoundryDataField) => boolean;
  /** Reads the given page fields that are not current at this epoch. */
  readStale: (pageFields: readonly FoundryDataField[]) => void;
  /**
   * Events may be missing: what was read before the stream's epoch began is
   * read again.
   */
  resync: () => void;
}

export interface UseLiveDataReadsInput {
  onRefresh: (
    read: FoundryDataRead,
  ) => Promise<FoundryDataReadOutcome> | FoundryDataReadOutcome;
  pageFields: readonly FoundryDataField[];
}

/**
 * The bookkeeping of reads: the epoch each read was current at, the page
 * fields read at least once, and retries of reads that did not apply, after
 * a wait that grows while they fail. `pageRetries` changes when page fields
 * are due to be read again.
 */
export function useLiveDataReads({
  onRefresh,
  pageFields,
}: UseLiveDataReadsInput) {
  const refreshRef = useRef(onRefresh);
  const pageFieldsRef = useRef(pageFields);
  refreshRef.current = onRefresh;
  pageFieldsRef.current = pageFields;
  const lastRefreshAtRef = useRef(Date.now());
  /** The epoch the last whole read started at; undefined before the first. */
  const readEpochRef = useRef<number | undefined>(undefined);
  /** Page fields current since the epoch they were read at. */
  const pageEpochsRef = useRef(new Map<FoundryDataField, number>());
  const [loadedPageFields, setLoadedPageFields] = useState<
    ReadonlySet<FoundryDataField>
  >(() => new Set());
  /** A read that did not apply waits on this timer to be made again. */
  const retryRef = useRef({
    timer: null as number | null,
    whole: false,
    failures: 0,
  });
  const [pageRetries, setPageRetries] = useState(0);

  const [reads] = useState<LiveDataReads>(() => {
    const read = (all: boolean, fields: readonly FoundryDataField[] = []) => {
      const epoch = foundryStreamEpoch();
      const page = new Set(
        fields.filter((field) => foundryDataPageFields.includes(field)),
      );
      if (all) {
        readEpochRef.current = epoch;
        for (const field of pageFieldsRef.current)
          if (pageEpochsRef.current.get(field) !== epoch) page.add(field);
      }
      page.forEach((field) => pageEpochsRef.current.set(field, epoch));
      lastRefreshAtRef.current = Date.now();
      const request = { all, fields: [...new Set([...fields, ...page])] };
      const done = (outcome: string | void) => {
        if (outcome === undefined || outcome === "applied") {
          retryRef.current.failures = 0;
          // A whole read that applied makes a waiting whole retry needless.
          if (all) retryRef.current.whole = false;
          if (page.size > 0)
            setLoadedPageFields((loaded) =>
              [...page].every((field) => loaded.has(field))
                ? loaded
                : new Set([...loaded, ...page]),
            );
          return;
        }
        // Not read (failed, or skipped while a workspace loads): not
        // current, and read again after a wait that grows while reads fail.
        for (const field of page)
          if (pageEpochsRef.current.get(field) === epoch)
            pageEpochsRef.current.delete(field);
        const retry = retryRef.current;
        if (all && outcome === "failed") retry.whole = true;
        if (page.size === 0 && !retry.whole) return;
        if (retry.timer !== null) return;
        retry.failures += 1;
        retry.timer = window.setTimeout(
          () => {
            retry.timer = null;
            if (retry.whole) {
              retry.whole = false;
              void read(true);
            } else setPageRetries((count) => count + 1);
          },
          Math.min(
            streamDownRefreshIntervalMs * 3 ** (retry.failures - 1),
            failedReadRetryCapMs,
          ),
        );
      };
      return Promise.resolve(refreshRef.current(request)).then(done, () =>
        done("failed"),
      );
    };
    return {
      read,
      started: () => readEpochRef.current !== undefined,
      lastReadAt: () => lastRefreshAtRef.current,
      wants: (field) => {
        if (
          foundryDataPageFields.includes(field) &&
          !pageFieldsRef.current.includes(field)
        ) {
          pageEpochsRef.current.delete(field);
          return false;
        }
        return true;
      },
      readStale: (fields) => {
        if (readEpochRef.current === undefined) return;
        const epoch = foundryStreamEpoch();
        const stale = fields.filter(
          (field) => pageEpochsRef.current.get(field) !== epoch,
        );
        if (stale.length) void read(false, stale);
      },
      resync: () => {
        const readEpoch = readEpochRef.current;
        const epoch = foundryStreamEpoch();
        for (const [field, at] of pageEpochsRef.current)
          if (at < epoch && !pageFieldsRef.current.includes(field))
            pageEpochsRef.current.delete(field);
        if (readEpoch !== undefined && readEpoch < epoch) void read(true);
      },
    };
  });

  useEffect(
    () => () => {
      const retry = retryRef.current;
      if (retry.timer !== null) window.clearTimeout(retry.timer);
      retry.timer = null;
    },
    [],
  );

  return { loadedPageFields, pageRetries, reads };
}
