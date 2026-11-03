import type { AgentSession } from "@bd777/foundry-protocol";
import type {
  AgentSessionRunResult,
  SessionEventEmitter,
} from "./session-state.js";
import type { WorkspaceSandbox } from "./workspace.js";

/** Where a dispatched session runs and keeps its state. */
export interface SessionExecution {
  /** Directory the agent works in. */
  cwd: string;
  /** Directory that receives Foundry's own session records. */
  stateRoot: string;
  sandbox?: WorkspaceSandbox;
}

/** One run of the session's agent: its turn's session, in a sandbox. */
export type AgentTurn = (
  session: AgentSession,
  sandbox?: WorkspaceSandbox,
) => Promise<AgentSessionRunResult>;

/**
 * What a session's role decides about an input it runs like any other
 * session (daemon/session-execution.ts): a chat only where it runs; an
 * Issue's clarification also its reply (issue-clarification.ts); an Issue's
 * execution also its candidate and result (issue-execution.ts).
 */
export interface SessionRole {
  /** Once the input started: where it runs and the session it runs as. */
  prepare: (
    emit: SessionEventEmitter,
  ) => Promise<{ execution: SessionExecution; session: AgentSession }>;
  /** Runs the agent; without it, once. */
  run?: (
    agent: AgentTurn,
    emit: SessionEventEmitter,
  ) => Promise<AgentSessionRunResult>;
  /** What the completion report adds once the agent answered. */
  settle?: (
    result: AgentSessionRunResult,
    emit: SessionEventEmitter,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  /**
   * What the report of an input that failed or was canceled adds. A failure
   * is reported as a worker failure either way; a cancel only with it.
   */
  stopped?: (error: unknown, canceled: boolean) => Record<string, unknown>;
  /** The agent's native session, as soon as it is known. */
  nativeSessionId?: (nativeSessionId: string) => void;
}
