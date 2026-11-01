import {
  claudeBackgroundWork,
  claudeScheduledWork,
} from "../agent-runtime/work/claude.js";
import {
  nativeWorkInfo,
  nativeWorkController,
  type NativeWorkTask,
} from "../agent-runtime/work/types.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  claudeRecurringFireAfter,
  nextZonedWorkFire,
  sessionWorkContext,
  isStandaloneWork,
  type AgentSession,
  type SessionWork,
  type SessionWorkList,
  type WorkObservation,
  type AgentBackgroundTask,
  type WorkRun,
} from "@bd777/foundry-protocol";
import { daemonRequestHeaders } from "../server-http.js";
import { foundryStatePath } from "../state-root.js";
import { writeFileAtomic } from "../storage.js";
import { WorkProcesses } from "./processes.js";
import { readNativeSchedules } from "./native-schedules.js";
import { HostSchedules, type HostSchedule } from "./host-schedules.js";
import {
  discoverDetachedProcesses,
  stopDetachedProcess,
  inspectDetachedProcess,
} from "./detached-processes.js";

export interface WorkSession {
  id: string;
  threadId: string;
  workspaceId: string;
  deviceId: string;
  nativeSessionId?: string;
  workspacePath: string;
}
interface WorkRuntimeAdapter {
  canStop?: (sessionId: string, sourceId: string, source: string) => boolean;
  inspect: (
    sessionId: string,
    sourceId: string,
    source?: string,
    kind?: SessionWork["kind"],
  ) => WorkObservation["status"];
  stop: (sessionId: string, sourceId: string, source?: string) => Promise<void>;
  stopScheduledRun: (
    sessionId: string,
    workId: string,
    executionSessionId?: string,
  ) => Promise<void>;
  stopChild: (sessionId: string) => Promise<void>;
}
class WorkAPIError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
// Reconciliation polls every few seconds while work changes and backs off to
// a quarter minute while nothing does (DEV-085).
const tickMs = 3000;
const idleTickMs = 15_000;
// The server treats a scheduler not heard from in 90 s as stale.
const coverageHeartbeatMs = 30_000;
// An unchanged running or idle item is reported again this often, so its
// observed time stays meaningful without a report every sweep.
const observationRefreshMs = 10 * 60_000;
// A report is split so a slow uplink sends each part within the timeout.
const reportBatchBytes = 32 * 1024;
const requestTimeoutMs = 30_000;
// A control the device has not yet confirmed keeps the regular pace this
// long; one it cannot confirm (a process it cannot stop) then backs off.
const controlFollowMs = 2 * 60_000;

/**
 * What a sweep compares to decide whether an item changed: everything but
 * the time it was looked at, independent of the order of its fields (the
 * server's copy names them in another order than a fresh observation).
 */
function workFingerprint(item: SessionWork): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([, v]) => v !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  return JSON.stringify(
    canonical({ ...item, observation: { ...item.observation, at: "" } }),
  );
}

export function workIdentity(
  sessionId: string,
  source: string,
  sourceId: string,
): string {
  return `work_${createHash("sha256").update(`${sessionId}\0${source}\0${sourceId}`).digest("hex").slice(0, 32)}`;
}

