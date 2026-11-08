/**
 * A session's goal, as its runtime reports it: Codex's thread goal
 * (thread/goal/get, thread/goal/updated, thread/goal/cleared) and Claude
 * Code's /goal (its SDK `active_goal` message). Both become one
 * AgentSessionGoalSnapshot event; the server keeps the newest for the chat.
 */

import {
  processLabels,
  type AgentSessionGoal,
  type AgentSessionGoalSnapshot,
  type AgentSessionGoalStatus,
} from "@bd777/foundry-protocol";

const goalStatuses = new Set<string>([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);

/** The person's controls of a goal, as the runtime offers them. */
export type SessionGoalAction = "pause" | "resume" | "clear";

export function isSessionGoalAction(
  value: unknown,
): value is SessionGoalAction {
  return value === "pause" || value === "resume" || value === "clear";
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/** Seconds or milliseconds since the epoch, as ISO 8601. */
function isoTime(value: unknown): string | undefined {
  const raw = count(value);
  if (!raw) return undefined;
  const ms = raw < 1e12 ? raw * 1000 : raw;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** A Codex ThreadGoal (0.167), or null once it was cleared. */
export function codexGoalSnapshot(goal: unknown): AgentSessionGoalSnapshot {
  if (!goal || typeof goal !== "object") return {};
  const value = goal as Record<string, unknown>;
  if (typeof value.status !== "string" || !goalStatuses.has(value.status))
    return {};
  const tokensUsed = count(value.tokensUsed);
  const timeUsedSeconds = count(value.timeUsedSeconds);
  const setAt = isoTime(value.createdAt);
  return {
    goal: {
      runtime: "codex",
      objective: typeof value.objective === "string" ? value.objective : "",
      status: value.status as AgentSessionGoalStatus,
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      ...(timeUsedSeconds !== undefined ? { timeUsedSeconds } : {}),
      ...(setAt ? { setAt } : {}),
    },
  };
}

/**
 * Claude Code's `active_goal` message (SDKActiveGoalMessage, SDK 0.3.318):
 * its value is null once the goal was met or cleared. Undefined for any
 * other message.
 */
export function claudeGoalSnapshot(
  message: unknown,
): AgentSessionGoalSnapshot | undefined {
  if (!message || typeof message !== "object") return undefined;
  const record = message as Record<string, unknown>;
  if (record.type !== "active_goal") return undefined;
  const value = record.value;
  if (!value || typeof value !== "object") return {};
  const goal = value as Record<string, unknown>;
  const condition =
    typeof goal.condition === "string" ? goal.condition.trim() : "";
  if (!condition) return {};
  const iterations = count(goal.iterations);
  const setAt = isoTime(goal.set_at);
  const lastReason =
    typeof goal.last_reason === "string" ? goal.last_reason.trim() : "";
  return {
    goal: {
      runtime: "claude",
      objective: condition,
      status: "active",
      ...(iterations !== undefined ? { iterations } : {}),
      ...(lastReason ? { lastReason } : {}),
      ...(setAt ? { setAt } : {}),
    },
  };
}

/** What changes the goal itself, as opposed to its progress counters. */
export function goalStateKey(snapshot: AgentSessionGoalSnapshot): string {
  const goal: AgentSessionGoal | undefined = snapshot.goal;
  return goal
    ? JSON.stringify([
        goal.runtime,
        goal.objective,
        goal.status,
        goal.iterations ?? null,
        goal.lastReason ?? null,
      ])
    : "none";
}

/** The transcript event that carries a goal snapshot (hidden as a step). */
export function goalSyncEvent(snapshot: AgentSessionGoalSnapshot) {
  return {
    label: processLabels.goalSync,
    detail: snapshot.goal
      ? `${snapshot.goal.status}: ${snapshot.goal.objective}`.slice(0, 200)
      : "",
    metadata: { goalSnapshot: snapshot },
  };
}
