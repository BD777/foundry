import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SessionWork,
  SessionWorkList,
  WorkControlInput,
  WorkAction,
} from "@bd777/foundry-protocol";
import { controlSessionWork, isDatabaseBusy, listSessionWork } from "../../api";
import { onStreamEvent } from "../../stream";
import { isSidebarWork, workActions } from "./chat-work-state";

/**
 * How long a read the server refused as database_busy waits before its one
 * retry; the server's Retry-After for that answer is 2 seconds.
 */
export const workBusyRetryMs = 2000;

export function useSessionWork(sessionId?: string) {
  const [list, setList] = useState<SessionWorkList>();
  const [listSessionId, setListSessionId] = useState<string>();
  const [error, setError] = useState<string>();
  const [controlError, setControlError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [retrying, setRetrying] = useState(false);
  const epoch = useRef(0);
  const inFlight = useRef<number | undefined>(undefined);
  const retry = useRef<WorkControlInput | undefined>(undefined);
  const refresh = useCallback(async () => {
    const version = epoch.current;
    if (!sessionId || inFlight.current === version) return;
    inFlight.current = version;
    try {
      let answer: SessionWorkList;
      try {
        answer = await listSessionWork(sessionId);
      } catch (e) {
        // A locked database is momentary: show that the panel is retrying
        // and read once more after a pause; polls wait for that retry.
        if (!isDatabaseBusy(e) || version !== epoch.current) throw e;
        setRetrying(true);
        await new Promise((resolve) => setTimeout(resolve, workBusyRetryMs));
        if (version !== epoch.current) return;
        answer = await listSessionWork(sessionId);
      }
      if (version === epoch.current) {
        setList(answer);
        setListSessionId(sessionId);
        setError(undefined);
        setRetrying(false);
      }
    } catch (e) {
      if (version === epoch.current) {
        setRetrying(false);
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (inFlight.current === version) inFlight.current = undefined;
    }
  }, [sessionId]);
  useEffect(() => {
    epoch.current++;
    setList(undefined);
    setListSessionId(undefined);
    setError(undefined);
    setBusy(undefined);
    setRetrying(false);
    setControlError(undefined);
    retry.current = undefined;
    void refresh();
    const poll = setInterval(() => void refresh(), 3000);
    const stop = onStreamEvent(
      "agent_session_event",
      (event) => {
        if (event.sessionId === sessionId && event.label.startsWith("Work "))
          void refresh();
      },
      { onResync: () => void refresh() },
    );
    return () => {
      clearInterval(poll);
      stop();
      epoch.current++;
    };
  }, [refresh, sessionId]);
  const applyControl = useCallback(
    async (input: WorkControlInput) => {
      if (!sessionId || busy) return;
      const version = epoch.current;
      retry.current = input;
      setBusy(input.id || input.action);
      setError(undefined);
      setControlError(undefined);
      try {
        await controlSessionWork(sessionId, input);
        if (version === epoch.current) retry.current = undefined;
        await refresh();
      } catch (e) {
        if (version === epoch.current)
          setControlError(e instanceof Error ? e.message : String(e));
      } finally {
        if (version === epoch.current) setBusy(undefined);
      }
    },
    [sessionId, busy, refresh],
  );
  const control = useCallback(
    async (action: WorkAction, item: SessionWork) => {
      // This UI hides processes and has no conversation-wide stop/barrier action.
      if (!item || !isSidebarWork(item) || !workActions(item).includes(action))
        return;
      const input =
        retry.current?.id === item?.id &&
        retry.current?.action === action &&
        retry.current?.expectedRevision === item?.revision &&
        retry.current?.expectedReferenceRevision === item?.referenceRevision
          ? retry.current
          : {
              id: item?.id,
              action,
              ...(action === "unlink" ? { relatedSessionId: sessionId } : {}),
              expectedRevision: item?.revision,
              expectedReferenceRevision: item?.referenceRevision,
              idempotencyKey: crypto.randomUUID(),
            };
      await applyControl(input);
    },
    [applyControl, sessionId],
  );
  const retryControl = useCallback(async () => {
    // Preserve the exact request: the device may have accepted it before a
    // response was lost, even if polling has since advanced the task revision.
    if (
      retry.current?.id &&
      list?.items.some(
        (item) => item.id === retry.current?.id && isSidebarWork(item),
      )
    )
      await applyControl(retry.current);
  }, [applyControl, list]);
  return {
    sessionId,
    list: listSessionId === sessionId ? list : undefined,
    error: controlError || error,
    controlError,
    controlTargetId: controlError ? retry.current?.id : undefined,
    /** The last read met a busy database; its retry is pending. */
    retrying,
    busy,
    refresh,
    control,
    retryControl,
  };
}
export type SessionWorkController = ReturnType<typeof useSessionWork>;
