import type WebSocket from "ws";
import type { BackgroundOutputFollowers } from "../background-output-follow.js";
import type { SessionExecutionRegistry } from "../session-state.js";
import type { ConcurrentTaskScheduler } from "../task-scheduler.js";
import type { ReliableSessionTransport } from "../transport.js";
import type { WorkspaceRoster } from "./workspace-roster.js";

export type SessionOutcome = "exit" | "reconnect" | "removed" | "refused";

/** What one control connection's handlers change as messages arrive. */
export interface ConnectionState {
  registered: boolean;
  refused: boolean;
  acceptedRun: boolean;
  idleTimer?: NodeJS.Timeout;
}

/** One control connection, as the handlers of its messages see it. */
export interface DaemonContext {
  readonly socket: WebSocket;
  readonly serverURL: string;
  /** The folder the daemon was started with; "" without one. */
  readonly workspacePath: string;
  readonly once: boolean;
  readonly idleTimeoutMs: number;
  readonly taskScheduler: ConcurrentTaskScheduler;
  readonly sessionExecutions: SessionExecutionRegistry;
  readonly sessionTransport: ReliableSessionTransport;
  readonly roster: WorkspaceRoster;
  /** Background task logs read while they grow (see background-output-follow). */
  readonly outputFollowers: BackgroundOutputFollowers;
  readonly state: ConnectionState;
  finish(outcome: SessionOutcome): void;
  announceAdditionalIssueCapacity(): void;
  checkProvidersAndReport(): void;
  /** Issue environment changes go to the server from now on. */
  tellEnvironmentChanges(): void;
  /** Background turns' events go over this connection from now on. */
  routeOutOfBandEvents(): void;
}

let openSocket: WebSocket | undefined;

/** The control socket open now; it changes with each reconnect. */
export function currentSocket(): WebSocket | undefined {
  return openSocket;
}

export function socketOpened(socket: WebSocket): void {
  openSocket = socket;
}

export function socketClosed(socket: WebSocket): void {
  if (openSocket === socket) openSocket = undefined;
}

/**
 * Timestamp for connection lifecycle lines: service managers such as launchd
 * write the daemon's output without one, and a dropped connection is only
 * diagnosable against the server's log by time.
 */
export function logTime(): string {
  return new Date().toISOString();
}
