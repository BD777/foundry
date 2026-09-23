import assert from "node:assert/strict";
import test from "node:test";
import {
  agentSessionIsAwaitingDetails,
  agentSessionNeedsDetails,
  mergeLoadedAgentSession,
  mergeAgentSessionEvent,
  normalizeAgentSessionForDisplay,
  normalizeAgentSessionEvents,
  shouldDisplayAgentSessionEvent,
} from "../src/lib/agent-session-events.ts";

function event(id, label, detail) {
  return {
    at: "2026-08-01T00:00:00.000Z",
    detail,
    id,
    label,
    level: "info",
    sessionId: "sess_test",
  };
}

test("typed answer identity survives normalization and terminal response hydration", () => {
  const first = {
    ...event("event-a", "Response stream", "one"),
    message: { id: "a", kind: "assistant", text: "one" },
  };
  const second = {
    ...event("event-b", "Response stream", "two"),
    message: { id: "b", kind: "assistant", text: "two" },
  };
  const normalized = normalizeAgentSessionForDisplay({
    id: "s",
    response: "two completed",
    events: [first, second],
  });
  assert.equal(normalized.events.length, 2);
  assert.equal(normalized.events[0].message.text, "one");
  assert.equal(normalized.events[1].message.text, "two completed");
});

test("replaces streamed response snapshots in place without moving prior text", () => {
  const first = event("evt_1", "Response stream", "hello");
  const thinking = event("evt_2", "正在思考", "thinking after text");
  const second = event("evt_3", "Response stream", "hello world");

  const merged = mergeAgentSessionEvent([first, thinking], second);

  assert.deepEqual(
    merged.map((item) => [item.label, item.detail]),
    [
      ["Response stream", "hello world"],
      ["正在思考", "thinking after text"],
    ],
  );
});

test("normalizes persisted legacy response snapshots at the original response position", () => {
  const normalized = normalizeAgentSessionEvents([
    event("evt_1", "Loaded workspace", "/tmp/project"),
    event("evt_2", "Response stream", "partial text"),
    event("evt_3", "正在使用工具", "rg"),
    event("evt_4", "Response stream", "final text"),
  ]);

  assert.deepEqual(
    normalized.map((item) => [item.label, item.detail]),
    [
      ["Loaded workspace", "/tmp/project"],
      ["Response stream", "final text"],
      ["正在使用工具", "rg"],
    ],
  );
});

test("stable response stream ids replace only the matching response event", () => {
  const firstTurn = event(
    "evt_sess_test_response_stream",
    "Response stream",
    "first turn",
  );
  const secondTurn = event(
    "evt_sess_test_response_stream_2",
    "Response stream",
    "second turn",
  );
  const nextSecondTurn = event(
    "evt_sess_test_response_stream_2",
    "Response stream",
    "second turn updated",
  );

  const merged = mergeAgentSessionEvent(
    [firstTurn, secondTurn],
    nextSecondTurn,
  );

  assert.deepEqual(
    merged.map((item) => item.detail),
    ["first turn", "second turn updated"],
  );
});

test("keeps loaded details when a background refresh returns a lightweight summary", () => {
  const detailed = {
    agentId: "agent_test",
    createdLabel: "just now",
    deviceId: "dev_test",
    events: [event("evt_response", "Response stream", "full streamed text")],
    id: "sess_test",
    prompt: "hello",
    provider: "codex",
    response: "full streamed text",
    status: "running",
    title: "hello",
    updatedLabel: "running",
    workspaceId: "ws_test",
  };
  const summary = {
    agentId: "agent_test",
    completedAt: "2026-08-01T00:00:05.000Z",
    createdLabel: "just now",
    deviceId: "dev_test",
    id: "sess_test",
    nativeSessionId: "native_test",
    prompt: "hello",
    provider: "codex",
    status: "completed",
    title: "hello",
    updatedLabel: "completed",
    workspaceId: "ws_test",
  };

  const merged = mergeLoadedAgentSession(detailed, summary);

  assert.equal(merged.status, "completed");
  assert.equal(merged.response, "full streamed text");
  assert.equal(merged.nativeSessionId, "native_test");
  assert.deepEqual(
    merged.events.map((item) => [item.label, item.detail]),
    [["Response stream", "full streamed text"]],
  );
});

test("keeps details when a lifecycle event carries a session without event detail", () => {
  const detailed = {
    agentId: "agent_test",
    createdLabel: "just now",
    deviceId: "dev_test",
    events: [event("evt_response", "Response stream", "partial")],
    id: "sess_test",
    prompt: "hello",
    provider: "codex",
    status: "running",
    title: "hello",
    updatedLabel: "running",
    workspaceId: "ws_test",
  };
  const lifecyclePayload = {
    agentId: "agent_test",
    createdLabel: "just now",
    deviceId: "dev_test",
    id: "sess_test",
    prompt: "hello",
    provider: "codex",
    response: "final",
    status: "completed",
    title: "hello",
    updatedLabel: "completed",
    workspaceId: "ws_test",
  };

  const merged = mergeLoadedAgentSession(detailed, lifecyclePayload);

  assert.equal(merged.status, "completed");
  assert.equal(merged.response, "final");
  assert.deepEqual(
    merged.events.map((item) => [item.label, item.detail]),
    [["Response stream", "final"]],
  );
});

