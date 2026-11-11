/**
 * The device's execution hosts as the daemon sees them. One host runs the
 * newest installed runtime and takes every new session and turn from the
 * moment the daemon starts; hosts of older runtimes retire: they finish what
 * they hold (a running turn, background work, a busy agent), hand idle
 * agents over, and are stopped when nothing is left. A session that sits
 * idle in a retiring host resumes on the newest host with its native
 * session id; the idle agent is closed first so one native session has one
 * writer. Each host has its own root, socket, service, claims and outbox
 * (roots.ts), so nothing but the device's shared work (kept by the older
 * host until it is gone, see server.ts) is shared.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ChatAttachment,
  DeviceRunner,
  DeviceRunnerDetail,
  DeviceRuntimeState,
  EvidenceWorkerRequest,
  RunSessionPayload,
} from "@bd777/foundry-protocol";
import { ownPackage } from "../install/worker-identity.js";
import type { SessionGoalAction } from "../session/goals.js";
import type {
  SessionCancelOutcome,
  SteerOptions,
} from "../session/session-control.js";
import { errorMessage } from "../platform/utils.js";
import { drainDecision, runningTurnSessions } from "./drain.js";
import {
  ExecutionHostClient,
  RunnerTurnsChangedError,
  type HostRegistry,
  type IssueEnvironmentRequest,
} from "./client.js";
import { hasUnfinishedWork } from "./adoption.js";
import { executionHostPaths } from "./paths.js";
import { hostRolloverCapability, type HostSnapshot } from "./protocol.js";
import {
  generationRoot,
  knownHostRoots,
  hostWasStopped,
  liveHostIdentity,
  markHostStopped,
  type HostIdentity,
} from "./roots.js";
import {
  executionServiceSupported,
  launchExecutionService,
  prepareExecutionSocket,
  reclaimExecutionService,
  runtimeStamp,
  stopExecutionService,
} from "./service.js";
import type { ReliableSessionTransport } from "../transport/transport.js";

/** How hosts are found, started and stopped; tests replace it. */
export interface HostDriver {
  /** The runtime this daemon belongs to. */
  entry: string;
  stamp: string;
  roots(): string[];
  rootFor(stamp: string): string;
  live(root: string): HostIdentity | undefined;
  /** The daemon stopped this host's service: nothing will bring it back. */
  stopped(root: string): boolean;
  /** Makes the root usable and returns the token its host and daemon share. */
  prepare(root: string): { socket: string; token: string };
  start(root: string): Promise<void>;
  stop(root: string): Promise<void>;
  reclaim(root: string): Promise<void>;
}

