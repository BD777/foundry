import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// Registered before the dynamic import so the resolver covers the whole graph.
register("./bundler-resolve.mjs", import.meta.url);
const {
  applyFoundryStreamEvent,
  compactFoundryStreamEvents,
  mergeLoadedFoundryData,
} = await import("../src/app/foundry-data-projection.ts");

function session(id, overrides = {}) {
  return {
    id,
    agentId: "agent_1",
    createdLabel: "just now",
    prompt: "do the thing",
    runtime: "claude",
    status: "running",
    title: `Session ${id}`,
    updatedLabel: "just now",
    workspaceId: "ws_1",
    ...overrides,
  };
}

function event(id, sessionId, label, detail) {
  return {
    at: "2026-08-01T00:00:00.000Z",
    detail,
    id,
    label,
    level: "info",
    sessionId,
  };
}

function data(workspaceId, agentSessions) {
  return {
    agentSessions,
    assets: [],
    chats: [],
    devices: [],
    issues: [],
    runs: [],
    providerHealth: [],
    skills: [],
    workspace: { id: workspaceId, name: workspaceId },
    workspaces: [],
  };
}

test("keeps streamed events and response when a list refresh omits them", () => {
  const streamed = session("sess_1", {
    events: [event("evt_1", "sess_1", "Response stream", "partial answer")],
    response: "partial answer",
  });
  const current = data("ws_1", [streamed]);
  const loaded = data("ws_1", [session("sess_1", { status: "completed" })]);

  const merged = mergeLoadedFoundryData(current, loaded);

  assert.equal(merged.agentSessions.length, 1);
  const [next] = merged.agentSessions;
  assert.equal(next.status, "completed", "loaded status must win");
  assert.equal(next.response, "partial answer");
  assert.deepEqual(
    next.events.map((item) => item.detail),
    ["partial answer"],
    "streamed transcript must survive the refresh",
  );
});

test("an identical loaded object is a projection no-op", () => {
  const current = data("ws_1", [session("sess_1")]);
  assert.equal(mergeLoadedFoundryData(current, current), current);
});

test("compacts only consecutive response snapshots for the same session", () => {
  const response = (id, sessionId, detail) => ({
    type: "agent_session_event",
    payload: event(id, sessionId, "Response stream", detail),
  });
  const tool = {
    type: "agent_session_event",
    payload: event("evt_tool", "sess_1", "Tool use", "read file"),
  };
  const compacted = compactFoundryStreamEvents([
    response("evt_1", "sess_1", "a"),
    response("evt_1", "sess_1", "ab"),
    response("evt_2", "sess_2", "other"),
    tool,
    response("evt_1", "sess_1", "abc"),
  ]);

  assert.deepEqual(
    compacted.map((item) => item.payload.detail),
    ["ab", "other", "read file", "abc"],
  );
});

test("a refresh for another workspace replaces the projection wholesale", () => {
  const current = data("ws_1", [
    session("sess_1", {
      events: [event("evt_1", "sess_1", "Response stream", "old workspace")],
    }),
  ]);
  const loaded = data("ws_2", [session("sess_2", { workspaceId: "ws_2" })]);

  const merged = mergeLoadedFoundryData(current, loaded);

  assert.equal(merged, loaded, "no cross-workspace merging may happen");
  assert.deepEqual(
    merged.agentSessions.map((item) => item.id),
    ["sess_2"],
  );
});

test("a refresh drops sessions the server no longer returns", () => {
  const current = data("ws_1", [session("sess_1"), session("sess_2")]);
  const loaded = data("ws_1", [session("sess_2")]);

  assert.deepEqual(
    mergeLoadedFoundryData(current, loaded).agentSessions.map(
      (item) => item.id,
    ),
    ["sess_2"],
  );
});

test("a created session for the active workspace is prepended", () => {
  const current = data("ws_1", [session("sess_1")]);

  const next = applyFoundryStreamEvent(current, {
    type: "agent_session_created",
    payload: session("sess_2", { status: "queued" }),
  });

  assert.deepEqual(
    next.agentSessions.map((item) => item.id),
    ["sess_2", "sess_1"],
  );
});

test("a session event for a foreign workspace is ignored", () => {
  const current = data("ws_1", [session("sess_1")]);

  const next = applyFoundryStreamEvent(current, {
    type: "agent_session_created",
    payload: session("sess_9", { workspaceId: "ws_2" }),
  });

  assert.equal(next, current, "mismatched workspace must not mutate state");
});

