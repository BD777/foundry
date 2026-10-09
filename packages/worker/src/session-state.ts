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
  ChatAttachment,
  TranscriptMessage,
} from "@bd777/foundry-protocol";
import { ClaudeTurnWatchdog } from "./watchdog.js";
import type { SessionTurnFiles } from "./session-files.js";
import type { ClaudeTimerTracker } from "./agent-timers.js";
import type { ClaudeBackgroundTaskTracker } from "./agent-background-tasks.js";
import type {
  ClaudeRequestUsageTracker,
  TurnTokenUsage,
} from "./turn-usage.js";

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
  setMcpServers?: (servers: Record<string, unknown>) => Promise<unknown>;
  /** Stops a background task; Claude reads a "stopped" notification. */
  stopTask?: (taskId: string) => Promise<void>;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

export interface AgentSessionRunResult {
  nativeSessionId?: string;
  response: string;
}

export interface ActiveClaudeTurn {
  /**
   * SDK tasks that were started during this Foundry turn and have not emitted
   * a terminal task_notification yet. For a turn that waits for background
   * work, a Claude SDK result is only a model-turn boundary while this set is
   * non-empty; it is not the end of the Foundry session.
   */
  openTaskIds: Set<string>;
  /**
   * Issue-bound and agent-created sessions are judged on their answer, so
   * their turn waits for background work. A chat's turn ends with Claude's
   * answer; its background work continues and is tracked on the runtime.
   */
  waitForBackgroundTasks?: boolean;
  /** The input's id, which Claude's command lifecycle reports it under. */
  commandId?: string;
  /** "started": the stream answers this input from now on. */
  commandState?: "queued" | "started";
  /**
   * Sent while Claude was continuing on its own; without command lifecycle
   * reports the turn begins once that continuation's result arrives.
   */
  behindContinuation?: boolean;
  emit: SessionEventEmitter;
  finalResult: string;
  messagesPath: string;
  nativeSessionId: string;
  partialResult: string;
  reject: (error: unknown) => void;
  reportNativeSessionId?: (nativeSessionId: string) => void;
  resolve: (result: AgentSessionRunResult) => void;
  resultPath: string;
  /** Epoch ms when the runtime took this turn. */
  startedAt: number;
  /** Provider usage summed over the turn's results. */
  usage?: TurnTokenUsage;
  /** Follows each model request's stream for its final tokens. */
  requestUsage?: ClaudeRequestUsageTracker;
  /** Files this turn's tools wrote and its answer named. */
  files?: SessionTurnFiles;
  watchdog: ClaudeTurnWatchdog;
}

/**
 * A model turn Claude runs on its own between Foundry turns, typically after
 * a background task finished. Its answer is published once its result
 * arrives.
 */
export interface ActiveClaudeContinuation {
  /** Epoch ms of its first message. */
  startedAt: number;
  finalResult: string;
  partialResult: string;
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
  /** Background work of the agent process; it outlives Foundry turns. */
  background?: ClaudeBackgroundTaskTracker;
  continuation?: ActiveClaudeContinuation;
  /** Summaries of background tasks that ended since the last answer. */
  notifications?: string[];
  /** The CLI reports command lifecycle, so turns own exactly their stream. */
  commandLifecycle?: boolean;
  /** The latest turn's raw message log; messages between turns go there too. */
  messagesPath?: string;
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
  /** Injects a message, and the files that came with it, into the turn. */
  steer: (message: string, attachments?: ChatAttachment[]) => Promise<void>;
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
 * — timer-driven (cron) turns, Claude's own follow-ups after background work
 * finished, and background task snapshots of a long-lived Claude process. The daemon connection registers a sink over its current
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
  /** Active dispatch key → its session id. */
  private readonly active = new Map<string, string>();
  private readonly recent = new Set<string>();
  private readonly recentOrder: string[] = [];

  constructor(private readonly maxRecent = 2048) {}

  /**
   * Claims one input of a session. A session runs many inputs over its life;
   * each is delivered once.
   */
  claim(sessionId: string, inputId = ""): boolean {
    const key = dispatchKey(sessionId, inputId);
    if (this.active.has(key) || this.recent.has(key)) {
      return false;
    }
    this.active.set(key, sessionId);
    return true;
  }

  /** True while this process runs the input or recently finished it. */
  handled(sessionId: string, inputId = ""): boolean {
    const key = dispatchKey(sessionId, inputId);
    return this.active.has(key) || this.recent.has(key);
  }

  activeSessionIds(): string[] {
    return [...new Set(this.active.values())].sort();
  }

  complete(sessionId: string, inputId = ""): void {
    const key = dispatchKey(sessionId, inputId);
    this.active.delete(key);
    if (this.maxRecent <= 0 || this.recent.has(key)) {
      return;
    }
    this.recent.add(key);
    this.recentOrder.push(key);
    while (this.recentOrder.length > this.maxRecent) {
      const expired = this.recentOrder.shift();
      if (expired) {
        this.recent.delete(expired);
      }
    }
  }
}

/** Names one input of a session; sessions built without inputs use their id. */
export function dispatchKey(sessionId: string, inputId = ""): string {
  return inputId ? `${sessionId}/${inputId}` : sessionId;
}
