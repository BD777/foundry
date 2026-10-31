import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
register("./bundler-resolve.mjs", import.meta.url);

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

const subagent = (id, status) => ({
  id,
  kind: "subagent",
  label: `Agent ${id}`,
  runtime: "claude",
  sessionId: "sess",
  status,
  taskId: id,
  workspaceId: "ws",
});

const background = (id, status) => ({
  id,
  kind: "background-task",
  label: `Task ${id}`,
  sessionId: "sess",
  workspaceId: "ws",
  task: {
    id,
    provider: "claude",
    kind: "command",
    description: `Task ${id}`,
    status,
    startedAt: "2026-10-09T15:00:00.000Z",
    ...(status === "running" ? {} : { endedAt: "2026-10-09T15:07:00.000Z" }),
    hasOutput: true,
  },
});

const data = {
  changes: [],
  files: [],
  previews: [],
  sources: [],
  timers: [],
  subagents: [
    subagent("c1", "completed"),
    subagent("r1", "running"),
    subagent("c2", "completed"),
    subagent("f1", "failed"),
    subagent("c3", "completed"),
    subagent("x1", "canceled"),
    subagent("r2", "running"),
  ],
  background: [
    background("b-run", "running"),
    background("b-done", "completed"),
    background("b-fail", "failed"),
  ],
};

function section(container, title) {
  return [...container.querySelectorAll(".fdy-chat-context-section")].find(
    (element) => element.querySelector("h3")?.textContent.startsWith(title),
  );
}

const labels = (element) =>
  [...element.querySelectorAll(".fdy-chat-context-row strong")].map(
    (strong) => strong.textContent,
  );

test("fallback subagents keep their own history; background commands list beside them", async () => {
  const { ChatContextCard } =
    await import("../src/features/chat/chat-context-card.tsx");
  const card = (chatKey) => createElement(ChatContextCard, { chatKey, data });
  await withDom(
    () => card("chat-a"),
    async (container, root) => {
      const subagents = () => section(container, "Subagents");
      const fold = () => subagents().querySelector(".fdy-chat-context-fold");
      // Running ones stay out; every ended one folds, failed and canceled
      // too, and the fold says how many failed.
      assert.deepEqual(labels(subagents()), ["Agent r1", "Agent r2"]);
      assert.equal(fold().tagName, "BUTTON");
      assert.equal(fold().textContent, "5 finished · 1 failed");
      assert.equal(fold().getAttribute("aria-expanded"), "false");

      await act(async () => fold().click());
      assert.equal(fold().getAttribute("aria-expanded"), "true");
      const panel = document.getElementById(
        fold().getAttribute("aria-controls"),
      );
      assert.deepEqual(labels(panel), [
        "Agent c1",
        "Agent c2",
        "Agent f1",
        "Agent c3",
        "Agent x1",
      ]);
      assert.equal(labels(subagents()).length, 7);

      // A session's background commands are not work-inventory rows (those
      // are hidden), so the card lists them itself: running ones first, the
      // ended ones folded (DEV-106).
      const background = () => section(container, "Background");
      assert.deepEqual(labels(background()), ["Task b-run"]);
      assert.equal(
        background().querySelector(".fdy-chat-context-fold").textContent,
        "2 finished · 1 failed",
      );

      // Another chat starts folded; coming back finds this one still open.
      await act(async () => root.render(card("chat-b")));
      assert.equal(fold().getAttribute("aria-expanded"), "false");
      assert.equal(labels(subagents()).length, 2);
      await act(async () => root.render(card("chat-a")));
      assert.equal(fold().getAttribute("aria-expanded"), "true");
      assert.equal(labels(subagents()).length, 7);

      await act(async () => fold().click());
      assert.equal(fold().getAttribute("aria-expanded"), "false");
      assert.equal(fold().getAttribute("aria-controls"), null);
      assert.equal(labels(subagents()).length, 2);
    },
  );
});

test("no fold row when nothing has finished", async () => {
  const { ChatContextCard } =
    await import("../src/features/chat/chat-context-card.tsx");
  await withDom(
    () =>
      createElement(ChatContextCard, {
        data: {
          ...data,
          subagents: [subagent("r1", "running")],
          background: [background("b-run", "running")],
        },
      }),
    async (container) => {
      assert.equal(container.querySelector(".fdy-chat-context-fold"), null);
    },
  );
});

test("background commands show whether or not the work inventory loaded", async () => {
  const { ChatContextCard } =
    await import("../src/features/chat/chat-context-card.tsx");
  const work = {
    sessionId: "sess",
    list: {
      items: [],
      operations: [],
      barrier: false,
      coverage: { processes: "managed_native_and_attributed" },
    },
    error: undefined,
    retrying: false,
    refresh() {},
    control() {},
    retryControl() {},
  };
  await withDom(
    () =>
      createElement(ChatContextCard, {
        data: {
          ...data,
          subagents: [],
          background: [background("b-run", "running")],
        },
        work,
      }),
    async (container) => {
      assert.deepEqual(labels(section(container, "Background")), [
        "Task b-run",
      ]);
    },
  );
});
