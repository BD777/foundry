import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { panel } from "./fixtures/session-panel.mjs";

register("./bundler-resolve.mjs", import.meta.url);
const { chatContextCardForSessions } =
  await import("../src/features/chat/context/chat-context-model.ts");
const { goalActions, goalProgress } =
  await import("../src/features/chat/context/chat-context-goal.tsx");
const { sessionTranscriptEntries } =
  await import("../src/features/chat/thread/transcript-adapters.ts");
const { shouldDisplayAgentSessionEvent } =
  await import("../src/lib/agent-session-events.ts");
const { i18n } = await import("../src/i18n/index.ts");

function session(id, provider, sessionPanel, events = []) {
  return {
    agentId: "agent_test",
    createdLabel: "just now",
    deviceId: "dev_test",
    events,
    panel: sessionPanel,
    id,
    prompt: "ship it",
    provider,
    status: "completed",
    title: "ship it",
    updatedLabel: "completed",
    workspaceId: "ws_test",
  };
}

const codexGoal = {
  runtime: "codex",
  objective: "Ship the release notes",
  status: "active",
  tokensUsed: 12_400,
  timeUsedSeconds: 75,
};

test("the open session's goal is the card's, with the controls its runtime has", async () => {
  const previous = i18n.language;
  await i18n.changeLanguage("en");
  try {
    const card = chatContextCardForSessions([
      session(
        "sess_old",
        "codex",
        panel({ goal: { ...codexGoal, status: "paused" } }),
      ),
      session("sess_open", "codex", panel({ goal: codexGoal })),
    ]);
    assert.deepEqual(card?.goal, { ...codexGoal, sessionId: "sess_open" });
    assert.equal(goalProgress(card.goal), "12.4K tokens · 1m 15s");
    assert.deepEqual(goalActions(card.goal), ["pause", "clear"]);
    for (const status of ["paused", "blocked", "usageLimited", "budgetLimited"])
      assert.deepEqual(goalActions({ ...card.goal, status }), [
        "resume",
        "clear",
      ]);
    assert.deepEqual(goalActions({ ...card.goal, status: "complete" }), [
      "clear",
    ]);

    const claude = {
      runtime: "claude",
      objective: "all tests pass",
      status: "active",
      iterations: 2,
      sessionId: "sess_c",
    };
    assert.deepEqual(goalActions(claude), ["clear"]);
    assert.equal(goalProgress(claude), "Checked 2 times, not met yet");

    // A goal the open session cleared is gone, even if an earlier one had one.
    assert.equal(
      chatContextCardForSessions([
        session("sess_old", "codex", panel({ goal: codexGoal })),
        session("sess_open", "codex", panel()),
      ])?.goal,
      undefined,
    );
  } finally {
    await i18n.changeLanguage(previous);
  }
});

test("a goal snapshot is no transcript step; a catch-up fire names when it was due", async () => {
  const previous = i18n.language;
  await i18n.changeLanguage("en");
  try {
    const goalEvent = {
      at: "2026-11-07T10:00:00.000Z",
      detail: "active: Ship it",
      id: "evt_goal",
      label: "Goal updated",
      level: "info",
      metadata: { goalSnapshot: { goal: codexGoal } },
      sessionId: "sess_open",
    };
    assert.equal(shouldDisplayAgentSessionEvent(goalEvent), false);
    const fire = {
      at: "2026-11-07T10:20:00.000Z",
      detail: "",
      id: "evt_fire",
      label: "Scheduled task fired",
      level: "info",
      metadata: {
        timerFire: {
          id: "cron_7",
          origin: "scheduled",
          prompt: "check the build",
          startedAt: "2026-11-07T10:20:00.000Z",
          completedAt: "2026-11-07T10:21:00.000Z",
          scheduledFor: "2026-11-07T10:02:00.000Z",
          catchUp: true,
          response: "green",
        },
      },
      sessionId: "sess_open",
    };
    const entries = sessionTranscriptEntries(
      session("sess_open", "claude", panel(), [goalEvent, fire]),
    );
    assert.ok(!entries.some((entry) => entry.kind === "status"));
    const boundary = entries.find((entry) => entry.kind === "boundary");
    assert.match(boundary?.text ?? "", /delivered late, once · was due /);
  } finally {
    await i18n.changeLanguage(previous);
  }
});