test("a session snapshot update preserves richer streamed detail", () => {
  const current = data("ws_1", [
    session("sess_1", {
      events: [event("evt_1", "sess_1", "Response stream", "streamed text")],
      response: "streamed text",
    }),
  ]);

  const next = applyFoundryStreamEvent(current, {
    type: "agent_session_completed",
    payload: session("sess_1", { status: "completed" }),
  });

  const [updated] = next.agentSessions;
  assert.equal(updated.status, "completed");
  assert.equal(updated.response, "streamed text");
  assert.deepEqual(
    updated.events.map((item) => item.detail),
    ["streamed text"],
  );
});

test("an event for an unknown session leaves the projection untouched", () => {
  const current = data("ws_1", [session("sess_1", { events: [] })]);

  const next = applyFoundryStreamEvent(current, {
    type: "agent_session_event",
    payload: event("evt_1", "sess_missing", "Response stream", "orphan"),
  });

  assert.equal(next, current);
});

test("an event promotes a queued session to running", () => {
  const current = data("ws_1", [
    session("sess_1", { events: [], status: "queued", updatedLabel: "queued" }),
  ]);

  const next = applyFoundryStreamEvent(current, {
    type: "agent_session_event",
    payload: event("evt_1", "sess_1", "Response stream", "first token"),
  });

  const [updated] = next.agentSessions;
  assert.equal(updated.status, "running");
  assert.equal(updated.updatedLabel, "running");
  assert.deepEqual(
    updated.events.map((item) => item.detail),
    ["first token"],
  );
  assert.notEqual(next, current, "a real change must produce a new object");
});

test("a terminal session keeps its label when a late event arrives", () => {
  const current = data("ws_1", [
    session("sess_1", {
      events: [],
      status: "completed",
      updatedLabel: "2m ago",
    }),
  ]);

  const [updated] = applyFoundryStreamEvent(current, {
    type: "agent_session_event",
    payload: event("evt_1", "sess_1", "Tool use", "late tail"),
  }).agentSessions;

  assert.equal(updated.status, "completed");
  assert.equal(updated.updatedLabel, "2m ago");
});

test("sequential events accumulate in arrival order", () => {
  let current = data("ws_1", [session("sess_1", { events: [] })]);

  for (const [index, detail] of ["one", "two", "three"].entries()) {
    current = applyFoundryStreamEvent(current, {
      type: "agent_session_event",
      payload: event(`evt_${index}`, "sess_1", "Tool use", detail),
    });
  }

  assert.deepEqual(
    current.agentSessions[0].events.map((item) => item.detail),
    ["one", "two", "three"],
  );
});

test("streamed state survives a following list refresh", () => {
  const streamed = applyFoundryStreamEvent(
    data("ws_1", [session("sess_1", { events: [], status: "queued" })]),
    {
      type: "agent_session_event",
      payload: event("evt_1", "sess_1", "Response stream", "hello"),
    },
  );

  const merged = mergeLoadedFoundryData(
    streamed,
    data("ws_1", [session("sess_1", { status: "running" })]),
  );

  assert.deepEqual(
    merged.agentSessions[0].events.map((item) => item.detail),
    ["hello"],
  );
});

test("an event the workspace data does not follow changes nothing", () => {
  const current = data("ws_1", [session("sess_1")]);
  // Their features follow them; none falls through to the session list,
  // even with a payload shaped like a session of this workspace.
  for (const type of [
    "evidence_updated",
    "feishu_bot_updated",
    "workspace_members_updated",
    "chat_queue_changed",
    "agent_subagent_updated",
    "chat_titles_changed",
    "chat_layout_changed",
    "foundry_data_changed",
    "not_a_client_event",
  ])
    assert.equal(
      applyFoundryStreamEvent(current, {
        type,
        payload: session("sess_2"),
      }),
      current,
      type,
    );
});

test("a switch reads what differs between workspaces and keeps the rest as shown", async () => {
  const { workspaceSwitchFields } = await import("../src/api.ts");
  const shown = {
    ...data("ws_1", [session("s1")]),
    devices: [{ id: "dev", label: "Studio", status: "connected" }],
    workspaces: [{ id: "ws_1" }, { id: "ws_2" }],
    chats: [{ id: "chat_1" }],
  };
  const answer = {
    workspace: { id: "ws_2", name: "Other" },
    agentSessions: [session("s2", { workspaceId: "ws_2" })],
    chats: [],
    issues: [],
  };
  const switched = mergeLoadedFoundryData(
    shown,
    answer,
    undefined,
    workspaceSwitchFields,
  );
  assert.equal(switched.workspace.id, "ws_2");
  assert.deepEqual(
    switched.agentSessions.map((item) => item.id),
    ["s2"],
  );
  assert.deepEqual(switched.chats, []);
  assert.equal(switched.devices, shown.devices, "devices stay as shown");
  assert.equal(switched.workspaces, shown.workspaces);
  // Any other selection of another workspace changes nothing.
  assert.equal(
    mergeLoadedFoundryData(shown, answer, undefined, ["chats"]),
    shown,
  );
});
