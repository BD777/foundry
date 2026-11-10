/**
 * The execution host's durable shell around the execution core
 * (daemon/execution-core.ts). What it accepted (claims.json), the steers it
 * applied (controls.json) and what it has still to report (the outbox)
 * outlive its process and its worker: a replaced worker's repeated dispatch
 * never runs an input twice, a steer is applied at most once, and an
 * interrupted input is reported, never silently rerun.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  daemonMessageTypes,
  executionHostStoppedError,
} from "@bd777/foundry-protocol";
import { ExecutionCore, type RunInput } from "../daemon/execution-core.js";
import {
  ControlOutcomeUnknownError,
  cancelActiveSession,
  steerActiveSessionOnce,
} from "../session/session-control.js";
import { FileSessionOutbox } from "../transport/session-outbox-store.js";
import { dispatchKey } from "../session/session-state.js";
import {
  CoalescedJSONWriter,
  writePrivateJSONAtomic,
  type CoalescedJSONWriterOptions,
} from "../platform/storage.js";
import type { ConcurrentTaskScheduler } from "../platform/task-scheduler.js";
import { ReliableSessionTransport } from "../transport/transport.js";
import { reportWorkerFailure } from "../session/worker-failure.js";
import type { HostMethods } from "./protocol.js";

interface Claim {
  sessionId: string;
  inputId: string;
  status: "active" | "completed";
  completedAt?: string;
}

type ControlOutcome = "pending" | "accepted" | "unknown";

export interface HostExecutionsOptions {
  /** Where claims.json, controls.json and the outbox are kept. */
  root: string;
  serverURL: string;
  scheduler: ConcurrentTaskScheduler;
  /** A claim was taken or settled: the owner hears it in a snapshot. */
  changed: () => void;
  /** A claim could not be recorded: the host cannot go on. */
  failed: (error: unknown) => void;
  /** Runs one input; tests replace it. */
  run?: RunInput;
  /** How long a completed claim suppresses a duplicate dispatch (24 h). */
  completedClaimRetentionMs?: number;
  /** Tests may shorten the claim write batch. */
  claimWriteDelayMs?: number;
  writeClaims?: CoalescedJSONWriterOptions["write"];
}

