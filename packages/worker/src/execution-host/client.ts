/** Authenticated local control link; reconnect never starts an agent again. */
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { randomBytes, randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  realpathSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  daemonMessageTypes,
  type ChatAttachment,
  type DeviceRunner,
  type DeviceRunnerDetail,
  type RunSessionPayload,
  type SessionTimers,
  type EvidenceWorkerRequest,
} from "@bd777/foundry-protocol";
import {
  ControlOutcomeUnknownError,
  SessionNotSteerableError,
  type SteerOptions,
} from "../session-control.js";
import { writePrivateJSONAtomic } from "../storage.js";
import { ownPackage } from "../worker-identity.js";
import {
  drainDecision,
  runnerSwitchCapMs,
  runningTurnSessions,
  type DrainDecision,
} from "./drain.js";
import { processIdentity } from "../agent-processes.js";
import { profileConfigForSession } from "../profiles.js";
import type { ReliableSessionTransport } from "../transport.js";
import type { SessionExecutionRegistry } from "../session-state.js";
import { executionHostPaths } from "./paths.js";
import {
  executionServiceSupported,
  prepareExecutionSocket,
  launchExecutionService,
  stopExecutionService,
  reclaimExecutionService,
  runtimeStamp,
  legacyExecutionHostIsAlone,
} from "./service.js";

export interface HostSnapshot {
  protocol: number;
  capabilities?: string[];
  entry?: string;
  runtimeStamp?: string;
  busy?: boolean;
  draining?: boolean;
  serverURL?: string;
  pid: number;
  startTime: string;
  claims: Array<{ sessionId: string; inputId: string }>;
  background: string[];
  ownTurns?: string[];
  /** Reported by runners from drain_switch_v1 on. */
  version?: string;
}

/** A runner's version from its entry, for runners that do not report it. */
export function runnerVersionFromEntry(entry?: string): string | undefined {
  if (!entry) return undefined;
  try {
    const manifest = JSON.parse(
      readFileSync(resolve(entry, "../../../package.json"), "utf8"),
    );
    if (typeof manifest.version === "string") return manifest.version;
  } catch {}
  return /\/runtime\/([^/]+)\/node_modules\//.exec(entry)?.[1];
}

/** How long a runner may take to answer a new connection. */
const handshakeTimeoutMs = 10_000;
/** A runner whose heartbeat is this old is not running its event loop. */
export const hostHeartbeatStaleMs = 60_000;

/** The runner's own record that its event loop runs (hostHeartbeatPath). */
export function readHostHeartbeat():
  { pid: number; startTime: string; at: string } | undefined {
  try {
    const beat = JSON.parse(
      readFileSync(
        resolve(executionHostPaths().root, "heartbeat.json"),
        "utf8",
      ),
    );
    return typeof beat.pid === "number" && typeof beat.at === "string"
      ? beat
      : undefined;
  } catch {
    return undefined;
  }
}

/** How long a failed switch is not tried again; new turns are not held. */
const switchRetryMs = 5 * 60_000;
let current: ExecutionHostClient | undefined;
export function executionHostClient(): ExecutionHostClient | undefined {
  return current;
}

