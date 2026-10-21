export {
  needsConfirmation,
  isFinishedWork,
  workActions,
  isCurrentWork,
} from "../../lib/session-work-state";

import { isStandaloneWork, type SessionWork } from "@bd777/foundry-protocol";
import { isCurrentWork } from "../../lib/session-work-state";

/** A presentation boundary only: the full inventory and Workspace services stay intact. */
export function isSidebarWork(item: SessionWork): boolean {
  return (
    item.desiredState !== "removed" &&
    isStandaloneWork(item) &&
    (item.kind === "schedule" || item.kind === "agent")
  );
}

export function sidebarWorkCounts(items: SessionWork[]) {
  const current = items.filter(
    (item) => isSidebarWork(item) && isCurrentWork(item),
  );
  return {
    timers: current.filter((item) => item.kind === "schedule").length,
    agents: current.filter((item) => item.kind === "agent").length,
  };
}
