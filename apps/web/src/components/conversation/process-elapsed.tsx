import { useSharedNow } from "../../lib/use-shared-now";
import { formatDuration } from "./turn-usage";

/**
 * Time since a running process group's first step, ticking once a second.
 * The tick lives here, so only this text re-renders while a group runs.
 */
export function ProcessElapsed({ startedAt }: { startedAt: string }) {
  const started = Date.parse(startedAt);
  const now = useSharedNow(!Number.isNaN(started));
  if (Number.isNaN(started)) return null;
  return (
    <span className="fdy-chat-process-trigger-meta">
      {formatDuration(Math.max(0, now - started))}
    </span>
  );
}
