import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
register("./bundler-resolve.mjs", import.meta.url);
const { chatMessages, chatMessagesForThread } =
  await import("../src/features/chat/chat-model.ts");
const { chatSessionStatus } =
  await import("../src/features/chat/chat-context-model.ts");
const { statusRows } =
  await import("../src/features/chat/chat-session-status.tsx");
const { CompactionDivider, compactionFacts } =
  await import("../src/components/conversation/compaction-divider.tsx");
const { i18n } = await import("../src/i18n/index.ts");

const at = (s) => `2026-10-29T09:01:${String(s).padStart(2, "0")}Z`;
const summary = "This session is being continued. DEV-083 synthetic summary.";

function session(events, provider = "claude") {
  return {
    id: "s1",
    provider,
    prompt: "go",
    status: "completed",
    events: events.map((event, index) => ({
      level: "info",
      at: at(index),
      detail: "",
      ...event,
    })),
  };
}

const usage = (contextUsage, id) => ({
  id,
  label: "Model request usage",
  metadata: { contextUsage },
});

// DEV-083: the compaction shows where it happened, with what the runtime
// reported, and the summary Claude kept joins it.
test("a compaction is a divider where it happened, with its counts and summary", () => {
  const messages = chatMessagesForThread({
    id: "thread",
    sessions: [
      session([
        {
          id: "a1",
          label: "Response stream",
          message: { id: "m1", kind: "assistant", text: "before" },
        },
        usage({ inputTokens: 951800, contextWindow: 1000000 }, "u0"),
        usage(
          {
            inputTokens: 38200,
            contextWindow: 1000000,
            compaction: {
              trigger: "auto",
              preTokens: 951800,
              postTokens: 38200,
            },
          },
          "c1",
        ),
        {
          id: "sum",
          label: "The native session compacted its context.",
          message: {
            id: "compaction-summary:b1",
            kind: "boundary",
            text: "The native session compacted its context.",
            compaction: { trigger: "auto", summary },
          },
        },
        {
          id: "a2",
          label: "Response stream",
          message: { id: "m2", kind: "assistant", text: "after" },
        },
      ]),
    ],
  });
  const dividers = messages.filter((message) => message.compaction);
  assert.equal(
    dividers.length,
    1,
    JSON.stringify(messages.map((m) => [m.kind, m.text])),
  );
  const [divider] = dividers;
  assert.equal(divider.kind, "boundary");
  assert.match(divider.id, /:c1:compaction$/);
  assert.deepEqual(divider.compaction, {
    trigger: "auto",
    preTokens: 951800,
    postTokens: 38200,
    summary,
  });
  const order = messages.map((m) => (m.compaction ? "divider" : m.text));
  assert.ok(order.indexOf("before") < order.indexOf("divider"));
  assert.ok(order.indexOf("divider") < order.indexOf("after"));
  // The summary is not a message or a divider of its own.
  assert.equal(messages.filter((m) => m.kind === "boundary").length, 1);
});

test("a summary a server without the compaction field kept adds no second divider", () => {
  const messages = chatMessagesForThread({
    id: "thread",
    sessions: [
      session([
        usage(
          {
            inputTokens: 5000,
            compaction: { trigger: "manual", preTokens: 80000 },
          },
          "c1",
        ),
        {
          id: "sum",
          label: "The native session compacted its context.",
          message: {
            id: "compaction-summary:b1",
            kind: "boundary",
            text: "The native session compacted its context.",
          },
        },
      ]),
    ],
  });
  const dividers = messages.filter((message) => message.kind === "boundary");
  assert.equal(dividers.length, 1);
  assert.deepEqual(dividers[0].compaction, {
    trigger: "manual",
    preTokens: 80000,
    postTokens: 5000,
  });
});

test("a summary whose compaction is on an earlier page stands as its divider", () => {
  const messages = chatMessages({
    id: "native",
    provider: "claude",
    transcript: [
      {
        id: "compaction-summary:s1",
        kind: "boundary",
        text: "The native session compacted its context.",
        compaction: { trigger: "auto", summary },
      },
    ],
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].compaction.summary, summary);
});

