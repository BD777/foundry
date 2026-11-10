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
  await import("../src/features/chat/thread/transcript-projection.ts");
const { sessionTranscriptEntries, subagentTranscriptEntries } =
  await import("../src/features/chat/thread/transcript-adapters.ts");
const { stepUsageSummary, subagentUsageSummary, TurnUsage, turnUsageSummary } =
  await import("../src/components/conversation/turn-usage.tsx");
const { ProcessDisclosure } =
  await import("../src/components/conversation/process-disclosure.tsx");
const { ProcessElapsed } =
  await import("../src/components/conversation/process-elapsed.tsx");
const { i18n } = await import("../src/i18n/index.ts");
const { chatSessionStatus } =
  await import("../src/features/chat/context/chat-context-model.ts");
const { contextLevel, contextSummary } =
  await import("../src/features/chat/context/chat-session-status.tsx");

const request = (
  requestId,
  outputTokens,
  inputTokens = 1000,
  generationMs,
) => ({
  requestId,
  inputTokens,
  cacheReadTokens: 900,
  cacheWriteTokens: 0,
  outputTokens,
  ...(generationMs === undefined ? {} : { generationMs }),
});

test("a process group counts each model request once, at its last report", async () => {
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

test("a process group sums request generation time for its output speed", async () => {
  await i18n.changeLanguage("en");
  const usage = stepUsage([
    {
      id: "a",
      kind: "reasoning",
      requestUsage: request("r1", 40, 1000, 1000),
    },
    {
      id: "b",
      kind: "tool",
      requestUsage: request("r1", 40, 1000, 1000),
    },
    {
      id: "c",
      kind: "tool",
      requestUsage: request("r2", 60, 1000, 1000),
    },
  ]);
  assert.equal(usage.generationMs, 2000);
  assert.equal(
    stepUsageSummary(usage),
    "2K in (90% cached) · 100 out · 50 tok/s",
  );

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(ProcessDisclosure, {
          durationMs: 3000,
          items: [{ title: "Used tool", detail: "Bash" }],
          stepUsage: usage,
          text: "done",
          title: "Processed",
        }),
      ),
    );
    assert.match(container.textContent, /50 tok\/s/);
    await act(async () =>
      root.render(
        createElement(ProcessDisclosure, {
          durationMs: 3000,
          items: [{ title: "Used tool", detail: "Bash" }],
          stepUsage: { ...usage, generationMs: undefined },
          text: "done",
          title: "Processed",
        }),
      ),
    );
    assert.doesNotMatch(container.textContent, /tok\/s/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a process group hides speed when any request lacks generation time", async () => {
  await i18n.changeLanguage("en");
  const usage = stepUsage([
    {
      id: "a",
      kind: "reasoning",
      requestUsage: request("r1", 50, 1000, 1000),
    },
    {
      id: "b",
      kind: "tool",
      requestUsage: request("r2", 50),
    },
  ]);
  assert.equal(usage.generationMs, undefined);
  assert.doesNotMatch(stepUsageSummary(usage), /tok\/s/);
});

test("the turn chip and tooltip show model timing and output speed", async () => {
  await i18n.changeLanguage("en");
  const usage = {
    durationMs: 12_000,
    modelMs: 5000,
    ttftMs: 850,
    inputTokens: 5000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 250,
    modelRequests: 2,
  };
  assert.match(turnUsageSummary(usage), /250 out · 50 tok\/s$/);
  assert.doesNotMatch(
    turnUsageSummary({ ...usage, modelMs: undefined }),
    /tok\/s/,
  );
  assert.doesNotMatch(turnUsageSummary({ ...usage, modelMs: 199 }), /tok\/s/);
  assert.doesNotMatch(
    turnUsageSummary({ ...usage, outputTokens: 19 }),
    /tok\/s/,
  );

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(TurnUsage, { usage })));
    const trigger = container.querySelector("button");
    assert.match(trigger.textContent, /50 tok\/s/);
    await act(async () => trigger.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    const rows = Object.fromEntries(
      [...document.querySelectorAll('[role="dialog"] dt')].map((term) => [
        term.textContent,
        term.nextElementSibling?.textContent,
      ]),
    );
    assert.equal(rows.Duration, "12s");
    assert.equal(rows["Model time"], "5s");
    assert.equal(rows["Tools & other"], "7s");
    assert.equal(rows["Time to first token"], "850ms");
    assert.equal(rows["Output speed"], "50 tok/s");

    await act(async () =>
      root.render(
        createElement(TurnUsage, {
          usage: { ...usage, timingEstimated: true },
        }),
      ),
    );
    const estimatedRows = Object.fromEntries(
      [...document.querySelectorAll('[role="dialog"] dt')].map((term) => [
        term.textContent,
        term.nextElementSibling?.textContent,
      ]),
    );
    assert.equal(estimatedRows["Model time"], "≈5s");
    assert.equal(estimatedRows["Tools & other"], "≈7s");
    assert.equal(estimatedRows["Time to first token"], "≈850ms");
    assert.equal(estimatedRows["Output speed"], "≈50 tok/s");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    document.body.replaceChildren();
  }
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

// Through a relay (AsterGate) a request's steps repeat the prompt its start
// estimated, 1738959 tokens; the request's settled report that follows says
// 301585 (DEV-142 follow-up, real events of one session). Already recorded
// sessions keep both reports.
test("a request's settled report replaces the estimate its steps carry", async () => {
  await i18n.changeLanguage("en");
  const estimated = {
    requestId: "msg_49baf",
    inputTokens: 1738959,
    cacheReadTokens: 0,
    cacheWriteTokens: 1738959,
    outputTokens: 0,
  };
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
    provider: "claude",
    status: "completed",
    events: [
      event("e1", "2026-11-06T01:51:43.847Z", {
        label: "Thought",
        message: {
          id: "think",
          kind: "reasoning",
          text: "plan",
          requestUsage: estimated,
        },
      }),
      event("e2", "2026-11-06T01:51:47.714Z", {
        label: "Using tool",
        message: {
          id: "toolu_1",
          kind: "tool",
          callId: "toolu_1",
          status: "running",
          text: "Bash",
          requestUsage: estimated,
        },
      }),
      event("e3", "2026-11-06T01:51:47.914Z", {
        label: "Model request usage",
        metadata: {
          contextUsage: {
            inputTokens: 301585,
            model: "kiro/claude-opus-5-5",
            configuredWindow: { tokens: 1000000, source: "endpoint" },
          },
        },
      }),
      event("e4", "2026-11-06T01:51:47.952Z", {
        label: "Model request usage",
        detail: "msg_49baf",
        metadata: {
          requestUsage: {
            ...estimated,
            inputTokens: 301585,
            cacheWriteTokens: 301585,
            outputTokens: 691,
          },
        },
      }),
      event("e5", "2026-11-06T01:51:57.248Z", {
        label: "Used tool",
        message: {
          id: "toolu_1",
          kind: "tool",
          callId: "toolu_1",
          status: "completed",
          text: "Bash\n\nok",
        },
      }),
    ],
    // The panel the server derives from these events (store.DeriveSessionPanel):
    // the newest context report, the window an earlier report named.
    panel: { usage: { usedTokens: 301585, contextWindow: 1000000 } },
  };
  const groups = projectTranscript(sessionTranscriptEntries(session)).filter(
    (message) => message.stepUsage,
  );
  assert.deepEqual(
    groups.map((group) => group.stepUsage),
    [
      {
        requests: 1,
        inputTokens: 301585,
        cacheReadTokens: 0,
        outputTokens: 691,
      },
    ],
  );
  const { context } = chatSessionStatus(session);
  assert.equal(contextLevel(context), "normal", "no Context full alert");
  assert.equal(contextSummary(context), "301.6K / 1M · 30%");
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
