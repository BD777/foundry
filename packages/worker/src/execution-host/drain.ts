/**
 * When a newer runner is installed, the old one drains: new turns wait for
 * the new runner while the running ones finish, at most for the cap. A turn
 * is never stopped here; only the owner's "switch now" stops one.
 */
export const runnerSwitchCapMs = 30 * 60_000;
/** No turn runs but the runner stays busy: holding new turns helps no more. */
export const backgroundHoldMs = 60_000;

export interface DrainSnapshot {
  busy?: boolean;
  capabilities?: string[];
  claims: Array<{ sessionId: string; inputId: string }>;
  background: string[];
  ownTurns?: string[];
}

export type DrainDecision =
  | { action: "switch"; mode: "idle" | "boundary" }
  | {
      action: "wait";
      /** New turns wait for the new runner. */
      hold: boolean;
      waitingFor?: "turns" | "background";
    };

/** Sessions with a turn running in the runner: dispatched or its agent's own. */
export function runningTurnSessions(snapshot: DrainSnapshot): string[] {
  return [
    ...new Set([
      ...snapshot.claims.map((claim) => claim.sessionId),
      ...(snapshot.ownTurns ?? []),
    ]),
  ];
}

/**
 * What a draining runner does now. `since`: when the switch became pending;
 * `quietSince`: since when no turn runs (undefined while one does).
 */
export function drainDecision(
  snapshot: DrainSnapshot,
  since: number,
  now: number,
  quietSince?: number,
): DrainDecision {
  const turns = runningTurnSessions(snapshot).length;
  if (!snapshot.busy && !turns && !snapshot.background.length)
    return { action: "switch", mode: "idle" };
  // A runner that knows turn boundaries hands its timers over and keeps
  // waiting only for turns, background tasks and managed services.
  if (
    !turns &&
    !snapshot.background.length &&
    snapshot.capabilities?.includes("drain_switch_v1")
  )
    return { action: "switch", mode: "boundary" };
  const pastCap = now >= since + runnerSwitchCapMs;
  if (turns)
    return pastCap
      ? { action: "wait", hold: false, waitingFor: "turns" }
      : { action: "wait", hold: true };
  const holding =
    !pastCap && quietSince !== undefined && now < quietSince + backgroundHoldMs;
  return holding
    ? { action: "wait", hold: true }
    : { action: "wait", hold: false, waitingFor: "background" };
}
