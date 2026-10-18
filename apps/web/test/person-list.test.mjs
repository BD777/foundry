// The day boundary is the browser's: pin a zone eight hours from UTC so
// "today" differs from the UTC day.
process.env.TZ = "Asia/Shanghai";

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({ url: "https://foundry.example/assistant" });
for (const key of [
  "window",
  "document",
  "navigator",
  "localStorage",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "HTMLDivElement",
  "MutationObserver",
  "ResizeObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "FocusEvent",
  "PopStateEvent",
  "NodeFilter",
  "DOMRect",
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === "window" ? window : window[key],
  });
}
Object.assign(globalThis, {
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { i18n } = await import("../src/i18n/index.ts");
await i18n.changeLanguage("en");
const model =
  await import("../src/features/personal-agent/person-list-model.ts");
const { PersonList } =
  await import("../src/features/personal-agent/person-list.tsx");

// 2026-10-15 09:00 in Shanghai; its day began at 2026-10-14T16:00Z.
const now = new Date("2026-10-15T01:00:00Z");

function item(id, fields = {}) {
  return {
    id,
    text: `item ${id}`,
    remind: false,
    status: "open",
    createdAt: "2026-10-14T01:00:00Z",
    updatedAt: "2026-10-14T01:00:00Z",
    ...fields,
  };
}

test("the day starts at local midnight, not UTC midnight", () => {
  assert.equal(
    model.startOfLocalDay(now).toISOString(),
    "2026-10-14T16:00:00.000Z",
  );
});

test("open items, then what was done today; dropped and earlier days hidden", () => {
  const items = [
    item("open_1"),
    item("done_today", { status: "done", closedAt: "2026-10-14T16:30:00Z" }),
    item("done_at_midnight", {
      status: "done",
      closedAt: "2026-10-14T16:00:00Z",
    }),
    // 23:30 yesterday in Shanghai, though the same UTC day as `now`.
    item("done_yesterday", {
      status: "done",
      closedAt: "2026-10-14T15:30:00Z",
    }),
    item("dropped_today", {
      status: "dropped",
      closedAt: "2026-10-15T00:30:00Z",
    }),
    item("done_no_time", { status: "done" }),
    item("open_2"),
  ];
  const view = model.personListView(items, now);
  assert.deepEqual(
    view.open.map((entry) => entry.id),
    ["open_1", "open_2"],
  );
  assert.deepEqual(
    view.doneToday.map((entry) => entry.id),
    ["done_today", "done_at_midnight"],
  );
});

test("a reminder shows only for an open item that asks for one at a known time", () => {
  const at = "2026-10-15T10:30:00Z";
  assert.equal(model.reminderAt(item("a", { remind: true, at })), at);
  assert.equal(model.reminderAt(item("b", { remind: false, at })), undefined);
  assert.equal(model.reminderAt(item("c", { remind: true })), undefined);
  assert.equal(
    model.reminderAt(item("d", { remind: true, at: "after work" })),
    undefined,
  );
  assert.equal(
    model.reminderAt(
      item("e", { remind: true, at, status: "done", closedAt: at }),
    ),
    undefined,
  );
});

test("an edit sends only what changed, trimmed", () => {
  const saved = item("a", { text: "call mum", when: "tonight" });
  assert.deepEqual(
    model.listItemEdit(saved, { text: " call mum ", when: "tonight " }),
    {},
  );
  assert.deepEqual(
    model.listItemEdit(saved, { text: "call dad", when: "tonight" }),
    { text: "call dad" },
  );
  assert.deepEqual(model.listItemEdit(saved, { text: "call mum", when: "" }), {
    when: "",
  });
});

test("the task helping is linked only when it can be opened", () => {
  const tasks = [
    { id: "task_1", sessionId: "sess_1", workspaceId: "ws_1" },
    { id: "task_2", workspaceId: "ws_1" },
  ];
  assert.equal(
    model.helpingTask(item("a", { taskId: "task_1" }), tasks)?.id,
    "task_1",
  );
  assert.equal(
    model.helpingTask(item("b", { taskId: "task_2" }), tasks),
    undefined,
  );
  assert.equal(model.helpingTask(item("c"), tasks), undefined);
});

async function render(props) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(PersonList, props)));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const noop = async () => {};

test("an empty list invites the person to say what they plan", async () => {
  const page = await render({
    items: [],
    tasks: [],
    error: "",
    onTick: noop,
    onEdit: noop,
    onDelete: noop,
  });
  assert.match(
    page.container.textContent,
    /Tell me what you plan to do and I'll keep it here\./,
  );
  await page.unmount();
});

test("a failed read says so instead of looking empty", async () => {
  const page = await render({
    items: [],
    tasks: [],
    error: "server unavailable",
    onTick: noop,
    onEdit: noop,
    onDelete: noop,
  });
  const text = page.container.textContent;
  assert.match(text, /Couldn't load your list/);
  assert.doesNotMatch(text, /Tell me what you plan/);
  await page.unmount();
});

test("rows tick done, show their reminder and the task helping", async () => {
  const ticked = [];
  const today = new Date();
  const at = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
    18,
    30,
  ).toISOString();
  const page = await render({
    items: [
      item("buy", {
        text: "Buy milk",
        when: "after work",
        remind: true,
        at,
        taskId: "task_1",
      }),
      item("run", {
        text: "Go for a run",
        status: "done",
        closedAt: new Date().toISOString(),
      }),
    ],
    tasks: [{ id: "task_1", sessionId: "sess_1", workspaceId: "ws_1" }],
    error: "",
    onTick: async (entry, done) => ticked.push([entry.id, done]),
    onEdit: noop,
    onDelete: noop,
  });
  const text = page.container.textContent;
  assert.match(text, /To do/);
  assert.match(text, /after work/);
  assert.match(text, /Reminder 06:30\sPM|Reminder 18:30/);
  assert.match(text, /I'm helping/);
  assert.match(text, /Done today/);
  const boxes = [...page.container.querySelectorAll("input[type=checkbox]")];
  assert.deepEqual(
    boxes.map((box) => box.checked),
    [false, true],
  );
  await act(async () => boxes[0].click());
  await act(async () => boxes[1].click());
  assert.deepEqual(ticked, [
    ["buy", true],
    ["run", false],
  ]);
  await page.unmount();
});
