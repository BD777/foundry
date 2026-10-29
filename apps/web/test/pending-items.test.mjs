import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({ url: "https://foundry.example/" });
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "HTMLFormElement",
  "MutationObserver",
  "CustomEvent",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "FocusEvent",
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
const {
  groupPendingItems,
  pendingForSession,
  pendingHeadline,
  pendingOptionLabel,
  pendingReplyText,
} = await import("../src/features/pending/pending-model.ts");
const { PendingFeature } =
  await import("../src/features/pending/pending-feature.tsx");
const { usePendingItems } =
  await import("../src/features/pending/use-pending-items.ts");
const { parseAppRoute, pathForAppRoute } =
  await import("../src/app/navigation.ts");

const item = (fields) => ({
  id: "pnd_1",
  workspaceId: "ws_1",
  workspaceName: "Project",
  sessionId: "sess_1",
  sessionTitle: "Fix the export",
  source: "question",
  state: "open",
  title: "Keep the closed rows blocked?",
  excerpt: "Keep the closed rows blocked?",
  occurrences: 1,
  createdAt: "2026-10-29T08:00:00Z",
  updatedAt: "2026-10-29T08:00:00Z",
  ...fields,
});

test("items group by chat or Issue, newest first, open apart from resolved", () => {
  const items = [
    item({ id: "a", updatedAt: "2026-10-29T08:00:00Z" }),
    item({
      id: "b",
      sessionId: "sess_2",
      sessionTitle: "",
      updatedAt: "2026-10-29T09:00:00Z",
    }),
    item({ id: "c", state: "replied", updatedAt: "2026-10-29T10:00:00Z" }),
    item({
      id: "d",
      source: "issue_question",
      issueId: "iss_1",
      title: "Ship it",
      updatedAt: "2026-10-29T07:00:00Z",
    }),
  ];
  const open = groupPendingItems(items, "open", "Untitled");
  assert.deepEqual(
    open.map((group) => [group.key, group.title, group.items.map((x) => x.id)]),
    [
      ["session:sess_2", "Untitled", ["b"]],
      ["session:sess_1", "Fix the export", ["a"]],
      ["issue:iss_1", "Ship it", ["d"]],
    ],
  );
  assert.deepEqual(
    groupPendingItems(items, "resolved", "Untitled").map((group) =>
      group.items.map((x) => x.id),
    ),
    [["c"]],
  );
  // A chat's own list leaves its Issue's question out and puts open first.
  assert.deepEqual(
    pendingForSession(items, "sess_1").map((x) => x.id),
    ["a", "c"],
  );
});

test("a reply quotes the item's own words, line by line", () => {
  assert.equal(
    pendingReplyText(
      item({ excerpt: "Line one\n\nLine two" }),
      "  Keep them  ",
    ),
    "> Line one\n>\n> Line two\n\nKeep them",
  );
});

test("an item's words are shown once: the excerpt only when it adds to the headline", () => {
  assert.deepEqual(pendingHeadline(item({})), {
    text: "Keep the closed rows blocked?",
    showExcerpt: false,
  });
  const failed = item({
    source: "turn_failed",
    title: "API Error: 503",
    excerpt: "API Error: 503\nretry later",
  });
  assert.equal(pendingHeadline(failed).showExcerpt, true);
  const denied = item({
    source: "needs_hands",
    rule: "permission",
    title: "cat: /etc/shadow: Permission denied",
    excerpt: "cat: /etc/shadow: Permission denied",
  });
  assert.deepEqual(pendingHeadline(denied), {
    text: denied.title,
    pathDenied: "/etc/shadow",
    showExcerpt: false,
  });
  const traceback = item({
    source: "needs_hands",
    rule: "permission",
    title: "Traceback (most recent call last):",
    excerpt:
      "Traceback (most recent call last):\n  File x\nPermissionError: [Errno 13] Permission denied: '/etc/shadow'",
  });
  assert.equal(pendingHeadline(traceback).pathDenied, "/etc/shadow");
  assert.equal(pendingHeadline(traceback).showExcerpt, true);
  const issue = item({
    source: "issue_question",
    issueId: "iss_1",
    title: "Ship it",
    excerpt: "May I deploy?",
  });
  assert.deepEqual(pendingHeadline(issue), {
    text: "Ship it",
    showExcerpt: true,
  });
});