export class ExecutionHostClient {
  private socket?: Socket;
  private pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private snapshot?: HostSnapshot;
  private transport?: ReliableSessionTransport;
  private earlyEnvelopes: Array<{
    id: string;
    type: string;
    payload: unknown;
  }> = [];
  private registry?: SessionExecutionRegistry;
  private claimed = new Map<string, { sessionId: string; inputId: string }>();
  private connecting?: Promise<void>;
  private switching?: Promise<void>;
  private closed = false;
  /** A newer runner is installed: since when this one drains. */
  private drain?: { stamp: string; since: number };
  private quietSince?: number;
  private decision?: DrainDecision;
  /** New turns waiting for the new runner, by session/input. */
  private held = new Map<
    string,
    { workspacePath: string; payload: RunSessionPayload }
  >();
  private failure?: { error: string; at: number };
  /** Handshakes in a row the runner took and never answered. */
  private unanswered = 0;
  private reclaiming = false;
  private unavailable?: string;
  private healthSink?: (
    health: "ready" | "reclaiming" | "unavailable" | "starting",
    detail?: string,
  ) => void;
  private runnerSink?: (runner: DeviceRunner) => void;
  private reported = "";
  private token: string;
  constructor(
    private readonly socketPath: string,
    token: string,
    private readonly serverURL?: string,
    private readonly managed?: {
      entry: string;
      stamp: string;
      start: () => Promise<void>;
      stop: () => Promise<void>;
      /** Stops a wedged runner whatever its job manager says. */
      reclaim: () => Promise<void>;
      legacyAlone: (pid: number) => boolean;
    },
  ) {
    this.token = token;
  }

