import type { RunStatus } from "@bd777/foundry-protocol";

/** Queued or running: the session still works on its current input. */
export function isSessionLive(session: { status?: RunStatus }): boolean {
  return session.status === "queued" || session.status === "running";
}

export function isTerminalSession(session: { status?: RunStatus }): boolean {
  return (
    session.status === "completed" ||
    session.status === "failed" ||
    session.status === "canceled"
  );
}
