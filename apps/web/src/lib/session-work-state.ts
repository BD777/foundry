import {
  isStandaloneWork,
  hasFutureScheduledWork,
  type SessionWork,
  type WorkAction,
} from "@bd777/foundry-protocol";

export function needsConfirmation(item: SessionWork): boolean {
  return (
    item.management === "managed" &&
    (item.revision > item.observation.confirmedRevision ||
      (item.desiredState === "stopped" &&
        !["completed", "failed", "stopped"].includes(
          item.observation.status,
        )) ||
      item.observation.status === "unknown" ||
      Boolean(item.observation.error))
  );
}

export function isFinishedWork(item: SessionWork): boolean {
  return (
    (item.management === "managed" || Boolean(item.native)) &&
    !hasFutureScheduledWork(item) &&
    !needsConfirmation(item) &&
    ["completed", "failed", "stopped"].includes(item.observation.status) &&
    (item.kind !== "schedule" || item.desiredState !== "paused")
  );
}

export function workActions(item: SessionWork): WorkAction[] {
  if (item.desiredState === "removed" || !isStandaloneWork(item)) return [];
  if (item.native && item.kind === "agent") return [];
  if (item.native && item.native.observation !== "available") return [];
  if (item.management === "observed")
    return item.allowedActions.filter((action) => action === "adopt");
  const finished = isFinishedWork(item);
  return item.allowedActions.filter((action) => {
    if (action === "remove") return finished;
    if (action === "stop")
      return (
        !finished &&
        (item.desiredState !== "stopped" ||
          Boolean(item.observation.error) ||
          (item.observation.confirmedRevision >= item.revision &&
            ["running", "suspended"].includes(item.observation.status)))
      );
    if (needsConfirmation(item)) return false;
    if (action === "pause")
      return (
        !finished &&
        item.desiredState === "enabled" &&
        (item.kind === "schedule" || item.observation.status === "running")
      );
    if (action === "resume")
      return (
        item.desiredState === "paused" ||
        (item.desiredState === "stopped" && finished) ||
        (item.kind === "process" && finished)
      );
    if (action === "run")
      return item.kind === "schedule" && item.desiredState !== "stopped";
    return false;
  });
}
/** The composer and panel count the same managed tasks, including paused work. */
export function isCurrentWork(item: SessionWork): boolean {
  return (
    (item.management === "managed" || Boolean(item.native)) &&
    isStandaloneWork(item) &&
    item.desiredState !== "removed" &&
    !isFinishedWork(item)
  );
}