  attach(
    transport: ReliableSessionTransport,
    registry: SessionExecutionRegistry,
  ): void {
    this.transport = transport;
    this.registry = registry;
    if (this.snapshot) this.adopt(this.snapshot);
    for (const envelope of this.earlyEnvelopes)
      transport.send(envelope.type, envelope.payload, envelope.id);
    this.earlyEnvelopes = [];
  }
  hasSession(sessionId: string): boolean {
    if (this.heldFor(sessionId).length) return true;
    return (
      this.snapshot?.claims.some((claim) => claim.sessionId === sessionId) ===
        true || this.snapshot?.background.includes(sessionId) === true
    );
  }
  owns(sessionId: string, inputId: string): boolean {
    if (this.held.has(`${sessionId}/${inputId}`)) return true;
    return (
      this.snapshot?.claims.some(
        (claim) => claim.sessionId === sessionId && claim.inputId === inputId,
      ) === true
    );
  }
  supportsCapability(capability: string): boolean {
    return (
      !!this.socket &&
      !this.socket.destroyed &&
      this.snapshot?.capabilities?.includes(capability) === true
    );
  }
  async open(): Promise<void> {
    if (this.closed) throw new Error("Execution host client is closed.");
    if (this.switching) return this.switching;
    if (this.connecting) return this.connecting;
    if (this.socket && !this.socket.destroyed) return;
    this.connecting = this.connect()
      .catch(async (error) => {
        if (
          this.closed ||
          !this.managed ||
          !this.serverURL ||
          /Another live worker|authentication failed|identity or protocol/.test(
            String(error),
          )
        )
          throw error;
        if (error instanceof ControlOutcomeUnknownError) {
          // It took the connection and never answered: its process lives,
          // but maybe not its event loop. A registered job proves nothing.
          this.unanswered++;
          if (!this.hostWedged()) throw error;
          await this.reclaim();
          return;
        }
        // The registered service may have stopped or be recovering. Recreate
        // it only through its manager, never as an unmanaged child.
        await this.managed.start().catch(() => undefined);
        await this.awaitService();
      })
      .then(
        () => {
          this.unanswered = 0;
          this.unavailable = undefined;
        },
        (error) => {
          this.unavailable =
            error instanceof Error ? error.message : String(error);
          throw error;
        },
      )
      .finally(() => {
        this.connecting = undefined;
        this.noteHealth();
      });
    return this.connecting;
  }
  /**
   * Whether an unanswering runner is wedged rather than slow: its heartbeat
   * (runners from drain_switch_v1 on) stopped, or, for an older runner, it
   * left three handshakes in a row unanswered.
   */
  private hostWedged(): boolean {
    const beat = readHostHeartbeat();
    if (beat && processIdentity(beat.pid)?.startTime === beat.startTime)
      return (
        Date.now() - Date.parse(beat.at) >= hostHeartbeatStaleMs &&
        this.unanswered >= 2
      );
    return this.unanswered >= 3;
  }
  /** Replaces a wedged runner: stop its job, kill its owner by identity, start. */
  private async reclaim(): Promise<void> {
    this.reclaiming = true;
    this.noteHealth();
    this.reportRunner();
    console.error(
      `Execution host did not answer ${this.unanswered} handshakes; reclaiming it.`,
    );
    try {
      await this.managed!.reclaim();
      await this.managed!.start();
      await this.awaitService();
      this.unanswered = 0;
    } finally {
      this.reclaiming = false;
    }
  }
  /** The runner as the connection service sees it, for its health record. */
  hostHealth(): "ready" | "reclaiming" | "unavailable" | "starting" {
    if (this.reclaiming) return "reclaiming";
    if (this.socket && !this.socket.destroyed && this.snapshot) return "ready";
    return this.unavailable ? "unavailable" : "starting";
  }
  setHealthSink(
    sink:
      | ((
          health: ReturnType<ExecutionHostClient["hostHealth"]>,
          detail?: string,
        ) => void)
      | undefined,
  ): void {
    this.healthSink = sink;
    this.noteHealth();
  }
  private noteHealth(): void {
    this.healthSink?.(this.hostHealth(), this.unavailable);
  }
  private async connect(): Promise<void> {
    if (this.closed) throw new Error("Execution host client is closed.");
    const socket = connect(this.socketPath);
    await new Promise<void>((done, reject) => {
      socket.once("connect", done);
      socket.once("error", reject);
    });
    if (this.closed) {
      socket.destroy();
      throw new Error("Execution host client is closed.");
    }
    this.socket = socket;
    const lines = createInterface({ input: socket });
    // readline forwards its input's errors as its own error event. A broken
    // pipe during service replacement must close the link, not the worker.
    lines.on("error", () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      lines.close();
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(
          new ControlOutcomeUnknownError(
            "Execution host acknowledgement lost; outcome unknown. Reconnect before retrying.",
          ),
        );
      }
      this.pending.clear();
      // Keep claims while disconnected. Never call a still-running host's
      // executions orphaned just because its control socket dropped.
    });
    lines.on("line", (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      if (message.type === "snapshot") {
        this.adopt(message);
        return;
      }
      if (message.type === "envelope") {
        const envelope = message.envelope;
        // Without an attached outbox the host retains and replays the event.
        if (this.transport)
          this.transport.send(envelope.type, envelope.payload, envelope.id);
        else this.earlyEnvelopes.push(envelope);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          message.outcomeUnknown
            ? new ControlOutcomeUnknownError(message.error)
            : new Error(message.error),
        );
      else pending.resolve(message.result);
    });
    const identity = processIdentity(process.pid);
    if (!identity) {
      socket.destroy();
      throw new Error("Cannot verify worker identity");
    }
    try {
      // A live runner answers at once; one that does not is suspect.
      const snapshot = await this.send(
        {
          token: this.token,
          owner: { pid: process.pid, startTime: identity.startTime },
        },
        Number(
          process.env.FOUNDRY_EXECUTION_HANDSHAKE_TIMEOUT_MS ||
            handshakeTimeoutMs,
        ),
      );
      if (
        (this.serverURL && snapshot.serverURL !== this.serverURL) ||
        snapshot.protocol !== 1 ||
        processIdentity(snapshot.pid)?.startTime !== snapshot.startTime
      )
        throw new Error("Execution host identity or protocol does not match");
      this.adopt(snapshot);
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }
  private adopt(snapshot: HostSnapshot): void {
    this.snapshot = snapshot;
    if (!this.registry) return;
    const next = new Map(
      snapshot.claims.map((claim) => [
        `${claim.sessionId}/${claim.inputId}`,
        claim,
      ]),
    );
    for (const [key, claim] of this.claimed)
      if (!next.has(key))
        this.registry.complete(claim.sessionId, claim.inputId);
    for (const [key, claim] of next)
      if (!this.claimed.has(key))
        this.registry.claim(claim.sessionId, claim.inputId);
    this.claimed = next;
  }
  private send(
    request: Record<string, unknown>,
    timeoutMs = request.method === "evidence" ? 15 * 60_000 : 35_000,
  ): Promise<any> {
    const socket = this.socket;
    if (!socket || socket.destroyed)
      return Promise.reject(new Error("Execution host is disconnected"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A runner that cannot answer a snapshot is not running its loop:
        // drop the link, so the next open() can tell slow from wedged.
        if (request.method === "snapshot") socket.destroy();
        reject(
          new ControlOutcomeUnknownError(
            "Execution host acknowledgement timed out; outcome unknown.",
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ ...request, id })}\n`);
    });
  }
  private async awaitService(): Promise<void> {
    let last: unknown;
    const deadline = Date.now() + 60_000;
    for (let i = 0; i < 100 && Date.now() < deadline; i++) {
      if (this.closed) throw new Error("Execution host client is closed.");
      try {
        await this.connect();
        return;
      } catch (error) {
        last = error;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw last ?? new Error("Execution service did not become ready.");
  }
  private async command(request: Record<string, unknown>): Promise<any> {
    await this.open();
    if (this.switching) await this.switching;
    return this.send(request);
  }
  private targetChanged(snapshot: HostSnapshot): boolean {
    if (!this.managed) return false;
    let entry = snapshot.entry;
    if (!entry) {
      try {
        const identity = JSON.parse(
          readFileSync(
            resolve(executionHostPaths().root, "identity.json"),
            "utf8",
          ),
        );
        if (
          identity.pid === snapshot.pid &&
          identity.startTime === snapshot.startTime
        )
          entry = identity.entry;
      } catch {}
    }
    return Boolean(
      entry &&
      (entry !== this.managed.entry ||
        (snapshot.runtimeStamp &&
          snapshot.runtimeStamp !== this.managed.stamp)),
    );
  }
  /** Since when the runner drains, kept across a connection-service restart. */
  private beginDrain(): void {
    if (this.drain || !this.managed) return;
    const path = resolve(executionHostPaths().root, "switch.json");
    const stamp = this.managed.stamp;
    try {
      const kept = JSON.parse(readFileSync(path, "utf8"));
      if (kept.stamp === stamp && Number.isFinite(kept.since)) {
        this.drain = { stamp, since: kept.since };
        return;
      }
    } catch {}
    this.drain = { stamp, since: Date.now() };
    try {
      writePrivateJSONAtomic(path, this.drain);
    } catch {}
  }
  private endDrain(): void {
    this.drain = undefined;
    this.quietSince = undefined;
    this.decision = undefined;
    this.failure = undefined;
    try {
      unlinkSync(resolve(executionHostPaths().root, "switch.json"));
    } catch {}
  }
  /** Whether new turns wait for the new runner now. */
  private holding(): boolean {
    return (
      !!this.drain &&
      !this.failure &&
      (this.switching !== undefined || this.decision?.action !== "wait"
        ? true
        : this.decision.hold)
    );
  }
  private async upgradeIfIdle(snapshot: HostSnapshot): Promise<void> {
    if (!this.managed || !this.serverURL || this.switching || this.pending.size)
      return;
    if (!this.targetChanged(snapshot)) {
      if (this.drain) this.endDrain();
      this.flushHeld();
      if (snapshot.draining) await this.send({ method: "cancel_upgrade" });
      return;
    }
    this.beginDrain();
    if (this.failure && Date.now() - this.failure.at < switchRetryMs) {
      this.flushHeld();
      return;
    }
    const now = Date.now();
    if (runningTurnSessions(snapshot).length) this.quietSince = undefined;
    else this.quietSince ??= now;
    this.decision = drainDecision(
      snapshot,
      this.drain!.since,
      now,
      this.quietSince,
    );
    if (this.decision.action === "wait") {
      if (!this.decision.hold) this.flushHeld();
      return;
    }
    const canDrain = snapshot.capabilities?.includes("idle_upgrade");
    if (!canDrain && !this.managed.legacyAlone(snapshot.pid)) return;
    await this.switchRunner(canDrain ? this.decision.mode : "legacy");
  }
  /**
   * Replaces the runner. idle/boundary/now ask the runner first (it refuses
   * new work from then on); legacy runners and a "now" an older runner
   * refuses are stopped directly: their turns were stopped already.
   */
  private async switchRunner(
    mode: "idle" | "boundary" | "now" | "legacy",
  ): Promise<void> {
    if (this.switching) return this.switching;
    this.switching = (async () => {
      if (mode !== "legacy") {
        const ready = (await this.send({ method: "prepare_upgrade", mode }))
          .ready;
        if (!ready && mode !== "now") return;
      }
      if (this.closed) return;
      // No RPC can cross this point: command() waits for the replacement,
      // while the old owner has atomically refused new work.
      this.socket?.destroy();
      this.socket = undefined;
      await this.managed!.stop();
      if (this.closed) return;
      await this.managed!.start();
      await this.awaitService();
      this.endDrain();
    })()
      .catch(async (error) => {
        this.failure = {
          error: error instanceof Error ? error.message : String(error),
          at: Date.now(),
        };
        // If stopping failed, release the old service's drain rather than
        // leaving it frozen. If it is gone, the next open asks its manager.
        try {
          await this.connect();
          await this.send({ method: "cancel_upgrade" });
        } catch {}
        throw error;
      })
      .finally(() => {
        this.switching = undefined;
        this.flushHeld();
        this.reportRunner();
      });
    this.reportRunner();
    await this.switching;
  }
  private heldFor(sessionId: string, inputId?: string): string[] {
    return [...this.held.keys()].filter(
      (key) =>
        key.startsWith(`${sessionId}/`) &&
        (inputId === undefined || key === `${sessionId}/${inputId}`),
    );
  }
  /** Held turns go to whichever runner serves now. */
  private flushHeld(): void {
    if (this.holding() || !this.held.size) return;
    const held = [...this.held.values()];
    this.held.clear();
    for (const { workspacePath, payload } of held)
      void this.command({ method: "run", workspacePath, payload })
        .then(() => this.refresh())
        .catch((error) =>
          console.error(
            `Execution dispatch acknowledgement: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    this.reportRunner();
  }
  /** The runner as the device's owner sees it. */
  runner(): DeviceRunner {
    const snapshot = this.snapshot;
    const drain = this.drain;
    const decision = this.decision;
    return {
      version: snapshot
        ? (snapshot.version ?? runnerVersionFromEntry(snapshot.entry))
        : undefined,
      ...(drain ? { targetVersion: ownPackage().version } : {}),
      state: this.switching
        ? "switching"
        : this.reclaiming ||
            (this.unavailable && (!this.socket || this.socket.destroyed))
          ? "unavailable"
          : !drain
            ? "current"
            : this.failure
              ? "failed"
              : "pending",
      ...(drain
        ? {
            pendingSince: new Date(drain.since).toISOString(),
            deadline: new Date(drain.since + runnerSwitchCapMs).toISOString(),
          }
        : {}),
      runningTurns: snapshot ? runningTurnSessions(snapshot).length : 0,
      heldTurns: this.held.size,
      backgroundSessions: snapshot?.background.length ?? 0,
      ...(drain && decision?.action === "wait" && decision.waitingFor
        ? { waitingFor: decision.waitingFor }
        : {}),
      ...(this.failure ? { error: this.failure.error } : {}),
      ...(this.reclaiming ? { reclaiming: true } : {}),
      ...(!this.failure &&
      this.unavailable &&
      (!this.socket || this.socket.destroyed)
        ? { error: this.unavailable }
        : {}),
    };
  }
  /** The turns a "switch now" would stop, and sessions with background tasks. */
  runnerDetail(): DeviceRunnerDetail {
    const snapshot = this.snapshot;
    const turns: DeviceRunnerDetail["turns"] = [];
    const seen = new Set<string>();
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
    return { runner: this.runner(), turns };
  }
  /** Sends the runner to the server when it changed (or always, when asked). */
  setRunnerSink(sink: ((runner: DeviceRunner) => void) | undefined): void {
    this.runnerSink = sink;
    this.reported = "";
    this.reportRunner();
  }
  private reportRunner(): void {
    if (
      !this.runnerSink ||
      (!this.snapshot && this.hostHealth() === "starting")
    )
      return;
    const runner = this.runner();
    const value = JSON.stringify(runner);
    if (value === this.reported) return;
    this.reported = value;
    this.runnerSink(runner);
  }
  /**
   * The owner's "switch now": stops exactly the turns they reviewed (the
   * sessions stay and continue with their next message), then switches.
   * Refused when another turn started since they looked.
   */
  async switchNow(
    reviewed: Array<{ sessionId: string; inputId?: string }>,
  ): Promise<{ switched: boolean }> {
    await this.refresh();
    if (!this.drain) return { switched: true };
    const known = new Set(
      reviewed.map((turn) => `${turn.sessionId}/${turn.inputId ?? ""}`),
    );
    const turns = this.runnerDetail().turns.filter((turn) => !turn.background);
    const unreviewed = turns.filter(
      (turn) => !known.has(`${turn.sessionId}/${turn.inputId ?? ""}`),
    );
    if (unreviewed.length)
      throw new RunnerTurnsChangedError(
        "Another turn started since the list was shown; review it again.",
      );
    await Promise.allSettled(
      turns.map((turn) => this.cancel(turn.sessionId, turn.inputId)),
    );
    for (let i = 0; i < 60 && this.snapshot?.claims.length; i++) {
      await new Promise((done) => setTimeout(done, 500));
      this.adopt(await this.command({ method: "snapshot" }));
    }
    const snapshot = this.snapshot;
    if (!this.drain || !snapshot) return { switched: true };
    const canDrain = snapshot.capabilities?.includes("idle_upgrade");
    // An older runner only answers "idle": when it is not, it is stopped.
    await this.switchRunner(
      snapshot.capabilities?.includes("drain_switch_v1")
        ? "now"
        : canDrain && !snapshot.busy
          ? "idle"
          : "legacy",
    );
    return { switched: !this.drain };
  }
  async refresh(): Promise<void> {
    const snapshot = await this.command({ method: "snapshot" });
    this.adopt(snapshot);
    try {
      await this.upgradeIfIdle(snapshot);
    } finally {
      this.reportRunner();
    }
  }
  async run(workspacePath: string, payload: RunSessionPayload): Promise<void> {
    if (
      profileConfigForSession(workspacePath, payload.session, payload.profile)
        .connectionType === "external"
    ) {
      await this.refresh();
      if (!this.supportsCapability("external_connection_v1"))
        throw new Error(
          "External connections need the updated execution host. It will switch when this device's active work finishes; no other account was used.",
        );
    }
    if (this.holding()) {
      const key = `${payload.session.id}/${payload.session.input?.id ?? ""}`;
      if (!this.owns(payload.session.id, payload.session.input?.id ?? "")) {
        // The server keeps it queued until the new runner starts it.
        this.held.set(key, { workspacePath, payload });
        this.reportRunner();
        return;
      }
    }
    await this.command({ method: "run", workspacePath, payload });
    await this.refresh();
  }
  async steer(
    sessionId: string,
    inputId: string | undefined,
    message: string,
    attachments: ChatAttachment[],
    sentBySessionId?: string,
    options?: SteerOptions,
  ): Promise<void> {
    // Its turn has not started: the server holds the message for it.
    if (this.heldFor(sessionId).length) throw new SessionNotSteerableError();
    await this.command({
      method: "steer",
      sessionId,
      inputId,
      message,
      attachments,
      sentBySessionId,
      ...(options?.delivery
        ? {
            delivery: options.delivery,
            boundaryLimitMs: options.boundaryLimitMs,
          }
        : {}),
    });
  }
  async cancel(
    sessionId: string,
    inputId?: string,
  ): Promise<{ answered?: boolean; stopped?: boolean; inputId?: string }> {
    const held = this.heldFor(sessionId, inputId);
    if (held.length) {
      for (const key of held) {
        this.held.delete(key);
        this.transport?.send(daemonMessageTypes.sessionCompleted, {
          sessionId,
          inputId: key.slice(sessionId.length + 1) || undefined,
          error: "Session canceled before it started.",
        });
      }
      this.reportRunner();
      return { inputId, stopped: true };
    }
    return this.command({ method: "cancel", sessionId, inputId });
  }
  async stopBackground(sessionId: string, taskId: string): Promise<void> {
    await this.command({ method: "stop_background", sessionId, taskId });
  }
  async issueEnvironment(
    payload: Parameters<
      typeof import("../issue-environment-rpc.js").issueEnvironmentAction
    >[0],
  ): Promise<unknown> {
    return this.command({ method: "issue_environment", payload });
  }
  async evidence(payload: EvidenceWorkerRequest): Promise<unknown> {
    return this.command({ method: "evidence", payload });
  }
  async adoptTimers(timers: SessionTimers): Promise<void> {
    await this.command({ method: "timers", timers });
  }
  reportOwnTurns(): void {
    for (const sessionId of this.snapshot?.ownTurns ?? [])
      this.transport?.send("session_turn", { sessionId, running: true });
  }
  acknowledge(envelopeId: string): void {
    if (this.socket && !this.socket.destroyed)
      this.socket.write(`${JSON.stringify({ method: "ack", envelopeId })}\n`);
  }
  close(): void {
    this.closed = true;
    this.socket?.destroy();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new ControlOutcomeUnknownError(
          "Execution host client closed; pending outcome unknown.",
        ),
      );
    }
    this.pending.clear();
  }
  async shutdown(): Promise<void> {
    this.close();
    await Promise.allSettled([this.connecting, this.switching].filter(Boolean));
  }
}

