import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({
  url: "https://foundry.example/assistant/settings/entry",
});
for (const key of [
  "window",
  "document",
  "navigator",
  "localStorage",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLFormElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLDivElement",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
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
globalThis.EventSource = class {
  addEventListener() {}
  close() {}
};

const bot = {
  connectorInstanceId: "builtin:feishu",
  label: "Foundry 飞书机器人",
  reason: "",
  recommended: true,
};
let notifyInstances = [bot];
let notifyListStatus = 200;

let testResponse = {
  status: "failed",
  reason: "the connector does not take notices",
};
const calls = [];

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), "https://foundry.example");
  const method = (init.method ?? "GET").toUpperCase();
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method, path: url.pathname, body });
  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  if (
    method === "GET" &&
    url.pathname === "/api/personal-agent/notify/instances"
  ) {
    if (notifyListStatus !== 200)
      return json(
        { error: "the connectors could not be listed" },
        notifyListStatus,
      );
    return json({ instances: notifyInstances });
  }
  if (method === "POST" && url.pathname === "/api/personal-agent/notify/test")
    return json(testResponse);
  throw new Error(`unexpected ${method} ${url.pathname}`);
};

const { createRoot } = await import("react-dom/client");
const { i18n } = await import("../src/i18n/index.ts");
await i18n.changeLanguage("en");
const { NotifySection } =
  await import("../src/features/personal-agent/settings-notify.tsx");
const { unsentNotices } = await import("../src/lib/pending-display.ts");

async function settle() {
  for (let index = 0; index < 4; index += 1)
    await act(async () => new Promise((done) => setTimeout(done, 0)));
}

async function render(draft, change = () => {}, pendingItems) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(createElement(NotifySection, { draft, change, pendingItems })),
  );
  await settle();
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function buttonNamed(container, text) {
  const found = [...container.querySelectorAll("button")].find(
    (button) => button.textContent.trim() === text,
  );
  assert.ok(found, `no button "${text}"`);
  return found;
}

function kindCheckbox(container, label) {
  const found = [...container.querySelectorAll("label")].find((node) =>
    node.textContent.includes(label),
  );
  const input = found?.querySelector("input[type=checkbox]");
  assert.ok(input, `no ${label} checkbox`);
  return input;
}

const savedDraft = {
  notify: {
    sinks: [
      {
        connectorInstanceId: bot.connectorInstanceId,
        kinds: ["question", "approval", "hand_over", "ask"],
      },
    ],
  },
};

test("the notice setting renders the saved connector and its four kinds", async () => {
  const page = await render(savedDraft);
  try {
    assert.match(page.container.textContent, /Notices to you/);
    assert.match(page.container.textContent, /Kinds to notify/);
    for (const label of ["Questions", "Approvals", "Hand-overs", "Requests"])
      assert.match(page.container.textContent, new RegExp(label));
    assert.match(page.container.textContent, /Send a test notice/);
  } finally {
    await page.unmount();
  }
});

test("the test notice reports a failed send with its reason", async () => {
  testResponse = {
    status: "failed",
    reason: "the connector does not take notices",
  };
  calls.length = 0;
  const page = await render(savedDraft);
  try {
    await act(async () =>
      buttonNamed(page.container, "Send a test notice").click(),
    );
    await settle();
    const sent = calls.find(
      (call) => call.path === "/api/personal-agent/notify/test",
    );
    assert.deepEqual(sent?.body, {
      connectorInstanceId: bot.connectorInstanceId,
    });
    assert.match(
      page.container.textContent,
      /The test notice failed: the connector does not take notices/,
    );
  } finally {
    await page.unmount();
  }
});

test("the test notice reports a sent message", async () => {
  testResponse = { status: "sent", messageId: "om_test" };
  const page = await render(savedDraft);
  try {
    await act(async () =>
      buttonNamed(page.container, "Send a test notice").click(),
    );
    await settle();
    assert.match(page.container.textContent, /The test notice was sent/);
  } finally {
    await page.unmount();
  }
});

test("unticking a kind saves the rest, and the last kind cannot be removed", async () => {
  const changes = [];
  const draft = {
    notify: {
      sinks: [
        { connectorInstanceId: bot.connectorInstanceId, kinds: ["question"] },
      ],
    },
  };
  const page = await render(draft, (patch) => changes.push(patch));
  try {
    const approvals = kindCheckbox(page.container, "Approvals");
    await act(async () => approvals.click());
    assert.deepEqual(changes.at(-1), {
      notify: {
        sinks: [
          {
            connectorInstanceId: bot.connectorInstanceId,
            kinds: ["question", "approval"],
          },
        ],
      },
    });
    const question = kindCheckbox(page.container, "Questions");
    await act(async () => question.click());
    assert.equal(changes.length, 1, "removing the last kind must not save");
  } finally {
    await page.unmount();
  }
});

