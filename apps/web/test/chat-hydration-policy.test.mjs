import assert from "node:assert/strict";
import test from "node:test";
import {
  chatDetailHydrationId,
  sessionThreadHydrationId,
  sessionThreadHydrationRevision,
  subagentDiscoveryRevision,
  subagentDiscoverySessionIds,
} from "../src/features/chat/chat-hydration-policy.ts";

test("hydrates a selected archived chat exactly once", () => {
  const selectedSummary = { id: "chat-1" };
  assert.equal(
    chatDetailHydrationId({ selectedSummary, threadSelected: false }),
    "chat-1",
  );
  assert.equal(
    chatDetailHydrationId({
      hydratedChatId: "chat-1",
      selectedSummary,
      threadSelected: false,
    }),
    undefined,
  );
});

test("skips hydration without a selection or when the transcript is present", () => {
  assert.equal(chatDetailHydrationId({ threadSelected: false }), undefined);
  assert.equal(
    chatDetailHydrationId({
      selectedSummary: { id: "chat-1" },
      threadSelected: true,
    }),
    undefined,
  );
  assert.equal(
    chatDetailHydrationId({
      selectedSummary: { handoffContext: "issue-1", id: "chat-1" },
      threadSelected: false,
    }),
    undefined,
  );
});

test("re-hydrates when the selection moves to another chat", () => {
  assert.equal(
    chatDetailHydrationId({
      hydratedChatId: "chat-1",
      selectedSummary: { id: "chat-2" },
      threadSelected: false,
    }),
    "chat-2",
  );
});

test("discovers subagents only for runtimes that report them", () => {
  assert.deepEqual(
    subagentDiscoverySessionIds([
      { id: "session-1", provider: "claude", status: "running" },
      { id: "session-2", provider: "codex" },
      {
        events: [
          {
            id: "task-1",
            label: "子任务完成",
            metadata: { taskId: "task-1" },
          },
        ],
        id: "session-3",
        provider: "claude",
        status: "completed",
      },
      { id: "session-4", provider: "claude", status: "completed" },
    ]),
    ["session-1", "session-3"],
  );
  assert.deepEqual(subagentDiscoverySessionIds([]), []);
});

test("subagent discovery revision ignores ordinary response snapshots", () => {
  const base = {
    id: "session-1",
    provider: "claude",
    status: "running",
  };
  const first = subagentDiscoveryRevision([
    {
      ...base,
      events: [{ id: "response-1", label: "Response stream" }],
    },
  ]);
  const second = subagentDiscoveryRevision([
    {
      ...base,
      events: [{ id: "response-1", label: "Response stream" }],
    },
  ]);
  const task = subagentDiscoveryRevision([
    {
      ...base,
      events: [
        { id: "response-2", label: "Response stream" },
        {
          id: "task-1",
          label: "正在启动子任务",
          metadata: { taskId: "task-1" },
        },
      ],
    },
  ]);

  assert.equal(first, second);
  assert.notEqual(first, task);
});

test("hydrates a selected live chat once per whole thread", () => {
  assert.equal(
    sessionThreadHydrationId("thread-1", ["session-1", "session-2"]),
    "thread-1",
  );
  assert.equal(sessionThreadHydrationId("thread-1", []), undefined);
  assert.equal(sessionThreadHydrationId(undefined, ["session-1"]), undefined);
});

test("transcript hydration revision advances when persisted activity advances", () => {
  const first = sessionThreadHydrationRevision("thread-1", [
    {
      events: [{ at: "2026-09-03T00:00:00Z", id: "event-1" }],
      id: "session-1",
      lastActivityAt: "2026-09-03T00:00:00Z",
    },
  ]);
  const next = sessionThreadHydrationRevision("thread-1", [
    {
      events: [{ at: "2026-09-03T00:00:00Z", id: "event-1" }],
      id: "session-1",
      lastActivityAt: "2026-09-03T00:01:00Z",
    },
  ]);
  assert.notEqual(first, next);
  assert.equal(sessionThreadHydrationRevision("thread-1", []), undefined);
});