export class RunnerTurnsChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerTurnsChangedError";
  }
}

/** The OS manager owns executions; a Worker only owns the control link. */
export async function startExecutionHost(
  serverURL: string,
): Promise<ExecutionHostClient | undefined> {
  if (!executionServiceSupported() || process.env.NODE_TEST_CONTEXT)
    return undefined;
  const paths = executionHostPaths();
  prepareExecutionSocket();
  try {
    writeFileSync(paths.token, randomBytes(32).toString("hex"), {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const entry = realpathSync(
    fileURLToPath(new URL("./main.js", import.meta.url)),
  );
  const client = new ExecutionHostClient(
    paths.socket,
    readFileSync(paths.token, "utf8").trim(),
    serverURL,
    {
      entry,
      stamp: runtimeStamp(entry),
      start: () => launchExecutionService(entry, serverURL),
      stop: stopExecutionService,
      reclaim: () => reclaimExecutionService(),
      legacyAlone: legacyExecutionHostIsAlone,
    },
  );
  // The connection service comes online whatever the runner does: work for
  // it waits, and the runner is started or reclaimed in the background.
  current = client;
  const ready = client.open().then(() => client.refresh());
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
      `Execution host not ready yet (${outcome === "timeout" ? "still starting" : outcome instanceof Error ? outcome.message : String(outcome)}); continuing and retrying in the background.`,
    );
  ready.catch(() => undefined);
  return client;
}

export async function stopExecutionHost(): Promise<void> {
  const paths = executionHostPaths();
  const identity = resolve(paths.root, "identity.json");
  if (!current && !existsSync(identity) && !existsSync(paths.plist)) return;
  await current?.shutdown();
  await stopExecutionService();
  current = undefined;
  try {
    unlinkSync(identity);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
