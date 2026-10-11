import { useEffect, useRef, useState } from "react";
import {
  browserEventTypes,
  type AgentBackgroundTaskOutput,
} from "@bd777/foundry-protocol";
import { isAbortError, readBackgroundTaskOutput } from "../../api";
import { onStreamEvent } from "../../stream";

/** As much of the end of a log as is shown: the device reads 64 KB. */
export const backgroundOutputShownChars = 64 * 1024;
/**
 * A followed log is read this often even when it does not grow: it keeps
 * the device following (its lease is a minute) and repairs a missed event.
 */
export const backgroundOutputFollowRenewMs = 25_000;
/** A device that cannot follow a log has it read this often instead. */
export const backgroundOutputPollMs = 5_000;

/** A log as shown, and where the next read continues. */
export interface ShownBackgroundOutput {
  output: AgentBackgroundTaskOutput;
  /** The part of the content before lineEnd; the rest is read again. */
  settled: string;
  /** Undefined: the next read reads the end of the log again. */
  lineEnd?: number;
}

/**
 * The log shown after a read. A read that continues another (`from`) adds
 * to what is shown, which keeps the last backgroundOutputShownChars from
 * a line start on; one that continues something else is not used
 * (undefined): the end of the log is read instead.
 */
export function mergeBackgroundOutput(
  shown: ShownBackgroundOutput | undefined,
  read: AgentBackgroundTaskOutput,
): ShownBackgroundOutput | undefined {
  const stable = Math.min(read.stable ?? 0, read.content.length);
  if (read.from === undefined)
    return {
      output: read,
      settled: read.content.slice(0, stable),
      lineEnd: read.lineEnd,
    };
  if (!shown || shown.lineEnd !== read.from) return undefined;
  let settled = shown.settled + read.content.slice(0, stable);
  let open = read.content.slice(stable);
  let truncated = shown.output.truncated;
  if (!shown.output.truncated && !shown.settled) {
    // The end of a log is shown without leading blank lines.
    settled = settled.replace(/^\n+/, "");
    if (!settled) open = open.replace(/^\n+/, "");
  }
  const excess = settled.length + open.length - backgroundOutputShownChars;
  if (excess > 0) {
    truncated = true;
    const cut = settled.indexOf("\n", excess - 1);
    settled = cut < 0 ? "" : settled.slice(cut + 1);
    if (open.length > backgroundOutputShownChars)
      open = open.slice(open.length - backgroundOutputShownChars);
  }
  return {
    output: {
      ...read,
      content: settled + open,
      truncated,
      from: undefined,
    },
    settled,
    lineEnd: read.lineEnd,
  };
}

export interface BackgroundTaskOutputState {
  output?: AgentBackgroundTaskOutput;
  error?: string;
  /** Only members read output; this reader is not one. */
  membersOnly: boolean;
}

const initialState: BackgroundTaskOutputState = { membersOnly: false };

/**
 * A background task's output while it is shown. A running task's log is
 * followed: the device tells when it grows and only what was added is read.
 * A device that cannot follow has it read every few seconds instead.
 */
export function useBackgroundTaskOutput(
  sessionId: string,
  taskId: string,
  running: boolean,
): BackgroundTaskOutputState {
  const [state, setState] = useState<BackgroundTaskOutputState>(initialState);
  const shown = useRef<ShownBackgroundOutput>(undefined);

  useEffect(() => {
    shown.current = undefined;
    setState(initialState);
  }, [sessionId, taskId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    let readAgain = false;
    let following = false;
    const controller = new AbortController();

    /** Reads once; false when reading further is of no use. */
    const read = async (): Promise<boolean> => {
      try {
        let value = await readBackgroundTaskOutput(sessionId, taskId, {
          signal: controller.signal,
          after: shown.current?.lineEnd,
          follow: running,
        });
        if (cancelled) return false;
        let next = mergeBackgroundOutput(shown.current, value);
        if (!next) {
          value = await readBackgroundTaskOutput(sessionId, taskId, {
            signal: controller.signal,
            follow: running,
          });
          if (cancelled) return false;
          next = mergeBackgroundOutput(undefined, value);
        }
        shown.current = next;
        following = value.following === true;
        setState({ output: next?.output, membersOnly: false });
        return true;
      } catch (reason) {
        if (cancelled || isAbortError(reason)) return false;
        if ((reason as { status?: number }).status === 403) {
          setState((current) => ({ ...current, membersOnly: true }));
          return false;
        }
        setState((current) => ({
          ...current,
          error: reason instanceof Error ? reason.message : String(reason),
        }));
        return true;
      }
    };

    const run = async () => {
      if (reading) {
        readAgain = true;
        return;
      }
      reading = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const goOn = await read();
      reading = false;
      if (cancelled || !goOn) return;
      if (readAgain) {
        readAgain = false;
        void run();
        return;
      }
      if (running)
        timer = setTimeout(
          () => void run(),
          following ? backgroundOutputFollowRenewMs : backgroundOutputPollMs,
        );
    };

    const unsubscribe = running
      ? onStreamEvent(
          browserEventTypes.backgroundTaskOutputChanged,
          (change) => {
            if (change.sessionId === sessionId && change.taskId === taskId)
              void run();
          },
          { onResync: () => void run() },
        )
      : undefined;
    void run();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe?.();
    };
  }, [sessionId, taskId, running]);

  return state;
}