/** One reconciler per execution-host, independent of chat turns and daemon sockets. */
export class WorkSupervisor {
  private sessions = new Map<string, WorkSession>();
  private items = new Map<string, SessionWork>();
  private timer?: NodeJS.Timeout;
  private timerDue = 0;
  private running = false;
  private quietTicks = 0;
  // The server's change cursor for this device's work; "" reads everything.
  private cursor = "";
  private received = 0;
  private reported = new Map<string, number>();
  // When each unconfirmed control (item id, revision) was first seen.
  private controlsSeen = new Map<string, { revision: number; at: number }>();
  private coverageSent = { key: "", at: 0 };
  private saved = "";
  private ticking = false;
  private draining = false;
  private serverURL = "";
  private active = false;
  private stoppedThreads = new Set<string>();
  private sweepRevision = 0;
  busy(): boolean {
    return (
      this.ticking ||
      [...this.items.values()].some(
        (w) =>
          w.management === "managed" &&
          w.desiredState !== "removed" &&
          isStandaloneWork(w) &&
          ["running", "suspended"].includes(w.observation.status),
      )
    );
  }
  private runtime?: WorkRuntimeAdapter;
  private pending = new Map<string, SessionWork>();
  private rejectedUntil = new Map<string, number>();
  private readonly processes: WorkProcesses;
  private readonly hosts: HostSchedules;
  private toolBaselines = new Map<
    string,
    { sessionId: string; ids: Set<string> }
  >();
  private coverage = {
    schedulerVersion: "unknown",
    hostSchedules: "not_observed",
    observedAt: "",
    sweepRevision: "0",
    processes: "managed_native_and_attributed",
  };
  private detached = new Set<string>();
  constructor(
    private readonly root: string,
    private readonly request: typeof fetch = fetch,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.processes = new WorkProcesses(join(root, "processes"));
    this.hosts = new HostSchedules(join(root, "host-sources.json"));
    try {
      const saved = JSON.parse(
        readFileSync(join(root, "inventory.json"), "utf8"),
      );
      for (const s of saved.sessions ?? []) this.sessions.set(s.id, s);
      for (const w of saved.items ?? []) this.items.set(w.id, w);
      for (const id of saved.pendingIds ?? [...this.items.keys()]) {
        const item = this.items.get(id);
        if (item) this.pending.set(id, item);
      }
      this.stoppedThreads = new Set(saved.stoppedThreads || []);
      this.cursor = saved.cursor || "";
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  setDraining(value: boolean) {
    this.draining = value;
    if (!value) this.wake();
  }
  configureRuntime(runtime: WorkRuntimeAdapter) {
    this.runtime = runtime;
  }
  attach(session: AgentSession, workspacePath: string) {
    if (session.role || session.source === "verification") return;
    this.sessions.set(session.id, {
      id: session.id,
      threadId: session.threadId || session.id,
      workspaceId: session.workspaceId,
      deviceId: session.deviceId,
      nativeSessionId: session.nativeSessionId,
      workspacePath,
    });
    this.save();
  }
  hasLegacyTimers(sessionId: string): boolean {
    return [...this.items.values()].some(
      (item) =>
        item.sessionId === sessionId &&
        item.source === "claude" &&
        item.kind === "schedule" &&
        !item.native &&
        item.management === "managed",
    );
  }
  context(sessionId: string, quiet = false): string {
    const thread = this.sessions.get(sessionId)?.threadId || sessionId;
    const scope = new Set([sessionId, thread]);
    const inventoryError = nativeWorkController(sessionId)?.inventoryError?.();
    return (
      sessionWorkContext(
        [...this.items.values()].filter(
          (w) =>
            scope.has(w.threadId) ||
            scope.has(w.sessionId) ||
            w.relatedSessionIds?.some((id) => scope.has(id)),
        ),
        [...scope].some((id) => this.stoppedThreads.has(id)),
        quiet && !inventoryError,
      ) +
      (inventoryError
        ? `\nNative background inventory is unverified; the count covers known items only. ${inventoryError}`
        : "")
    );
  }
  observeNativeWork(sessionId: string, task: NativeWorkTask) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const source = task.native.runtime;
    const id = workIdentity(sessionId, source, task.id);
    const previous = this.items.get(id);
    // An already migrated timer retains its sole Foundry executor. Never
    // revive its native definition or change its historical control intent.
    if (
      previous?.kind === "schedule" &&
      !previous.native &&
      previous.management === "managed"
    )
      return;
    const before = previous && workFingerprint(previous);
    const observedAt = previous?.observation.at;
    const updatedAt = previous?.updatedAt;
    const item: SessionWork = previous ?? {
      id,
      sessionId,
      threadId: session.threadId,
      deviceId: session.deviceId,
      workspaceId: session.workspaceId,
      kind: task.kind,
      source,
      sourceId: task.id,
      title: task.title,
      management: "observed",
      desiredState: "enabled",
      revision: 1,
      generation: 1,
      createdAt: task.observation.startedAt || task.observation.at,
      updatedAt: task.observation.at,
      spec: {},
      allowedActions: [],
      observation: { status: "unknown", at: "", confirmedRevision: 0 },
    };
    if (task.kind === "schedule" && previous?.native?.lastRun) {
      const run = previous.native.lastRun;
      task.native = { ...task.native, lastRun: run };
      task.observation = {
        ...task.observation,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
      };
    }
    item.native = task.native;
    item.title = task.title;
    item.spec = {
      ...item.spec,
      ...task.spec,
      nativeSessionId: task.native.sessionId,
    };
    item.allowedActions =
      task.kind === "process" && task.native.controls.stop === "available"
        ? ["stop"]
        : [];
    item.management = item.allowedActions.length ? "managed" : "observed";
    item.observation = {
      ...task.observation,
      confirmedRevision:
        item.desiredState === "enabled" ||
        ["completed", "failed", "stopped"].includes(task.observation.status)
          ? item.revision
          : item.observation.confirmedRevision,
    };
    item.updatedAt = task.observation.at;
    // The runtime reports its tasks again and again; only a change (or the
    // periodic refresh of a running item) is worth sending, as in a sweep.
    if (
      before !== undefined &&
      workFingerprint({ ...item, updatedAt: updatedAt! }) === before &&
      !(
        ["running", "idle"].includes(item.observation.status) &&
        Date.now() - (this.reported.get(id) || 0) >= observationRefreshMs
      )
    ) {
      item.observation.at = observedAt!;
      item.updatedAt = updatedAt!;
      return;
    }
    this.items.set(id, item);
    this.pending.set(id, item);
    this.save();
    this.wake();
  }
  observeBackground(
    sessionId: string,
    tasks: readonly AgentBackgroundTask[],
    version = "unknown",
    nativeSessionId?: string,
  ) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const task of tasks)
      this.observeNativeWork(
        sessionId,
        claudeBackgroundWork(task, {
          sessionId: nativeSessionId || session.nativeSessionId || "",
          version,
          canStop: (id) =>
            this.runtime?.canStop?.(sessionId, id, "claude") === true,
        }),
      );
  }

  observeTimers(
    sessionId: string,
    tasks: readonly import("@bd777/foundry-protocol").AgentScheduledTask[],
    version = "unknown",
    nativeSessionId?: string,
  ) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const at = new Date().toISOString();
    for (const task of tasks)
      this.observeNativeWork(
        sessionId,
        claudeScheduledWork(task, {
          sessionId: nativeSessionId || session.nativeSessionId || "",
          version,
          canStop: () => false,
        }),
      );
    for (const item of this.items.values())
      if (
        item.sessionId === sessionId &&
        item.native?.runtime === "claude" &&
        (!nativeSessionId ||
          !item.native.sessionId ||
          nativeSessionId === item.native.sessionId) &&
        item.kind === "schedule" &&
        !tasks.some((task) => task.id === item.sourceId)
      ) {
        item.observation = {
          ...item.observation,
          status: item.native.lastRun?.status || "stopped",
          at,
          endedAt:
            item.native.lastRun?.status === "running"
              ? undefined
              : item.native.lastRun?.endedAt || at,
          nextFireAt: undefined,
          confirmedRevision: item.revision,
        };
        item.spec.recurring = false;
        this.pending.set(item.id, item);
      }
    this.save();
    this.wake();
  }
  observeTimerRun(
    sessionId: string,
    fire: { id?: string; startedAt?: string; completedAt?: string },
    failed = false,
    nativeSessionId?: string,
  ) {
    if (
      !fire.id ||
      !fire.startedAt ||
      !Number.isFinite(Date.parse(fire.startedAt))
    )
      return;
    const item = this.items.get(workIdentity(sessionId, "claude", fire.id));
    if (
      !item?.native ||
      item.kind !== "schedule" ||
      (nativeSessionId &&
        item.native.sessionId &&
        nativeSessionId !== item.native.sessionId)
    )
      return;
    const id = `${fire.id}@${fire.startedAt}`;
    const previous = item.native.lastRun;
    if (
      previous &&
      (Date.parse(previous.startedAt) > Date.parse(fire.startedAt) ||
        (previous.id === id && previous.endedAt && !fire.completedAt))
    )
      return;
    const status = fire.completedAt
      ? failed
        ? "failed"
        : "completed"
      : "running";
    item.native.lastRun = {
      id,
      startedAt: fire.startedAt,
      endedAt: fire.completedAt || undefined,
      status,
    };
    item.observation = {
      ...item.observation,
      status,
      at: new Date().toISOString(),
      startedAt: fire.startedAt,
      endedAt: fire.completedAt || undefined,
      confirmedRevision: item.revision,
      error: undefined,
    };
    this.pending.set(item.id, item);
    this.save();
    this.wake();
  }
  observeAgent(
    sessionId: string,
    event: {
      label: string;
      detail: string;
      metadata?: { taskId?: string; taskType?: string };
    },
    version = "unknown",
    nativeSessionId?: string,
  ) {
    const taskId = event.metadata?.taskId;
    if (!taskId) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const id = workIdentity(sessionId, "claude", taskId),
      existing = this.items.get(id);
    if (!existing && event.metadata?.taskType !== "local_agent") return;
    const at = new Date().toISOString();
    const item: SessionWork = existing ?? {
      id,
      sessionId,
      threadId: session.threadId,
      workspaceId: session.workspaceId,
      deviceId: session.deviceId,
      kind: "agent",
      source: "claude",
      sourceId: taskId,
      title: event.detail.slice(0, 250),
      management: "managed",
      desiredState: "enabled",
      revision: 1,
      generation: 1,
      createdAt: at,
      updatedAt: at,
      spec: {},
      observation: {
        status: "running",
        at,
        confirmedRevision: 0,
      },
      allowedActions: [],
    };
    item.management = "observed";
    item.allowedActions = [];
    item.native = nativeWorkInfo(
      "claude",
      version,
      nativeSessionId || session.nativeSessionId || "",
      taskId,
      "SDK agent lifecycle",
    );
    if (/Subtask completed|Subtask failed/.test(event.label))
      item.observation = {
        ...item.observation,
        status: event.label.includes("failed") ? "failed" : "completed",
        at,
        endedAt: at,
      };
    this.items.set(id, item);
    this.pending.set(id, item);
    this.save();
    this.wake();
  }
  toolStarting(sessionId: string, toolId: string) {
    if (!this.active || !this.sessions.has(sessionId) || !toolId) return;
    const scan = this.hosts.scan();
    this.toolBaselines.set(toolId, {
      sessionId,
      ids: new Set(scan.entries.map((e) => `${e.source}:${e.id}`)),
    });
    if (this.toolBaselines.size > 256)
      this.toolBaselines.delete(this.toolBaselines.keys().next().value!);
  }
  toolCompleted(toolId: string) {
    const before = this.toolBaselines.get(toolId);
    if (!before) return;
    this.toolBaselines.delete(toolId);
    // A tool-time delta is discovery evidence, not ownership proof: another
    // local program may have created the entry during this command.
    for (const entry of this.hosts.scan().entries)
      if (!before.ids.has(`${entry.source}:${entry.id}`))
        this.recordHost(entry, before.sessionId);
  }
  private recordHost(entry: HostSchedule, sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const recorded = this.hosts.recorded(entry);
    if (recorded && recorded.sessionId !== sessionId) return;
    this.hosts.record(entry, sessionId);
    const sourceId = `${entry.source}:${entry.id}`,
      id = workIdentity(sessionId, entry.source, sourceId);
    if (this.items.has(id)) return;
    const at = new Date().toISOString();
    const item: SessionWork = {
      id,
      sessionId,
      threadId: session.threadId,
      deviceId: session.deviceId,
      workspaceId: session.workspaceId,
      kind: "schedule",
      source: entry.source,
      sourceId,
      title: entry.title,
      management: "observed",
      desiredState: entry.active ? "enabled" : "paused",
      revision: 1,
      generation: 1,
      createdAt: at,
      updatedAt: at,
      spec: { schedule: entry.schedule },
      observation: { status: "unknown", at, confirmedRevision: 0 },
      allowedActions: ["adopt"],
    };
    this.items.set(id, item);
    this.pending.set(id, item);
  }
  private save() {
    // A sweep that changed nothing leaves the inventory (megabytes on a
    // device with a long history) as it is on disk.
    const inventory = JSON.stringify({
      sessions: [...this.sessions.values()],
      items: [...this.items.values()],
      pendingIds: [...this.pending.keys()],
      stoppedThreads: [...this.stoppedThreads],
      cursor: this.cursor,
    });
    if (inventory === this.saved) return;
    writeFileAtomic(join(this.root, "inventory.json"), `${inventory}\n`);
    this.saved = inventory;
  }
  async start(serverURL: string, version?: string) {
    this.serverURL = serverURL;
    if (version) this.coverage.schedulerVersion = version;
    // Sweeps keep running even when the first one fails.
    this.running = true;
    await this.tick();
  }
  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  /** Runs the next sweep within delay ms, unless one is already due sooner. */
  private schedule(delay: number) {
    if (!this.running) return;
    const due = Date.now() + Math.max(delay, 0);
    if (this.timer && this.timerDue <= due) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerDue = due;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, due - Date.now());
    this.timer.unref();
  }
  /** Local evidence changed: report it at the regular pace again. */
  private wake() {
    this.quietTicks = 0;
    this.schedule(tickMs);
  }
  /** How long until the next sweep: soon while work changes, later while nothing does. */
  private nextDelay(): number {
    const now = Date.now();
    let outstanding = false;
    const unconfirmed = new Set<string>();
    for (const item of this.items.values()) {
      if (
        item.desiredState === "enabled" ||
        item.observation.confirmedRevision >= item.revision
      )
        continue;
      unconfirmed.add(item.id);
      let seen = this.controlsSeen.get(item.id);
      if (seen?.revision !== item.revision) {
        seen = { revision: item.revision, at: now };
        this.controlsSeen.set(item.id, seen);
      }
      if (now - seen.at < controlFollowMs) outstanding = true;
    }
    for (const id of this.controlsSeen.keys())
      if (!unconfirmed.has(id)) this.controlsSeen.delete(id);
    this.quietTicks =
      this.pending.size || outstanding || this.received
        ? 0
        : this.quietTicks + 1;
    let delay = Math.min(tickMs * 2 ** this.quietTicks, idleTickMs);
    // A schedule fires on its time, not up to a backed-off sweep late. An
    // overdue one that could not fire is retried at the sweep's pace.
    for (const item of this.items.values()) {
      const wait = Date.parse(item.observation.nextFireAt || "") - Date.now();
      if (
        item.kind === "schedule" &&
        item.desiredState === "enabled" &&
        wait > 0
      )
        delay = Math.min(delay, wait + 50);
    }
    return delay;
  }
  private async api<T>(path: string, body?: unknown): Promise<T> {
    // Device inventory reads and reports name the cursor, so the server
    // answers with what changed after it rather than every item (DEV-085).
    const query =
      path === "/api/daemon/session-work"
        ? `?cursor=${encodeURIComponent(this.cursor)}`
        : "";
    const response = await this.request(`${this.serverURL}${path}${query}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...daemonRequestHeaders(body !== undefined),
        "X-Foundry-Native-Work": "1",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok)
      throw new WorkAPIError(
        response.status,
        `Work API ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    return response.json() as Promise<T>;
  }
  private async flushPending(): Promise<void> {
    const queued = [...this.pending.values()]
      .map((item) => ({
        id: item.id,
        raw: JSON.stringify(item),
      }))
      .filter((item) => (this.rejectedUntil.get(item.id) || 0) <= Date.now());
    const send = async (batch: typeof queued): Promise<void> => {
      try {
        const list = await this.api<SessionWorkList>(
          "/api/daemon/session-work",
          {
            items: batch.map((x) => JSON.parse(x.raw)),
            // Item batches, including split retries, never acknowledge a whole
            // discovery sweep. A later batch can still fail or be quarantined.
            coverage: { ...this.coverage, sweepRevision: "0" },
          },
        );
        for (const sent of batch) {
          this.rejectedUntil.delete(sent.id);
          this.reported.set(sent.id, Date.now());
          if (JSON.stringify(this.pending.get(sent.id)) === sent.raw)
            this.pending.delete(sent.id);
        }
        this.absorb(list);
      } catch (error) {
        if (
          !(error instanceof WorkAPIError) ||
          ![400, 403, 404, 409].includes(error.status)
        )
          throw error;
        if (batch.length > 1) {
          for (const item of batch) await send([item]);
          return;
        }
        const item = this.pending.get(batch[0]!.id);
        if (item) {
          item.observation.error = `Work report rejected: ${error.message}`;
          this.rejectedUntil.set(item.id, Date.now() + 30_000);
        }
      }
    };
    let batch: typeof queued = [];
    let bytes = 0;
    for (const item of queued) {
      if (
        batch.length &&
        (batch.length === 100 || bytes + item.raw.length > reportBatchBytes)
      ) {
        await send(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(item);
      bytes += item.raw.length;
    }
    if (batch.length) await send(batch);
  }
  async sync(): Promise<void> {
    await this.flushPending();
    // A first read, or one after the server lost the cursor's database,
    // arrives in pages.
    for (let page = 0; page < 1000; page++) {
      const list = await this.api<SessionWorkList>("/api/daemon/session-work");
      this.absorb(list);
      if (!list.more) break;
    }
    this.active = true;
    this.save();
  }
  /**
   * Applies a device inventory read: every item from a server without
   * cursors, or what changed after the cursor sent with the request.
   */
  private absorb(list: SessionWorkList) {
    if (list.cursor !== undefined) this.cursor = list.cursor;
    this.received += list.items.length + (list.removedIds?.length || 0);
    for (const id of list.removedIds || []) {
      this.items.delete(id);
      this.pending.delete(id);
      this.rejectedUntil.delete(id);
      this.reported.delete(id);
    }
    this.stoppedThreads = new Set(list.stoppedThreads || []);
    this.sweepRevision = list.sweepRevision || 0;
    for (const scope of list.scopes || []) this.sessions.set(scope.id, scope);
    for (const item of list.items) {
      const pending = this.pending.get(item.id);
      if (pending && item.revision > pending.revision)
        this.rejectedUntil.delete(item.id);
      if (
        pending &&
        Date.parse(pending.observation.at) >= Date.parse(item.observation.at)
      ) {
        item.observation = pending.observation;
        if (pending.native) {
          item.native = pending.native;
          item.spec = pending.spec;
          item.allowedActions = pending.allowedActions;
          item.management = pending.management;
        }
        this.pending.set(item.id, item);
      }
      this.items.set(item.id, item);
      const known = this.sessions.get(item.sessionId);
      if (known && !known.nativeSessionId && item.spec.nativeSessionId)
        known.nativeSessionId = item.spec.nativeSessionId;
      if (!this.sessions.has(item.sessionId) && item.spec.cwd)
        this.sessions.set(item.sessionId, {
          id: item.sessionId,
          threadId: item.threadId,
          workspaceId: item.workspaceId,
          deviceId: item.deviceId,
          nativeSessionId: item.spec.nativeSessionId,
          workspacePath: item.spec.cwd,
        });
    }
  }
  async tick(): Promise<void> {
    if (this.ticking) return;
    if (this.draining || !this.serverURL) return this.schedule(tickMs);
    this.ticking = true;
    this.received = 0;
    try {
      await this.sync();
      const changed: SessionWork[] = [];
      this.detached.clear();
      for (const process of discoverDetachedProcesses(
        new Set(this.sessions.keys()),
      )) {
        this.detached.add(process.id);
        const session = this.sessions.get(process.sessionId)!;
        const id = workIdentity(process.sessionId, "process", process.id);
        if (!this.items.has(id)) {
          const at = new Date().toISOString();
          const item: SessionWork = {
            id,
            sessionId: session.id,
            threadId: session.threadId,
            workspaceId: session.workspaceId,
            deviceId: session.deviceId,
            kind: "process",
            source: "process",
            sourceId: process.id,
            title: process.title,
            management: "managed",
            desiredState: "enabled",
            revision: 1,
            generation: 1,
            createdAt: at,
            updatedAt: at,
            spec: {},
            observation: {
              status: "running",
              at,
              confirmedRevision: 0,
              processRole: "background",
            },
            allowedActions: ["stop", "remove"],
          };
          this.items.set(id, item);
          this.pending.set(id, item);
        }
      }
      const hostScan = this.hosts.scan();
      this.coverage.hostSchedules = hostScan.errors.length
        ? "partial"
        : "observed";
      const latest = [...this.sessions.values()].at(-1);
      if (latest)
        for (const entry of hostScan.entries)
          this.recordHost(
            entry,
            this.hosts.recorded(entry)?.sessionId || latest.id,
          );
      for (const session of this.sessions.values()) {
        try {
          for (const task of readNativeSchedules(session.workspacePath)) {
            if (task.createdBySessionId !== session.nativeSessionId) continue;
            const id = workIdentity(session.id, "claude", task.id);
            if (!this.items.has(id)) {
              const created = new Date(task.createdAt).toISOString();
              const item: SessionWork = {
                id,
                sessionId: session.id,
                threadId: session.threadId,
                workspaceId: session.workspaceId,
                deviceId: session.deviceId,
                kind: "schedule",
                native: nativeWorkInfo(
                  "claude",
                  "unknown",
                  task.createdBySessionId || "",
                  task.id,
                  ".claude/scheduled_tasks.json",
                ),
                source: "claude",
                sourceId: task.id,
                title: task.prompt.split("\n")[0]!.slice(0, 250),
                management: "observed",
                desiredState: "enabled",
                revision: 1,
                generation: 1,
                createdAt: created,
                updatedAt: created,
                spec: {
                  schedule: task.cron,
                  nativeSessionId: task.createdBySessionId,
                  recurring: task.recurring === true,
                  prompt: task.prompt,
                  expiresAt:
                    task.recurring && !task.permanent
                      ? new Date(task.createdAt + 7 * 86400000).toISOString()
                      : undefined,
                },
                observation: {
                  status: "unknown",
                  at: created,
                  confirmedRevision: 0,
                },
                allowedActions: [],
              };
              this.items.set(id, item);
              this.pending.set(id, item);
            }
          }
        } catch (e) {
          console.error(`Native work discovery: ${String(e)}`);
        }
      }
      if (this.pending.size) await this.sync();
      for (const item of this.items.values()) {
        const session = this.sessions.get(item.sessionId);
        if (!session) continue;
        if ((this.rejectedUntil.get(item.id) || 0) > Date.now()) continue;
        if (
          item.kind !== "schedule" &&
          (item.source === "claude" ||
            item.source === "codex" ||
            item.source === "process") &&
          item.observation.confirmedRevision === item.revision &&
          !item.observation.error &&
          ["completed", "failed", "stopped"].includes(item.observation.status)
        )
          continue;
        const before = workFingerprint(item);
        const observedAt = item.observation.at;
        try {
          item.observation = await this.reconcile(item, session);
          if (
            item.management === "managed" &&
            item.observation.status !== "unknown" &&
            !(item.kind === "schedule" && item.observation.status === "failed")
          )
            item.observation.error = undefined;
        } catch (e) {
          item.observation = {
            ...item.observation,
            at: new Date().toISOString(),
            error: String(e),
            // Never make a new runtime failure disappear as a stale observation.
            confirmedRevision: item.observation.confirmedRevision,
            status:
              item.observation.status === "running" ? "running" : "unknown",
          };
        }
        // Report what changed; an item looked at again unchanged keeps the
        // time it was last reported, refreshed now and then while it runs.
        if (
          workFingerprint(item) === before &&
          !(
            ["running", "idle"].includes(item.observation.status) &&
            Date.now() - (this.reported.get(item.id) || 0) >=
              observationRefreshMs
          )
        ) {
          item.observation.at = observedAt;
          continue;
        }
        changed.push(item);
        this.pending.set(item.id, item);
      }
      for (const item of this.pending.values())
        if (!changed.some((w) => w.id === item.id)) changed.push(item);
      this.coverage.observedAt = new Date().toISOString();
      if (changed.length) await this.flushPending();
      this.coverage.sweepRevision = this.rejectedUntil.size
        ? "0"
        : String(this.sweepRevision);
      this.coverage.processes = this.rejectedUntil.size
        ? "unverified"
        : "managed_native_and_attributed";
      // The sweep acknowledgement doubles as the scheduler's heartbeat:
      // sent when it says something new, and before the server finds it stale.
      const coverageKey = JSON.stringify({
        ...this.coverage,
        observedAt: "",
      });
      if (
        coverageKey !== this.coverageSent.key ||
        Date.now() - this.coverageSent.at >= coverageHeartbeatMs
      ) {
        this.absorb(
          await this.api<SessionWorkList>("/api/daemon/session-work", {
            items: [],
            coverage: this.coverage,
          }),
        );
        this.coverageSent = { key: coverageKey, at: Date.now() };
      }
    } catch (e) {
      if (this.active) console.error(`Work reconciliation: ${String(e)}`);
    } finally {
      this.ticking = false;
      // A failed report must not lose newly discovered work on host restart.
      this.save();
      this.schedule(this.nextDelay());
    }
  }
  private async reconcile(
    item: SessionWork,
    session: WorkSession,
  ): Promise<WorkObservation> {
    const at = new Date().toISOString();
    if (item.source === "process") {
      const actual = inspectDetachedProcess(item.sourceId || "");
      actual.processRole ||= item.observation.processRole;
      if (actual.status === "unknown")
        return {
          ...actual,
          confirmedRevision: item.observation.confirmedRevision,
        };
      // Classification precedes all controls, including old misclassified rows.
      // A stop-all must never stop its caller's Codex helper or foreground tools.
      if (actual.processRole && actual.processRole !== "background")
        return { ...actual, confirmedRevision: item.revision };
      if (item.desiredState === "stopped" || item.desiredState === "removed") {
        await stopDetachedProcess(item.sourceId || "");
        return {
          ...actual,
          status: "stopped",
          at,
          confirmedRevision: item.revision,
          endedAt: actual.endedAt || at,
        };
      }
      return { ...actual, confirmedRevision: item.revision };
    }
    if (item.kind === "agent" && item.source === "foundry") {
      if (
        (item.desiredState === "stopped" || item.desiredState === "removed") &&
        item.observation.status === "running"
      )
        await this.runtime?.stopChild(item.sourceId || "");
      return item.observation;
    }
    if (
      item.source === "crontab" ||
      item.source === "systemd" ||
      item.source === "launchd"
    ) {
      if (item.management !== "managed")
        return {
          ...item.observation,
          at,
          status: "unknown",
          error: "Host schedule origin is unconfirmed; adopt it to control",
          confirmedRevision: 0,
        };
      const actual = await this.hosts.apply(item);
      return {
        status: actual.active ? "idle" : "stopped",
        at,
        confirmedRevision: item.revision,
      };
    }
    if (item.source === "foundry" && item.kind === "process") {
      if (
        item.desiredState === "enabled" &&
        item.observation.confirmedRevision < item.revision
      )
        await this.processes.start(item, session.workspacePath);
      else if (item.desiredState === "paused") await this.processes.pause(item);
      else if (item.desiredState !== "enabled") await this.processes.stop(item);
      const observation = await this.processes.inspect(item);
      if (observation.status === "unknown")
        throw new Error("Background process exit cannot be verified");
      return {
        ...observation,
        status:
          item.desiredState !== "enabled" && observation.status === "idle"
            ? "stopped"
            : observation.status,
        confirmedRevision: item.revision,
      };
    }
    if (item.native && (item.kind === "agent" || item.kind === "schedule")) {
      if (
        item.observation.endedAt &&
        ["completed", "failed", "stopped"].includes(item.observation.status)
      )
        return { ...item.observation, at, confirmedRevision: item.revision };
      const status =
        this.runtime?.inspect(
          item.sessionId,
          item.sourceId || "",
          item.source,
          item.kind,
        ) ?? "unknown";
      item.native.observation =
        status === "unknown" ? "unavailable" : "available";
      return {
        ...item.observation,
        status,
        at,
        confirmedRevision: item.revision,
      };
    }
    if (
      item.kind !== "schedule" &&
      (item.source === "claude" || item.source === "codex")
    ) {
      if (item.native) {
        const available =
          this.runtime?.canStop?.(
            item.sessionId,
            item.sourceId || "",
            item.source,
          ) === true;
        item.native.controls.stop = available ? "available" : "unavailable";
        item.allowedActions = available ? ["stop"] : [];
        item.management = available ? "managed" : "observed";
      }
      const status =
        this.runtime?.inspect(
          item.sessionId,
          item.sourceId || "",
          item.source,
        ) ?? "unknown";
      const actual =
        status === "unknown" && item.observation.endedAt
          ? item.observation.status
          : status;
      if (item.desiredState === "stopped" || item.desiredState === "removed") {
        if (actual === "running")
          await this.runtime?.stop(
            item.sessionId,
            item.sourceId || "",
            item.source,
          );
        const after =
          actual !== "running"
            ? actual
            : (this.runtime?.inspect(
                item.sessionId,
                item.sourceId || "",
                item.source,
              ) ?? "unknown");
        if (after === "running" || after === "unknown")
          throw new Error("Native task termination not yet confirmed");
        return {
          ...item.observation,
          status: "stopped",
          at,
          confirmedRevision: item.revision,
        };
      }
      return {
        ...item.observation,
        status: actual,
        at,
        confirmedRevision:
          actual === "unknown"
            ? item.observation.confirmedRevision
            : item.revision,
      };
    }
    if (
      item.kind === "schedule" &&
      (item.source === "foundry" || item.source === "claude")
    ) {
      // Historical definitions whose native source was already retired keep
      // their existing executor. New workers never migrate a remaining source.
      if (
        item.source === "claude" &&
        readNativeSchedules(session.workspacePath).some(
          (task) => task.id === item.sourceId,
        )
      ) {
        throw new Error(
          "This legacy timer still has a native definition; automatic migration is disabled to preserve native ownership.",
        );
      }
      const manualAt = item.spec.manualRunAt;
      if (
        item.desiredState !== "enabled" &&
        !(item.desiredState !== "removed" && manualAt)
      ) {
        if (
          item.observation.status === "failed" &&
          item.observation.endedAt &&
          item.observation.error &&
          item.observation.confirmedRevision === item.revision
        )
          return { ...item.observation, at, nextFireAt: undefined };
        if (
          item.desiredState !== "paused" &&
          item.observation.status === "unknown" &&
          item.observation.runId &&
          !item.observation.endedAt
        )
          throw new Error(
            "Scheduled execution outcome is unknown; stop cannot yet be verified",
          );
        if (
          item.desiredState !== "paused" &&
          item.observation.status === "running"
        ) {
          if (!this.runtime)
            throw new Error("Scheduled execution controller unavailable");
          await this.runtime.stopScheduledRun(
            item.sessionId,
            item.id,
            item.observation.executionSessionId,
          );
          throw new Error(
            "Execution stop requested; awaiting confirmed session exit",
          );
        }
        return {
          ...item.observation,
          at,
          nextFireAt: undefined,
          status:
            item.desiredState === "paused" &&
            item.observation.status === "running"
              ? "running"
              : "stopped",
          confirmedRevision: item.revision,
          error: undefined,
        };
      }
      if (item.observation.status === "running")
        return { ...item.observation, at, confirmedRevision: item.revision };
      if (
        item.observation.status === "unknown" &&
        item.observation.runId &&
        !item.observation.endedAt
      )
        return {
          ...item.observation,
          at,
          error:
            item.observation.error ||
            "Scheduled dispatch acknowledgement is pending",
        };
      if (
        !manualAt &&
        item.spec.expiresAt &&
        Date.parse(item.spec.expiresAt) <= Date.now()
      )
        return {
          ...item.observation,
          status: "completed",
          at,
          nextFireAt: undefined,
          confirmedRevision: item.revision,
        };
      if (
        (item.spec.at || (item.source === "claude" && !item.spec.recurring)) &&
        item.observation.endedAt &&
        !manualAt
      )
        return { ...item.observation, at, confirmedRevision: item.revision };
      // Controls carry a revision across hosts; wall clocks and RFC3339 text
      // precision do not establish whether a resume superseded an observation.
      const resumed =
        item.revision > 1 && item.observation.confirmedRevision < item.revision;
      const next =
        manualAt ||
        (!resumed ? item.observation.nextFireAt : undefined) ||
        this.next(item, new Date());
      if (!next) throw new Error("Invalid or unsupported schedule");
      if (Date.parse(next) <= Date.now()) {
        const run = await this.api<WorkRun>(
          `/api/daemon/sessions/${encodeURIComponent(item.sessionId)}/work-fire`,
          { id: item.id, generation: item.generation, scheduledAt: next },
        );
        return {
          status: run.status,
          at: new Date().toISOString(),
          startedAt: run.startedAt,
          runId: run.id,
          executionSessionId: run.executionSessionId,
          endedAt: run.endedAt,
          error: run.error,
          confirmedRevision:
            run.status === "unknown"
              ? item.observation.confirmedRevision
              : item.revision,
        };
      }
      return {
        status: "idle",
        at,
        nextFireAt: next,
        confirmedRevision: item.revision,
      };
    }
    throw new Error("This source has no verified control adapter");
  }
  private next(item: SessionWork, from: Date): string | undefined {
    if (item.spec.at)
      return item.observation.endedAt ? undefined : item.spec.at;
    if (!item.spec.schedule) return undefined;
    if (item.source === "claude")
      return claudeRecurringFireAfter(
        item.spec.schedule,
        item.sourceId || item.id,
        from,
      )?.toISOString();
    return nextZonedWorkFire(
      item.spec.schedule,
      item.spec.timeZone || "UTC",
      from,
    )?.toISOString();
  }
}

let instance: WorkSupervisor | undefined;
export function sessionWork(): WorkSupervisor {
  return (instance ??= new WorkSupervisor(foundryStatePath("session-work")));
}
/**
 * The supervisor only where this process owns it (started or attached a
 * session); a sandboxed SDK host gets none and must not create it.
 */
export function observedSessionWork(): WorkSupervisor | undefined {
  return instance;
}
export function sessionWorkBusy(): boolean {
  return instance?.busy() === true;
}

/** Sandboxed SDK hosts report events but do not own the device reconciler. */
export function recordWorkToolStarting(
  sessionId: string,
  toolId: string,
): void {
  instance?.toolStarting(sessionId, toolId);
}
export function recordWorkToolCompleted(toolId: string): void {
  instance?.toolCompleted(toolId);
}

export function recordNativeWork(
  sessionId: string,
  task: NativeWorkTask,
): void {
  instance?.observeNativeWork(sessionId, task);
}

/** Native transcripts can retain definitions already migrated by older workers. */
export function hasLegacyManagedTimers(sessionId: string): boolean {
  return instance?.hasLegacyTimers(sessionId) === true;
}
