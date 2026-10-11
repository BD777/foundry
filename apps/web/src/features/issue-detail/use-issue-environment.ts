import { useEffect, useState } from "react";
import { browserEventTypes, type Issue } from "@bd777/foundry-protocol";
import {
  isAbortError,
  readIssueEnvironment,
  type IssueEnvironmentData,
} from "../../api";
import { onStreamEvent } from "../../stream";

/** While its run works, an environment is read at most this often. */
export const environmentRunReadMs = 4_000;
/** A device that does not tell changes has it read this often instead. */
export const environmentPollMs = 4_000;
/**
 * Changes no event names (a preview configuration added, sizes changing
 * outside a run) show within this.
 */
export const environmentSlowReadMs = 60_000;

export interface IssueEnvironmentState {
  data?: IssueEnvironmentData;
  error: string;
}

/**
 * An Issue's environment while it is shown: read when the device says it
 * changed, at most every few seconds while its run works, and on what may
 * have been missed. A device that does not tell changes has it read every
 * few seconds. `reload` reads it again at once (after an action).
 */
export function useIssueEnvironment(
  issue: Issue,
  reload: number,
): IssueEnvironmentState {
  const [state, setState] = useState<IssueEnvironmentState>({ error: "" });
  const runId = issue.run?.id;

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    let readAgain = false;
    let notifies = false;
    let readAt = Number.NEGATIVE_INFINITY;
    const controller = new AbortController();

    const schedule = (delay: number) => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => void read(), delay);
    };
    const read = async () => {
      if (reading) {
        readAgain = true;
        return;
      }
      reading = true;
      readAt = Date.now();
      try {
        const value = await readIssueEnvironment(issue.id, {
          signal: controller.signal,
        });
        if (!active) return;
        notifies = value.notifiesChanges === true;
        setState({ data: value.environment, error: "" });
      } catch (reason) {
        if (!active || isAbortError(reason)) return;
        setState((current) => ({ ...current, error: String(reason) }));
      } finally {
        reading = false;
      }
      if (!active) return;
      if (readAgain) {
        readAgain = false;
        void read();
        return;
      }
      schedule(notifies ? environmentSlowReadMs : environmentPollMs);
    };
    /** A read for run activity: at most every environmentRunReadMs. */
    const readSoon = () => {
      const wait = readAt + environmentRunReadMs - Date.now();
      if (wait <= 0) void read();
      else if (!reading) schedule(Math.min(wait, environmentRunReadMs));
    };

    const stopChanges = onStreamEvent(
      browserEventTypes.issueEnvironmentChanged,
      (change) => {
        if (
          change.issueId === issue.id ||
          (!change.issueId && change.workspaceId === issue.workspaceId)
        )
          void read();
      },
      { onResync: () => void read() },
    );
    const stopRunEvents = runId
      ? onStreamEvent(browserEventTypes.issueRunEvent, (event) => {
          if (event.runId === runId) readSoon();
        })
      : undefined;
    void read();
    return () => {
      active = false;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
      stopChanges();
      stopRunEvents?.();
    };
  }, [issue.id, issue.workspaceId, issue.status, runId, reload]);

  return state;
}
