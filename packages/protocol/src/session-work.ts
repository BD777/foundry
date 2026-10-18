/** Persistent work is independent of a conversation turn or its compacted history. */
export type WorkAction =
  "pause" | "resume" | "stop" | "remove" | "run" | "adopt";
export type WorkState = "enabled" | "paused" | "stopped" | "removed";
export type WorkStatus =
  | "idle"
  | "running"
  | "suspended"
  | "completed"
  | "failed"
  | "stopped"
  | "unknown";

export interface SessionWork {
  id: string;
  sessionId: string;
  threadId: string;
  workspaceId: string;
  deviceId: string;
  kind: "schedule" | "process" | "agent";
  source: "foundry" | "claude" | "crontab" | "systemd" | "launchd" | "process";
  sourceId?: string;
  parentId?: string;
  title: string;
  management: "managed" | "observed";
  desiredState: WorkState;
  revision: number;
  generation: number;
  createdAt: string;
  updatedAt: string;
  spec: WorkSpec;
  observation: WorkObservation;
  allowedActions: WorkAction[];
}

export interface WorkSpec {
  manualRunAt?: string;
  schedule?: string;
  at?: string;
  timeZone?: string;
  recurring?: boolean;
  prompt?: string;
  argv?: string[];
  cwd?: string;
  nativeSessionId?: string;
  expiresAt?: string;
  target?: "continue_thread" | "new_session";
}

export interface WorkObservation {
  processRole?: "background" | "foreground" | "runtime";
  executionSessionId?: string;
  status: WorkStatus;
  at: string;
  confirmedRevision: number;
  nextFireAt?: string;
  startedAt?: string;
  endedAt?: string;
  error?: string;
  runId?: string;
  exitCode?: number;
}

export interface WorkOperation {
  sequence?: number;
  unmanaged?: number;
  id: string;
  sessionId: string;
  action: WorkAction | "stop_all" | "pause_all";
  state: "pending" | "verified" | "failed" | "unknown";
  createdAt: string;
  items: Array<{ id: string; revision: number }>;
}

export interface SessionWorkScope {
  id: string;
  threadId: string;
  workspaceId: string;
  deviceId: string;
  workspacePath: string;
  nativeSessionId?: string;
}

/** Device capability keys remain extensible, matching the server string map. */
export type WorkCoverage = {
  hostSchedules: string;
  processes: string;
  scheduler?: "observed" | "not_observed" | "stale";
  schedulerError?: string;
  schedulerVersion?: string;
  observedAt?: string;
  sweepRevision?: string;
};

export interface SessionWorkList {
  sweepRevision?: number;
  scopes?: SessionWorkScope[];
  items: SessionWork[];
  operations: WorkOperation[];
  barrier: boolean;
  stoppedThreads?: string[];
  /** Discovery failures never become an empty successful inventory. */
  coverage: WorkCoverage;
}

export interface WorkControlInput {
  id?: string;
  action: WorkOperation["action"];
  expectedRevision?: number;
  idempotencyKey: string;
}

export interface WorkRun {
  inputId?: string;
  executionSessionId?: string;
  id: string;
  workId: string;
  generation: number;
  scheduledAt: string;
  startedAt: string;
  endedAt?: string;
  status: WorkStatus;
  error?: string;
}

/** External inventory needs verified background classification before it is work. */
export function isStandaloneWork(item: SessionWork): boolean {
  return (
    item.source !== "process" || item.observation.processRole === "background"
  );
}

/** A recurring definition survives the end of each individual execution. */
export function hasFutureScheduledWork(item: SessionWork): boolean {
  return (
    item.kind === "schedule" &&
    item.desiredState === "enabled" &&
    item.spec.recurring === true &&
    (!item.spec.expiresAt || Date.parse(item.spec.expiresAt) > Date.now())
  );
}

export function isOutstandingWork(item: SessionWork): boolean {
  if (!isStandaloneWork(item)) return false;
  if (item.management !== "managed" || item.desiredState === "removed")
    return false;
  if (
    item.revision !== item.observation.confirmedRevision ||
    ["running", "suspended", "unknown"].includes(item.observation.status) ||
    Boolean(item.observation.error) ||
    hasFutureScheduledWork(item)
  )
    return true;
  return (
    item.desiredState === "enabled" &&
    item.kind === "schedule" &&
    !["completed", "stopped", "failed"].includes(item.observation.status)
  );
}

/** Identical bounded context is supplied to both runtimes, without model inference. */
export function sessionWorkContext(
  items: readonly SessionWork[],
  barrier = false,
): string {
  const outstanding = items
    .filter(
      (item) =>
        item.desiredState !== "removed" &&
        isStandaloneWork(item) &&
        (isOutstandingWork(item) ||
          item.management === "observed" ||
          (item.kind === "schedule" && item.desiredState === "paused")),
    )
    .sort(
      (a, b) =>
        Number(b.revision !== b.observation.confirmedRevision) -
          Number(a.revision !== a.observation.confirmedRevision) ||
        a.createdAt.localeCompare(b.createdAt),
    );
  const unclassified = items.filter(
    (item) =>
      item.source === "process" &&
      !item.observation.processRole &&
      item.desiredState !== "removed" &&
      !["completed", "stopped", "failed"].includes(item.observation.status),
  ).length;
  const lines = outstanding
    .slice(0, 24)
    .map(
      (item) =>
        `- ${item.id}: ${item.title.slice(0, 140)}; source=${item.source}; management=${item.management}; desired=${item.desiredState}; actual=${item.observation.status}; ${item.revision === item.observation.confirmedRevision ? "confirmed" : "control NOT confirmed"}${item.observation.nextFireAt ? `; next=${item.observation.nextFireAt}` : ""}${hasFutureScheduledWork(item) ? "; recurring schedule remains enabled" : ""}`,
    );
  return [
    "Foundry persistent work state (independent of compacted history):",
    barrier
      ? "Automatic work is STOPPED for this conversation. Only explicitly resumed work may start."
      : "",
    `${outstanding.length} outstanding work item(s).`,
    unclassified
      ? `${unclassified} unclassified process observation(s) are not verified standalone tasks. The device worker must classify them; do not stop them as tasks.`
      : "",
    ...lines,
    outstanding.length > lines.length
      ? `${outstanding.length - lines.length} further items: call list_session_work.`
      : "",
    "Use list_session_work and control_session_work to inspect/control ALL work, including older turns. Completing an answer does not stop schedules. Only a verified control receipt proves work stopped. Use create_scheduled_work for timers; do not create host cron or detached agents to work around scheduling.",
  ]
    .filter(Boolean)
    .join("\n");
}
