import { useEffect, useRef } from "react";
import { subscribeFoundryEvents } from "../../api";

/** SSE contains IDs/status only; fetch the authoritative review after a burst. */
export function useEvidenceUpdates(
  issueId: string,
  refresh: () => Promise<void>,
  onError: (message: string) => void,
) {
  const refreshRef = useRef(refresh);
  const errorRef = useRef(onError);
  refreshRef.current = refresh;
  errorRef.current = onError;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (active)
          void refreshRef.current().catch((error) => {
            if (active) errorRef.current(String(error));
          });
      }, 100);
    };
    const close = subscribeFoundryEvents(
      (event) => {
        if (
          event.type === "evidence_updated" &&
          event.payload.issueId === issueId
        )
          schedule();
      },
      { onOpen: schedule },
    );
    return () => {
      active = false;
      clearTimeout(timer);
      close();
    };
  }, [issueId]);
}
