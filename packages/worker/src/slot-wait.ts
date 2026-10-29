import {
  daemonMessageTypes,
  processLabels,
  type AgentSession,
} from "@bd777/foundry-protocol";
import { sessionEvent } from "./session-helpers.js";
import type { SchedulerWait } from "./task-scheduler.js";
import type { ReliableSessionTransport } from "./transport.js";

/**
 * Tells a turn that cannot start at once why it waits (DEV-084): one event
 * per input, rewritten when the turn starts.
 */
export function slotWaitNotice(
  transport: Pick<ReliableSessionTransport, "send">,
  session: Pick<AgentSession, "id" | "input">,
  now: () => number = Date.now,
) {
  const id = `evt_${session.id}_slot_${session.input?.id || "turn"}`;
  let since: number | undefined;
  const send = (label: string, detail: string) =>
    transport.send(daemonMessageTypes.sessionEvent, {
      event: sessionEvent(session.id, label, detail, "info", id),
    });
  return {
    onWait(wait: SchedulerWait): void {
      since = now();
      send(
        processLabels.waitingForSlot,
        wait.sameKey
          ? "This conversation's previous turn is still running on this device; this turn starts when it ends."
          : `${wait.running} of ${wait.limit} turns are running on this device; this turn starts when one ends. The limit is in the device's settings.`,
      );
    },
    /** The turn starts with `running` turns running, itself included. */
    started(load: { running: number; limit: number }): void {
      if (since === undefined) return;
      const seconds = Math.max(1, Math.round((now() - since) / 1000));
      const waited =
        seconds < 60
          ? `${seconds} s`
          : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
      send(
        processLabels.waitedForSlot,
        `Started after waiting ${waited}; ${load.running} of ${load.limit} turns are running on this device.`,
      );
    },
  };
}
