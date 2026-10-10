import { useCallback, useEffect, useState } from "react";
import type { OutboxEntry } from "./chat-outbox";

/** How long a delivered message keeps its client id in the transcript. */
const deliveredLingerMs = 30_000;

export interface ChatOutbox {
  entries: readonly OutboxEntry[];
  add: (entry: OutboxEntry) => void;
  accept: (id: string, patch: Partial<OutboxEntry>) => void;
  remove: (...ids: string[]) => void;
}

/** Messages this tab sent and the transcript may not show yet. */
export function useChatOutbox(workspaceId: string): ChatOutbox {
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  useEffect(() => () => setEntries([]), [workspaceId]);
  const add = useCallback((entry: OutboxEntry) => {
    setEntries((current) => [
      ...current.filter((item) => item.id !== entry.id),
      entry,
    ]);
  }, []);
  const accept = useCallback((id: string, patch: Partial<OutboxEntry>) => {
    setEntries((current) =>
      current.map((item) =>
        item.id === id ? { ...item, ...patch, state: "accepted" } : item,
      ),
    );
  }, []);
  const remove = useCallback((...ids: string[]) => {
    setEntries((current) => current.filter((item) => !ids.includes(item.id)));
  }, []);
  return { entries, add, accept, remove };
}

/** Drops, a little later, accepted entries whose events the transcript shows. */
export function usePruneDeliveredOutbox(
  outbox: ChatOutbox,
  delivered: ReadonlySet<string>,
): void {
  const done = outbox.entries
    .filter((entry) => entry.state === "accepted" && delivered.has(entry.id))
    .map((entry) => entry.id)
    .join("\n");
  const { remove } = outbox;
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(
      () => remove(...done.split("\n")),
      deliveredLingerMs,
    );
    return () => clearTimeout(timer);
  }, [done, remove]);
}
