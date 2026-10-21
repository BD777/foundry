import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SessionWork,
  SessionWorkList,
  WorkControlInput,
  WorkAction,
} from "@bd777/foundry-protocol";
import { controlSessionWork, listSessionWork } from "../../api";
import { onStreamEvent } from "../../stream";
import { isSidebarWork, workActions } from "./chat-work-state";

export function useSessionWork(sessionId?: string) {
  const [list, setList] = useState<SessionWorkList>();
  const [listSessionId, setListSessionId] = useState<string>();
  const [error, setError] = useState<string>();
  const [controlError, setControlError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const epoch = useRef(0);
  const inFlight = useRef<number | undefined>(undefined);
  const retry = useRef<WorkControlInput | undefined>(undefined);
  const refresh = useCallback(async () => {
    const version = epoch.current;
    if (!sessionId || inFlight.current === version) return;
    inFlight.current = version;
    try {
      const answer = await listSessionWork(sessionId);
      if (version === epoch.current) {
        setList(answer);
        setListSessionId(sessionId);
        setError(undefined);
      }
    } catch (e) {
      if (version === epoch.current)
        setError(e instanceof Error ? e.message : String(e));
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
    busy,
    refresh,
    control,
    retryControl,
  };
}
export type SessionWorkController = ReturnType<typeof useSessionWork>;
