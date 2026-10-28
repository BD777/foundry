/**
 * Steering and stopping running sessions: who answers a session's steer and
 * cancel, and the cancels that arrived before their input started.
 */

import type {
  AgentSession,
  ChatAttachment,
  SteerDelivery,
} from "@bd777/foundry-protocol";
import { dispatchKey } from "./session-state.js";

export { ControlOutcomeUnknownError } from "./agent-runtime/control-error.js";
import { ControlOutcomeUnknownError } from "./agent-runtime/control-error.js";

export interface ActiveSessionSteerTarget {
  provider: AgentSession["provider"];
  /**
   * Injects a message, and the files that came with it, into the turn.
   * steerId, the server's id for the message, names its transcript event
   * (evt_<steerId>, as the input event of a sent message is named).
   */
  steer: (
    message: string,
    attachments?: ChatAttachment[],
    steerId?: string,
    sentBySessionId?: string,
    options?: SteerOptions,
  ) => Promise<void>;
}

/**
 * How a message from another session enters the turn (DEV-057): absent
 * delivery is the runtime's own way, a person's message.
 */
export interface SteerOptions {
  delivery?: SteerDelivery;
  boundaryLimitMs?: number;
}

/**
 * The session has no turn that takes input now: it is starting, finishing
 * or compacting. Nothing was applied; the server holds the message.
 */
export class SessionNotSteerableError extends Error {
  constructor(message = "This session is not accepting active steer input.") {
    super(message);
    this.name = "SessionNotSteerableError";
  }
}

/** A refusal for not taking input now, also one that crossed a process. */
export function isNotSteerableError(error: unknown): boolean {
  if (error instanceof SessionNotSteerableError) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /not accepting (active )?(steer )?input/i.test(message);
}

/**
 * What a stop did. answered: the turn had already answered, so the stop ended
 * only the background work it waited for and the turn completes with that
 * answer.
 */
export interface SessionCancelOutcome {
  inputId?: string;
  pending?: boolean;
  stopped?: boolean;
  answered?: boolean;
}

export interface ActiveSessionCancelTarget {
  inputId?: string;
  provider: AgentSession["provider"];
  cancel: () =>
    Promise<SessionCancelOutcome | void> | SessionCancelOutcome | void;
}

const activeSessionSteerTargets = new Map<string, ActiveSessionSteerTarget>();
const activeSessionCancelTargets = new Map<string, ActiveSessionCancelTarget>();
const queuedSessionCancelRequests = new Set<string>();
const cancelFlights = new WeakMap<
  ActiveSessionCancelTarget,
  Promise<SessionCancelOutcome>
>();
function cancelTargetOnce(
  target: ActiveSessionCancelTarget,
): Promise<SessionCancelOutcome> {
  const previous = cancelFlights.get(target);
  if (previous) return previous;
  let flight: Promise<SessionCancelOutcome>;
  try {
    flight = Promise.resolve(target.cancel()).then((value) => value ?? {});
  } catch (error) {
    flight = Promise.reject(error);
  }
  cancelFlights.set(target, flight);
  return flight;
}

export function registerActiveSessionSteerTarget(
  sessionID: string,
  target: ActiveSessionSteerTarget,
): () => void {
  activeSessionSteerTargets.set(sessionID, target);
  return () => {
    if (activeSessionSteerTargets.get(sessionID) === target) {
      activeSessionSteerTargets.delete(sessionID);
    }
  };
}

export function registerActiveSessionCancelTarget(
  sessionID: string,
  target: ActiveSessionCancelTarget,
): () => void {
  activeSessionCancelTargets.set(sessionID, target);
  if (
    target.inputId &&
    queuedSessionCancelRequests.delete(dispatchKey(sessionID, target.inputId))
  )
    void cancelTargetOnce(target).catch(() => {});
  return () => {
    if (activeSessionCancelTargets.get(sessionID) === target) {
      activeSessionCancelTargets.delete(sessionID);
    }
  };
}

