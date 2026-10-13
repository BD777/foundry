import { useEffect } from "react";
import { setDocumentChat } from "../../lib/document-title";

/**
 * The tab names the open chat (`title`, empty for none) and marks it while
 * it runs, or while its agent still works in the background.
 */
export function useChatDocumentTitle(
  title: string,
  running: boolean,
  background: boolean,
): void {
  useEffect(() => {
    setDocumentChat(title ? { title, running, background } : undefined);
  }, [title, running, background]);
  useEffect(() => () => setDocumentChat(undefined), []);
}
