import { useEffect, useState } from "react";
import { getAssistantHomeUnread, markAssistantHomeSeen } from "../../api";
import { onStreamEvent } from "../../stream";
import { isAssistantSession } from "./assistant-model";

/** How often the marker is read while the tab is visible. */
const unreadPollMs = 10_000;

function documentVisible(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
}

/**
 * Whether the assistant's home conversation holds an answer the person has
 * not seen (DEV-278). The marker follows the person's last view: while the
 * home conversation is on screen and the tab is visible, its answers are
 * marked seen and no marker shows. The sidebar and the tab title read it.
 */
export function useAssistantHomeUnread(
  assistantId: string | undefined,
  workspaceId: string | undefined,
  viewing: boolean,
): boolean {
  const [unread, setUnread] = useState(false);
  const [visible, setVisible] = useState(documentVisible);

  useEffect(() => {
    if (!assistantId) {
      setUnread(false);
      return;
    }
    let cancelled = false;
    const read = () => {
      getAssistantHomeUnread(assistantId).then(
        (state) => {
          if (!cancelled) setUnread(state.unread);
        },
        () => {
          // The last marker stays; the next read retries.
        },
      );
    };
    read();
    const timer = window.setInterval(() => {
      if (documentVisible()) read();
    }, unreadPollMs);
    const onVisibility = () => {
      const next = documentVisible();
      setVisible(next);
      if (next) read();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);
    const stop = workspaceId
      ? onStreamEvent(
          "agent_session_completed",
          (session) => {
            if (isAssistantSession(session)) read();
          },
          { workspaceId },
        )
      : () => {};
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
      stop();
    };
  }, [assistantId, workspaceId]);

  // Looking at the conversation marks what it holds seen; an answer recorded
  // after this read stays unseen until the person looks again.
  useEffect(() => {
    if (!assistantId || !viewing || !visible || !unread) return;
    let cancelled = false;
    markAssistantHomeSeen(assistantId).then(
      (state) => {
        if (!cancelled) setUnread(state.unread);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [assistantId, viewing, visible, unread]);

  return viewing && visible ? false : unread;
}