test("requests detail after a terminal summary preserves partial events without a response", () => {
  const detailed = {
    agentId: "agent_test",
    createdLabel: "just now",
    deviceId: "dev_test",
    events: [event("evt_response", "Response stream", "partial")],
    id: "sess_test",
    prompt: "hello",
    provider: "codex",
    status: "running",
    title: "hello",
    updatedLabel: "running",
    workspaceId: "ws_test",
  };
  const completedSummary = {
    agentId: "agent_test",
    createdLabel: "just now",
    deviceId: "dev_test",
    id: "sess_test",
    prompt: "hello",
    provider: "codex",
    status: "completed",
    title: "hello",
    updatedLabel: "completed",
    workspaceId: "ws_test",
  };

  const merged = mergeLoadedAgentSession(detailed, completedSummary);

  assert.equal(merged.status, "completed");
  assert.equal(merged.response, undefined);
  assert.equal(agentSessionNeedsDetails(merged), true);
});

test("does not request detail for a terminal session that already has a response", () => {
  assert.equal(
    agentSessionNeedsDetails({
      agentId: "agent_test",
      createdLabel: "just now",
      deviceId: "dev_test",
      events: [],
      id: "sess_test",
      prompt: "hello",
      provider: "codex",
      response: "done",
      status: "completed",
      title: "hello",
      updatedLabel: "completed",
      workspaceId: "ws_test",
    }),
    false,
  );
});

test("requests detail when a summary reports activity newer than loaded events", () => {
  assert.equal(
    agentSessionNeedsDetails({
      agentId: "agent_test",
      createdLabel: "just now",
      deviceId: "dev_test",
      events: [event("evt_old", "Response stream", "partial")],
      id: "sess_test",
      lastActivityAt: "2026-08-01T00:00:05.000Z",
      prompt: "hello",
      provider: "codex",
      status: "running",
      title: "hello",
      updatedLabel: "running",
      workspaceId: "ws_test",
    }),
    true,
  );
});

test("distinguishes an unhydrated terminal summary from an empty detail", () => {
  const summary = {
    agentId: "agent_test",
    createdLabel: "just now",
    deviceId: "dev_test",
    id: "sess_test",
    prompt: "hello",
    provider: "claude",
    status: "completed",
    title: "hello",
    updatedLabel: "completed",
    workspaceId: "ws_test",
  };

  assert.equal(agentSessionIsAwaitingDetails(summary), true);
  assert.equal(
    agentSessionIsAwaitingDetails({ ...summary, events: [] }),
    false,
  );
});

test("hides successful provider finished lifecycle events from chat display", () => {
  assert.equal(
    shouldDisplayAgentSessionEvent(
      event("evt_finished", "Claude Agent SDK finished", "/tmp/result.md"),
    ),
    false,
  );
  assert.equal(
    shouldDisplayAgentSessionEvent(
      event("evt_codex_finished", "Codex CLI finished", "/tmp/result.md"),
    ),
    false,
  );
  assert.equal(
    shouldDisplayAgentSessionEvent(
      event(
        "evt_custom_finished",
        "Custom profile command finished",
        "/tmp/result.md",
      ),
    ),
    false,
  );
});

test("keeps warning provider finished lifecycle events visible", () => {
  assert.equal(
    shouldDisplayAgentSessionEvent({
      ...event(
        "evt_finished_warning",
        "Claude Agent SDK finished",
        "timed out",
      ),
      level: "warning",
    }),
    true,
  );
});

test("moves workspace and subagent lifecycle events out of the main transcript", () => {
  for (const label of [
    "Loaded workspace",
    "Still working",
    "正在启动子任务",
    "子任务进行中",
    "子任务完成",
    "子任务失败",
  ]) {
    assert.equal(
      shouldDisplayAgentSessionEvent(event(`evt_${label}`, label, "detail")),
      false,
    );
  }
});

test("keeps response snapshots anchored before later process events from the same turn", () => {
  const normalized = normalizeAgentSessionEvents([
    event("evt_loaded", "Loaded workspace", "/tmp/project"),
    event("evt_response", "Response stream", "first text"),
    event("evt_tool_start", "正在使用工具", "Bash"),
    event("evt_tool_done", "已使用工具", "Bash result"),
    event("evt_response", "Response stream", "final answer"),
  ]);

  assert.deepEqual(
    normalized.map((item) => [item.label, item.detail]),
    [
      ["Loaded workspace", "/tmp/project"],
      ["Response stream", "final answer"],
      ["正在使用工具", "Bash"],
      ["已使用工具", "Bash result"],
    ],
  );
});

test("keeps a terminal response snapshot anchored when later process events exist", () => {
  const session = normalizeAgentSessionForDisplay({
    agentId: "agent_test",
    completedAt: "2026-08-01T00:00:05.000Z",
    createdLabel: "just now",
    deviceId: "dev_test",
    events: [
      event("evt_response", "Response stream", "early text"),
      event("evt_tool_start", "正在使用工具", "Bash"),
      event("evt_tool_done", "已使用工具", "Bash result"),
    ],
    id: "sess_test",
    prompt: "hello",
    provider: "claude",
    response: "final answer",
    status: "completed",
    title: "hello",
    updatedLabel: "completed",
    workspaceId: "ws_test",
  });

  assert.deepEqual(
    session.events.map((item) => [item.label, item.detail]),
    [
      ["Response stream", "final answer"],
      ["正在使用工具", "Bash"],
      ["已使用工具", "Bash result"],
    ],
  );
});

test("synthesizes a terminal response event when only process events were loaded", () => {
  const session = normalizeAgentSessionForDisplay({
    agentId: "agent_test",
    completedAt: "2026-08-01T00:00:05.000Z",
    createdLabel: "just now",
    deviceId: "dev_test",
    events: [event("evt_tool_start", "正在使用工具", "Bash")],
    id: "sess_test",
    prompt: "hello",
    provider: "claude",
    response: "final answer",
    status: "completed",
    title: "hello",
    updatedLabel: "completed",
    workspaceId: "ws_test",
  });

  assert.deepEqual(
    session.events.map((item) => [item.label, item.detail]),
    [
      ["正在使用工具", "Bash"],
      ["Response stream", "final answer"],
    ],
  );
});
