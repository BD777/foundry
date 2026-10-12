import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
register("./bundler-resolve.mjs", import.meta.url);

const { chatContextCardForSessions, chatSessionStatus } =
  await import("../src/features/chat/chat-context-model.ts");
const { appendAgentEvents } = await import("../src/lib/agent-event-log.ts");

function event(id, minute, label, metadata) {
  return {
    at: `2026-10-11T08:${String(minute).padStart(2, "0")}:00.000Z`,
    detail: "",
    id,
    label,
    level: "info",
    metadata,
    sessionId: "sess_status",
  };
}

const context = (id, minute, inputTokens, extra = {}) =>
  event(id, minute, "Model request usage", {
    contextUsage: { inputTokens, model: "claude-opus-5-5", ...extra },
  });

const turn = (id, minute, usage) =>
  event(id, minute, "Claude Agent SDK finished", {
    turnUsage: {
      durationMs: 65_000,
      inputTokens: 1000,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
      outputTokens: 50,
      ...usage,
    },
  });

function session(events, extra = {}) {
  return {
    agentId: "agent_status",
    claudeEffort: "high",
    claudePermissionMode: "bypassPermissions",
    createdLabel: "now",
    deviceId: "dev_status",
    events,
    id: "sess_status",
    nativeSessionId: "0f6c2a1e-native",
    profileLabel: "Claude · Device account",
    prompt: "hello",
    provider: "claude",
    status: "completed",
    title: "hello",
    updatedLabel: "now",
    workspaceId: "ws_status",
    ...extra,
  };
}

test("the status reads the newest context report against its model's window", () => {
  const status = chatSessionStatus(
    session([
      context("evt_c1", 1, 40_000, { contextWindow: 1_000_000 }),
      turn("evt_t1", 2, { costUsd: 0.25 }),
      // Reported before this process learned the window: the earlier one holds.
      context("evt_c2", 3, 182_000),
      turn("evt_t2", 4, { durationMs: 5_000 }),
    ]),
    { id: "ws_status", deviceLabel: "sg-chaos" },
  );
  assert.deepEqual(status.context, {
    usedTokens: 182_000,
    contextWindow: 1_000_000,
  });
  assert.equal(status.model, "claude-opus-5-5");
  assert.equal(status.deviceLabel, "sg-chaos");
  assert.equal(status.turns, 2);
  assert.equal(status.lastTurnDurationMs, 5_000);
  assert.deepEqual(status.totals, {
    inputTokens: 2000,
    cacheReadTokens: 1600,
    cacheWriteTokens: 200,
    outputTokens: 100,
    costUsd: 0.25,
    costTurns: 1,
  });
  assert.equal(status.compactions, 0);
});

test("compactions count, and a compaction without a size leaves the context unknown", () => {
  const status = chatSessionStatus(
    session([
      context("evt_c1", 1, 950_000, { contextWindow: 1_000_000 }),
      event("evt_compact", 2, "Model request usage", {
        contextUsage: {
          contextWindow: 1_000_000,
          compaction: { trigger: "auto", preTokens: 950_000 },
        },
      }),
    ]),
  );
  assert.equal(status.compactions, 1);
  assert.deepEqual(status.context, { contextWindow: 1_000_000 });
});

test("an older worker's request usage gives the size without a window", () => {
  const status = chatSessionStatus(
    session(
      [
        event("evt_r1", 1, "Model request usage", {
          requestUsage: {
            requestId: "msg_1",
            inputTokens: 52_000,
            cacheReadTokens: 50_000,
            cacheWriteTokens: 0,
            outputTokens: 10,
          },
        }),
      ],
      { provider: "codex", claudeEffort: undefined, model: "gpt-5.5" },
    ),
  );
  assert.deepEqual(status.context, { usedTokens: 52_000 });
  assert.equal(status.model, "gpt-5.5");
  assert.equal(status.turns, 0);
});

test("the status does not depend on which events are loaded, and follows live events", () => {
  // The window holds the newest events; the rest arrive as state events.
  const stateEvents = [
    turn("evt_t1", 1, { costUsd: 0.5 }),
    turn("evt_t2", 2, { costUsd: 0.25 }),
    context("evt_c2", 3, 300_000, { contextWindow: 1_000_000 }),
  ];
  const loaded = [event("evt_answer", 9, "Response stream")];
  const card = chatContextCardForSessions([
    { ...session(loaded), stateEvents, eventsBefore: "cursor" },
  ]);
  assert.equal(card?.status?.turns, 2);
  assert.equal(card?.status?.totals.costUsd, 0.75);
  assert.deepEqual(card?.status?.context, {
    usedTokens: 300_000,
    contextWindow: 1_000_000,
  });

  const live = appendAgentEvents(loaded, [
    context("evt_c3", 10, 450_000, { contextWindow: 1_000_000 }),
  ]);
  const updated = chatContextCardForSessions([
    { ...session(live), stateEvents, eventsBefore: "cursor" },
  ]);
  assert.equal(updated?.status?.context.usedTokens, 450_000);
  assert.equal(updated?.status?.turns, 2);
});

/** Renders into a happy-dom document; `body` runs with the container. */
async function withDom(render, body) {
  const window = new Window();
  const previous = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of [
    "Node",
    "Element",
    "HTMLElement",
    "HTMLButtonElement",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
  ])
    globals[key] = window[key];
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  try {
    const { createRoot } = await import("react-dom/client");
    const { i18n } = await import("../src/i18n/index.ts");
    await i18n.changeLanguage("en");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(await render()));
    await body(container, root);
    await act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    await window.happyDOM.close();
  }
}

