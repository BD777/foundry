/**
 * Shared session state for the daemon.
 *
 * These Maps/Sets are module-level because they need to survive across
 * WebSocket reconnections within the same process. Active runtimes are closed
 * only during process shutdown or an explicit one-shot teardown.
 */

import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionEventMetadata,
  TranscriptMessage,
} from "@foundry/protocol";
import { ClaudeTurnWatchdog } from "./watchdog.js";
import type { SessionOutputFiles } from "./session-output-files.js";
import type { ClaudeTimerTracker } from "./agent-timers.js";

export type SessionEventEmitter = (
  label: string,
  detail: string,
  level?: AgentSessionEvent["level"],
  metadata?: AgentSessionEventMetadata,
  message?: TranscriptMessage,
) => Promise<void>;

// --- Async input queue ---

export class AsyncInputQueue<T> implements AsyncIterable<T> {
  private closed = false;
  private readonly pending: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined });
    }
  }

  push(value: T): void {
    if (this.closed) {
      throw new Error("Claude active input queue is closed");
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }
    this.pending.push(value);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
    };
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.pending.length > 0) {
      return Promise.resolve({
        done: false,
        value: this.pending.shift() as T,
      });
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

// --- Claude active runtime ---

export interface ClaudeSDKQuery {
  close?: () => void;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

export interface AgentSessionRunResult {
  nativeSessionId?: string;
  response: string;
}

export interface ActiveClaudeTurn {
  /**
   * SDK tasks that were started during this Foundry turn and have not emitted
   * a terminal task_notification yet. A Claude SDK result is only a model-turn
   * boundary while this set is non-empty; it is not the end of the Foundry
   * session.
   */
  openTaskIds: Set<string>;
  emit: SessionEventEmitter;
  finalResult: string;
  messagesPath: string;
  nativeSessionId: string;
  partialResult: string;
  reject: (error: unknown) => void;
  reportNativeSessionId?: (nativeSessionId: string) => void;
  resolve: (result: AgentSessionRunResult) => void;
  resultPath: string;
  /** Files this turn produced, reported once each. */
  outputs?: SessionOutputFiles;
  watchdog: ClaudeTurnWatchdog;
}

export interface ActiveClaudeRuntime {
  closed: boolean;
  /** Foundry session currently attached to the long-lived native thread. */
  foundrySessionId: string;
  input: AsyncInputQueue<unknown>;
  key: string;
  lastUsed: number;
  nativeSessionId: string;
  pending?: ActiveClaudeTurn;
  query?: ClaudeSDKQuery;
  timers?: ClaudeTimerTracker;
}

export const activeClaudeRuntimes = new Map<string, ActiveClaudeRuntime>();

// --- Codex active thread ---

export interface CodexSDKThread {
  id?: string | null;
  run: (input: unknown, options?: Record<string, unknown>) => Promise<unknown>;
  runStreamed?: (
    input: unknown,
    options?: Record<string, unknown>,
  ) => Promise<{ events: AsyncIterable<unknown> }>;
}

export interface ActiveCodexThread {
  key: string;
  lastUsed: number;
  nativeSessionId: string;
  thread: CodexSDKThread;
}

export const activeCodexThreads = new Map<string, ActiveCodexThread>();

// --- Session steer/cancel targets ---

export interface ActiveSessionSteerTarget {
  provider: AgentSession["provider"];
  steer: (message: string) => Promise<void>;
}

export interface ActiveSessionCancelTarget {
  provider: AgentSession["provider"];
  cancel: () => Promise<void> | void;
}

export const activeSessionSteerTargets = new Map<
  string,
  ActiveSessionSteerTarget
>();
export const activeSessionCancelTargets = new Map<
  string,
  ActiveSessionCancelTarget
>();
export const queuedSessionCancelRequests = new Set<string>();

// --- Out-of-band session events ---

export type OutOfBandSessionEvent = {
  detail: string;
  level?: AgentSessionEvent["level"];
  metadata?: AgentSessionEventMetadata;
  message?: AgentSessionEvent["message"];
  label: string;
};

/**
 * Sink for session events that arrive while no Foundry turn owns the runtime
 * — today this means timer-driven (cron) background turns in a long-lived
 * Claude process. The daemon connection registers a sink over its current
 * WebSocket; runtimes stay alive across socket reconnects and simply drop
 * events while no socket is bound.
 */
let outOfBandSessionEventSink:
  ((sessionId: string, event: OutOfBandSessionEvent) => void) | undefined;

export function setOutOfBandSessionEventSink(
  sink: ((sessionId: string, event: OutOfBandSessionEvent) => void) | undefined,
): void {
  outOfBandSessionEventSink = sink;
}

/** Clear the sink only when it is still this exact registration. */
export function clearOutOfBandSessionEventSink(
  sink: (sessionId: string, event: OutOfBandSessionEvent) => void,
): void {
  if (outOfBandSessionEventSink === sink) {
    outOfBandSessionEventSink = undefined;
  }
}

export function emitOutOfBandSessionEvent(
  sessionId: string,
  event: OutOfBandSessionEvent,
): void {
  outOfBandSessionEventSink?.(sessionId, event);
}

/**
 * Prevents a queued session from being executed twice when a replacement
 * WebSocket races with replay of the original session_started envelope.
 * Completed IDs stay in a bounded recent set until the server has had ample
 * time to persist and acknowledge the terminal envelope.
 */
export class SessionExecutionRegistry {
  private readonly active = new Set<string>();
  private readonly recent = new Set<string>();
  private readonly recentOrder: string[] = [];

  constructor(private readonly maxRecent = 2048) {}

  claim(sessionId: string): boolean {
    if (this.active.has(sessionId) || this.recent.has(sessionId)) {
      return false;
    }
    this.active.add(sessionId);
    return true;
  }

  activeSessionIds(): string[] {
    return [...this.active].sort();
  }

  complete(sessionId: string): void {
    this.active.delete(sessionId);
    if (this.maxRecent <= 0 || this.recent.has(sessionId)) {
      return;
    }
    this.recent.add(sessionId);
    this.recentOrder.push(sessionId);
    while (this.recentOrder.length > this.maxRecent) {
      const expired = this.recentOrder.shift();
      if (expired) {
        this.recent.delete(expired);
      }
    }
  }
}
