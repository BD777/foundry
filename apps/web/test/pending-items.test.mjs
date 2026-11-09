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
  "PopStateEvent",
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
  pendingFailure,
  pendingHeadline,
  pendingOptionLabel,
  pendingPrimary,
  pendingReplyText,
} = await import("../src/features/pending/pending-model.ts");
const { PendingFeature } =
  await import("../src/features/pending/pending-feature.tsx");
const { usePendingItems } =
  await import("../src/features/pending/use-pending-items.ts");
const { parseAppRoute, pathForAppRoute } = await import("../src/lib/routes.ts");
const { issuesEnabled } = await import("../src/lib/feature-flags.ts");

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

test("a failed turn is read for what fixes it, and every item has one first action", () => {
  const failed = (text) =>
    item({ source: "turn_failed", title: text.split("\n")[0], excerpt: text });
  assert.deepEqual(
    pendingFailure(
      failed(
        "You've hit your weekly limit · resets Nov 6, 2pm (America/Toronto)",
      ),
    ),
    { kind: "usage_limit", resets: "Nov 6, 2pm (America/Toronto)" },
  );
  assert.deepEqual(pendingFailure(failed("rate_limit_exceeded")), {
    kind: "usage_limit",
  });
  assert.deepEqual(
    pendingFailure(
      failed(
        "This chat uses foundry_codex_provider_llm_gateway, but your current provider is openai. Switch to foundry_codex_provider_llm_gateway to continue.",
      ),
    ),
    {
      kind: "provider_mismatch",
      chatProvider: "foundry_codex_provider_llm_gateway",
      currentProvider: "openai",
    },
  );
  assert.equal(
    pendingFailure(failed("write: ENOSPC: no space left on device")).kind,
    "disk_full",
  );
  assert.equal(
    pendingFailure(failed("Codex exited with code 1")).kind,
    "other",
  );
  assert.equal(pendingFailure(item({})), undefined);

  assert.equal(pendingPrimary(item({ options: ["A", "B"] })), "options");
  assert.equal(pendingPrimary(item({})), "reply");
  assert.equal(pendingPrimary(failed("boom")), "open");
  assert.equal(
    pendingPrimary(item({ source: "needs_hands", rule: "permission" })),
    "open",
  );
  assert.equal(
    pendingPrimary(item({ source: "account", sessionId: undefined })),
    "open",
  );
  assert.equal(pendingPrimary(item({ state: "done" })), "none");
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
    if (path.includes("/models"))
      return answer([{ id: "gemini-3.8-flash-high" }]);
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

async function openMenu(host, label) {
  const trigger = host.querySelector(`button[aria-label="${label}"]`);
  assert.ok(trigger, `menu ${label}`);
  await act(async () =>
    trigger.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  return [...document.querySelectorAll('[role="menuitem"]')].map((node) =>
    node.textContent.trim(),
  );
}

const menuItem = (name) =>
  [...document.querySelectorAll('[role="menuitem"]')].find(
    (node) => node.textContent.trim() === name,
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
  // The recommended option is the filled one, saying so in words.
  const recommended = host.querySelector(
    'button[aria-label="Reply with “Alpha” (recommended)"]',
  );
  assert.ok(recommended, host.innerHTML);
  assert.match(recommended.className, /fdy-button-primary/);
  assert.match(recommended.textContent, /Alpha· Recommended/);
  // Done, Dismiss, the message and the context wait in one menu.
  assert.equal(buttonNamed(host, "Dismiss"), undefined);
  assert.equal(buttonNamed(host, "Open message"), undefined);
  assert.ok(buttonNamed(host, "Reply"));
  // An option is the answer: one click sends it into the chat.
  await act(async () =>
    host
      .querySelector('button[aria-label="Reply with “Run them too”"]')
      .click(),
  );
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
  // Marking it done changes it by hand, from the item's menu.
  const menu = await openMenu(host, "More for “Keep the closed rows blocked?”");
  assert.deepEqual(menu, [
    "Open message",
    "Show context",
    "Mark done",
    "Dismiss",
  ]);
  await act(async () => menuItem("Mark done").click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const state = calls.find((call) =>
    call.path.includes("/api/pending-items/pnd_1/state"),
  );
  assert.deepEqual(state.body, { state: "done" });
  await act(async () => root.unmount());
  host.remove();
});

test("while Issues are hidden their items are not listed or counted", async (t) => {
  if (issuesEnabled)
    return t.skip("Issues are shown (src/lib/feature-flags.ts)");
  const list = {
    open: 2,
    bySession: { sess_1: 1 },
    items: [
      item({ id: "chat" }),
      item({
        id: "issue",
        source: "issue_question",
        issueId: "iss_1",
        title: "Ship it",
      }),
    ],
  };
  const { host, root } = await render(list);
  assert.doesNotMatch(host.textContent, /Ship it|Issue question/);
  assert.match(host.textContent, /Open · 1/);
  await act(async () => root.unmount());
  host.remove();
});

test("an Issue's question is answered on the Issue, not in a chat", async (t) => {
  if (!issuesEnabled)
    return t.skip("Issues are hidden (src/lib/feature-flags.ts)");
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

test("a failed turn leads with what happened and its fix; the raw error waits in the menu", async () => {
  const error =
    "You've hit your weekly limit · resets Nov 6, 2pm (America/Toronto)";
  const list = {
    open: 1,
    bySession: { sess_1: 1 },
    items: [
      item({
        source: "turn_failed",
        title: error,
        excerpt: error,
        occurrences: 3,
      }),
    ],
  };
  const { host, root } = await render(list);
  assert.equal(
    host.querySelector(".fdy-pending-item-title").textContent,
    "Usage limit reached",
  );
  assert.match(
    host.querySelector(".fdy-pending-item-fix").textContent,
    /Resets Nov 6, 2pm \(America\/Toronto\)\./,
  );
  assert.match(host.textContent, /Turn failed·.*·Seen 3 times/);
  assert.doesNotMatch(host.textContent, /weekly limit/);
  assert.ok(buttonNamed(host, "Fix in chat"));
  assert.ok(buttonNamed(host, "Reply"));
  const menu = await openMenu(host, "More for “Usage limit reached”");
  assert.deepEqual(menu, ["Show the error", "Mark done", "Dismiss"]);
  await act(async () => menuItem("Show the error").click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.match(
    host.querySelector(".fdy-pending-item-shown").textContent,
    /weekly limit/,
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

test("the open chat pins what it waits for above its composer, and opens into the items", async () => {
  const { PendingChatBar } =
    await import("../src/features/pending/pending-chat-bar.tsx");
  const pending = {
    list: {
      open: 2,
      bySession: { sess_1: 2 },
      items: [
        item({ id: "a", title: "Keep the closed rows blocked?" }),
        item({ id: "b", title: "Ship on Friday?" }),
        item({ id: "c", sessionId: "sess_2", title: "Elsewhere?" }),
        item({ id: "d", state: "done", title: "Already done?" }),
      ],
    },
    changeState: async () => undefined,
    reply: async () => undefined,
    refresh: () => undefined,
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(PendingChatBar, { pending, sessionId: "sess_1" }),
    ),
  );
  const bar = host.querySelector("section");
  assert.match(bar.textContent, /Waiting on you · 2/);
  assert.match(bar.textContent, /Keep the closed rows blocked\?/);
  assert.doesNotMatch(bar.textContent, /Ship on Friday\?/);
  const toggle = bar.querySelector("button[aria-expanded]");
  await act(async () => toggle.click());
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  // Open, it shows one item at a time, compact, and steps to the next.
  assert.equal(bar.querySelectorAll("article").length, 1);
  assert.match(bar.textContent, /1 of 2/);
  assert.match(bar.textContent, /Keep the closed rows blocked\?/);
  assert.equal(
    bar.querySelector('button[aria-label="Previous item"]').disabled,
    true,
  );
  await act(async () =>
    bar.querySelector('button[aria-label="Next item"]').click(),
  );
  assert.match(bar.textContent, /2 of 2/);
  assert.match(bar.textContent, /Ship on Friday\?/);
  assert.doesNotMatch(bar.textContent, /Elsewhere\?|Already done\?/);
  // A chat with nothing open shows nothing.
  await act(async () =>
    root.render(
      createElement(PendingChatBar, { pending, sessionId: "sess_9" }),
    ),
  );
  assert.equal(host.querySelector("section"), null);
  await act(async () => root.unmount());
  host.remove();
});

test("an account or a device's sign-in waits in its own group and opens its Connectors tab", async () => {
  const list = {
    open: 2,
    bySession: {},
    items: [
      item({
        id: "acct",
        source: "account",
        rule: "feishu",
        workspaceId: "",
        workspaceName: "",
        sessionId: undefined,
        sessionTitle: undefined,
        title: "Alice Feishu",
        excerpt: "refresh_token_expired",
      }),
      item({
        id: "conn",
        source: "connector",
        rule: "gh",
        workspaceId: "",
        workspaceName: "",
        sessionId: undefined,
        sessionTitle: undefined,
        title: "GitHub CLI · byte-dev",
        excerpt: "alice",
      }),
    ],
  };
  const { host, root } = await render(list);
  const group = host.querySelector(
    'section[aria-label*="Your accounts and devices"]',
  );
  assert.ok(group, host.textContent);
  assert.match(group.textContent, /Authorize Alice Feishu again/);
  assert.match(group.textContent, /Sign in again: GitHub CLI · byte-dev/);
  // Its words are the headline; the status code is not shown as an excerpt.
  assert.doesNotMatch(group.textContent, /refresh_token_expired/);
  assert.equal(buttonNamed(group, "Open chat"), undefined);
  assert.equal(buttonNamed(group, "Reply"), undefined);
  const open = [...group.querySelectorAll("button")].filter((button) =>
    /Open Connectors/.test(button.textContent),
  );
  assert.equal(open.length, 2);
  await act(async () => open[1].click());
  assert.match(window.location.pathname, /\/connectors\/gh$/);
  await act(async () => root.unmount());
  host.remove();
});

test("one list: what the assistant handles waits apart, what came to the person says why (§h)", async () => {
  const list = {
    open: 2,
    assistantOpen: 1,
    bySession: { sess_1: 1, sess_2: 1 },
    items: [
      item({
        id: "theirs",
        sessionId: "sess_1",
        title: "Which colour for the header?",
        excerpt: "Which colour for the header?",
        handler: "person",
        note: "The helper needs your pick of colour before it goes on.",
        handedReason: "assistant",
      }),
      item({
        id: "offline",
        sessionId: "sess_2",
        sessionTitle: "Export",
        source: "turn_failed",
        title: "provider error",
        excerpt: "provider error",
        handler: "person",
        handedReason: "assistant_offline",
      }),
      item({
        id: "yours",
        sessionId: "sess_3",
        sessionTitle: "Helper",
        source: "helper_stuck",
        title: "Cannot reach its model service",
        excerpt: "Cannot reach its model service",
        handler: "assistant",
      }),
    ],
  };
  const { host, root } = await render(list);
  assert.match(host.textContent, /Needs you/);
  assert.match(
    host.textContent,
    /Your assistant: The helper needs your pick of colour/,
  );
  assert.match(
    host.textContent,
    /its computer is offline, so this came to you/,
  );
  // The assistant's own item is not in the person's groups.
  const disclosure = host.querySelector("details");
  assert.ok(disclosure, "assistant group");
  assert.match(
    disclosure.querySelector("summary").textContent,
    /Your assistant is handling · 1/,
  );
  const groups = [...host.querySelectorAll("section")].filter(
    (section) => !disclosure.contains(section) && !section.contains(disclosure),
  );
  assert.ok(groups.length >= 2, "the person's groups");
  assert.ok(
    groups.every(
      (section) => !/Cannot reach its model/.test(section.textContent),
    ),
  );
  // Shown, not acted on: no reply, done or dismiss for the assistant's item.
  const yours = [...disclosure.querySelectorAll("article")];
  assert.equal(yours.length, 1);
  assert.equal(
    [...yours[0].querySelectorAll("button")].some((b) =>
      /Reply|Fix in chat/.test(b.textContent),
    ),
    false,
  );
  // Counts are the person's.
  const { pendingForSession, needsYouSummary } =
    await import("../src/features/pending/pending-model.ts");
  assert.equal(pendingForSession(list.items, "sess_3").length, 0);
  assert.deepEqual(
    needsYouSummary(list.items, list.open).items.map((shown) => shown.id),
    ["theirs", "offline"],
  );
  await act(async () => root.unmount());
  host.remove();
});

test("a missing GitHub scope opens the session device's permission picker with it selected (DEV-136)", async () => {
  const { pendingGitHubScopes, pendingPrimary } =
    await import("../src/features/pending/pending-model.ts");
  const base = {
    id: "p1",
    workspaceId: "ws",
    sessionId: "sess_1",
    source: "needs_hands",
    rule: "github_scope",
    state: "open",
    occurrences: 1,
    createdAt: "2026-11-06T00:00:00Z",
    updatedAt: "2026-11-06T00:00:00Z",
  };
  const gh = {
    ...base,
    deviceId: "dev_1",
    title:
      "error: your authentication token is missing required scopes [read:packages, workflow]",
    excerpt: "",
  };
  assert.equal(pendingPrimary(gh), "grant");
  assert.deepEqual(pendingGitHubScopes(gh), ["read:packages", "workflow"]);
  const git = {
    ...gh,
    title:
      " ! [remote rejected] main -> main (refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)",
  };
  assert.deepEqual(pendingGitHubScopes(git), ["workflow"]);
  // Without the session's device there is nowhere to grant it: the chat.
  assert.equal(pendingPrimary({ ...gh, deviceId: undefined }), "open");
  assert.equal(pendingPrimary({ ...gh, state: "done" }), "none");
  assert.deepEqual(pendingGitHubScopes({ ...gh, rule: "login" }), []);
});