const emptyCard = {
  changes: [],
  files: [],
  previews: [],
  sources: [],
  timers: [],
  subagents: [],
  background: [],
};

function statusOf(events, extra) {
  return chatSessionStatus(session(events, extra), {
    id: "ws_status",
    deviceLabel: "sg-chaos",
  });
}

test("the card's first line shows the context; the rest folds, remembered per chat", async () => {
  const { ChatContextCard } =
    await import("../src/features/chat/chat-context-card.tsx");
  const status = statusOf([
    context("evt_c1", 1, 182_000, { contextWindow: 1_000_000 }),
    turn("evt_t1", 2, { costUsd: 0.25 }),
    turn("evt_t2", 3, {}),
  ]);
  const card = (chatKey) =>
    createElement(ChatContextCard, {
      chatKey,
      data: { ...emptyCard, status },
    });
  await withDom(
    () => card("chat-status-a"),
    async (container, root) => {
      const line = () => container.querySelector(".fdy-chat-status");
      const toggle = () => line().querySelector(".fdy-chat-status-toggle");
      // It is the card's first section.
      assert.equal(
        container.querySelector(".fdy-chat-context-section"),
        line(),
      );
      assert.equal(toggle().textContent, "Context182K / 1M · 18%");
      assert.equal(line().dataset.level, "normal");
      const meter = line().querySelector("progress");
      assert.equal(meter.getAttribute("max"), "1000000");
      assert.equal(meter.getAttribute("value"), "182000");
      assert.equal(line().querySelector(".fdy-chat-status-warning"), null);
      // Closed by default.
      assert.equal(toggle().getAttribute("aria-expanded"), "false");
      assert.equal(line().querySelector("dl"), null);

      await act(async () => toggle().click());
      assert.equal(toggle().getAttribute("aria-expanded"), "true");
      const details = document.getElementById(
        toggle().getAttribute("aria-controls"),
      );
      const rows = Object.fromEntries(
        [...details.querySelectorAll("div")].map((row) => [
          row.querySelector("dt").textContent,
          row.querySelector("dd").textContent,
        ]),
      );
      assert.deepEqual(rows, {
        Model: "claude-opus-5-5 · High",
        Account: "Claude · Device account",
        Device: "sg-chaos",
        Permissions: "Full access",
        Turns: "2 · last took 1m 5s",
        Tokens: "2K in · 100 out",
        Cache: "1.6K read · 200 written",
        Cost: "$0.25 (1 of 2 turns)",
        Session: "sess_status",
        Native: "0f6c2a1e-native",
      });
      assert.equal(details.querySelectorAll(".fdy-chat-status-copy").length, 2);

      // Another chat starts folded; coming back finds this one open.
      await act(async () => root.render(card("chat-status-b")));
      assert.equal(toggle().getAttribute("aria-expanded"), "false");
      await act(async () => root.render(card("chat-status-a")));
      assert.equal(toggle().getAttribute("aria-expanded"), "true");
    },
  );
});

test("a context near or at its window says so in words, not color alone", async () => {
  const { ChatContextCard } =
    await import("../src/features/chat/chat-context-card.tsx");
  for (const [used, level, words] of [
    [850_000, "high", "Context nearly full"],
    [990_000, "full", "Context full"],
  ]) {
    await withDom(
      () =>
        createElement(ChatContextCard, {
          data: {
            ...emptyCard,
            status: statusOf([
              context("evt_c", 1, used, { contextWindow: 1_000_000 }),
            ]),
          },
        }),
      async (container) => {
        const line = container.querySelector(".fdy-chat-status");
        assert.equal(line.dataset.level, level);
        assert.ok(
          line
            .querySelector(".fdy-chat-status-warning")
            .textContent.startsWith(words),
        );
      },
    );
  }
});

test("without reports the line reads unknown, with no meter", async () => {
  const { ChatContextCard } =
    await import("../src/features/chat/chat-context-card.tsx");
  await withDom(
    () =>
      createElement(ChatContextCard, {
        data: { ...emptyCard, status: statusOf([]) },
      }),
    async (container) => {
      const line = container.querySelector(".fdy-chat-status");
      assert.equal(line.dataset.level, "unknown");
      assert.equal(
        line.querySelector(".fdy-chat-status-value").textContent,
        "— / —",
      );
      assert.equal(line.querySelector("progress"), null);
    },
  );
});

test("a verifier's permissions read as its read-only sandbox, not full access", async () => {
  const { statusRows } =
    await import("../src/features/chat/chat-session-status.tsx");
  const permissions = (status) =>
    statusRows(status).find((row) => row.id === "permissions")?.value;
  const record = {
    provider: "codex",
    codexSandboxMode: "danger-full-access",
    codexApprovalPolicy: "never",
  };
  const verifier = chatSessionStatus(
    session([], { ...record, source: "verification" }),
    { id: "ws_status" },
  );
  assert.equal(verifier.verification, true);
  assert.equal(permissions(verifier), "Read-only verification sandbox");
  const claudeVerifier = chatSessionStatus(
    session([], { claudePermissionMode: "dontAsk", source: "verification" }),
    { id: "ws_status" },
  );
  assert.equal(permissions(claudeVerifier), "Read-only verification sandbox");
  const chat = chatSessionStatus(session([], record), { id: "ws_status" });
  assert.equal(chat.verification, undefined);
  assert.match(permissions(chat), /^Full access/);
});
