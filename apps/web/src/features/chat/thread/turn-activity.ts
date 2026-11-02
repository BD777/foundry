import {
  processLabels,
  sessionInputEventLabel,
  type AgentSession,
} from "@bd777/foundry-protocol";

/** The transcript event of a message steered into a running turn. */
export const steeredIntoTurnLabel = "Steered into active turn";

/** A tool call of the session's running turn that has not returned yet. */
export interface RunningTool {
  callId: string;
  /** The step's label ("Using tool", "Running command"). */
  title: string;
  /** Its detail: the tool's name and input, or the command. */
  detail: string;
  /** When the call started: its first event. */
  startedAt: string;
  /**
   * The Claude task that runs the call (a shell command runs as one): the
   * call can be stopped through it, and returns at once.
   */
  taskId?: string;
}

/**
 * How far the agent got with a message steered into its turn (DEV-089).
 * waiting: delivered, not read yet; read: a model request took it in.
 */
export interface SteerProgress {
  state: "waiting" | "read";
  deliveredAt: string;
  readAt?: string;
  /** While waiting: the running tool calls it waits behind, longest first. */
  blockers: RunningTool[];
}

export interface TurnActivity {
  /** The running turn's tool calls still running, longest first. */
  running: RunningTool[];
  /** Steered messages by transcript entry id, where their state is known. */
  steers: Map<string, SteerProgress>;
}

interface PendingSteer {
  id: string;
  deliveredAt: string;
  /** The calls running when it arrived. */
  behind: Set<string>;
  readAt?: string;
}

/**
 * The tools the running turn runs and where each steered message stands,
 * read from the session's events.
 *
 * Claude takes a steered message with its next model request: after the
 * tool calls running when it arrived return, it requests the model again
 * ("Requesting model") with the message in it. Codex does the same after
 * the running tool returns, and at once (preempting its response) when no
 * tool runs. A message whose turn ended without such a sign stays without
 * a state: nothing tells when it was read.
 */
export function turnActivity(
  session: Pick<AgentSession, "id" | "events" | "provider">,
  live: boolean,
): TurnActivity {
  const claude = session.provider !== "codex";
  const running = new Map<string, RunningTool>();
  const taskOf = new Map<string, string>();
  const steers = new Map<string, SteerProgress>();
  let pending: PendingSteer[] = [];
  const settle = (steer: PendingSteer) =>
    steers.set(steer.id, {
      state: "read",
      deliveredAt: steer.deliveredAt,
      readAt: steer.readAt,
      blockers: [],
    });
  for (const event of session.events ?? []) {
    // A new input starts a turn: what the last one left running ended
    // with it, and its unread messages went in with this input.
    if (event.label === sessionInputEventLabel || event.metadata?.timerFire) {
      running.clear();
      pending = [];
      continue;
    }
    const message = event.message;
    if (event.label === steeredIntoTurnLabel) {
      const steer: PendingSteer = {
        id: `agent-session:${session.id}:${message?.id ?? event.id}`,
        deliveredAt: event.at,
        behind: new Set(running.keys()),
      };
      if (!claude && steer.behind.size === 0) {
        steer.readAt = event.at;
        settle(steer);
      } else pending.push(steer);
      continue;
    }
    if (
      event.label === processLabels.startingSubtask &&
      event.metadata?.taskId &&
      event.metadata.toolUseId
    ) {
      taskOf.set(event.metadata.toolUseId, event.metadata.taskId);
      const tool = running.get(event.metadata.toolUseId);
      if (tool) tool.taskId = event.metadata.taskId;
      continue;
    }
    if (claude && event.label === processLabels.requestingModel) {
      pending = pending.filter((steer) => {
        if ([...steer.behind].some((call) => running.has(call))) return true;
        steer.readAt = event.at;
        settle(steer);
        return false;
      });
      continue;
    }
    if (message?.kind !== "tool" || !message.callId) continue;
    const callId = message.callId;
    if (message.status === "running") {
      const known = running.get(callId);
      running.set(callId, {
        callId,
        title: message.title ?? event.label,
        // The call's first event may come before its input.
        detail: message.text || known?.detail || "",
        startedAt: known?.startedAt ?? message.at ?? event.at,
        ...((known?.taskId ?? taskOf.get(callId))
          ? { taskId: known?.taskId ?? taskOf.get(callId) }
          : {}),
      });
    } else if (message.status === "completed" || message.status === "failed") {
      running.delete(callId);
      if (claude) continue;
      pending = pending.filter((steer) => {
        if ([...steer.behind].some((call) => running.has(call))) return true;
        steer.readAt = event.at;
        settle(steer);
        return false;
      });
    }
  }
  const longestFirst = (tools: Iterable<RunningTool>) =>
    [...tools].sort(
      (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt),
    );
  const now = live ? longestFirst(running.values()) : [];
  if (live)
    for (const steer of pending) {
      const behind = now.filter((tool) => steer.behind.has(tool.callId));
      steers.set(steer.id, {
        state: "waiting",
        deliveredAt: steer.deliveredAt,
        // Nothing ran when it came: it waits behind what the agent runs
        // next, if anything.
        blockers: steer.behind.size > 0 ? behind : now,
      });
    }
  return { running: now, steers };
}
