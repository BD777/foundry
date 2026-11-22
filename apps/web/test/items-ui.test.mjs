// The day boundary is the browser's: pin a zone eight hours from UTC.
process.env.TZ = "Asia/Shanghai";

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({ url: "https://foundry.example/items" });
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
const { WorkspaceItems } =
  await import("../src/features/personal-agent/workspace-items.tsx");
const { AssistantItemsPage } =
  await import("../src/features/personal-agent/items-page.tsx");
const { ItemsReview } =
  await import("../src/features/personal-agent/items-review.tsx");

// The live reads subscribe to the stream; nothing streams here.
globalThis.EventSource = class {
  addEventListener() {}
  close() {}
};

// Each test that reads the server sets `answer`; the calls are kept.
const calls = [];
let answer = () => undefined;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), "https://foundry.example");
  const method = (init.method ?? "GET").toUpperCase();
  calls.push({
    method,
    path: url.pathname,
    query: url.searchParams,
    body: init.body ? JSON.parse(init.body) : undefined,
  });
  const value = answer(method, url);
  return value === undefined
    ? new Response(JSON.stringify({ error: "not found" }), { status: 404 })
    : new Response(JSON.stringify(value), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
};

const workspaces = [
  { id: "ws_home", name: "Foundry", kind: "project" },
  { id: "ws_docs", name: "Docs", kind: "project" },
];

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
    workspaces,
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

test("an empty list says so, and says when a filter is why", async () => {
  for (const [narrowed, body] of [
    [false, /What you or the assistant decide to follow up on/],
    [true, /Nothing matches this tab, workspace or search/],
  ]) {
    const page = await mount(ItemsList, {
      items: [],
      narrowed,
      workspaces,
      busyId: "",
      onOpen: () => {},
      onTick: () => {},
    });
    const empty = page.container.querySelector('[role="status"]');
    assert.ok(empty, "the empty list is announced");
    assert.match(empty.textContent, /No items here/);
    assert.match(empty.textContent, body);
    await page.unmount();
  }
});

test("a channel item names who asked on its detail line, not in a chip", async () => {
  const page = await mount(ItemsList, {
    items: [
      item("chan", {
        text: "reply to Alex",
        origin: { kind: "channel", name: "Feishu", requester: "Alex" },
      }),
    ],
    workspaces,
    busyId: "",
    onOpen: () => {},
    onTick: () => {},
  });
  const row = page.container.querySelector("[data-selected]");
  assert.match(row.textContent, /You · To do · .*Alex/);
  assert.equal(page.container.querySelector(".fdy-badge"), null);
  await page.unmount();
});

