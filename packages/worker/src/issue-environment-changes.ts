/**
 * Changes to what an Issue environment's status read returns
 * (environmentStatus): its record, its preview, or the workspace's
 * repositories. Whoever shows environments listens here instead of asking
 * again on a timer; the device connection tells the server.
 */

import { errorMessage } from "./utils.js";

/** One Issue's environment, or (without issueId) every one of a workspace. */
export interface IssueEnvironmentChange {
  workspaceId?: string;
  issueId?: string;
}

type Listener = (change: IssueEnvironmentChange) => void;

const listeners = new Set<Listener>();

export function onIssueEnvironmentChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function issueEnvironmentChanged(change: IssueEnvironmentChange): void {
  for (const listener of [...listeners]) {
    try {
      listener(change);
    } catch (error) {
      console.error(
        `Telling an Issue environment change failed: ${errorMessage(error)}`,
      );
    }
  }
}

/**
 * Tells changes at most once per `quietMs` for each environment, the last
 * of a burst included: a run saves its environment several times in a row.
 */
export function coalescedIssueEnvironmentChanges(
  tell: (change: IssueEnvironmentChange) => void,
  quietMs = 250,
): { listener: Listener; close: () => void } {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    listener: (change) => {
      const key = `${change.workspaceId ?? ""}\n${change.issueId ?? ""}`;
      if (pending.has(key)) return;
      const timer = setTimeout(() => {
        pending.delete(key);
        tell(change);
      }, quietMs);
      timer.unref?.();
      pending.set(key, timer);
    },
    close: () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
}
