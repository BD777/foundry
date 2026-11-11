/**
 * The execution host's control link (client.ts ↔ server.ts): one JSON object
 * per line each way over the private socket. The worker's first line is a
 * handshake, answered with a snapshot; then requests by method, each
 * answered by its id; `ack` is never answered. The host also pushes
 * snapshots and the session envelopes it sends to the server.
 */
import type {
  ChatAttachment,
  DeviceRuntimeState,
  EvidenceWorkerRequest,
  ProtocolEnvelope,
  RunSessionPayload,
} from "@bd777/foundry-protocol";
import type { issueEnvironmentAction } from "../issue/issue-environment-rpc.js";
import type { SessionGoalAction } from "../session/goals.js";
import type {
  SessionCancelOutcome,
  SteerOptions,
} from "../session/session-control.js";

/** Optional methods may be absent during a drain; a version mismatch is refused. */
export const executionHostProtocol = 1;

/**
 * A host with this capability can run beside a newer one: it answers
 * `retire` and `release_session`, and reports `resident` and `outbox`.
 * An older host is only routed around and stopped once nothing runs on it.
 */
export const hostRolloverCapability = "rollover";

export interface HostSnapshot {
  protocol: number;
  capabilities?: string[];
  /** Retiring: it takes no new session, only the ones it already holds. */
  retiring?: boolean;
  /** Started beside an older host: the device's shared work waits for it. */
  standby?: boolean;
  /** Sessions whose agent process or thread this host holds. */
  resident?: Array<{ sessionId: string; busy: boolean }>;
  /** Envelopes not yet acknowledged by the server. */
  outbox?: number;
  entry?: string;
  runtimeStamp?: string;
  busy?: boolean;
  draining?: boolean;
  serverURL?: string;
  pid: number;
  startTime?: string;
  claims: Array<{ sessionId: string; inputId: string }>;
  background: string[];
  ownTurns?: string[];
  /** Sessions whose agents work on their own (sessionsWithNativeWork). */
  nativeWork?: string[];
  /** Latest sampled admission decision. */
  runtimeState?: DeviceRuntimeState;
  version: string;
}

/** The worker's first line: the shared token and the live process it is. */
export interface HostHandshake {
  token: string;
  owner: { pid: number; startTime: string };
}

export type IssueEnvironmentRequest = Parameters<
  typeof issueEnvironmentAction
>[0];

/** Each method's request fields and its result. */
export interface HostMethods {
  snapshot: { request: Record<string, never>; result: HostSnapshot };
  /** Accepts an input once; `status` is its claim's. */
  run: {
    request: { workspacePath: string; payload: RunSessionPayload };
    result: { status: "active" | "completed" };
  };
  /** Applies a steer at most once, by its input id. */
  steer: {
    request: {
      sessionId: string;
      inputId?: string;
      message: string;
      attachments: ChatAttachment[];
      sentBySessionId?: string;
    } & SteerOptions;
    result: Record<string, never>;
  };
  cancel: {
    request: { sessionId: string; inputId?: string };
    result: SessionCancelOutcome;
  };
  stop_background: {
    request: { sessionId: string; taskId: string };
    result: Record<string, never>;
  };
  control_goal: {
    request: { sessionId: string; action: SessionGoalAction };
    result: Record<string, never>;
  };
  /** The daemon registered with the server again; reconcile host-local tools. */
  server_reconnected: {
    request: Record<string, never>;
    result: Record<string, never>;
  };
  issue_environment: {
    request: { payload: IssueEnvironmentRequest };
    result: unknown;
  };
  evidence: { request: { payload: EvidenceWorkerRequest }; result: unknown };
  /**
   * Asks the host to stop taking work for a switch. idle: nothing at all
   * runs. boundary: no turn runs. now: the owner stopped the turns.
   */
  prepare_upgrade: {
    request: { mode: "idle" | "boundary" | "now" };
    result: { ready: boolean };
  };
  cancel_upgrade: {
    request: Record<string, never>;
    result: Record<string, never>;
  };
  /**
   * A newer host serves the device: this one takes no session it does not
   * already hold (a turn, background work, a busy agent), closes the idle
   * agents it keeps, and pauses the timers it delivers. `false` undoes it.
   */
  retire: {
    request: { retiring: boolean };
    result: { retiring: boolean };
  };
  /**
   * The session's next turn runs on a newer host: closes its idle agent
   * here. `released` is false while the agent works; the session stays here.
   */
  release_session: {
    request: { sessionId: string };
    result: { released: boolean };
  };
}

export type HostMethod = keyof HostMethods;

export type HostRequest<M extends HostMethod = HostMethod> = {
  id: string;
  method: M;
} & HostMethods[M]["request"];

/** The server acknowledged an envelope the host sent; never answered. */
export interface HostAck {
  method: "ack";
  envelopeId: string;
}

export type HostReply =
  | { id?: string; result: unknown }
  | { id?: string; error: string; outcomeUnknown: boolean };

/** What the host sends unasked. */
export type HostPush =
  | ({ type: "snapshot" } & HostSnapshot)
  | { type: "envelope"; envelope: ProtocolEnvelope };