test("an empty review says so and its actions are disabled with the reason", async () => {
  const page = await mount(ItemsReview, {
    report: {
      from: "2026-11-01T00:00:00Z",
      to: "2026-11-02T00:00:00Z",
      counts: { created: 0, done: 0, dropped: 0, open: 0 },
      groups: [],
    },
    error: "",
    rangeLabel: "Today",
    askText: "Summarise",
    onBack: () => {},
    onAsked: () => {},
  });
  const empty = page.container.querySelector('[role="status"]');
  assert.ok(empty, "the empty range is announced");
  assert.match(empty.textContent, /No items in this range/);
  for (const name of ["Copy as Markdown", "Ask the assistant to write it up"]) {
    const button = [...page.container.querySelectorAll("button")].find(
      (entry) => entry.textContent.trim() === name,
    );
    assert.ok(button?.disabled, `${name} is disabled`);
    assert.equal(
      button.parentElement.getAttribute("tabindex"),
      "0",
      `${name}'s reason is reachable by hover and focus`,
    );
  }
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

test("the timeline says what an item waited on the person for and their answer, in their words", async () => {
  const detail = {
    item: item("waits", { text: "rerun the batch" }),
    events: [
      {
        id: "e1",
        itemId: "waits",
        at: nowIso,
        actor: "foundry",
        kind: "needs_you_opened",
        detail: { needsYouId: "pnd_1", title: "Batch A or batch B?" },
      },
      {
        id: "e2",
        itemId: "waits",
        at: nowIso,
        actor: "person",
        kind: "needs_you_answered",
        detail: { needsYouId: "pnd_1", quote: "Batch A" },
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
  assert.match(text, /Waiting for you: Batch A or batch B\?/);
  assert.match(text, /You answered: “Batch A”/);
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

test("a row names the workspace an item lives in; the inbox goes unsaid", async () => {
  const page = await mount(ItemsList, {
    items: [
      item("home", { text: "lives in foundry", homeWorkspaceId: "ws_home" }),
      item("inbox", { text: "lives in the inbox" }),
    ],
    workspaces,
    busyId: "",
    onOpen: () => {},
    onTick: () => {},
  });
  const rows = [...page.container.querySelectorAll("[data-selected]")];
  const home = rows.find((row) => /lives in foundry/.test(row.textContent));
  const inbox = rows.find((row) => /lives in the inbox/.test(row.textContent));
  assert.match(home.textContent, /Foundry/);
  assert.doesNotMatch(inbox.textContent, /Assistant's inbox/);
  await page.unmount();
});

function detailProps(detail) {
  return {
    assistantId: "asst_1",
    detail,
    error: "",
    onBack: () => {},
    onOpenAssistant: () => {},
    items: [],
    operations: [],
    workspaces,
    onChanged: noop,
    onDeleted: () => {},
  };
}

test("the detail shows where the item lives, what it touches and the chat that follows it", async () => {
  answer = (method, url) =>
    method === "GET" && url.pathname === "/api/agent-sessions/sess_holder/link"
      ? { id: "sess_holder", workspaceId: "ws_home", title: "Ledger web" }
      : undefined;
  const at = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
  const detail = {
    item: item("lives", {
      text: "item ledger",
      homeWorkspaceId: "ws_home",
      touches: ["ws_docs", "ws_gone"],
      holderSessionId: "sess_holder",
    }),
    events: [
      {
        id: "e1",
        itemId: "lives",
        at: at(4),
        actor: "person",
        kind: "rehomed",
        detail: { to: "ws_home" },
      },
      {
        id: "e2",
        itemId: "lives",
        at: at(3),
        actor: "session",
        kind: "claimed",
        detail: { sessionId: "sess_holder" },
      },
      {
        id: "e3",
        itemId: "lives",
        at: at(2),
        actor: "session",
        kind: "claimed",
        detail: { sessionId: "sess_holder", from: "sess_old" },
      },
      {
        id: "e4",
        itemId: "lives",
        at: at(1),
        actor: "session",
        kind: "released",
        detail: { sessionId: "sess_old" },
      },
    ],
  };
  const page = await mount(ItemDetail, detailProps(detail));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const text = page.container.textContent;
  const home = page.container.querySelector(
    'a[href="/workspace?workspace=ws_home"]',
  );
  assert.ok(home, "the home links to its workspace");
  assert.equal(home.textContent, "Foundry");
  assert.ok(
    page.container.querySelector('a[href="/workspace?workspace=ws_docs"]'),
  );
  assert.match(text, /A workspace you can't see/);
  assert.doesNotMatch(text, /ws_gone|sess_holder|sess_old/);
  const holder = page.container.querySelector(
    'a[href="/chats/sess_holder?workspace=ws_home"]',
  );
  assert.ok(holder, "the holder links to its chat");
  assert.equal(holder.textContent, "Ledger web");
  assert.match(text, /Workspace: Assistant's inbox → Foundry/);
  assert.match(text, /A chat started following it/);
  assert.match(text, /Another chat took it over/);
  assert.match(text, /The chat stopped following it/);
  assert.match(text, /A chat/);
  const change = [...page.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Change",
  );
  assert.ok(change, "an open item's home can be changed");
  await act(async () => change.click());
  assert.ok(
    page.container.querySelector('[aria-label^="Choose the workspace"]'),
    "changing shows the workspace choice",
  );
  await page.unmount();
});

test("an item without a home lives in the assistant's inbox; a closed one keeps it", async () => {
  const page = await mount(
    ItemDetail,
    detailProps({
      item: item("closed", { status: "done", closedAt: nowIso }),
      events: [],
    }),
  );
  assert.match(page.container.textContent, /Assistant's inbox/);
  assert.ok(
    ![...page.container.querySelectorAll("button")].some(
      (button) => button.textContent === "Change",
    ),
    "a closed item's home is not changed",
  );
  await page.unmount();
});

test("a workspace lists its open items: those living here apart from those touching it", async () => {
  calls.length = 0;
  answer = (method, url) =>
    method === "GET" && url.pathname === "/api/personal-agent/items"
      ? {
          items: [
            item("mine", { text: "lives here", homeWorkspaceId: "ws_home" }),
            item("theirs", {
              text: "helper ran here",
              homeWorkspaceId: "ws_docs",
              touches: ["ws_home"],
            }),
            item("inbox", { text: "from the inbox", touches: ["ws_home"] }),
          ],
          total: 3,
          offset: 0,
        }
      : undefined;
  const opened = [];
  const page = await mount(WorkspaceItems, {
    workspaceId: "ws_home",
    workspaces,
    onOpenItem: (itemId) => opened.push(itemId),
    onOpenAll: () => opened.push("all"),
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const read = calls.find((call) => call.path === "/api/personal-agent/items");
  assert.equal(read.query.get("workspace"), "ws_home");
  assert.equal(read.query.get("view"), "open");
  const [here, touching] = page.container.querySelectorAll("section");
  assert.equal(here.getAttribute("aria-label"), "Belongs here");
  assert.match(here.textContent, /lives here/);
  assert.doesNotMatch(here.textContent, /helper ran here/);
  assert.equal(touching.getAttribute("aria-label"), "Touches here");
  assert.match(touching.textContent, /helper ran here.*Docs/);
  assert.match(touching.textContent, /from the inbox.*Assistant's inbox/);
  await act(async () => here.querySelector("button").click());
  assert.deepEqual(opened, ["mine"]);
  await page.unmount();
});

test("the overview's ten rows go first to items living here, the rest to those touching it", async () => {
  calls.length = 0;
  // Newest first: twelve touching items, then four living here.
  const touchingItems = Array.from({ length: 12 }, (_, index) =>
    item(`touch${index}`, {
      text: `touching ${index}`,
      homeWorkspaceId: "ws_docs",
      touches: ["ws_home"],
    }),
  );
  const homeItems = Array.from({ length: 4 }, (_, index) =>
    item(`home${index}`, { text: `home ${index}`, homeWorkspaceId: "ws_home" }),
  );
  answer = (method, url) =>
    method === "GET" && url.pathname === "/api/personal-agent/items"
      ? { items: [...touchingItems, ...homeItems], total: 16, offset: 0 }
      : undefined;
  const page = await mount(WorkspaceItems, {
    workspaceId: "ws_home",
    workspaces,
    onOpenItem() {},
    onOpenAll() {},
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const [here, touching] = page.container.querySelectorAll("section");
  assert.equal(here.querySelectorAll("button").length, 4, "every item here");
  assert.equal(
    touching.querySelectorAll("button").length,
    6,
    "the rest of ten",
  );
  assert.match(touching.textContent, /touching 0/);
  assert.doesNotMatch(touching.textContent, /touching 6/);
  assert.match(page.container.textContent, /6 more on the items page/);
  await page.unmount();
});

test("the items page filters by workspace or the inbox: read from the URL once, written back on change", async () => {
  calls.length = 0;
  answer = (method, url) =>
    method === "GET" && url.pathname === "/api/personal-agent/items"
      ? { items: [], total: 0, offset: 0 }
      : undefined;
  window.history.replaceState(null, "", "/items?workspace=ws_home&in=inbox");
  const page = await mount(AssistantItemsPage, {
    onSelectItem() {},
    onOpenAssistant() {},
    workspaces,
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const reads = () =>
    calls.filter((call) => call.path === "/api/personal-agent/items");
  assert.equal(reads().at(-1).query.get("inbox"), "true");
  assert.equal(reads().at(-1).query.get("workspace"), null);
  const trigger = page.container.querySelector(
    'button[aria-label^="Filter by workspace"]',
  );
  assert.equal(
    trigger.getAttribute("aria-label"),
    "Filter by workspace: Assistant's inbox",
  );

  await act(() =>
    trigger.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  const options = [
    ...window.document.querySelectorAll("[role=menu] [role=menuitemradio]"),
  ];
  assert.deepEqual(
    options.map((option) => option.textContent),
    ["All", "Assistant's inbox", "Foundry", "Docs"],
  );
  await act(() => options[3].click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.equal(reads().at(-1).query.get("workspace"), "ws_docs");
  assert.equal(reads().at(-1).query.get("inbox"), null);
  // The filter writes the URL; the active workspace stays as it was.
  const params = new URLSearchParams(window.location.search);
  assert.equal(params.get("in"), "ws_docs");
  assert.equal(params.get("workspace"), "ws_home");
  // A later URL change does not drive the filter back.
  window.history.replaceState(null, "", "/items?in=inbox");
  window.dispatchEvent(new window.PopStateEvent("popstate"));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.equal(trigger.getAttribute("aria-label"), "Filter by workspace: Docs");
  await page.unmount();
  window.history.replaceState(null, "", "/items");
});

test("before the workspaces are read, a workspace not in the list is not yet called one you can't see", async () => {
  const rowsOf = async (workspacesLoaded) => {
    const page = await mount(ItemsList, {
      items: [item("far", { text: "lives far", homeWorkspaceId: "ws_far" })],
      workspaces: [],
      workspacesLoaded,
      busyId: "",
      onOpen: () => {},
      onTick: () => {},
    });
    const text = page.container.textContent;
    await page.unmount();
    return text;
  };
  assert.doesNotMatch(await rowsOf(false), /can't see/);
  assert.match(await rowsOf(true), /A workspace you can't see/);

  calls.length = 0;
  answer = (method, url) =>
    method === "GET" && url.pathname === "/api/personal-agent/items"
      ? { items: [], total: 0, offset: 0 }
      : undefined;
  window.history.replaceState(null, "", "/items?in=ws_far");
  const props = {
    onSelectItem() {},
    onOpenAssistant() {},
    workspaces: [],
    workspacesLoaded: false,
  };
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(AssistantItemsPage, props)));
  const trigger = () =>
    container.querySelector('button[aria-label^="Filter by workspace"]');
  assert.equal(
    trigger().getAttribute("aria-label"),
    "Filter by workspace: Loading…",
  );
  // Read: one the list does not hold is one the person cannot see.
  await act(async () =>
    root.render(
      createElement(AssistantItemsPage, { ...props, workspacesLoaded: true }),
    ),
  );
  assert.equal(
    trigger().getAttribute("aria-label"),
    "Filter by workspace: A workspace you can't see",
  );
  await act(async () => root.unmount());
  container.remove();
  window.history.replaceState(null, "", "/items");
});

test("an item shows what waits on the person: a count on its row, the entries in its detail", async () => {
  const waiting = item("waiting", {
    text: "renew the passport",
    needsYou: [
      {
        id: "pnd_1",
        source: "question",
        title: "Which photo should I use?",
        sessionId: "sess_1",
        createdAt: nowIso,
      },
      {
        id: "pnd_2",
        source: "turn_failed",
        title: "Not logged in",
        sessionId: "sess_2",
        createdAt: nowIso,
      },
    ],
  });
  const list = await mount(ItemsList, {
    items: [waiting, item("quiet", { text: "nothing waits" })],
    workspaces,
    busyId: "",
    onOpen: () => {},
    onTick: () => {},
  });
  const rows = [...list.container.querySelectorAll("button")].filter((row) =>
    /Waiting on you/.test(row.textContent),
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /renew the passport/);
  assert.match(rows[0].textContent, /Waiting on you: 2/);
  await list.unmount();

  const page = await mount(
    ItemDetail,
    detailProps({ item: waiting, events: [] }),
  );
  assert.match(page.container.textContent, /Waiting on you: 2/);
  const links = [...page.container.querySelectorAll("a")].filter((link) =>
    /Which photo|Not logged in/.test(link.textContent),
  );
  assert.equal(links.length, 2);
  for (const link of links) {
    assert.equal(link.getAttribute("href"), "/pending");
    assert.equal(link.getAttribute("target"), "_blank");
  }
  await page.unmount();
});
