import type {
  AgentSession,
  AgentSessionEvent,
  AgentSubagentDigest,
} from "@bd777/foundry-protocol";
import { isProcessLabel } from "../../lib/process-labels";

/** The task type of Claude's subagents; devices list only these. */
const subagentTaskType = "local_agent";

/**
 * What decides whether a session's subagent list is read: once the session
 * shows subagents, and, while the event stream is down, again as they start
 * and end.
 */
export interface SubagentActivity {
  /**
   * Short: the count of subagent start and end events and the last one's
   * id. Progress events do not change it: the panel shows their detail and
   * usage from the events themselves.
   */
  revision: string;
  /** Some subagent started and has not finished. */
  running: boolean;
  /** How many subagent end events there are (completed or failed). */
  ended: number;
}

function isSubagentEvent(event: AgentSessionEvent): boolean {
  return (
    Boolean(event.metadata?.taskId) ||
    isProcessLabel(
      event.label,
      "startingSubtask",
      "subtaskRunning",
      "subtaskCompleted",
      "subtaskFailed",
    ) ||
    /^Subtask /i.test(event.label)
  );
}

/** A subagent's progress report ("Subtask running"), not a start or end. */
function isSubagentProgress(event: AgentSessionEvent): boolean {
  return isProcessLabel(event.label, "subtaskRunning");
}

const activities = new WeakMap<
  readonly AgentSessionEvent[],
  SubagentActivity
>();

/** One pass over the events, cached per event list. */
export function subagentActivity(
  session: Pick<AgentSession, "events" | "provider" | "status">,
): SubagentActivity | undefined {
  if (session.provider !== "claude" || !session.events) return undefined;
  let activity = activities.get(session.events);
  if (!activity) {
    let count = 0;
    let lastId = "";
    let ended = 0;
    const open = new Set<string>();
    // Tasks that are no subagents (background commands, monitors), as their
    // starts say: their ends do not name a type.
    const others = new Set<string>();
    for (const event of session.events) {
      if (!isSubagentEvent(event) || isSubagentProgress(event)) continue;
      const taskId = event.metadata?.taskId;
      const type = event.metadata?.taskType;
      if (type && type !== subagentTaskType) {
        if (taskId) others.add(taskId);
        continue;
      }
      if (taskId && others.has(taskId)) continue;
      count += 1;
      lastId = event.id;
      const end = isProcessLabel(
        event.label,
        "subtaskCompleted",
        "subtaskFailed",
      );
      if (end) ended += 1;
      if (!taskId) continue;
      if (isProcessLabel(event.label, "startingSubtask")) open.add(taskId);
      else if (end) open.delete(taskId);
    }
    activity = {
      revision: count ? `${count}:${lastId}` : "",
      running: open.size > 0,
      ended,
    };
    activities.set(session.events, activity);
  }
  if (!activity.revision) return undefined;
  const sessionActive =
    session.status === "running" || session.status === "queued";
  return sessionActive ? activity : { ...activity, running: false };
}

/**
 * How often a session's list is fetched at most while the stream is down
 * and subagents run, how long a first failed read waits before the next,
 * and the shortest wait between reads a subagent's end asks for while reads
 * fail.
 */
export const subagentRefreshIntervalMs = 5_000;

/** The longest wait between reads that keep failing (a device offline). */
export const subagentRetryCapMs = 5 * 60_000;

/** How long a read waits after `failures` failed in a row: it backs off. */
export function subagentRetryDelayMs(failures: number): number {
  return Math.min(
    subagentRefreshIntervalMs * 3 ** Math.max(0, failures - 1),
    subagentRetryCapMs,
  );
}

export interface SubagentReadInput {
  activity: SubagentActivity | undefined;
  /** The side panel, which lists subagents, is on screen. */
  panelVisible: boolean;
  /**
   * The list held was read at the stream's current epoch, no update asked
   * for it again and no read of it failed since: the stream's updates keep
   * it current.
   */
  current: boolean;
  /** The last read failed. */
  failed: boolean;
  /** Reads that failed in a row. */
  failures?: number;
  /** The activity's `ended` when the last read started. */
  endedAtFetch?: number;
  inFlight: boolean;
  lastFetchAt?: number;
  now: number;
}

