import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SessionWork,
  SessionWorkList,
  WorkControlInput,
} from "@bd777/foundry-protocol";
import { controlSessionWork, listSessionWork } from "../../api";
import { onStreamEvent } from "../../stream";

export function useSessionWork(sessionId?: string) {
  const [list, setList] = useState<SessionWorkList>();
  const [error, setError] = useState<string>();
  const [controlError, setControlError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const retry = useRef<WorkControlInput | undefined>(undefined);
  const refresh = useCallback(async () => {
    if (!sessionId || inFlight.current) return;
    inFlight.current = true;
    const version = epoch.current;
    try {
      const answer = await listSessionWork(sessionId);
      if (version === epoch.current) {
        setList(answer);
        setError(undefined);
      }
    } catch (e) {
      if (version === epoch.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
    }
  }, [sessionId]);
  useEffect(() => {
    epoch.current++;
    setList(undefined);
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
    async (action: WorkControlInput["action"], item?: SessionWork) => {
      const input =
        retry.current?.id === item?.id &&
        retry.current?.action === action &&
        retry.current?.expectedRevision === item?.revision
          ? retry.current
          : {
              id: item?.id,
              action,
              expectedRevision: item?.revision,
              idempotencyKey: crypto.randomUUID(),
            };
      await applyControl(input);
    },
    [applyControl],
  );
  const retryControl = useCallback(async () => {
    // Preserve the exact request: the device may have accepted it before a
    // response was lost, even if polling has since advanced the task revision.
    if (retry.current) await applyControl(retry.current);
  }, [applyControl]);
  return {
    list,
    error: controlError || error,
    controlError,
    busy,
    refresh,
    control,
    retryControl,
  };
}
export type SessionWorkController = ReturnType<typeof useSessionWork>;