export async function steerActiveSession(
  sessionID: string,
  message: string,
  attachments?: ChatAttachment[],
  steerID?: string,
  sentBySessionId?: string,
  options?: SteerOptions,
): Promise<void> {
  const target = activeSessionSteerTargets.get(sessionID);
  if (!target) {
    throw new SessionNotSteerableError();
  }
  await target.steer(message, attachments, steerID, sentBySessionId, options);
}

/**
 * Steers the server named (by session and id), applied or being applied. A
 * steer whose reply reached the server too late is sent again; it must not
 * reach the agent twice. A refused steer is forgotten so it can be retried.
 */
const appliedSteers = new Map<string, Promise<void>>();
const appliedSteerLimit = 512;

function rememberSteer(key: string, applying: Promise<void>): void {
  appliedSteers.set(key, applying);
  if (appliedSteers.size > appliedSteerLimit) {
    const oldest = appliedSteers.keys().next().value;
    if (oldest !== undefined) appliedSteers.delete(oldest);
  }
}

/**
 * A message the session was given as an input of its own: a steer of it
 * (sent before the server stopped waiting for its answer) is answered as
 * applied and never reaches the agent a second time.
 */
export function noteSessionInput(sessionID: string, inputID: string): void {
  rememberSteer(`${sessionID}\u0000${inputID}`, Promise.resolve());
}

/** steerActiveSession, once per id; without an id, every time. */
export function steerActiveSessionOnce(
  sessionID: string,
  steerID: string | undefined,
  message: string,
  attachments?: ChatAttachment[],
  sentBySessionId?: string,
  options?: SteerOptions,
): Promise<void> {
  if (!steerID) {
    return steerActiveSession(
      sessionID,
      message,
      attachments,
      undefined,
      sentBySessionId,
      options,
    );
  }
  const key = `${sessionID}\u0000${steerID}`;
  const known = appliedSteers.get(key);
  if (known) {
    return known;
  }
  const applying = steerActiveSession(
    sessionID,
    message,
    attachments,
    steerID,
    sentBySessionId,
    options,
  );
  rememberSteer(key, applying);
  applying.catch((error) => {
    // An unknown native acknowledgement must not be retried as a new input.
    if (
      appliedSteers.get(key) === applying &&
      !(error instanceof Error && error instanceof ControlOutcomeUnknownError)
    )
      appliedSteers.delete(key);
  });
  return applying;
}

/**
 * Cancels the input a session is running. A cancel that arrives before the
 * input started is parked for that input only, never for the session's later
 * inputs.
 */
export async function cancelActiveSession(
  sessionID: string,
  inputID = "",
): Promise<SessionCancelOutcome> {
  const target = activeSessionCancelTargets.get(sessionID);
  if (!target) {
    queuedSessionCancelRequests.add(dispatchKey(sessionID, inputID));
    return { inputId: inputID, pending: true };
  }
  if (inputID && target.inputId !== inputID)
    return { inputId: inputID, pending: true };
  const outcome = await cancelTargetOnce(target);
  return { ...outcome, inputId: inputID, pending: true };
}

/** Whether a cancel for this input arrived before it started; it is used up. */
export function takeQueuedSessionCancel(
  sessionID: string,
  inputID?: string,
): boolean {
  return queuedSessionCancelRequests.delete(dispatchKey(sessionID, inputID));
}

/** The session's input ended: nothing of it answers steers or cancels. */
export function forgetActiveSession(sessionID: string): void {
  activeSessionSteerTargets.delete(sessionID);
  activeSessionCancelTargets.delete(sessionID);
}

/** Every steer and cancel target, and every parked cancel, is dropped. */
export function clearSessionControl(): void {
  activeSessionSteerTargets.clear();
  activeSessionCancelTargets.clear();
  queuedSessionCancelRequests.clear();
}

export class AgentSessionCanceledError extends Error {
  constructor() {
    super("Session was canceled.");
    this.name = "AgentSessionCanceledError";
  }
}

export function isAgentSessionCanceledError(error: unknown): boolean {
  return error instanceof AgentSessionCanceledError;
}