test("an option drops the Agent's own recommended mark", () => {
  assert.equal(pendingOptionLabel("Alpha (Recommended)"), "Alpha");
  assert.equal(pendingOptionLabel("保留（推荐）"), "保留");
  assert.equal(pendingOptionLabel("Beta"), "Beta");
});

test("the Pending page has its own global route", () => {
  assert.deepEqual(parseAppRoute("/pending"), { view: "pending" });
  assert.equal(pathForAppRoute({ view: "pending" }), "/pending");
});

const answer = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function Page() {
  const pending = usePendingItems();
  return createElement(PendingFeature, { pending });
}

async function render(list) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    calls.push({
      path,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    if (path.endsWith("/api/pending-items")) return answer(list);
    if (path.includes("/state"))
      return answer({ ...list.items[0], state: "done" });
    if (path.includes("/queue"))
      return answer({ chatId: "sess_1", revision: 1, items: [] });
    if (path.includes("/answer")) return answer({ id: "iss_1" });
    return answer({});
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Page)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  return { host, root, calls };
}

const buttonNamed = (host, name) =>
  [...host.querySelectorAll("button")].find(
    (button) => button.textContent.trim() === name,
  );

test("the page shows an item in its own words and replies into its chat", async () => {
  const list = {
    open: 1,
    bySession: { sess_1: 1 },
    items: [
      item({
        options: ["Alpha (Recommended)", "Run them too"],
        recommendation: "Alpha (Recommended)",
        context: "I checked the nine rows.",
        occurrences: 2,
      }),
    ],
  };
  const { host, root, calls } = await render(list);
  assert.match(host.textContent, /Open · 1/);
  // The question is the headline, shown once; its context stays folded.
  assert.equal(host.querySelectorAll(".fdy-pending-item-excerpt").length, 0);
  assert.match(
    host.querySelector(".fdy-pending-item-title").textContent,
    /Keep the closed rows blocked\?/,
  );
  assert.match(host.textContent, /Seen 2 times/);
  // One recommended mark: the tag, not the Agent's own suffix as well.
  assert.equal(
    host.querySelectorAll(".fdy-pending-item-recommended").length,
    1,
  );
  assert.ok(buttonNamed(host, "AlphaRecommended"));
  // An option starts a reply with its words; sending steers it into the chat.
  await act(async () => buttonNamed(host, "Run them too").click());
  const textarea = host.querySelector("textarea");
  assert.equal(textarea.value, "Run them too");
  await act(async () => buttonNamed(host, "Send").click());
  const sent = calls.find((call) =>
    call.path.includes("/api/chats/sess_1/queue"),
  );
  assert.ok(sent, JSON.stringify(calls));
  assert.equal(sent.method, "POST");
  assert.equal(sent.body.steer, true);
  assert.equal(
    sent.body.text,
    "> Keep the closed rows blocked?\n\nRun them too",
  );
  // Marking it done changes it by hand.
  await act(async () =>
    host.querySelector('button[aria-label="Mark done"]').click(),
  );
  const state = calls.find((call) =>
    call.path.includes("/api/pending-items/pnd_1/state"),
  );
  assert.deepEqual(state.body, { state: "done" });
  await act(async () => root.unmount());
  host.remove();
});

test("an Issue's question is answered on the Issue, not in a chat", async () => {
  const list = {
    open: 1,
    bySession: {},
    items: [
      item({
        source: "issue_question",
        issueId: "iss_1",
        eventId: "question_1",
        rule: "permission",
        title: "Ship it",
        excerpt: "May I deploy?",
      }),
    ],
  };
  const { host, root, calls } = await render(list);
  assert.match(host.textContent, /Issue question/);
  await act(async () => buttonNamed(host, "Reply").click());
  const textarea = host.querySelector("textarea");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    ).set;
    setter.call(textarea, "Yes");
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => buttonNamed(host, "Send").click());
  const answered = calls.find((call) =>
    call.path.includes("/api/issues/iss_1/answer"),
  );
  assert.deepEqual(answered?.body, { questionId: "question_1", answer: "Yes" });
  assert.equal(
    calls.some((call) => call.path.includes("/queue")),
    false,
  );
  await act(async () => root.unmount());
  host.remove();
});

test("with nothing pending the page says so", async () => {
  const { host, root } = await render({ open: 0, bySession: {}, items: [] });
  assert.match(host.textContent, /Nothing waits for you/);
  await act(async () => root.unmount());
  host.remove();
});
