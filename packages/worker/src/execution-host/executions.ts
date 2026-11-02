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
import { writePrivateJSONAtomic } from "../platform/storage.js";
import type { ConcurrentTaskScheduler } from "../platform/task-scheduler.js";
import { ReliableSessionTransport } from "../transport/transport.js";
import { reportWorkerFailure } from "../session/worker-failure.js";
import type { HostMethods } from "./protocol.js";

interface Claim {
  sessionId: string;
  inputId: string;
  status: "active" | "completed";
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
}

function readRecords<T>(path: string): Record<string, T> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export class HostExecutions {
  readonly transport: ReliableSessionTransport;
  readonly core: ExecutionCore;
  private readonly claimsPath: string;
  private readonly controlsPath: string;
  private readonly claims: Record<string, Claim>;
  private readonly controls: Record<string, ControlOutcome>;
  private readonly controlFlights = new Map<string, Promise<void>>();

  constructor(private readonly options: HostExecutionsOptions) {
    this.claimsPath = resolve(options.root, "claims.json");
    this.controlsPath = resolve(options.root, "controls.json");
    this.claims = readRecords(this.claimsPath);
    this.controls = readRecords(this.controlsPath);
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
        if (claim) {
          claim.status = "completed";
          this.persistClaims();
        }
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
          this.claims[key] = { sessionId, inputId, status: "active" };
          this.persistClaims();
          return true;
        },
        complete: (sessionId, inputId) => {
          this.claims[dispatchKey(sessionId, inputId)]!.status = "completed";
          this.persistClaims();
          options.changed();
        },
      },
      asksForIssues: true,
      failed: options.failed,
      run: options.run,
    });
  }

  /**
   * The inputs an earlier host was running, reported as stopped. Its
   * processes were cleaned up before (superviseAgentProcesses).
   */
  reportInterrupted(): void {
    for (const claim of Object.values(this.claims))
      if (claim.status === "active") {
        reportWorkerFailure(
          this.transport,
          { id: claim.sessionId, input: { id: claim.inputId } },
          executionHostStoppedError,
        );
        claim.status = "completed";
      }
    this.persistClaims();
  }

  /** The inputs accepted and not yet reported. */
  active(): Claim[] {
    return Object.values(this.claims).filter(
      (claim) => claim.status === "active",
    );
  }

  run({
    workspacePath,
    payload,
  }: HostMethods["run"]["request"]): HostMethods["run"]["result"] {
    if (this.core.accept(payload, () => workspacePath)) this.options.changed();
    const claim =
      this.claims[dispatchKey(payload.session.id, payload.session.input?.id)];
    return { status: claim!.status };
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
    writePrivateJSONAtomic(this.claimsPath, this.claims);
  }

  private persistControls(): void {
    writePrivateJSONAtomic(this.controlsPath, this.controls);
  }
}
