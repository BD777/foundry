import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
register("./bundler-resolve.mjs", import.meta.url);

const { chatSessionStatus } =
  await import("../src/features/chat/context/chat-context-model.ts");
const { withPanel } = await import("./fixtures/session-panel.mjs");

// The server folds context reports and turn usage into the panel's usage
// (apps/server/internal/store/session_panel_test.go); the status line
// shows it.

/** Usage as the panel reports it: two turns, one with a known cost. */
const twoTurns = {
  model: "claude-opus-5-5",
  usedTokens: 182_000,
  contextWindow: 1_000_000,
  turns: 2,
  totals: {
    inputTokens: 2000,
    cacheReadTokens: 1600,
    cacheWriteTokens: 200,
    outputTokens: 100,
    costUsd: 0.25,
    costTurns: 1,
  },
  lastTurnDurationMs: 65_000,
};

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

test("the status shows the panel's context and usage", () => {
  const status = chatSessionStatus(
    withPanel(session([]), {
      usage: { ...twoTurns, lastTurnDurationMs: 5_000 },
    }),
    { id: "ws_status", deviceLabel: "dev-server" },
  );
  assert.deepEqual(status.context, {
    usedTokens: 182_000,
    contextWindow: 1_000_000,
  });
  assert.equal(status.model, "claude-opus-5-5");
  assert.equal(status.effort, "high");
  assert.equal(status.deviceLabel, "dev-server");
  assert.equal(status.turns, 2);
  assert.equal(status.lastTurnDurationMs, 5_000);
  assert.deepEqual(status.totals, twoTurns.totals);
  assert.equal(status.compactions, 0);
  // Another workspace's device is not this session's.
  assert.equal(
    chatSessionStatus(withPanel(session([])), {
      id: "ws_other",
      deviceLabel: "dev-server",
    }).deviceLabel,
    undefined,
  );
});

test("a size without a window, and the session's model when no report names one", () => {
  const status = chatSessionStatus(
    withPanel(
      session([], {
        provider: "codex",
        claudeEffort: undefined,
        codexReasoningEffort: "medium",
        model: "gpt-5.5",
      }),
      { usage: { usedTokens: 52_000 } },
    ),
  );
  assert.deepEqual(status.context, { usedTokens: 52_000 });
  assert.equal(status.model, "gpt-5.5");
  assert.equal(status.effort, "medium");
  assert.equal(status.turns, 0);
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

/** The status of a session whose panel reports `usage` (none: no panel). */
function statusOf(usage, extra) {
  const item = session([], extra);
  return chatSessionStatus(usage ? withPanel(item, { usage }) : item, {
    id: "ws_status",
    deviceLabel: "dev-server",
  });
}

test("the card's first line shows the context; the rest folds, remembered per chat", async () => {
  const { ChatContextCard } =
    await import("../src/features/chat/context/chat-context-card.tsx");
  const status = statusOf(twoTurns);
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
        Device: "dev-server",
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
    await import("../src/features/chat/context/chat-context-card.tsx");
  for (const [used, level, words] of [
    [850_000, "high", "Context nearly full"],
    [990_000, "full", "Context full"],
  ]) {
    await withDom(
      () =>
        createElement(ChatContextCard, {
          data: {
            ...emptyCard,
            status: statusOf({ usedTokens: used, contextWindow: 1_000_000 }),
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
    await import("../src/features/chat/context/chat-context-card.tsx");
  await withDom(
    () =>
      createElement(ChatContextCard, {
        data: { ...emptyCard, status: statusOf() },
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
    await import("../src/features/chat/context/chat-session-status.tsx");
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

test("a window Foundry set shows with its source, and the runtime's own when it differs", async () => {
  const { statusRows } =
    await import("../src/features/chat/context/chat-session-status.tsx");
  const windowRow = (status) =>
    statusRows(status).find((row) => row.id === "window")?.value;
  const endpoint = { tokens: 1_000_000, source: "endpoint" };
  // Before the runtime names a window, the configured one stands in (the
  // server's panel says so).
  const pending = statusOf({
    usedTokens: 1000,
    contextWindow: 1_000_000,
    configured: endpoint,
  });
  assert.deepEqual(pending.context.configured, endpoint);
  assert.equal(windowRow(pending), "1M · endpoint model list");
  // Codex counts 95% of the window it was given as usable.
  const adjusted = statusOf({
    usedTokens: 1000,
    contextWindow: 950_000,
    configured: endpoint,
  });
  assert.equal(
    windowRow(adjusted),
    "950K · the runtime's own (set 1M, endpoint model list)",
  );
  // A login runs with the CLI's own window and gets no row.
  const login = statusOf({ usedTokens: 1000, contextWindow: 200_000 });
  assert.equal(windowRow(login), undefined);
});