test("Codex reports no count with its compaction: the next request's input is what is left", () => {
  const messages = chatMessagesForThread({
    id: "thread",
    sessions: [
      session(
        [
          usage(
            { contextWindow: 828400, compaction: { trigger: "auto" } },
            "c1",
          ),
          usage({ inputTokens: 41000, contextWindow: 828400 }, "u1"),
          usage({ inputTokens: 52000, contextWindow: 828400 }, "u2"),
        ],
        "codex",
      ),
    ],
  });
  const divider = messages.find((m) => m.compaction);
  assert.deepEqual(divider.compaction, { trigger: "auto", postTokens: 41000 });
});

test("an imported chat shows its compactions and keeps the summary on the divider", () => {
  const messages = chatMessages({
    id: "native",
    provider: "claude",
    transcript: [
      { id: "u1", kind: "user", text: "hello" },
      {
        id: "b1",
        kind: "boundary",
        text: "The native session compacted its context.",
        compaction: { trigger: "manual", preTokens: 120000, postTokens: 9000 },
      },
      {
        id: "compaction-summary:s1",
        kind: "boundary",
        text: "The native session compacted its context.",
        compaction: { trigger: "auto", summary },
      },
      { id: "u2", kind: "user", text: "next" },
    ],
  });
  const dividers = messages.filter((m) => m.compaction);
  assert.equal(dividers.length, 1);
  assert.equal(dividers[0].compaction.trigger, "manual");
  assert.equal(dividers[0].compaction.summary, summary);
});

test("the divider says what is known and the context panel links to the latest", async () => {
  await i18n.changeLanguage("en");
  const t = i18n.getFixedT("en", "conversation");
  assert.match(
    compactionFacts(
      { trigger: "auto", preTokens: 951800, postTokens: 38200 },
      undefined,
      t,
    ),
    /^Automatic · 951\.8K → 38\.2K tokens$/,
  );
  assert.equal(compactionFacts({ trigger: "manual" }, undefined, t), "Manual");
  const status = chatSessionStatus(
    session([
      usage(
        {
          inputTokens: 1000,
          contextWindow: 200000,
          compaction: { trigger: "manual", preTokens: 90000, postTokens: 1000 },
        },
        "c1",
      ),
      usage(
        {
          inputTokens: 2000,
          contextWindow: 200000,
          compaction: { trigger: "auto", preTokens: 190000, postTokens: 2000 },
        },
        "c2",
      ),
    ]),
  );
  assert.equal(status.compactions, 2);
  assert.deepEqual(status.lastCompaction, {
    at: at(1),
    messageId: "c2:compaction",
  });
  const row = statusRows(status).find((entry) => entry.id === "compactions");
  assert.match(row.value, /^2 · last /);
  assert.equal(row.jump.messageId, "c2:compaction");
});

test("the summary opens from the divider by keyboard and can be copied", async (t) => {
  const window = new Window();
  const saved = {};
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  const { createRoot } = await import("react-dom/client");
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(() => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  await act(async () =>
    root.render(
      createElement(CompactionDivider, {
        compaction: {
          trigger: "auto",
          preTokens: 951800,
          postTokens: 38200,
          summary,
        },
      }),
    ),
  );
  const toggle = host.querySelector(".fdy-chat-compaction-toggle");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(host.querySelector(".fdy-chat-compaction-summary"), null);
  await act(async () => toggle.click());
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  const panel = host.querySelector(".fdy-chat-compaction-summary");
  assert.equal(toggle.getAttribute("aria-controls"), panel.id);
  assert.equal(
    panel.querySelector(".fdy-chat-compaction-summary-text").textContent,
    summary,
  );
  assert.ok(panel.querySelector('button[aria-label="Copy summary"]'));
  // Without a summary it is a plain note, not a button.
  await act(async () =>
    root.render(
      createElement(CompactionDivider, { compaction: { trigger: "auto" } }),
    ),
  );
  assert.equal(host.querySelector(".fdy-chat-compaction-toggle"), null);
  assert.ok(host.querySelector('.fdy-chat-compaction-label[role="note"]'));
});
