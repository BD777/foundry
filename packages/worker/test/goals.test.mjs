import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeGoalSnapshot,
  codexGoalSnapshot,
  goalStateKey,
  goalSyncEvent,
} from "../dist/session/goals.js";

test("a Codex thread goal maps to the session goal with its usage", () => {
  const snapshot = codexGoalSnapshot({
    threadId: "thr_1",
    objective: "Ship the release notes",
    status: "paused",
    tokenBudget: null,
    tokensUsed: 12_345,
    timeUsedSeconds: 98,
    createdAt: 1_793_963_292,
    updatedAt: 1_793_963_300,
  });
  assert.deepEqual(snapshot, {
    goal: {
      runtime: "codex",
      objective: "Ship the release notes",
      status: "paused",
      tokensUsed: 12_345,
      timeUsedSeconds: 98,
      setAt: new Date(1_793_963_292_000).toISOString(),
    },
  });
  assert.deepEqual(codexGoalSnapshot(null), {}, "cleared");
  assert.deepEqual(codexGoalSnapshot({ status: "unheard-of" }), {});
});

test("Claude Code's active_goal maps to an active goal, and null to none", () => {
  assert.equal(claudeGoalSnapshot({ type: "assistant" }), undefined);
  const set = claudeGoalSnapshot({
    type: "active_goal",
    value: {
      condition: "all tests pass",
      iterations: 2,
      set_at: 1_793_963_292_123,
      tokens_at_start: 4_000,
      last_reason: "2 tests still fail",
    },
    uuid: "u1",
    session_id: "s1",
  });
  assert.deepEqual(set, {
    goal: {
      runtime: "claude",
      objective: "all tests pass",
      status: "active",
      iterations: 2,
      lastReason: "2 tests still fail",
      setAt: new Date(1_793_963_292_123).toISOString(),
    },
  });
  assert.deepEqual(
    claudeGoalSnapshot({ type: "active_goal", value: null }),
    {},
  );
});

test("progress alone keeps the goal's state key; status, objective and Claude's checks change it", () => {
  const goal = (fields) =>
    codexGoalSnapshot({
      objective: "x",
      status: "active",
      tokensUsed: 1,
      timeUsedSeconds: 1,
      ...fields,
    });
  assert.equal(goalStateKey(goal({ tokensUsed: 900 })), goalStateKey(goal({})));
  assert.notEqual(
    goalStateKey(goal({ status: "paused" })),
    goalStateKey(goal({})),
  );
  assert.equal(goalStateKey({}), "none");
  const event = goalSyncEvent(goal({}));
  assert.equal(event.label, "Goal updated");
  assert.deepEqual(event.metadata.goalSnapshot, goal({}));
});