function readRecords<T>(path: string): Record<string, T> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function legacyClaimTimestamp(claim: Claim): number | undefined {
  const candidates: number[] = [];
  const sessionTime = /^sess_(\d{13})/.exec(claim.sessionId)?.[1];
  if (sessionTime) candidates.push(Number(sessionTime));
  const uuid7 = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-/i.exec(
    claim.inputId,
  );
  if (uuid7) candidates.push(Number.parseInt(uuid7[1]! + uuid7[2]!, 16));
  const timestamp = Math.max(...candidates.filter(Number.isFinite));
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export class HostExecutions {
  readonly transport: ReliableSessionTransport;
  readonly core: ExecutionCore;
  private readonly claimsPath: string;
  private readonly controlsPath: string;
  private readonly claims: Record<string, Claim>;
  private readonly controls: Record<string, ControlOutcome>;
  private readonly controlFlights = new Map<string, Promise<void>>();
  private readonly claimWriter: CoalescedJSONWriter<Record<string, Claim>>;
  private readonly completedClaimRetentionMs: number;
  private readonly localClaims = new Map<string, Claim>();
  private readonly deletedClaims = new Set<string>();

  constructor(private readonly options: HostExecutionsOptions) {
    this.claimsPath = resolve(options.root, "claims.json");
    this.controlsPath = resolve(options.root, "controls.json");
    this.claims = readRecords(this.claimsPath);
    this.controls = readRecords(this.controlsPath);
    this.completedClaimRetentionMs =
      options.completedClaimRetentionMs ?? 24 * 60 * 60 * 1000;
    this.claimWriter = new CoalescedJSONWriter(
      this.claimsPath,
      () => this.claims,
      {
        delayMs: options.claimWriteDelayMs ?? 50,
        prepare: () => this.mergeClaimsFromDisk(),
        write: options.writeClaims,
      },
    );
    if (this.pruneClaims()) this.persistClaims();
    this.transport = new ReliableSessionTransport({
      store: new FileSessionOutbox(resolve(options.root, "outbox")),
      // An input whose completion is on its way is done, even before its
      // run returns.
      onEnqueued: (envelope) => {
        if (envelope.type !== daemonMessageTypes.sessionCompleted) return;
        const payload = envelope.payload as {
          sessionId: string;
          inputId?: string;
        };
        const claim =
          this.claims[dispatchKey(payload.sessionId, payload.inputId)];
        if (claim) this.completeClaim(claim, true);
      },
    });
    this.core = new ExecutionCore({
      serverURL: options.serverURL,
      transport: this.transport,
      scheduler: options.scheduler,
      claims: {
        claim: (sessionId, inputId) => {
          const key = dispatchKey(sessionId, inputId);
          if (this.claims[key]) return false;
          const claim: Claim = { sessionId, inputId, status: "active" };
          this.claims[key] = claim;
          this.localClaims.set(key, { ...claim });
          this.deletedClaims.delete(key);
          this.persistClaims();
          return true;
        },
        complete: (sessionId, inputId) => {
          this.completeClaim(this.claims[dispatchKey(sessionId, inputId)]!);
          options.changed();
        },
      },
      asksForIssues: true,
      failed: options.failed,
      run: options.run,
      beforeRun: () => this.flushClaims(),
    });
  }

  /**
   * The inputs an earlier host was running, reported as stopped. Its
   * processes were cleaned up before (superviseAgentProcesses).
   */
  async reportInterrupted(): Promise<void> {
    for (const claim of Object.values(this.claims))
      if (claim.status === "active") {
        reportWorkerFailure(
          this.transport,
          { id: claim.sessionId, input: { id: claim.inputId } },
          executionHostStoppedError,
        );
        this.completeClaim(claim);
      }
    await this.flush();
  }

  /** The inputs accepted and not yet reported. */
  active(): Array<Pick<Claim, "sessionId" | "inputId">> {
    if (this.pruneClaims()) this.persistClaims();
    return Object.values(this.claims)
      .filter((claim) => claim.status === "active")
      .map(({ sessionId, inputId }) => ({ sessionId, inputId }));
  }

  async run({
    workspacePath,
    payload,
  }: HostMethods["run"]["request"]): Promise<HostMethods["run"]["result"]> {
    if (this.core.accept(payload, () => workspacePath)) this.options.changed();
    await this.flush();
    const claim =
      this.claims[dispatchKey(payload.session.id, payload.session.input?.id)];
    return { status: claim!.status };
  }

  /** Test and startup barrier for the compact claims batch. */
  async flush(): Promise<void> {
    await this.flushClaims();
  }

  async steer(
    request: HostMethods["steer"]["request"],
  ): Promise<HostMethods["steer"]["result"]> {
    if (!request.inputId)
      throw new Error("Steer requires a stable input identity");
    const key = dispatchKey(request.sessionId, request.inputId);
    // Already accepted by this execution owner.
    if (this.controls[key] === "accepted") return {};
    const flight = this.controlFlights.get(key);
    if (flight) {
      await flight;
      return {};
    }
    if (this.controls[key])
      throw new ControlOutcomeUnknownError(
        "The previous steer outcome is unknown; it will not be applied again.",
      );
    this.controls[key] = "pending";
    this.persistControls();
    const applying = steerActiveSessionOnce(
      request.sessionId,
      request.inputId,
      request.message,
      request.attachments,
      request.sentBySessionId,
      request.delivery
        ? {
            delivery: request.delivery,
            boundaryLimitMs: request.boundaryLimitMs,
          }
        : undefined,
    );
    this.controlFlights.set(key, applying);
    try {
      await applying;
      this.controls[key] = "accepted";
    } catch (error) {
      if (error instanceof ControlOutcomeUnknownError)
        this.controls[key] = "unknown";
      else delete this.controls[key];
      throw error;
    } finally {
      this.persistControls();
      this.controlFlights.delete(key);
    }
    return {};
  }

  /** Stops the input; one that already ended here is reported stopped. */
  async cancel({
    sessionId,
    inputId,
  }: HostMethods["cancel"]["request"]): Promise<
    HostMethods["cancel"]["result"]
  > {
    const key = dispatchKey(sessionId, inputId ?? "");
    const ended = () =>
      !!inputId && !!this.claims[key] && this.claims[key].status !== "active";
    if (ended()) return { inputId, stopped: true };
    const outcome = await cancelActiveSession(sessionId, inputId);
    return {
      ...outcome,
      inputId,
      ...(ended() ? { stopped: true, pending: false } : { pending: true }),
    };
  }

  private persistClaims(): void {
    void this.claimWriter.change().catch(this.options.failed);
  }

  private flushClaims(): Promise<void> {
    return this.claimWriter.flush();
  }

  private completeClaim(claim: Claim, flush = false): void {
    claim.status = "completed";
    claim.completedAt = new Date().toISOString();
    const key = dispatchKey(claim.sessionId, claim.inputId);
    this.localClaims.set(key, { ...claim });
    this.deletedClaims.delete(key);
    this.pruneClaims();
    this.persistClaims();
    if (flush) this.claimWriter.flushSync();
  }

  /**
   * Keeps every active claim, plus completions recent enough to suppress a
   * duplicate dispatch. Old records had no completion time; a UUIDv7 input id
   * is a safe lower bound for when that input was accepted.
   */
  private pruneClaims(now = Date.now()): boolean {
    const cutoff = now - this.completedClaimRetentionMs;
    let changed = false;
    for (const [key, claim] of Object.entries(this.claims)) {
      if (claim.status === "active") {
        if (claim.completedAt !== undefined) {
          delete claim.completedAt;
          this.localClaims.set(key, { ...claim });
          this.deletedClaims.delete(key);
          changed = true;
        }
        continue;
      }
      const parsed = Date.parse(claim.completedAt ?? "");
      const completedAt = Number.isFinite(parsed)
        ? parsed
        : legacyClaimTimestamp(claim);
      if (completedAt !== undefined && completedAt >= cutoff) {
        const normalized = new Date(completedAt).toISOString();
        if (claim.completedAt !== normalized) {
          claim.completedAt = normalized;
          this.localClaims.set(key, { ...claim });
          this.deletedClaims.delete(key);
          changed = true;
        }
        continue;
      }
      delete this.claims[key];
      this.localClaims.delete(key);
      this.deletedClaims.add(key);
      changed = true;
    }
    return changed;
  }

  /**
   * The old host and a draining new host can share claims.json. Neither has a
   * lock, so whole-file writes are already last-writer-wins. Before our
   * asynchronous write, retain every external key we did not change and merge
   * conflicts toward completion. This does not make the shared file
   * multi-writer safe; it avoids widening the existing race during debounce.
   */
  private mergeClaimsFromDisk(): void {
    const disk = readRecords<Claim>(this.claimsPath);
    const merged: Record<string, Claim> = { ...disk };
    for (const key of this.deletedClaims) {
      const remote = merged[key];
      if (remote?.status !== "active") delete merged[key];
    }
    for (const [key, local] of this.localClaims) {
      const remote = merged[key];
      if (!remote) {
        merged[key] = local;
        continue;
      }
      if (local.status === "completed" || remote.status === "completed") {
        const candidates = [local, remote].filter(
          (claim) => claim.status === "completed",
        );
        merged[key] =
          candidates
            .filter((claim) =>
              Number.isFinite(Date.parse(claim.completedAt ?? "")),
            )
            .sort(
              (a, b) =>
                Date.parse(b.completedAt ?? "") -
                Date.parse(a.completedAt ?? ""),
            )[0] ?? candidates[0]!;
      } else merged[key] = local;
    }
    for (const key of Object.keys(this.claims))
      if (!(key in merged)) delete this.claims[key];
    for (const [key, claim] of Object.entries(merged)) this.claims[key] = claim;
    this.localClaims.clear();
    this.deletedClaims.clear();
  }

  private persistControls(): void {
    writePrivateJSONAtomic(this.controlsPath, this.controls);
  }
}
