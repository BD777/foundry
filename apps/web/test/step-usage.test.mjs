import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { mock } from "node:test";

register("./bundler-resolve.mjs", import.meta.url);

const window = new Window();
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "MutationObserver",
  "ResizeObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "NodeFilter",
  "DOMRect",
])
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value:
      key === "window" || key === "document" || key === "navigator"
        ? window[key]
        : window[key],
  });
Object.defineProperty(globalThis, "getComputedStyle", {
  configurable: true,
  value: window.getComputedStyle.bind(window),
});
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: window.requestAnimationFrame.bind(window),
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: window.cancelAnimationFrame.bind(window),
});
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

const { createRoot } = await import("react-dom/client");
const { projectTranscript, stepUsage } =
  await import("../src/features/chat/transcript-projection.ts");
const { sessionTranscriptEntries, subagentTranscriptEntries } =
  await import("../src/features/chat/transcript-adapters.ts");
const { stepUsageSummary, subagentUsageSummary, turnUsageSummary } =
  await import("../src/components/conversation/turn-usage.tsx");
const { ProcessElapsed } =
  await import("../src/components/conversation/process-elapsed.tsx");
const { i18n } = await import("../src/i18n/index.ts");

const request = (requestId, outputTokens, inputTokens = 1000) => ({
  requestId,
  inputTokens,
  cacheReadTokens: 900,
  cacheWriteTokens: 0,
  outputTokens,
});

test("a process group counts each model request once, at its largest report", async () => {
  await i18n.changeLanguage("en");
  const [group, answer] = projectTranscript([
    {
      id: "a",
      at: "2026-10-09T10:00:00Z",
      kind: "reasoning",
      text: "think",
      requestUsage: request("r1", 10),
    },
    {
      id: "b",
      at: "2026-10-09T10:00:02Z",
      kind: "tool",
      text: "ls",
      requestUsage: request("r1", 40),
    },
    {
      id: "c",
      at: "2026-10-09T10:00:05Z",
      kind: "tool",
      text: "cat",
      requestUsage: request("r2", 5, 2000),
    },
    { id: "d", at: "2026-10-09T10:00:06Z", kind: "assistant", text: "done" },
  ]);
  assert.equal(group.kind, "process");
  assert.equal(group.startedAt, "2026-10-09T10:00:00Z");
  assert.deepEqual(group.stepUsage, {
    requests: 2,
    inputTokens: 3000,
    cacheReadTokens: 1800,
    outputTokens: 45,
  });
  assert.equal(
    stepUsageSummary(group.stepUsage),
    "3K in (60% cached) · 45 out",
  );
  assert.equal(answer.stepUsage, undefined);
  // Codex steps carry no request usage: the group shows its duration only.
  assert.equal(stepUsage([{ id: "x", kind: "tool", text: "ls" }]), undefined);
});

test("subagent steps keep their request usage and the subagent its total", async () => {
  await i18n.changeLanguage("en");
  const entries = subagentTranscriptEntries({
    messages: [
      {
        id: "m",
        role: "tool",
        kind: "tool",
        content: "ls",
        requestUsage: request("r9", 7),
      },
    ],
    sessionId: "s",
    status: "completed",
    taskId: "t",
    title: "Explore",
    toolUseId: "tu",
  });
  assert.equal(entries[0].requestUsage.requestId, "r9");
  assert.equal(
    subagentUsageSummary({
      totalTokens: 12345,
      toolUses: 3,
      durationMs: 61_000,
    }),
    "12.3K tokens · 3 tool calls · 1m 1s",
  );
});

test("a running group's timer ticks every second from its first step", async () => {
  await i18n.changeLanguage("en");
  mock.timers.enable({
    apis: ["setInterval", "Date"],
    now: Date.parse("2026-10-09T10:00:05Z"),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(ProcessElapsed, { startedAt: "2026-10-09T10:00:00Z" }),
      ),
    );
    assert.equal(container.textContent, "5s");
    await act(async () => mock.timers.tick(2000));
    assert.equal(container.textContent, "7s");
    await act(async () => root.unmount());
    // Unmounted: its interval is gone, so ticking further does nothing.
    mock.timers.tick(5000);
  } finally {
    mock.timers.reset();
    container.remove();
  }
});

// Through a relay a step carries no tokens; the request's real tokens arrive
// in a hidden event when its stream ends.
test("a request's final tokens reach its steps and the event itself is not shown", async () => {
  await i18n.changeLanguage("en");
  const event = (id, at, fields) => ({
    id,
    sessionId: "s",
    at,
    level: "info",
    label: "",
    detail: "",
    ...fields,
  });
  const session = {
    id: "s",
    events: [
      event("e1", "2026-10-09T10:00:00Z", {
        label: "Used tool",
        message: {
          id: "toolu_1",
          kind: "tool",
          text: "ls",
          status: "completed",
        },
      }),
      event("e2", "2026-10-09T10:00:03Z", {
        label: "Model request usage",
        detail: "msg_1",
        metadata: { requestUsage: request("msg_1", 87, 3212) },
      }),
      event("e3", "2026-10-09T10:00:04Z", {
        label: "Used tool",
        message: {
          id: "toolu_2",
          kind: "tool",
          text: "cat",
          status: "completed",
        },
      }),
      event("e4", "2026-10-09T10:00:05Z", {
        message: { id: "a", kind: "assistant", text: "done" },
      }),
    ],
  };
  const entries = sessionTranscriptEntries(session);
  assert.equal(entries.length, 3, "no entry for the usage event");
  const [group] = projectTranscript(entries);
  assert.equal(group.kind, "process");
  assert.deepEqual(group.stepUsage, {
    requests: 1,
    inputTokens: 3212,
    cacheReadTokens: 900,
    outputTokens: 87,
  });
});

test("reports of only zeros show no token counts", () => {
  const zero = { ...request("r0", 0, 0), cacheReadTokens: 0 };
  assert.equal(
    stepUsage([{ id: "x", kind: "tool", text: "ls", requestUsage: zero }]),
    undefined,
    "the group shows its duration only",
  );
  assert.equal(
    turnUsageSummary({
      durationMs: 15000,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    }),
    "15s",
  );
  assert.equal(
    subagentUsageSummary({ totalTokens: 0, toolUses: 2, durationMs: 0 }),
    "2 tool calls",
  );
});
