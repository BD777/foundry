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
const { NeedsYouSection, UnprocessedSection, needsYouFromLine } =
  await import("../src/features/personal-agent/assistant-side-card.tsx");
const { inboxReason, inboxSummaryReason, sideSummary } =
  await import("../src/features/personal-agent/assistant-model.ts");

async function render(component, props) {
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

function needs(id, fields) {
  return {
    id,
    workspaceId: "",
    state: "open",
    excerpt: fields.title,
    occurrences: 1,
    createdAt: "2026-11-13T01:00:00Z",
    updatedAt: "2026-11-13T01:00:00Z",
    ...fields,
  };
}

// The rows of the assistant's home say what is needed, never just a name,
// and where it came from, never an id (the 「邓灿文」 rows: account items
// whose title is the account's name).
test("needs-you rows say what is needed and where, without ids", async () => {
  let opened = 0;
  const page = await render(NeedsYouSection, {
    needsYou: {
      open: 4,
      items: [
        needs("a", {
          source: "account",
          rule: "feishu",
          title: "邓灿文",
          eventId: "account-scopes:xacc_1|feishu-cli v1.44.0",
          context: "feishu-cli v1.44.0",
          excerpt: "okr:okr.content:readonly task:comment:read",
          from: { kind: "personal", name: "feishu" },
        }),
        needs("q", {
          source: "question",
          title: "Commit with --no-verify this once?",
          from: {
            kind: "chat",
            name: "这两个session以及他们的sub",
            detail: "ccm",
          },
        }),
        needs("h", {
          source: "question",
          title: "Which export format?",
          from: { kind: "helper", name: "dev8" },
        }),
      ],
    },
    onOpenAll: () => opened++,
  });
  const text = page.container.textContent;
  assert.match(text, /Needs you\s*4/);
  assert.match(
    text,
    /Authorize 邓灿文 again: feishu-cli v1\.44\.0 needs 2 more permissions/,
  );
  assert.match(text, /Your accounts and devices/);
  assert.match(text, /ccm · 这两个session以及他们的sub/);
  assert.match(text, /Assistant · helper “dev8”/);
  assert.doesNotMatch(text, /sess_|xacc_/);
  const rows = page.container.querySelectorAll(".fdy-chat-context-row");
  assert.equal(rows.length, 3);
  await act(async () => rows[0].click());
  page.container
    .querySelector('button[aria-label="See everything that needs you"]')
    .click();
  assert.equal(opened, 2);
  await page.unmount();
});

test("when this assistant sees less than the sidebar counts, the card says so", async () => {
  let opened = 0;
  const one = needs("q", {
    source: "question",
    title: "Which export format?",
    from: { kind: "helper", name: "dev8" },
  });
  const page = await render(NeedsYouSection, {
    needsYou: { open: 3, items: [one] },
    total: 4,
    onOpenAll: () => opened++,
  });
  assert.match(page.container.textContent, /Needs you · this assistant\s*3/);
  const all = page.container.querySelector(
    'button[aria-label="See all 4 things that need you"]',
  );
  assert.equal(all.textContent, "All 4");
  await act(async () => all.click());
  assert.equal(opened, 1);
  await page.unmount();
  // The same count reads plainly; nothing for this assistant still links
  // to the rest.
  const same = await render(NeedsYouSection, {
    needsYou: { open: 4, items: [one] },
    total: 4,
    onOpenAll: () => {},
  });
  assert.match(same.container.textContent, /^Needs you4All/);
  await same.unmount();
  const none = await render(NeedsYouSection, {
    needsYou: { open: 0, items: [] },
    total: 2,
    onOpenAll: () => {},
  });
  assert.equal(none.container.textContent, "Needs you · this assistantAll 2");
  await none.unmount();
});

test("an empty needs-you section is one quiet line", async () => {
  const page = await render(NeedsYouSection, {
    needsYou: { open: 0, items: [] },
    onOpenAll: () => {},
  });
  assert.equal(page.container.textContent, "Needs youNothing");
  await page.unmount();
});

test("where an item came from reads in names", () => {
  const t = i18n.getFixedT("en", "personalAgent");
  assert.equal(
    needsYouFromLine({ kind: "channel", name: "飞书私聊", detail: "浩辉" }, t),
    "飞书私聊 · 浩辉",
  );
  assert.equal(
    needsYouFromLine({ kind: "chat", name: "", detail: "Budget" }, t),
    "A chat in Budget",
  );
  assert.equal(needsYouFromLine({ kind: "helper" }, t), "Assistant · helper");
  // The assistant's own chat, unnamed: never "Assistant · Assistant".
  assert.equal(
    needsYouFromLine({ kind: "assistant" }, t),
    "Your assistant's chat",
  );
});

const quota = {
  id: "in_1",
  text: "你好",
  status: "delivered",
  resultStatus: "failed",
  sessionId: "sess_9",
  resultError:
    "API Error: Request rejected (429) · upstream account quota usage limit has been reached",
  resultFailure: {
    category: "quota_exhausted",
    resetAt: "2026-11-13T04:02:00Z",
  },
};

test("a failed message's reason is the server's classification", () => {
  const before = new Date("2026-11-13T03:00:00Z");
  assert.deepEqual(inboxReason(quota, before), {
    kind: "quota_exhausted",
    resetAt: "2026-11-13T04:02:00Z",
    resetPassed: false,
  });
  assert.equal(
    inboxReason(quota, new Date("2026-11-13T05:00:00Z")).resetPassed,
    true,
  );
  assert.deepEqual(
    inboxReason(
      { ...quota, resultFailure: undefined, resultStatus: "canceled" },
      before,
    ),
    { kind: "canceled" },
  );
  // A stop the person asked for reads as stopped, even when the server
  // classified its "Stopped: person_requested" error as other.
  assert.deepEqual(
    inboxReason(
      {
        ...quota,
        resultStatus: "canceled",
        resultError: "Stopped: person_requested",
        resultFailure: { category: "other" },
      },
      before,
    ),
    { kind: "canceled" },
  );
  assert.equal(
    inboxSummaryReason(
      [quota, { ...quota, resultFailure: { category: "other" } }],
      before,
    ),
    undefined,
  );
});

test("unprocessed messages read as one line, the error behind Details", async () => {
  const retried = [];
  const page = await render(UnprocessedSection, {
    error: "",
    failed: [
      {
        ...quota,
        resultFailure: {
          ...quota.resultFailure,
          resetAt: "2999-01-01T04:02:00Z",
        },
      },
    ],
    waiting: [],
    retrying: false,
    onRetry: (entry) => retried.push(entry.id),
  });
  const text = page.container.textContent;
  // One message reads as its words and why, on one line; no summary.
  assert.match(text, /“你好” · the model quota ran out; retry after/);
  assert.doesNotMatch(text, /message not processed/);
  const details = page.container.querySelector("details");
  assert.ok(details && !details.open);
  assert.match(details.textContent, /Request rejected \(429\)/);
  const retry = [...page.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  );
  await act(async () => retry.click());
  assert.deepEqual(retried, ["in_1"]);
  await page.unmount();
});

test("several messages with one reason are summed up once", async () => {
  const later = {
    ...quota,
    resultFailure: { ...quota.resultFailure, resetAt: "2999-01-01T04:02:00Z" },
  };
  const page = await render(UnprocessedSection, {
    error: "",
    failed: [later, { ...later, id: "in_2", text: "再试一次" }],
    waiting: [],
    retrying: false,
    onRetry: () => {},
  });
  const text = page.container.textContent;
  assert.match(text, /2 messages not processed: the model quota ran out/);
  assert.match(text, /“你好”/);
  assert.match(text, /“再试一次”/);
  assert.equal(text.match(/quota ran out/g).length, 1);
  await page.unmount();
});

test("with nothing unprocessed the section is not there", async () => {
  const page = await render(UnprocessedSection, {
    error: "",
    failed: [],
    waiting: [],
    retrying: false,
    onRetry: () => {},
  });
  assert.equal(page.container.textContent, "");
  await page.unmount();
});

test("the narrow summary names only the sections that hold something", () => {
  const t = i18n.getFixedT("zh-CN", "personalAgent");
  const parts = sideSummary({ needsYou: 4, unprocessed: 1, list: 4, tasks: 0 });
  assert.equal(
    parts.map((part) => t(part.key, { count: part.count })).join(" · "),
    "等你处理 4 · 没处理 1 · 清单 4",
  );
  assert.deepEqual(
    sideSummary({ needsYou: 0, unprocessed: 0, list: 0, tasks: 0 }),
    [],
  );
});
