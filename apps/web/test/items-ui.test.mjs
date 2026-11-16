// The day boundary is the browser's: pin a zone eight hours from UTC.
process.env.TZ = "Asia/Shanghai";

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({ url: "https://foundry.example/assistant/items" });
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
const { ItemsCard } =
  await import("../src/features/personal-agent/items-card.tsx");
const { ItemsList } =
  await import("../src/features/personal-agent/items-list.tsx");
const { ItemDetail } =
  await import("../src/features/personal-agent/items-detail.tsx");

// Thursday 2026-10-15 09:00 in Shanghai; "now" for the rows' relative times.
const nowIso = new Date().toISOString();

function item(id, fields = {}) {
  return {
    id,
    intentRevision: 1,
    revision: 1,
    owner: "person",
    text: `item ${id}`,
    remind: false,
    status: "open",
    createdAt: nowIso,
    updatedAt: nowIso,
    helpers: [],
    ...fields,
  };
}

const noop = async () => {};

async function mount(component, props) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(component, props)));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function cardProps(overrides = {}) {
  return {
    open: { items: [], total: 0, offset: 0 },
    openError: "",
    closed: [],
    tasks: [],
    projectName: () => undefined,
    onTick: noop,
    onOpenAll: () => {},
    onOpenItem: () => {},
    ...overrides,
  };
}

test("an empty card says nothing is open and still reaches the full list", async () => {
  const page = await mount(ItemsCard, cardProps());
  const text = page.container.textContent;
  assert.match(text, /Items/);
  assert.match(text, /Nothing open\./);
  assert.match(text, /All/);
  assert.doesNotMatch(text, /Finished \d/);
  await page.unmount();
});