test("only the Foundry bot is offered, read from the notify instances route", async () => {
  // A server that still lists an extension instance: the picker leaves it out.
  notifyInstances = [
    bot,
    { connectorInstanceId: "app_openlark_1", label: "OpenLark", reason: "" },
  ];
  calls.length = 0;
  const page = await render(savedDraft);
  try {
    assert.match(page.container.textContent, /Foundry 飞书机器人/);
    assert.doesNotMatch(page.container.textContent, /OpenLark/);
    assert.doesNotMatch(page.container.textContent, /recommended/);
    // Radix opens on keyboard activation, not happy-dom's synthetic click.
    await act(async () =>
      page.container.querySelector('[aria-label^="Notices"]').dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await settle();
    const labels = [
      ...window.document.querySelectorAll('[role="menuitemradio"]'),
    ].map((option) => option.textContent.trim());
    await act(async () =>
      window.document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    assert.deepEqual(labels, ["No notices", "Foundry 飞书机器人"]);
    assert.ok(
      calls.some(
        (call) =>
          call.method === "GET" &&
          call.path === "/api/personal-agent/notify/instances",
      ),
    );
    assert.equal(
      calls.some((call) => call.path === "/api/personal-agent/notify/chat"),
      false,
      "the bot needs no self chat",
    );
  } finally {
    await page.unmount();
    notifyInstances = [bot];
  }
});

test("a bot that cannot take notices yet says why", async () => {
  notifyInstances = [{ ...bot, reason: "feishu_not_paired" }];
  try {
    const page = await render({});
    try {
      assert.match(
        page.container.textContent,
        /Foundry 飞书机器人 cannot take notices yet\. Send the pairing code once/,
      );
    } finally {
      await page.unmount();
    }
  } finally {
    notifyInstances = [bot];
  }
});

test("a connector sink saved before cards only says it is no longer offered", async () => {
  const page = await render({
    notify: {
      sinks: [{ connectorInstanceId: "app_openlark_1", kinds: ["question"] }],
    },
  });
  try {
    assert.match(page.container.textContent, /A connector no longer offered/);
    assert.match(
      page.container.textContent,
      /Notices now go only as Foundry bot cards/,
    );
    assert.doesNotMatch(page.container.textContent, /Send a test notice/);
  } finally {
    await page.unmount();
  }
});

test("without the bot the setting says no notices can be sent", async () => {
  notifyInstances = [];
  try {
    const page = await render({});
    try {
      assert.match(
        page.container.textContent,
        /The Foundry bot is not available on this server/,
      );
    } finally {
      await page.unmount();
    }
  } finally {
    notifyInstances = [bot];
  }
});

test("a failed list is reported, not shown as no bot", async () => {
  notifyListStatus = 500;
  try {
    const page = await render({});
    try {
      assert.match(
        page.container.textContent,
        /The notice settings could not be read/,
      );
      assert.doesNotMatch(page.container.textContent, /not available/);
    } finally {
      await page.unmount();
    }
  } finally {
    notifyListStatus = 200;
  }
});

const now = Date.parse("2026-11-22T12:00:00Z");
const request = (fields) => ({
  id: "pnd_1",
  workspaceId: "ws_1",
  source: "question",
  state: "open",
  title: "Which day?",
  excerpt: "Which day?",
  occurrences: 1,
  createdAt: "2026-11-21T12:00:00Z",
  updatedAt: "2026-11-21T12:00:00Z",
  ...fields,
});

test("unsent requests of the last 7 days are counted by reason, open requests only", () => {
  const items = [
    request({ id: "a", notice: { skipped: "no_sinks" } }),
    request({ id: "b", notice: { skipped: "no_sinks" } }),
    request({ id: "c", notice: { skipped: "bot_not_paired" } }),
    request({ id: "sent", notice: { state: "sent" } }),
    request({
      id: "old",
      createdAt: "2026-11-10T12:00:00Z",
      notice: { skipped: "no_sinks" },
    }),
    request({
      id: "done",
      state: "done",
      notice: { skipped: "no_sinks" },
    }),
    request({
      id: "note",
      source: "notice",
      notice: { skipped: "no_sinks" },
    }),
    request({
      id: "helper",
      handler: "assistant",
      notice: { skipped: "no_sinks" },
    }),
  ];
  assert.deepEqual(unsentNotices(items, now), {
    count: 3,
    reasons: [
      { reason: "no_sinks", count: 2 },
      { reason: "bot_not_paired", count: 1 },
    ],
  });
  assert.deepEqual(unsentNotices([], now), { count: 0, reasons: [] });
});

test("the setting says how many recent requests were not sent and why; nothing when none", async () => {
  const recent = new Date().toISOString();
  const page = await render(savedDraft, () => {}, [
    request({ id: "a", createdAt: recent, notice: { skipped: "no_sinks" } }),
    request({
      id: "b",
      createdAt: recent,
      notice: { skipped: "kind_not_taken" },
    }),
    request({
      id: "c",
      createdAt: recent,
      notice: { skipped: "kind_not_taken" },
    }),
  ]);
  try {
    const summary = page.container.querySelector(".fdy-pa-notify-unsent");
    assert.ok(summary, "the summary is shown");
    assert.match(
      summary.textContent,
      /3 requests in the last 7 days were not sent/,
    );
    assert.match(
      summary.textContent,
      /2 because the notice setting leaves this kind out/,
    );
    assert.match(summary.textContent, /1 because no notice channel is set/);
  } finally {
    await page.unmount();
  }
  const quiet = await render(savedDraft, () => {}, [
    request({ id: "s", notice: { state: "sent" } }),
  ]);
  try {
    assert.equal(quiet.container.querySelector(".fdy-pa-notify-unsent"), null);
  } finally {
    await quiet.unmount();
  }
});