export function systemHostDriver(serverURL: string): HostDriver {
  const entry = realpathSync(
    fileURLToPath(new URL("./main.js", import.meta.url)),
  );
  return {
    entry,
    stamp: runtimeStamp(entry),
    roots: () => knownHostRoots(),
    rootFor: (stamp) => generationRoot(stamp),
    live: liveHostIdentity,
    stopped: hostWasStopped,
    prepare(root) {
      const paths = executionHostPaths(root);
      prepareExecutionSocket(paths);
      try {
        writeFileSync(paths.token, randomBytes(32).toString("hex"), {
          mode: 0o600,
          flag: "wx",
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      return {
        socket: paths.socket,
        token: readFileSync(paths.token, "utf8").trim(),
      };
    },
    start: (root) =>
      launchExecutionService(entry, serverURL, executionHostPaths(root)),
    stop: async (root) => {
      await stopExecutionService(executionHostPaths(root));
      markHostStopped(root);
    },
    reclaim: (root) =>
      reclaimExecutionService(
        () => stopExecutionService(executionHostPaths(root)),
        resolve(root, "identity.json"),
      ),
  };
}

interface Slot {
  root: string;
  client: ExecutionHostClient;
  retiring: boolean;
  since: number;
  quietSince?: number;
  stopping?: Promise<void>;
  error?: string;
  /** Since when no process runs this host; its service may still restart it. */
  deadSince?: number;
}

/** The turn, background work or busy agent that keeps a session on a host. */
function holds(snapshot: HostSnapshot | undefined, sessionId: string): boolean {
  return Boolean(
    snapshot &&
    (snapshot.claims.some((claim) => claim.sessionId === sessionId) ||
      snapshot.background.includes(sessionId) ||
      snapshot.ownTurns?.includes(sessionId) ||
      snapshot.nativeWork?.includes(sessionId) ||
      snapshot.resident?.some(
        (resident) => resident.sessionId === sessionId && resident.busy,
      )),
  );
}

const retiringRefusal = /Execution host is retiring/;
const settleTimeoutMs = 30_000;
/** How long a host that died without being stopped is given to come back. */
const deadSlotGraceMs = 60_000;
/** How long the active host may stay unreachable before retired hosts serve again. */
const activeDownGraceMs = 20_000;

export class ExecutionHostFleet {
  private readonly slots = new Map<string, Slot>();
  private active?: Slot;
  private transport?: ReliableSessionTransport;
  private registry?: HostRegistry;
  private readonly nativeWork = new Map<string, string[]>();
  private healthSink?: Parameters<ExecutionHostClient["setHealthSink"]>[0];
  private runnerSink?: (runner: DeviceRunner) => void;
  private reported = "";
  private closed = false;
  private lifecycle?: Promise<void>;
  private activeDownSince?: number;

  constructor(
    private readonly serverURL: string,
    private readonly driver: HostDriver,
    private readonly timing?: { serviceStartMs?: number },
  ) {}

  /**
   * Finds the live hosts, makes the one of this runtime the active one
   * (started when none runs it) and retires the others. Does not wait for
   * the active host to answer.
   */
  async start(): Promise<void> {
    const live = this.driver.roots().filter((root) => this.driver.live(root));
    const matching = live.find((root) => {
      const identity = this.driver.live(root);
      return (
        identity?.entry === this.driver.entry &&
        identity.runtimeStamp === this.driver.stamp
      );
    });
    const activeRoot = matching ?? this.driver.rootFor(this.driver.stamp);
    this.active = this.link(activeRoot, true);
    // The older hosts are told to retire once the newest answers (refresh):
    // until then they are the ones that can still run a turn.
    for (const root of live)
      if (root !== activeRoot) this.link(root, false).retiring = true;
  }

  /** Waits for the active host to answer. */
  async open(): Promise<void> {
    await this.active!.client.open();
    await this.refresh();
  }

  private link(root: string, managed: boolean): Slot {
    const existing = this.slots.get(root);
    if (existing) return existing;
    const { socket, token } = this.driver.prepare(root);
    const client = new ExecutionHostClient(
      socket,
      token,
      this.serverURL,
      managed
        ? {
            root,
            entry: this.driver.entry,
            stamp: this.driver.stamp,
            start: () => this.driver.start(root),
            stop: () => this.driver.stop(root),
            reclaim: () => this.driver.reclaim(root),
          }
        : undefined,
      this.timing,
    );
    const slot: Slot = { root, client, retiring: false, since: Date.now() };
    this.slots.set(root, slot);
    if (this.transport && this.registry) this.attachSlot(slot);
    if (managed && this.healthSink) client.setHealthSink(this.healthSink);
    return slot;
  }

  private attachSlot(slot: Slot): void {
    const real = this.registry!;
    slot.client.attach(this.transport!, {
      claim: (sessionId, inputId) => real.claim(sessionId, inputId),
      complete: (sessionId, inputId) => real.complete(sessionId, inputId),
      setNativeWork: (sessionIds) => {
        this.nativeWork.set(slot.root, sessionIds);
        real.setNativeWork([...new Set([...this.nativeWork.values()].flat())]);
      },
    });
  }

  attach(transport: ReliableSessionTransport, registry: HostRegistry): void {
    this.transport = transport;
    this.registry = registry;
    for (const slot of this.slots.values()) this.attachSlot(slot);
  }

  private retiringSlots(): Slot[] {
    return [...this.slots.values()].filter((slot) => slot.retiring);
  }

  /** Retiring hosts that can take a call now: not being stopped, reachable. */
  private reachableRetiring(): Slot[] {
    return this.retiringSlots().filter(
      (slot) => !slot.stopping && slot.client.connected(),
    );
  }

  /** The newest host answers: only then do older ones retire and get stopped. */
  private activeHealthy(): boolean {
    return Boolean(
      this.active?.client.latest() && this.active.client.connected(),
    );
  }

  /** Forgets a host: its link, its claims in the registry, its native work. */
  private dropSlot(slot: Slot): void {
    slot.client.close();
    slot.client.releaseClaims();
    this.slots.delete(slot.root);
    this.nativeWork.delete(slot.root);
    this.registry?.setNativeWork([
      ...new Set([...this.nativeWork.values()].flat()),
    ]);
  }

  /** Reads every host; stops retiring ones that hold nothing any more. */
  async refresh(): Promise<void> {
    const active = this.active!;
    const [activeResult] = await Promise.allSettled([active.client.refresh()]);
    const now = Date.now();
    const healthy = this.activeHealthy();
    if (healthy) this.activeDownSince = undefined;
    else this.activeDownSince ??= now;
    this.rediscover();
    await Promise.allSettled(
      this.retiringSlots().map((slot) => this.refreshRetiring(slot, healthy)),
    );
    const latest = active.client.latest();
    // A host this runtime was retired by an earlier one (a rollback) serves.
    if (latest?.retiring && active.client.connected())
      await active.client.retire(false).catch(() => undefined);
    // A retiring host that left no process behind is gone, unless its
    // service manager may still restart it (a crash): then it is given time.
    for (const slot of this.retiringSlots()) {
      if (this.driver.live(slot.root) || slot.stopping) {
        slot.deadSince = undefined;
        continue;
      }
      slot.deadSince ??= now;
      if (
        this.driver.stopped(slot.root) ||
        now - slot.deadSince >= deadSlotGraceMs
      )
        this.dropSlot(slot);
    }
    this.drainRetiring(healthy);
    this.reportRunner();
    if (activeResult?.status === "rejected") throw activeResult.reason;
  }

  /** A live host nobody links (restarted after a crash): retire it again. */
  private rediscover(): void {
    for (const root of this.driver.roots())
      if (
        !this.slots.has(root) &&
        root !== this.active!.root &&
        this.driver.live(root)
      )
        this.link(root, false).retiring = true;
  }

  private async refreshRetiring(
    slot: Slot,
    activeHealthy: boolean,
  ): Promise<void> {
    try {
      if (!slot.client.connected()) await slot.client.open();
      await slot.client.refresh();
      slot.error = undefined;
      const latest = slot.client.latest();
      if (!latest?.capabilities?.includes(hostRolloverCapability)) return;
      if (activeHealthy && !latest.retiring) await slot.client.retire(true);
      // The newest host stays down: the older one serves until it is back.
      else if (
        !activeHealthy &&
        latest.retiring &&
        this.activeDownSince !== undefined &&
        Date.now() - this.activeDownSince >= activeDownGraceMs
      )
        await slot.client.retire(false);
    } catch (error) {
      slot.error = errorMessage(error);
    }
  }

  private drainRetiring(activeHealthy: boolean): void {
    // No host is stopped while the newest one cannot take over its work.
    if (!activeHealthy) return;
    const now = Date.now();
    for (const slot of this.retiringSlots()) {
      const snapshot = slot.client.latest();
      if (!snapshot || slot.stopping || !slot.client.connected()) continue;
      if (runningTurnSessions(snapshot).length) slot.quietSince = undefined;
      else slot.quietSince ??= now;
      const decision = drainDecision(
        snapshot,
        slot.since,
        now,
        slot.quietSince,
      );
      // Unacknowledged envelopes are delivered through the live link first.
      if (decision.action === "switch" && !(snapshot.outbox ?? 0))
        void this.stopSlot(slot, decision.mode).catch(() => undefined);
    }
  }

  private stopSlot(
    slot: Slot,
    mode: "idle" | "boundary" | "now",
  ): Promise<void> {
    if (slot.stopping) return slot.stopping;
    slot.stopping = (async () => {
      if (!(await slot.client.prepareStop(mode)) && mode !== "now") return;
      slot.client.close();
      await this.driver.stop(slot.root);
      this.dropSlot(slot);
      slot.error = undefined;
    })()
      .catch((error) => {
        slot.error = errorMessage(error);
        // The link is closed: a host that still runs is linked anew by refresh().
        this.dropSlot(slot);
        throw error;
      })
      .finally(() => {
        slot.stopping = undefined;
        this.reportRunner();
      });
    this.reportRunner();
    return slot.stopping;
  }

  /** The slot a session's turn, steer or cancel belongs to. */
  private slotFor(sessionId: string, inputId?: string): Slot {
    const slots = [this.active!, ...this.reachableRetiring()];
    return (
      slots.find((slot) =>
        inputId === undefined ? false : slot.client.owns(sessionId, inputId),
      ) ??
      slots.find(
        (slot) =>
          slot.client.hasSession(sessionId) ||
          holds(slot.client.latest(), sessionId),
      ) ??
      this.active!
    );
  }

  /**
   * Where a session's next turn runs: where it is held, else the active
   * host, after the idle agent of a retiring host is closed.
   */
  private async homeFor(sessionId: string): Promise<Slot> {
    const retiring = this.reachableRetiring();
    for (const slot of retiring)
      if (holds(slot.client.latest(), sessionId)) return slot;
    // The newest host does not answer (it failed to start): the host that
    // still runs serves rather than a dead one.
    if (!this.activeHealthy()) {
      const serving = retiring.find((slot) => !slot.client.latest()?.retiring);
      if (serving) return serving;
    }
    for (const slot of retiring) {
      const resident = slot.client
        .latest()
        ?.resident?.some((entry) => entry.sessionId === sessionId);
      if (!resident) continue;
      const released = await slot.client
        .releaseSession(sessionId)
        .catch(() => false);
      if (!released) return slot;
    }
    return this.active!;
  }

  async run(workspacePath: string, payload: RunSessionPayload): Promise<void> {
    const sessionId = payload.session.id;
    const inputId = payload.session.input?.id ?? "";
    const owner = [
      this.active!,
      ...this.retiringSlots().filter((slot) => !slot.stopping),
    ].find((slot) => slot.client.owns(sessionId, inputId));
    const home = owner ?? (await this.homeFor(sessionId));
    try {
      await home.client.run(workspacePath, payload);
    } catch (error) {
      if (home === this.active || !retiringRefusal.test(errorMessage(error)))
        throw error;
      await this.active!.client.run(workspacePath, payload);
    }
    this.reportRunner();
  }

  steer(
    sessionId: string,
    inputId: string | undefined,
    message: string,
    attachments: ChatAttachment[],
    sentBySessionId?: string,
    options?: SteerOptions,
  ): Promise<void> {
    return this.slotFor(sessionId, inputId).client.steer(
      sessionId,
      inputId,
      message,
      attachments,
      sentBySessionId,
      options,
    );
  }
  cancel(sessionId: string, inputId?: string): Promise<SessionCancelOutcome> {
    return this.slotFor(sessionId, inputId).client.cancel(sessionId, inputId);
  }
  stopBackground(sessionId: string, taskId: string): Promise<void> {
    return this.slotFor(sessionId).client.stopBackground(sessionId, taskId);
  }
  controlGoal(sessionId: string, action: SessionGoalAction): Promise<void> {
    return this.slotFor(sessionId).client.controlGoal(sessionId, action);
  }
  async serverReconnected(): Promise<void> {
    const results = await Promise.allSettled(
      [this.active!, ...this.retiringSlots()].map((slot) =>
        slot.client.serverReconnected(),
      ),
    );
    const failed = results[0];
    if (failed?.status === "rejected") throw failed.reason;
  }
  issueEnvironment(payload: IssueEnvironmentRequest): Promise<unknown> {
    return this.active!.client.issueEnvironment(payload);
  }
  evidence(payload: EvidenceWorkerRequest): Promise<unknown> {
    return this.active!.client.evidence(payload);
  }
  reportOwnTurns(): void {
    for (const slot of this.slots.values()) slot.client.reportOwnTurns();
  }
  acknowledge(envelopeId: string): void {
    for (const slot of this.slots.values()) slot.client.acknowledge(envelopeId);
  }
  hasSession(sessionId: string): boolean {
    return [...this.slots.values()].some(
      (slot) =>
        slot.client.hasSession(sessionId) ||
        slot.client
          .latest()
          ?.resident?.some((entry) => entry.sessionId === sessionId) === true,
    );
  }
  owns(sessionId: string, inputId: string): boolean {
    return [...this.slots.values()].some((slot) =>
      slot.client.owns(sessionId, inputId),
    );
  }
  runtimeState(): DeviceRuntimeState | undefined {
    return (
      this.active!.client.runtimeState() ??
      this.retiringSlots()
        .map((slot) => slot.client.runtimeState())
        .find(Boolean)
    );
  }
  hostHealth(): ReturnType<ExecutionHostClient["hostHealth"]> {
    return this.active!.client.hostHealth();
  }
  setHealthSink(sink: Parameters<ExecutionHostClient["setHealthSink"]>[0]) {
    this.healthSink = sink;
    this.active?.client.setHealthSink(sink);
  }

  /**
   * The runner as the device's owner sees it. While older hosts drain it is
   * the oldest one, `pending`: its turns finish there, new ones do not wait.
   */
  runner(): DeviceRunner {
    const active = this.active?.client.runner();
    const retiring = this.retiringSlots();
    if (!retiring.length)
      return (
        active ?? {
          state: "unavailable",
          runningTurns: 0,
          heldTurns: 0,
          backgroundSessions: 0,
        }
      );
    const snapshots = retiring.map((slot) => slot.client.latest());
    const turns = snapshots.reduce(
      (sum, snapshot) =>
        sum + (snapshot ? runningTurnSessions(snapshot).length : 0),
      0,
    );
    const background = snapshots.reduce(
      (sum, snapshot) => sum + (snapshot?.background.length ?? 0),
      0,
    );
    const error =
      retiring.find((slot) => slot.error && slot.client.connected())?.error ??
      retiring.find((slot) => slot.stopping === undefined && slot.error)?.error;
    return {
      version: snapshots.find(Boolean)?.version,
      targetVersion: active?.version ?? ownPackage().version,
      state: retiring.some((slot) => slot.stopping)
        ? "switching"
        : active?.state === "unavailable"
          ? "unavailable"
          : error
            ? "failed"
            : "pending",
      pendingSince: new Date(
        Math.min(...retiring.map((slot) => slot.since)),
      ).toISOString(),
      runningTurns: turns,
      heldTurns: active?.heldTurns ?? 0,
      backgroundSessions: background,
      ...(turns
        ? { waitingFor: "turns" as const }
        : background
          ? { waitingFor: "background" as const }
          : {}),
      ...(error ? { error } : {}),
    };
  }

  /** The turns a "switch now" would stop, and sessions with background tasks. */
  runnerDetail(): DeviceRunnerDetail {
    const turns: DeviceRunnerDetail["turns"] = [];
    const seen = new Set<string>();
    for (const slot of this.retiringSlots()) {
      const snapshot = slot.client.latest();
      for (const claim of snapshot?.claims ?? []) {
        seen.add(claim.sessionId);
        turns.push({ sessionId: claim.sessionId, inputId: claim.inputId });
      }
      for (const sessionId of snapshot?.ownTurns ?? [])
        if (!seen.has(sessionId)) {
          seen.add(sessionId);
          turns.push({ sessionId });
        }
      for (const sessionId of snapshot?.background ?? [])
        if (sessionId && !seen.has(sessionId)) {
          seen.add(sessionId);
          turns.push({ sessionId, background: true });
        }
    }
    return { runner: this.runner(), turns };
  }

  setRunnerSink(sink: ((runner: DeviceRunner) => void) | undefined): void {
    this.runnerSink = sink;
    this.reported = "";
    this.reportRunner();
  }
  private reportRunner(): void {
    if (
      !this.runnerSink ||
      (!this.active?.client.latest() && !this.retiringSlots().length)
    )
      return;
    const runner = this.runner();
    const value = JSON.stringify(runner);
    if (value === this.reported) return;
    this.reported = value;
    this.runnerSink(runner);
  }

  /**
   * The owner's "switch now": stops the turns they reviewed on the retiring
   * hosts (the sessions continue with their next message), then stops those
   * hosts. Refused when another turn started since they looked.
   */
  async switchNow(
    reviewed: Array<{ sessionId: string; inputId?: string }>,
  ): Promise<{ switched: boolean }> {
    await this.refresh();
    if (!this.retiringSlots().length) return { switched: true };
    const known = new Set(
      reviewed.map((turn) => `${turn.sessionId}/${turn.inputId ?? ""}`),
    );
    const turns = this.runnerDetail().turns.filter((turn) => !turn.background);
    if (
      turns.some(
        (turn) => !known.has(`${turn.sessionId}/${turn.inputId ?? ""}`),
      )
    )
      throw new RunnerTurnsChangedError(
        "Another turn started since the list was shown; review it again.",
      );
    await Promise.allSettled(
      turns.map((turn) => this.cancel(turn.sessionId, turn.inputId)),
    );
    for (
      let waited = 0;
      waited < settleTimeoutMs &&
      this.retiringSlots().some((slot) => slot.client.latest()?.claims.length);
      waited += 500
    ) {
      await new Promise((done) => setTimeout(done, 500));
      await this.refresh().catch(() => undefined);
    }
    await Promise.allSettled(
      this.retiringSlots().map((slot) => this.stopSlot(slot, "now")),
    );
    return { switched: this.retiringSlots().length === 0 };
  }

  close(): void {
    this.closed = true;
    for (const slot of this.slots.values()) slot.client.close();
  }
  async shutdown(): Promise<void> {
    this.close();
    await Promise.allSettled(
      [...this.slots.values()].map((slot) => slot.client.shutdown()),
    );
  }
}

let current: ExecutionHostFleet | undefined;
export function executionHostClient(): ExecutionHostFleet | undefined {
  return current;
}

/** The OS manager owns executions; a Worker only owns the control links. */
export async function startExecutionHost(
  serverURL: string,
): Promise<ExecutionHostFleet | undefined> {
  if (!executionServiceSupported() || process.env.NODE_TEST_CONTEXT)
    return undefined;
  const fleet = new ExecutionHostFleet(serverURL, systemHostDriver(serverURL));
  await fleet.start();
  // The connection service comes online whatever the newest host does: work
  // for it waits, and the host is started or reclaimed in the background.
  current = fleet;
  const ready = fleet.open();
  const timeout = new Promise<"timeout">((done) =>
    setTimeout(done, 15_000, "timeout").unref(),
  );
  const outcome = await Promise.race([ready, timeout]).catch(
    (error: unknown) => error,
  );
  if (
    outcome instanceof Error &&
    /Another live worker|authentication failed/.test(outcome.message)
  )
    throw outcome;
  if (outcome !== undefined)
    console.error(
      `Execution host not ready yet (${outcome === "timeout" ? "still starting" : errorMessage(outcome)}); continuing and retrying in the background.`,
    );
  ready.catch(() => undefined);
  return fleet;
}

export async function stopExecutionHost(): Promise<void> {
  const driver = systemHostDriver("");
  const any = driver.roots().some((root) => driver.live(root));
  if (!current && !any) return;
  await current?.shutdown();
  for (const root of driver.roots()) {
    await driver.stop(root);
    // A host that left unfinished work keeps its identity: a Worker that runs
    // this feature adopts the root (reports the inputs interrupted, delivers
    // the envelopes); removing the identity would leave them forever.
    if (!hasUnfinishedWork(root))
      rmSync(resolve(root, "identity.json"), { force: true });
  }
  current = undefined;
}