test("a failed read shows its error instead of looking empty", async () => {
  const page = await mount(
    ItemsCard,
    cardProps({ openError: "server unavailable" }),
  );
  const text = page.container.textContent;
  assert.match(text, /Couldn't load items/);
  assert.match(text, /server unavailable/);
  assert.doesNotMatch(text, /Nothing open\./);
  await page.unmount();
});

test("a person's item ticks done; the assistant's running item says whose helper it is", async () => {
  const ticked = [];
  const mine = item("mine", { text: "buy paper", when: "after work" });
  const running = item("ccm", {
    owner: "assistant",
    text: "check the ccm rollout",
    helpers: [
      {
        sessionId: "sess_ccm",
        title: "ccm-omh-integration",
        status: "running",
        readOnly: false,
      },
    ],
  });
  const page = await mount(
    ItemsCard,
    cardProps({
      open: { items: [mine, running], total: 2, offset: 0 },
      onTick: async (_item, done) => ticked.push(done),
    }),
  );
  const text = page.container.textContent;
  assert.match(text, /buy paper/);
  assert.match(text, /You · after work/);
  assert.match(text, /Assistant · ccm-omh-integration in progress/);
  const tick = page.container.querySelector(
    'input[type="checkbox"][aria-label="Mark “buy paper” done"]',
  );
  assert.ok(tick, "a person's open item has a real checkbox");
  await act(async () => tick.click());
  assert.deepEqual(ticked, [true]);
  await page.unmount();
});

test("finished items fold under their count; the open list is capped at six rows", async () => {
  const many = Array.from({ length: 8 }, (_, index) =>
    item(`open-${index}`, { text: `open item ${index}` }),
  );
  const page = await mount(
    ItemsCard,
    cardProps({
      open: { items: many, total: 8, offset: 0 },
      closed: [
        item("closed", {
          status: "done",
          text: "shipped it",
          closedAt: nowIso,
        }),
      ],
    }),
  );
  const text = page.container.textContent;
  assert.match(text, /open item 0/);
  assert.match(text, /open item 5/);
  assert.doesNotMatch(text, /open item 6/);
  assert.match(text, /Finished 1/);
  assert.doesNotMatch(text, /shipped it/, "the fold starts closed");
  const fold = [...page.container.querySelectorAll("button")].find((button) =>
    /Finished 1/.test(button.textContent),
  );
  await act(async () => fold.click());
  assert.match(page.container.textContent, /shipped it/);
  await page.unmount();
});

test("a helper without an item shows apart; one of an item stays on the item", async () => {
  const linked = item("linked", {
    owner: "assistant",
    helpers: [{ sessionId: "sess_linked", status: "running", readOnly: false }],
  });
  const page = await mount(
    ItemsCard,
    cardProps({
      open: { items: [linked], total: 1, offset: 0 },
      tasks: [
        {
          id: "task_linked",
          conversationSessionId: "sess_conv",
          sessionId: "sess_linked",
          workspaceId: "ws_1",
          title: "linked helper",
          status: "running",
          readOnly: false,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        {
          id: "task_free",
          conversationSessionId: "sess_conv",
          sessionId: "sess_free",
          workspaceId: "ws_1",
          title: "free helper",
          status: "running",
          readOnly: false,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      ],
      projectName: () => "foundry",
    }),
  );
  const text = page.container.textContent;
  assert.match(text, /free helper/);
  assert.match(text, /In “foundry”/);
  assert.doesNotMatch(text, /Other work finished/, "nothing ended to fold");
  assert.equal(
    text.split("linked helper").length - 1,
    0,
    "the helper of an item is not listed apart",
  );
  await page.unmount();
});

test("open items read To do; In progress only where a helper is running", async () => {
  const page = await mount(ItemsList, {
    items: [
      item("ticket", { text: "buy paper" }),
      item("ccm", {
        owner: "assistant",
        text: "check the rollout",
        helpers: [
          {
            sessionId: "sess_ccm",
            title: "ccm",
            status: "running",
            readOnly: false,
          },
        ],
      }),
      item("idle", { owner: "assistant", text: "keep the digest" }),
    ],
    selectedItemId: undefined,
    busyId: "",
    onOpen: () => {},
    onTick: () => {},
  });
  const text = page.container.textContent;
  assert.match(text, /You · To do/);
  assert.match(text, /Assistant · In progress/);
  assert.match(text, /Assistant · To do/);
  assert.doesNotMatch(text, /You · In progress/);
  await page.unmount();
});

test("the list groups by day and marks the selected row", async () => {
  const page = await mount(ItemsList, {
    items: [item("a", { text: "today item" })],
    selectedItemId: "a",
    busyId: "",
    onOpen: () => {},
    onTick: () => {},
  });
  assert.match(page.container.textContent, /Today/);
  assert.match(page.container.textContent, /today item/);
  const row = page.container.querySelector('[data-selected="true"]');
  assert.ok(row, "the selected item is marked");
  assert.match(row.textContent, /today item/);
  await page.unmount();
});

test("the detail shows its plan and its helper opens in a new tab", async () => {
  const detail = {
    item: item("detail", {
      owner: "assistant",
      text: "ship the items page",
      origin: { kind: "channel", name: "OpenLark", requester: "Zhang" },
      quote: "please ship it",
      plan: {
        mode: "record",
        progress: "working",
        nextAction: "wait for review",
        route: {
          kind: "existing",
          reason: "the foundry project",
          needsClarification: false,
        },
      },
      helpers: [
        {
          sessionId: "sess_helper",
          workspaceId: "ws_1",
          title: "items page",
          project: "foundry",
          status: "running",
          readOnly: false,
          startedAt: nowIso,
        },
      ],
    }),
    events: [
      {
        id: "e1",
        itemId: "detail",
        at: nowIso,
        actor: "assistant",
        kind: "helper_started",
        detail: { title: "items page", sessionId: "sess_helper" },
      },
    ],
  };
  const page = await mount(ItemDetail, {
    assistantId: "asst_1",
    detail,
    error: "",
    onBack: () => {},
    onOpenAssistant: () => {},
    items: [],
    operations: [],
    workspaces: [],
    onChanged: noop,
    onDeleted: () => {},
  });
  const text = page.container.textContent;
  assert.match(text, /ship the items page/);
  assert.match(text, /Assistant · OpenLark · Zhang|OpenLark · Zhang/);
  assert.match(text, /please ship it/);
  assert.match(text, /the foundry project/);
  assert.match(text, /Started “items page”/);
  const helperLink = page.container.querySelector('a[href*="sess_helper"]');
  assert.ok(helperLink, "the helper links to its chat");
  assert.equal(helperLink.getAttribute("target"), "_blank");

  await page.unmount();
});

test("a detail that failed to load says so", async () => {
  const page = await mount(ItemDetail, {
    assistantId: "asst_1",
    detail: undefined,
    error: "not found",
    onBack: () => {},
    onOpenAssistant: () => {},
    items: [],
    operations: [],
    workspaces: [],
    onChanged: noop,
    onDeleted: () => {},
  });
  assert.match(page.container.textContent, /Couldn't load this item/);
  assert.match(page.container.textContent, /not found/);
  await page.unmount();
});
