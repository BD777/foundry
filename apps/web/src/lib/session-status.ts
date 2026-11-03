import { isActiveSessionStatus, type RunStatus } from "@bd777/foundry-protocol";

/** Queued, running or blocked: the session still works on its current input. */
export function isSessionLive(session: { status?: RunStatus }): boolean {
  return isActiveSessionStatus(session.status);
}

export function isTerminalSession(session: { status?: RunStatus }): boolean {
  return (
    session.status === "completed" ||
    session.status === "failed" ||
    session.status === "canceled"
  );
}
