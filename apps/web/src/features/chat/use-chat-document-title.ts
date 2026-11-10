import { useEffect } from "react";
import { setDocumentChat } from "../../lib/document-title";

/**
 * The tab names the open chat (`title`, empty for none) and marks it while
 * it waits on child sessions, runs, or still works in the background.
 */
export function useChatDocumentTitle(
  title: string,
  running: boolean,
  background: boolean,
  waitingChildCount = 0,
): void {
  useEffect(() => {
    setDocumentChat(
      title ? { title, running, background, waitingChildCount } : undefined,
    );
  }, [title, running, background, waitingChildCount]);
  useEffect(() => () => setDocumentChat(undefined), []);
}