/**
 * The wait before reading again after a failed read: it grows while reads
 * keep failing, except that a subagent which ended since the last read is
 * read after subagentRefreshIntervalMs at most. Until the list holds its
 * answer, the main transcript shows it as well; a device that keeps
 * failing still gets no more than one such read per interval.
 */
function failedReadWait(
  activity: SubagentActivity,
  failures: number,
  endedAtFetch: number | undefined,
): number {
  const backOff = subagentRetryDelayMs(failures);
  return endedAtFetch !== undefined && activity.ended > endedAtFetch
    ? Math.min(backOff, subagentRefreshIntervalMs)
    : backOff;
}

/**
 * When to read a session's subagents while the event stream is open: once,
 * when the session shows subagents and no current list is held; never while
 * a request for it runs. Running subagents alone wait for the panel, as
 * nothing they answered is kept out of the transcript yet. A failed read is
 * read again after a wait that grows while reads keep failing, or sooner
 * once a subagent ends (see failedReadWait). Returns the delay in ms, or
 * undefined for no read.
 */
export function subagentReadDelay({
  activity,
  panelVisible,
  current,
  failed,
  failures = 1,
  endedAtFetch,
  inFlight,
  lastFetchAt,
  now,
}: SubagentReadInput): number | undefined {
  if (!activity || inFlight || current) return undefined;
  if (activity.running && activity.ended === 0 && !panelVisible)
    return undefined;
  if (!failed || lastFetchAt === undefined) return 0;
  return Math.max(
    0,
    lastFetchAt + failedReadWait(activity, failures, endedAtFetch) - now,
  );
}

/**
 * The list with one subagent as an update reports it. A start never
 * replaces the subagent the list has: a read may already hold its end.
 */
export function applySubagentUpdate(
  subagents: AgentSubagentDigest[],
  update: AgentSubagentDigest,
): AgentSubagentDigest[] {
  const index = subagents.findIndex(
    (subagent) => subagent.taskId === update.taskId,
  );
  if (index < 0) return [...subagents, update];
  if (update.status === "running") return subagents;
  return subagents.map((subagent, at) => (at === index ? update : subagent));
}

export interface SubagentFetchInput {
  activity: SubagentActivity | undefined;
  /** The side panel, which lists subagents, is on screen. */
  panelVisible: boolean;
  /** Revision of the list shown, if one was fetched. */
  fetchedRevision?: string;
  /** The activity's `ended` when the last fetch started. */
  endedAtFetch?: number;
  /** The last fetch failed. */
  failed?: boolean;
  /** Fetches that failed in a row. */
  failures?: number;
  inFlight: boolean;
  lastFetchAt?: number;
  now: number;
}

/**
 * When to fetch a session's subagents while the event stream is down (no
 * updates arrive): never while a request for it runs.
 * A subagent that ended since the last fetch is fetched at once, panel or
 * not: its answer shows in the transcript until the list keeps it out.
 * Otherwise at most every few seconds; while subagents run, only with the
 * panel on screen; once they settled, once more whether the panel shows or
 * not (the panel shows their final state). After a failed fetch the next
 * waits as subagentReadDelay's does. Returns the delay in ms, or undefined
 * for no fetch.
 */
export function subagentFetchDelay({
  activity,
  panelVisible,
  fetchedRevision,
  endedAtFetch = 0,
  failed = false,
  failures = 1,
  inFlight,
  lastFetchAt,
  now,
}: SubagentFetchInput): number | undefined {
  if (!activity || inFlight || activity.revision === fetchedRevision)
    return undefined;
  const ended = activity.ended > endedAtFetch;
  if (!ended && activity.running && !panelVisible) return undefined;
  if (lastFetchAt === undefined) return 0;
  if (failed)
    return Math.max(
      0,
      lastFetchAt + failedReadWait(activity, failures, endedAtFetch) - now,
    );
  if (ended) return 0;
  return Math.max(0, lastFetchAt + subagentRefreshIntervalMs - now);
}
