import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);

const { applyAnsweredEvent } =
  await import("../src/app/loaded-foundry-data.ts");
const { applyFoundryStreamEvent, mergeLoadedFoundryData } =
  await import("../src/app/foundry-data-projection.ts");
const { createStreamTouchLedger } =
  await import("../src/app/stream-touches.ts");
const { resolveLoadedChatSelection } =
  await import("../src/app/chat-selection.ts");

const session = (id, overrides = {}) => ({
  id,
  workspaceId: "ws",
  agentId: "agent",
  provider: "claude",
  prompt: "",
  title: id,
  createdLabel: "",
  updatedLabel: "",
  status: "queued",
  threadId: id,
  ...overrides,
});

const shown = (agentSessions = [session("old", { status: "completed" })]) => ({
  workspace: { id: "ws", name: "ws" },
  workspaces: [],
  devices: [],
  providerHealth: [],
  agentProfiles: [],
  profiles: [],
  deviceProfiles: [],
  deviceSkillRoots: [],
  promotedSkills: [],
  workspaceSkillBindings: [],
  agents: [],
  workspaceFiles: [],
  agentSessions,
  skills: [],
  issues: [],
  chats: [],
  assets: [],
});

/** The app's data as setData leaves it. */
function app(data) {
  const touches = createStreamTouchLedger();
  const state = { data };
  return {
    touches,
    state,
    setData: (update) => {
      state.data = typeof update === "function" ? update(state.data) : update;
    },
  };
}

test("a sent message's session shows from the answer: no read, and a read that started before keeps it", () => {
  const view = app(shown());
  const readStartedAt = Date.now() - 50;
  // POST /api/agent-sessions answered the new session.
  applyAnsweredEvent(view, {
    type: "agent_session_created",
    payload: session("new"),
  });
  assert.deepEqual(
    view.state.data.agentSessions.map((item) => item.id),
    ["new", "old"],
    "shown at once",
  );

  // A whole read that started before the send lands now.
  const stale = shown();
  const merged = mergeLoadedFoundryData(
    view.state.data,
    stale,
    view.touches.since(view.touches.markAt(readStartedAt)),
  );
  assert.deepEqual(
    merged.agentSessions.map((item) => item.id),
    ["new", "old"],
    "the read does not undo it",
  );
  // The selection made for it survives against what the read shows.
  assert.equal(
    resolveLoadedChatSelection(
      {
        chats: merged.chats,
        chatSessions: merged.agentSessions,
        chatThreads: merged.agentSessions,
        preferredChatId: "",
      },
      "new",
    ),
    "new",
  );

  // The stream's own event for it arrives: one session, now running.
  const streamed = applyFoundryStreamEvent(view.state.data, {
    type: "agent_session_started",
    payload: session("new", { status: "running" }),
  });
  assert.deepEqual(
    streamed.agentSessions.map((item) => [item.id, item.status]),
    [
      ["new", "running"],
      ["old", "completed"],
    ],
  );
});

test("a created Issue shows from the answer, as its event would show it", () => {
  const view = app(shown());
  const issue = {
    id: "iss_1",
    workspaceId: "ws",
    title: "Fix",
    status: "pending",
    runtime: "claude",
    sourceInput: "Fix",
  };
  applyAnsweredEvent(view, { type: "issue_created", payload: issue });
  assert.deepEqual(
    view.state.data.issues.map((item) => item.id),
    ["iss_1"],
  );
  // foundry_data_changed[issues] then reads only the issues.
  const later = mergeLoadedFoundryData(
    view.state.data,
    { workspace: { id: "ws" }, issues: [{ ...issue, status: "in_progress" }] },
    view.touches.since(view.touches.markAt(Date.now() + 1)),
    ["issues"],
  );
  assert.equal(later.issues[0].status, "in_progress");
  assert.equal(later.agentSessions, view.state.data.agentSessions);
});
