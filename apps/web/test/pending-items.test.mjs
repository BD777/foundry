import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import {
  agentQuestionReplyText,
  nativeQuestionItemId,
} from "@bd777/foundry-protocol";

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
  pendingFocusItemId,
  pendingInboxReason,
  pendingItemDomId,
  pendingOptionLabel,
  pendingMatchesAssistant,
  pendingOrigin,
  pendingPrimary,
  pendingReplyRoute,
  pendingReplyText,
  pendingStatusKey,
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

test("an item names its assistant, chat or project and filters by that scope", () => {
  const work = item({
    id: "work",
    assistantId: "asst_work",
    assistantName: "Work",
  });
  const chat = item({ id: "chat" });
  const project = item({
    id: "project",
    sessionId: undefined,
    sessionTitle: undefined,
  });
  const personal = item({
    id: "personal",
    source: "account",
    workspaceId: "",
    workspaceName: "",
    sessionId: undefined,
    sessionTitle: undefined,
  });
  assert.deepEqual(pendingOrigin(work, "Untitled", "Personal", "Default"), {
    kind: "assistant",
    name: "Work",
  });
  assert.deepEqual(pendingOrigin(chat, "Untitled", "Personal", "Default"), {
    kind: "chat",
    name: "Fix the export",
  });
  assert.deepEqual(pendingOrigin(project, "Untitled", "Personal", "Default"), {
    kind: "project",
    name: "Project",
  });
  assert.deepEqual(pendingOrigin(personal, "Untitled", "Personal", "Default"), {
    kind: "personal",
    name: "Personal",
  });
  assert.equal(pendingMatchesAssistant(work, "assistant:asst_work"), true);
  assert.equal(pendingMatchesAssistant(chat, "assistant:asst_work"), false);
  assert.equal(pendingMatchesAssistant(chat, "none"), true);
  assert.equal(pendingMatchesAssistant(work, "all"), true);
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

test("a question's reply names the runtime's call id, as the question card does", () => {
  const asked = item({
    source: "question",
    title: "a.txt or b.txt?",
    messageId: "01a1eca1-8475-7bbe-b3b9-5b01c61d7d28/call_7aa501bc",
    sessionId: "sess_helper",
  });
  assert.equal(
    pendingReplyText(asked, "b.txt"),
    agentQuestionReplyText(
      "call_7aa501bc",
      [{ title: "a.txt or b.txt?" }],
      ["b.txt"],
    ),
  );
  assert.equal(nativeQuestionItemId("turn-1/call_x"), "call_x");
  assert.equal(nativeQuestionItemId("call_x"), "call_x");
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
    if (path.endsWith("/api/pending-items"))
      return answer({ assistants: [], ...list });
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

test("the global page labels where every item came from and filters by assistant", async () => {
  const list = {
    open: 3,
    assistantOpen: 0,
    bySession: { sess_a: 1, sess_b: 1, sess_none: 1 },
    assistants: [
      { id: "asst_a", name: "Work", isDefault: false },
      { id: "asst_b", name: "Home", isDefault: true },
    ],
    items: [
      item({
        id: "a",
        assistantId: "asst_a",
        assistantName: "Work",
        sessionId: "sess_a",
        sessionTitle: "Quarterly plan",
        title: "Work question",
      }),
      item({
        id: "b",
        assistantId: "asst_b",
        assistantName: "Home",
        sessionId: "sess_b",
        sessionTitle: "Trip",
        title: "Home question",
      }),
      item({
        id: "none",
        sessionId: "sess_none",
        sessionTitle: "Personal project",
        title: "Unassigned question",
      }),
    ],
  };
  const { host, root } = await render(list);
  assert.match(host.textContent, /Assistant · Work/);
  assert.match(host.textContent, /Assistant · Home/);
  assert.match(host.textContent, /Chat · Personal project/);
  await act(async () => buttonNamed(host, "Work").click());
  assert.match(host.textContent, /Work question/);
  assert.doesNotMatch(host.textContent, /Home question|Unassigned question/);
  await act(async () =>
    buttonNamed(host, "Not assigned to an assistant").click(),
  );
  assert.match(host.textContent, /Unassigned question/);
  assert.doesNotMatch(host.textContent, /Work question|Home question/);
  await act(async () => buttonNamed(host, "All").click());
  assert.match(host.textContent, /Work question/);
  assert.match(host.textContent, /Home question/);
  assert.match(host.textContent, /Unassigned question/);
  await act(async () => root.unmount());
  host.remove();
});

const menuItem = (name) =>
  [...document.querySelectorAll('[role="menuitem"]')].find(
    (node) => node.textContent.trim() === name,
  );

/**
 * The name a screen reader (and getByRole) gives a button: its aria-label,
 * else its text without aria-hidden parts.
 */
function accessibleName(element) {
  if (element.hasAttribute("aria-label"))
    return element.getAttribute("aria-label").trim();
  const copy = element.cloneNode(true);
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]'))
    hidden.remove();
  return copy.textContent.trim();
}

const optionButton = (host, label) =>
  [...host.querySelectorAll("button")].find(
    (button) => accessibleName(button) === label,
  );

test("an option is a button named by its label; the recommended mark is described, not named (DEV-296)", async () => {
  const list = {
    open: 1,
    bySession: { sess_1: 1 },
    items: [
      item({
        source: "assistant_question",
        title: "Which test file should I use?",
        excerpt: "Which test file should I use?",
        options: ["a.txt", "b.txt"],
        recommendation: "a.txt",
      }),
    ],
  };
  const { host, root, calls } = await render(list);
  const first = optionButton(host, "a.txt");
  const second = optionButton(host, "b.txt");
  assert.ok(first, host.innerHTML);
  assert.ok(second, host.innerHTML);
  for (const option of [first, second]) {
    assert.equal(option.tagName, "BUTTON");
    assert.equal(option.type, "button");
    assert.equal(option.hasAttribute("aria-label"), false);
    assert.equal(option.hasAttribute("tabindex"), false);
  }
  // The recommended option says so as its description, not inside its name.
  assert.equal(second.hasAttribute("aria-describedby"), false);
  const described = host.ownerDocument.getElementById(
    first.getAttribute("aria-describedby"),
  );
  assert.equal(described?.textContent, "Recommended");
  assert.match(first.textContent, /Recommended/);
  // A button is answered by its click, which the browser also fires for Enter
  // on the focused button: the reply goes to the question's own answer route.
  await act(async () => second.click());
  const answered = calls.find((call) =>
    call.path.endsWith("/api/pending-items/pnd_1/answer"),
  );
  assert.ok(answered, JSON.stringify(calls));
  assert.equal(answered.method, "POST");
  assert.equal(answered.body.text, "b.txt");
  await act(async () => root.unmount());
  host.remove();
});

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
  const recommended = optionButton(host, "Alpha");
  assert.ok(recommended, host.innerHTML);
  assert.match(recommended.className, /fdy-button-primary/);
  assert.match(recommended.textContent, /Alpha· Recommended/);
  // Done, the message and the context wait in one menu; "Not for me" is direct.
  assert.ok(buttonNamed(host, "Not for me"));
  assert.equal(buttonNamed(host, "Open message"), undefined);
  assert.ok(buttonNamed(host, "Reply"));
  // An option is the answer: one click sends it into the chat.
  await act(async () => optionButton(host, "Run them too").click());
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
  assert.deepEqual(menu, ["Open message", "Show context", "Mark done"]);
  await act(async () => menuItem("Mark done").click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const state = calls.find((call) =>
    call.path.includes("/api/pending-items/pnd_1/state"),
  );
  assert.deepEqual(state.body, { state: "done" });
  await act(async () => root.unmount());
  host.remove();
});

test("a person can close an item as not needed without a confirmation", async () => {
  const { host, root, calls } = await render({
    open: 1,
    bySession: { sess_1: 1 },
    items: [item({ id: "not_for_me" })],
  });
  const action = buttonNamed(host, "Not for me");
  assert.ok(action);
  await act(async () => action.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const state = calls.find((call) =>
    call.path.includes("/api/pending-items/not_for_me/state"),
  );
  assert.deepEqual(state?.body, { state: "dismissed" });
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
  assert.deepEqual(menu, ["Show the error", "Mark done"]);
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

test("a newer CLI's missing permissions and a rolled-back bundle update are the person's own items (DEV-154)", async () => {
  const list = {
    open: 2,
    bySession: {},
    items: [
      item({
        id: "scopes",
        source: "account",
        rule: "feishu",
        eventId: "account-scopes:fs-account|feishu-cli v1.44.0",
        workspaceId: "",
        workspaceName: "",
        sessionId: undefined,
        sessionTitle: undefined,
        title: "Alice Feishu",
        context: "feishu-cli v1.44.0",
        excerpt: "slides:presentation:screenshot task:section:read",
      }),
      item({
        id: "bundle",
        source: "bundle_update",
        rule: "rolled_back",
        workspaceId: "",
        workspaceName: "",
        sessionId: undefined,
        sessionTitle: undefined,
        title: "feishu-cli v1.44.0",
        excerpt: "the check on the canary sg-chaos failed: auth status",
      }),
      item({
        id: "bundle-failed",
        source: "bundle_update",
        rule: "failed",
        workspaceId: "",
        workspaceName: "",
        sessionId: undefined,
        sessionTitle: undefined,
        title: "@playwright/cli 0.1.23",
        excerpt:
          "installing on the canary sg-chaos failed: download failed: 504",
      }),
    ],
  };
  const { host, root } = await render(list);
  const group = host.querySelector(
    'section[aria-label*="Your accounts and devices"]',
  );
  assert.ok(group, host.textContent);
  assert.match(
    group.textContent,
    /Authorize Alice Feishu again: feishu-cli v1\.44\.0 needs 2 more permissions/,
  );
  assert.match(group.textContent, /Update rolled back: feishu-cli v1\.44\.0/);
  assert.match(
    group.textContent,
    /Update not installed: @playwright\/cli 0\.1\.23/,
  );
  // The rollback says why; the scope list waits for the re-authorization.
  assert.match(group.textContent, /the check on the canary sg-chaos failed/);
  assert.doesNotMatch(group.textContent, /slides:presentation:screenshot/);
  const library = [...group.querySelectorAll("button")].find((button) =>
    /Open Skill Library/.test(button.textContent),
  );
  assert.ok(library, group.textContent);
  await act(async () => library.click());
  assert.match(window.location.pathname, /library/);
  const connectors = [...group.querySelectorAll("button")].find((button) =>
    /Open Connectors/.test(button.textContent),
  );
  await act(async () => connectors.click());
  assert.match(window.location.pathname, /\/connectors\/feishu$/);
  await act(async () => root.unmount());
  host.remove();
});

test("one list: what the assistant handles waits apart, what came to the person says why (§h)", async () => {
  const list = {
    open: 3,
    assistantOpen: 1,
    bySession: { sess_1: 1, sess_2: 1, sess_4: 1 },
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
      item({
        id: "timed-out",
        sessionId: "sess_4",
        sessionTitle: "Weekly report",
        title: "Choose the report format",
        handler: "person",
        handedReason: "assistant_timeout",
        outcome: "escalated_timeout",
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
  assert.match(
    host.textContent,
    /The assistant didn't handle it within 10 minutes/,
  );
  const timedOut = [...host.querySelectorAll("article")].find((article) =>
    article.textContent.includes("Choose the report format"),
  );
  assert.ok(timedOut);
  assert.equal(
    timedOut.querySelector(".fdy-pending-item-reason").textContent,
    "The assistant didn't handle it within 10 minutes",
  );
  assert.doesNotMatch(timedOut.textContent, /Your assistant:/);
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
  const { pendingForSession } =
    await import("../src/features/pending/pending-model.ts");
  assert.equal(pendingForSession(list.items, "sess_3").length, 0);
  await act(async () => root.unmount());
  host.remove();
});

test("an entry names the item it is stuck on and links to it", async () => {
  const { host, root } = await render({
    open: 2,
    bySession: { sess_1: 1, sess_2: 1 },
    items: [
      item({
        id: "pnd_linked",
        itemId: "pai_passport",
        itemAssistantId: "asst_1",
        itemText: "Renew the passport",
      }),
      item({ id: "pnd_free", sessionId: "sess_2", title: "Which day?" }),
    ],
  });
  try {
    const links = [...host.querySelectorAll("a")].filter((link) =>
      link.textContent.startsWith("Item: "),
    );
    assert.equal(links.length, 1);
    assert.equal(links[0].textContent, "Item: Renew the passport");
    assert.equal(
      links[0].getAttribute("href"),
      pathForAppRoute({
        view: "items",
        selectedItemId: "pai_passport",
      }),
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

const inboxItem = (fields) =>
  item({
    id: "pnd_inbox_1",
    source: "assistant_inbox",
    sessionId: undefined,
    sessionTitle: undefined,
    assistantId: "asst_1",
    assistantName: "Ada",
    key: "inbox:ibx_1",
    title: "Draft the Q3 notes",
    excerpt: "Draft the Q3 notes",
    ...fields,
  });

test("an unprocessed message groups under its assistant and says why in one line", () => {
  const t = i18n.getFixedT("en", "pending");
  const failed = inboxItem({
    sessionId: "sess_1",
    failureCategory: "rate_limited",
    context: "429 too many requests",
  });
  const waiting = inboxItem({
    id: "pnd_inbox_2",
    key: "inbox:ibx_2",
    title: "Send the invoice",
    rule: "device_offline",
  });
  const groups = groupPendingItems(
    [failed, waiting],
    "open",
    "Untitled",
    "Personal",
    "Default assistant",
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, "Ada");
  assert.equal(groups[0].items.length, 2);
  // Its actions are its own: retry, not-process and the attempt.
  assert.equal(pendingPrimary(failed), "none");
  assert.equal(
    pendingInboxReason(failed, t),
    "too many model requests; try again shortly",
  );
  assert.equal(
    pendingInboxReason(waiting, t),
    "saved; waiting for the computer",
  );
  const now = new Date("2026-11-16T00:00:00Z");
  assert.equal(
    pendingInboxReason(
      inboxItem({
        failureCategory: "quota_exhausted",
        failureResetAt: "2026-11-15T00:00:00Z",
      }),
      t,
      now,
    ),
    "the model quota should be back; you can retry",
  );
});

test("an unprocessed message's item: retry, not-process and the attempt in one row, the error behind Details", async () => {
  const list = {
    open: 1,
    bySession: { sess_1: 1 },
    items: [
      inboxItem({
        sessionId: "sess_1",
        failureCategory: "rate_limited",
        context: "429 too many requests",
      }),
    ],
  };
  const { host, root, calls } = await render(list);
  const card = host.querySelector('[data-source="assistant_inbox"]');
  assert.ok(card, host.innerHTML);
  assert.match(
    card.textContent,
    /“Draft the Q3 notes” · too many model requests; try again shortly/,
  );
  assert.ok(buttonNamed(card, "Retry"));
  assert.ok(buttonNamed(card, "Don't process"));
  assert.ok(buttonNamed(card, "Open the last attempt"));
  // The error sits in a disclosure, never among the action buttons.
  const details = card.querySelector("details");
  assert.ok(details);
  assert.equal(details.contains(buttonNamed(card, "Retry")), false);
  assert.match(details.textContent, /429 too many requests/);
  await act(async () => buttonNamed(card, "Retry").click());
  const retried = calls.find((call) =>
    call.path.endsWith("/api/pending-items/pnd_inbox_1/retry"),
  );
  assert.ok(retried, JSON.stringify(calls));
  assert.equal(retried.method, "POST");
  assert.match(retried.body.requestId, /^[0-9a-f-]{36}$/);
  await act(async () => buttonNamed(card, "Don't process").click());
  const dismissed = calls.find((call) =>
    call.path.endsWith("/api/pending-items/pnd_inbox_1/state"),
  );
  assert.deepEqual(dismissed.body, { state: "dismissed" });
  await act(async () => root.unmount());
  host.remove();
});

test("a connector write says what would be written where, and allows exactly it", async () => {
  const list = {
    open: 1,
    bySession: {},
    items: [
      item({
        id: "pnd_write_1",
        source: "connector_write",
        assistantId: "asst_1",
        assistantName: "Ada",
        sessionId: undefined,
        sessionTitle: undefined,
        title: "OpenLark",
        excerpt: "hello",
        createdAt: "2026-11-17T04:51:47Z",
        connectorWrite: {
          proposalId: "p_1",
          action: "message",
          accountName: "OpenLark",
          targetType: "conversation",
          targetId: "oc_other",
          targetName: "Gao Yibin",
          text: "hello",
          channelName: "OpenLark",
          conversationKind: "self",
          conversationName: "Me",
        },
      }),
      item({
        id: "pnd_write_2",
        source: "connector_write",
        assistantId: "asst_1",
        assistantName: "Ada",
        sessionId: undefined,
        sessionTitle: undefined,
        title: "OpenLark",
        excerpt: "",
        createdAt: "2026-11-17T05:00:00Z",
        connectorWrite: {
          proposalId: "p_2",
          action: "write",
          accountName: "OpenLark",
          operation: "新建云文档",
          expiresAt: "2099-01-01T00:00:00Z",
          preview: ["docType: docx", "title: DEV-265 授权测试（可删）"],
          body: '{\n  "docType": "docx",\n  "title": "DEV-265 授权测试（可删）"\n}',
          text: "",
        },
      }),
      item({
        id: "pnd_write_3",
        source: "connector_write",
        assistantId: "asst_1",
        assistantName: "Ada",
        sessionId: undefined,
        sessionTitle: undefined,
        title: "OpenLark",
        excerpt: "",
        createdAt: "2026-11-17T05:10:00Z",
        connectorWrite: {
          proposalId: "p_3",
          action: "write",
          accountName: "OpenLark",
          targetType: "conversation",
          targetId: "oc_missing",
          text: "",
        },
      }),
    ],
  };
  const { host, root, calls } = await render(list);
  const card = host.querySelector('[data-source="connector_write"]');
  assert.ok(card, host.innerHTML);
  assert.match(card.textContent, /Allow this write\?/);
  assert.match(
    card.textContent,
    /The assistant wants to message Gao Yibin on OpenLark: hello/,
  );
  assert.match(card.textContent, /from \/ai in OpenLark self chat/);
  assert.doesNotMatch(card.textContent, /oc_other/);
  assert.match(card.textContent, /hello/);
  const cards = [...host.querySelectorAll('[data-source="connector_write"]')];
  assert.equal(cards.length, 3, host.innerHTML);
  // A generic write names the operation, previews its body, and keeps the
  // full JSON behind a disclosure.
  assert.match(
    cards[1].textContent,
    /The assistant wants to run “新建云文档” on OpenLark/,
  );
  assert.match(cards[1].textContent, /docType: docx/);
  assert.match(cards[1].textContent, /title: DEV-265 授权测试（可删）/);
  const details = cards[1].querySelector("details");
  assert.ok(details, cards[1].innerHTML);
  assert.match(details.textContent, /"title": "DEV-265 授权测试（可删）"/);
  assert.match(cards[0].querySelector("time").textContent, /requested/);
  assert.match(cards[1].querySelector("time").textContent, /expires/);
  assert.equal(
    cards[1].querySelector("time").getAttribute("datetime"),
    "2099-01-01T00:00:00Z",
  );
  const requestLine = [...cards[1].querySelectorAll("p")].find((line) =>
    line.textContent.includes("The assistant wants to run"),
  );
  assert.ok(requestLine, cards[1].innerHTML);
  assert.doesNotMatch(requestLine.textContent, /"title"/);
  assert.match(
    cards[2].textContent,
    /The assistant wants to write to unknown conversation \(oc_missing\) on OpenLark/,
  );
  assert.ok(buttonNamed(card, "Allow"));
  assert.ok(buttonNamed(card, "Don't allow"));
  await act(async () => buttonNamed(card, "Allow").click());
  const decided = calls.find((call) =>
    call.path.endsWith("/api/pending-items/pnd_write_1/decide"),
  );
  assert.ok(decided, JSON.stringify(calls));
  assert.equal(decided.method, "POST");
  assert.deepEqual(decided.body, { allow: true });
  await act(async () => buttonNamed(card, "Don't allow")?.click());
  const declined = calls.filter((call) =>
    call.path.endsWith("/api/pending-items/pnd_write_1/decide"),
  );
  assert.deepEqual(declined.at(-1).body, { allow: false });
  await act(async () => root.unmount());
  host.remove();
});

test("an unprocessed message's time is when it was sent, not when its item was recorded", async () => {
  const list = {
    open: 1,
    bySession: {},
    items: [
      inboxItem({
        sessionId: undefined,
        createdAt: "2026-11-16T09:00:00Z",
        messageAt: "2026-11-16T08:12:00Z",
        rule: "device_offline",
      }),
    ],
  };
  const { host, root } = await render(list);
  const time = host.querySelector('[data-source="assistant_inbox"] time');
  assert.ok(time, host.innerHTML);
  assert.equal(time.getAttribute("datetime"), "2026-11-16T08:12:00Z");
  await act(async () => root.unmount());
  host.remove();
});

test("a refused retry says why in the person's words, never the server's sentence", async () => {
  const list = {
    open: 1,
    bySession: { sess_1: 1 },
    items: [
      inboxItem({
        sessionId: "sess_1",
        failureCategory: "rate_limited",
        context: "429 too many requests",
      }),
    ],
  };
  const { host, root } = await render(list);
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url).includes("/api/pending-items/pnd_inbox_1/retry")
      ? answer(
          {
            code: "inbox_retry_not_settled",
            error: "the last attempt is not confirmed finished yet",
          },
          409,
        )
      : previous(url, init);
  const card = host.querySelector('[data-source="assistant_inbox"]');
  await act(async () => buttonNamed(card, "Retry").click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  globalThis.fetch = previous;
  assert.match(
    card.textContent,
    /The last attempt is still finishing on the computer\. Try again in a moment\./,
  );
  assert.doesNotMatch(card.textContent, /not confirmed finished yet/);
  await act(async () => root.unmount());
  host.remove();
});

test("a notice is a short row the person can open or dismiss", async () => {
  const notice = item({
    id: "pnd_notice_1",
    source: "notice",
    title: "The image did not make it into the thread",
    excerpt: "The image did not make it into the thread.",
    note: "The image did not make it into the thread.",
  });
  const { host, root, calls } = await render({
    open: 1,
    bySession: { sess_1: 1 },
    items: [notice],
  });
  const card = host.querySelector('[data-source="notice"]');
  assert.ok(card, "the notice has its own row");
  assert.match(card.textContent, /The image did not make it into the thread\./);
  assert.ok(buttonNamed(card, "Open message"), "it links to the conversation");
  const got = buttonNamed(card, "Got it");
  assert.ok(got, "it can be dismissed");
  await act(async () => got.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.ok(
    calls.some(
      (call) =>
        call.path.includes("/state") && call.body?.state === "dismissed",
    ),
  );
  await act(async () => root.unmount());
  host.remove();
});

test("a hand-over shows the assistant's note as its reason, clamped, and says who handed it over", async () => {
  const note =
    "The export needs your pick of colour for the header: three palettes pass the contrast check, and the helper waits at the next step until you choose one, then finishes the report.";
  const handed = item({
    id: "handed-note",
    sessionId: "sess_1",
    title: "Which colour for the header?",
    excerpt: "Which colour for the header?",
    handler: "person",
    handedReason: "assistant",
    note,
  });
  const { host, root } = await render({
    open: 1,
    bySession: { sess_1: 1 },
    items: [handed],
  });
  const block = host.querySelector(".fdy-pending-item-handed");
  assert.ok(block, "the hand-over is its own block");
  assert.equal(block.textContent, `Your assistant: ${note}`);
  assert.ok(
    block.querySelector(".fdy-clamped-text .line-clamp-3"),
    "the note clamps to three lines and offers the rest",
  );
  await act(async () => root.unmount());
  host.remove();
});

test("a hand-over whose note only repeats the title says it was handed over, without the title twice", async () => {
  const handed = item({
    id: "handed-title",
    sessionId: "sess_1",
    title: "Which colour for the header?",
    excerpt: "Which colour for the header?",
    handler: "person",
    handedReason: "assistant",
    rule: "handed_over",
    note: "Which colour for the header?",
  });
  const { host, root } = await render({
    open: 1,
    bySession: { sess_1: 1 },
    items: [handed],
  });
  const block = host.querySelector(".fdy-pending-item-handed");
  assert.ok(block);
  assert.equal(block.textContent, "Your assistant: handed this to you.");
  await act(async () => root.unmount());
  host.remove();
});

test("a decision the assistant made is marked in 已处理 and opens its chat to reply", async () => {
  const answered = item({
    id: "answered",
    sessionId: "sess_1",
    workspaceId: "ws_1",
    messageId: "msg_9",
    title: "Pick the export format",
    excerpt: "Pick the export format",
    state: "done",
    outcome: "assistant_answered",
    resolvedAt: "2026-11-17T09:00:00Z",
  });
  const mine = item({
    id: "mine",
    sessionId: "sess_2",
    title: "Keep the closed rows blocked?",
    excerpt: "Keep the closed rows blocked?",
    state: "replied",
    outcome: "person_answered",
    resolvedAt: "2026-11-17T09:00:00Z",
  });
  const { host, root } = await render({
    open: 0,
    bySession: {},
    items: [answered, mine],
  });
  const resolvedFilter = [...host.querySelectorAll("*")].find(
    (element) =>
      element.children.length === 0 &&
      element.textContent === "Resolved · 7 days",
  );
  assert.ok(resolvedFilter, "the resolved filter");
  await act(
    async () =>
      resolvedFilter.closest("button")?.click() ?? resolvedFilter.click(),
  );
  const decided = host.querySelector('[data-state="done"]');
  assert.ok(decided, "the assistant's decision is listed as resolved");
  assert.ok(
    decided.querySelector(".fdy-pending-item-decided"),
    "marked as the assistant's decision",
  );
  assert.match(decided.textContent, /Your assistant decided this/);
  const open = buttonNamed(decided, "Open the chat to see or reply");
  assert.ok(open, "the person can open the chat and reply there");
  await act(async () => open.click());
  assert.match(window.location.search, /message=msg_9/);
  const mineCard = host.querySelector('[data-state="replied"]');
  assert.ok(mineCard);
  assert.equal(mineCard.querySelector(".fdy-pending-item-decided"), null);
  assert.doesNotMatch(mineCard.textContent, /Your assistant decided this/);
  await act(async () => root.unmount());
  host.remove();
});

test("the assistant's answer sits under its mark, clamped to two lines; without one the card is as before", async () => {
  const sentence = "导出选 PDF，理由是报表要发给客户，PDF 在各设备上版式一致。";
  const answer = sentence
    .repeat(Math.ceil(300 / sentence.length))
    .slice(0, 300);
  assert.equal(answer.length, 300);
  const answered = item({
    id: "answered-long",
    sessionId: "sess_1",
    messageId: "msg_9",
    title: "Pick the export format",
    excerpt: "Pick the export format",
    state: "done",
    outcome: "assistant_answered",
    answer,
    answeredBy: "assistant",
    resolvedAt: "2026-11-17T09:00:00Z",
  });
  const bare = item({
    id: "answered-bare",
    sessionId: "sess_2",
    title: "Pick the file name",
    excerpt: "Pick the file name",
    state: "done",
    outcome: "assistant_answered",
    resolvedAt: "2026-11-17T09:00:00Z",
  });
  const { host, root } = await render({
    open: 0,
    bySession: {},
    items: [answered, bare],
  });
  const resolvedFilter = [...host.querySelectorAll("*")].find(
    (element) =>
      element.children.length === 0 &&
      element.textContent === "Resolved · 7 days",
  );
  assert.ok(resolvedFilter, "the resolved filter");
  await act(
    async () =>
      resolvedFilter.closest("button")?.click() ?? resolvedFilter.click(),
  );
  const longCard = [...host.querySelectorAll('[data-state="done"]')].find(
    (card) => card.textContent.includes("Pick the export format"),
  );
  assert.ok(longCard, "the answered card");
  const clamped = longCard.querySelector(".fdy-clamped-text");
  assert.ok(clamped, "the answer is a clamped text");
  assert.ok(clamped.querySelector(".line-clamp-2"), "two lines");
  assert.equal(clamped.textContent, answer);
  const mark = longCard.querySelector(".fdy-pending-item-decided");
  assert.ok(
    mark.compareDocumentPosition(clamped) &
      window.Node.DOCUMENT_POSITION_FOLLOWING,
    "the answer comes after the mark",
  );
  const bareCard = [...host.querySelectorAll('[data-state="done"]')].find(
    (card) => card.textContent.includes("Pick the file name"),
  );
  assert.ok(bareCard, "the card without an answer");
  assert.ok(bareCard.querySelector(".fdy-pending-item-decided"));
  assert.equal(bareCard.querySelector(".fdy-clamped-text"), null);
  await act(async () => root.unmount());
  host.remove();
});

async function showResolvedItems(host) {
  const resolvedFilter = [...host.querySelectorAll("*")].find(
    (element) =>
      element.children.length === 0 &&
      element.textContent === "Resolved · 7 days",
  );
  assert.ok(resolvedFilter, "the resolved filter");
  await act(
    async () =>
      resolvedFilter.closest("button")?.click() ?? resolvedFilter.click(),
  );
}

const cardTitled = (host, title, state) =>
  [...host.querySelectorAll(`[data-state="${state}"]`)].find((card) =>
    card.textContent.includes(title),
  );

test("an item the assistant closed with a reason says so, not that it decided it (assistant_closed)", async () => {
  const closed = item({
    id: "closed-reason",
    sessionId: "sess_1",
    title: "Send the report to the client?",
    excerpt: "Send the report to the client?",
    state: "dismissed",
    outcome: "assistant_closed",
    closeReason: "The client already got it on Monday.",
    resolvedAt: "2026-11-17T09:00:00Z",
  });
  const bare = item({
    id: "closed-bare",
    sessionId: "sess_2",
    title: "Rename the folder?",
    excerpt: "Rename the folder?",
    state: "dismissed",
    outcome: "assistant_closed",
    resolvedAt: "2026-11-17T09:00:00Z",
  });
  const { host, root } = await render({
    open: 0,
    bySession: {},
    items: [closed, bare],
  });
  await showResolvedItems(host);
  const withReason = cardTitled(
    host,
    "Send the report to the client?",
    "dismissed",
  );
  assert.ok(withReason, "the closed card");
  assert.match(
    withReason.textContent,
    /Closed by the assistant: The client already got it on Monday\./,
  );
  assert.ok(withReason.querySelector(".fdy-pending-item-closed"));
  assert.equal(withReason.querySelector(".fdy-pending-item-decided"), null);
  assert.doesNotMatch(withReason.textContent, /Your assistant decided this/);
  const withoutReason = cardTitled(host, "Rename the folder?", "dismissed");
  assert.ok(withoutReason, "the closed card without a reason");
  assert.match(withoutReason.textContent, /Closed by the assistant/);
  assert.doesNotMatch(withoutReason.textContent, /Closed by the assistant:/);
  assert.equal(withoutReason.querySelector(".fdy-clamped-text"), null);
  assert.equal(withoutReason.querySelector(".fdy-pending-item-decided"), null);
  assert.doesNotMatch(withoutReason.textContent, /Your assistant decided this/);
  await act(async () => root.unmount());
  host.remove();
});

test("an approval shows its command without the fence lines, open and resolved; without detail it is as before", async () => {
  const command = "git push origin main";
  const commandDetail = [
    "```sh",
    command,
    "```",
    "In `/home/windeng/repo`",
  ].join("\n");
  const open = item({
    id: "approval-open",
    sessionId: "sess_1",
    title: "Allow this command?",
    excerpt: "Allow this command?",
    options: ["Approve", "Deny"],
    approval: true,
    detail: commandDetail,
  });
  const resolved = item({
    id: "approval-done",
    sessionId: "sess_2",
    title: "Allow these file changes?",
    excerpt: "Allow these file changes?",
    options: ["Approve", "Deny"],
    approval: true,
    detail: "- `src/a.ts`\n- `src/b.ts`",
    state: "replied",
    outcome: "person_answered",
    resolvedAt: "2026-11-17T09:00:00Z",
  });
  const bare = item({
    id: "approval-bare",
    sessionId: "sess_3",
    title: "Allow this other command?",
    excerpt: "Allow this other command?",
    options: ["Approve", "Deny"],
    approval: true,
  });
  const { host, root } = await render({
    open: 0,
    bySession: {},
    items: [open, resolved, bare],
  });
  const openCard = cardTitled(host, "Allow this command?", "open");
  assert.ok(openCard, "the open approval card");
  const openDetail = openCard.querySelector(".fdy-pending-item-approval");
  assert.ok(openDetail, "the detail shows in the open card");
  assert.ok(openDetail.querySelector(".font-mono"), "monospace");
  assert.match(openDetail.textContent, /^git push origin main/);
  assert.doesNotMatch(openDetail.textContent, /```/);
  assert.ok(buttonNamed(openCard, "Approve"), "Approve stays");
  assert.ok(buttonNamed(openCard, "Deny"), "Deny stays");
  const bareCard = cardTitled(host, "Allow this other command?", "open");
  assert.ok(bareCard, "the approval card without detail");
  assert.equal(bareCard.querySelector(".fdy-pending-item-approval"), null);
  assert.ok(buttonNamed(bareCard, "Approve"));
  await showResolvedItems(host);
  const resolvedCard = cardTitled(host, "Allow these file changes?", "replied");
  assert.ok(resolvedCard, "the resolved approval card");
  const resolvedDetail = resolvedCard.querySelector(
    ".fdy-pending-item-approval",
  );
  assert.ok(resolvedDetail, "the detail shows in the resolved card");
  assert.match(resolvedDetail.textContent, /src\/a\.ts/);
  assert.match(resolvedDetail.textContent, /src\/b\.ts/);
  assert.doesNotMatch(resolvedDetail.textContent, /`/);
  await act(async () => root.unmount());
  host.remove();
});

test("a reply to an older question item names that question's message, so it answers that question (DEV-292b)", async () => {
  const { parseAgentQuestionReply, agentQuestionReplyText } =
    await import("../src/components/conversation/agent-questions.ts");
  const older = "2026-11-17T08:00:00Z";
  const newer = "2026-11-18T08:00:00Z";
  const list = {
    open: 2,
    bySession: { sess_1: 2 },
    items: [
      item({
        id: "pnd_new",
        source: "question",
        messageId: "sess_1/msg_new_7",
        title: "Use the monthly totals instead?",
        excerpt: "Use the monthly totals instead?",
        createdAt: newer,
        updatedAt: newer,
      }),
      item({
        id: "pnd_old",
        source: "question",
        messageId: "sess_1/turn_3/msg_old_42",
        title: "Q4 cumulative or per month?",
        excerpt: "Q4 cumulative or per month?",
        createdAt: older,
        updatedAt: older,
      }),
    ],
  };
  const { host, root, calls } = await render(list);
  const olderCard = [...host.querySelectorAll("article")].find((article) =>
    article.textContent.includes("Q4 cumulative or per month?"),
  );
  assert.ok(olderCard, "the older question is listed");
  await act(async () => buttonNamed(olderCard, "Reply").click());
  const textarea = olderCard.querySelector("textarea");
  assert.ok(textarea, "its own reply box");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    ).set;
    setter.call(textarea, "per month");
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => buttonNamed(olderCard, "Send").click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const sent = calls.find((call) =>
    call.path.includes("/api/chats/sess_1/queue"),
  );
  assert.ok(sent, JSON.stringify(calls));
  assert.equal(sent.body.steer, true);
  assert.equal(
    sent.body.text,
    agentQuestionReplyText(
      "msg_old_42",
      [{ title: "Q4 cumulative or per month?" }],
      ["per month"],
    ),
  );
  assert.deepEqual(parseAgentQuestionReply(sent.body.text), [
    {
      itemId: "msg_old_42",
      index: 0,
      question: "Q4 cumulative or per month?",
      answer: "per month",
      noAnswer: false,
      reason: "",
    },
  ]);
  await act(async () => root.unmount());
  host.remove();
});

test("other items keep the quoted reply, even with a message id", async () => {
  const failed = item({
    source: "turn_failed",
    messageId: "sess_1/msg_fail_3",
    title: "API Error: 503",
    excerpt: "API Error: 503",
  });
  assert.equal(
    pendingReplyText(failed, "Retry later"),
    "> API Error: 503\n\nRetry later",
  );
});

test("an item waiting on the person is answered through its entry, not a chat", () => {
  assert.equal(pendingReplyRoute({ source: "item_wait" }), "answer");
  assert.equal(
    pendingReplyRoute({ source: "item_wait", sessionId: "sess_holder" }),
    "answer",
  );
});

test("a reply goes to the item an assistant asked, and a withdrawn question says so", () => {
  assert.equal(
    pendingReplyRoute({ source: "assistant_question", sessionId: "sess_home" }),
    "answer",
  );
  assert.equal(
    pendingReplyRoute({ source: "question", sessionId: "sess_1" }),
    "chat",
  );
  assert.equal(
    pendingReplyRoute({
      source: "issue_question",
      issueId: "iss_1",
      eventId: "evt_1",
      sessionId: "sess_1",
    }),
    "issue",
  );
  assert.equal(pendingReplyRoute({ source: "notice" }), "none");
  assert.equal(
    pendingStatusKey({ state: "done", outcome: "withdrawn" }),
    "outcome.withdrawn",
  );
  assert.equal(
    pendingStatusKey({ state: "done", outcome: "person_answered" }),
    "state.done",
  );
});

test("an assistant's question is answered through its item, one option at a time", async () => {
  const list = {
    open: 1,
    bySession: { sess_home: 1 },
    items: [
      item({
        id: "pnd_q1",
        source: "assistant_question",
        sessionId: "sess_home",
        title: "Which folder should the receipt go to?",
        excerpt: "Which folder should the receipt go to?",
        options: ["Q3 folder", "Travel"],
      }),
    ],
  };
  const { host, root, calls } = await render(list);
  assert.match(host.textContent, /Your assistant asks/, host.innerHTML);
  await act(async () => optionButton(host, "Travel").click());
  const answered = calls.find((call) =>
    call.path.endsWith("/api/pending-items/pnd_q1/answer"),
  );
  assert.ok(answered, JSON.stringify(calls));
  assert.equal(answered.method, "POST");
  assert.deepEqual(answered.body, { text: "Travel" });
  assert.equal(
    calls.some((call) => call.path.includes("/api/chats/")),
    false,
    "the answer went into the chat as a message",
  );
  await act(async () => root.unmount());
  host.remove();
});

test("a notice's link names its item, and the item's card has its own id", () => {
  assert.equal(pendingFocusItemId("?item=pnd_1"), "pnd_1");
  assert.equal(pendingFocusItemId("?item="), "");
  assert.equal(pendingFocusItemId(""), "");
  assert.equal(pendingItemDomId("pnd_1"), "pending-item-pnd_1");
});

const noteItem = (fields) =>
  item({
    id: "pnd_note",
    source: "notice",
    assistantId: "asst_1",
    assistantName: "Ada",
    title: "The image did not make it into the thread",
    excerpt: "The image did not make it into the thread.",
    updatedAt: "2026-10-29T12:00:00Z",
    ...fields,
  });

test("notices form their own group after the requests and count nowhere", async () => {
  const items = [
    item({ id: "ask", updatedAt: "2026-10-29T08:00:00Z" }),
    noteItem({}),
    noteItem({ id: "pnd_note_2", assistantId: "asst_2", assistantName: "Bo" }),
  ];
  const groups = groupPendingItems(
    items,
    "open",
    "Untitled",
    "Personal",
    "Default assistant",
    "For your information",
  );
  assert.deepEqual(
    groups.map((group) => [group.title, group.items.map((x) => x.id)]),
    [
      ["Fix the export", ["ask"]],
      // Newer than the request, still after it; both assistants' notes in one.
      ["For your information", ["pnd_note", "pnd_note_2"]],
    ],
  );
  const { host, root } = await render({
    open: 1,
    bySession: { sess_1: 1 },
    noticeOpen: 2,
    items,
  });
  try {
    assert.match(host.textContent, /Open · 1/);
    const headings = [...host.querySelectorAll("section h2")].map(
      (heading) => heading.textContent,
    );
    assert.deepEqual(headings, ["Fix the export", "For your information"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("the list's own counts leave notices out: open, per chat and apart", async () => {
  let seen;
  function Probe() {
    seen = usePendingItems().list;
    return null;
  }
  globalThis.fetch = async () =>
    answer({
      assistants: [],
      open: 1,
      bySession: { sess_1: 1 },
      noticeOpen: 1,
      items: [
        item({ id: "ask" }),
        noteItem({ sessionId: "sess_1" }),
        item({ id: "helper", handler: "assistant" }),
      ],
    });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  try {
    assert.equal(seen.open, 1);
    assert.deepEqual(seen.bySession, { sess_1: 1 });
    assert.equal(seen.noticeOpen, 1);
    assert.equal(seen.assistantOpen, 1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("a chat's bar counts its requests, not a notice posted in it", async () => {
  const { PendingChatBar } =
    await import("../src/features/pending/pending-chat-bar.tsx");
  const pending = {
    list: {
      open: 1,
      bySession: { sess_1: 1 },
      items: [
        item({ id: "a", title: "Keep the closed rows blocked?" }),
        noteItem({ sessionId: "sess_1" }),
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
  try {
    assert.match(host.textContent, /Waiting on you · 1/);
    // A chat whose only open entry is a notice shows no bar.
    await act(async () =>
      root.render(
        createElement(PendingChatBar, {
          pending: {
            ...pending,
            list: {
              ...pending.list,
              items: [noteItem({ sessionId: "sess_1" })],
            },
          },
          sessionId: "sess_1",
        }),
      ),
    );
    assert.equal(host.querySelector("section"), null);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("a request says whether its Feishu card went out, or why not", async () => {
  const { pendingNoticeText } =
    await import("../src/features/pending/pending-model.ts");
  const en = i18n.getFixedT("en", "pending");
  const zh = i18n.getFixedT("zh-CN", "pending");
  const said = (notice, t = en, fields = {}) =>
    pendingNoticeText(item({ notice, ...fields }), t);
  assert.equal(said({ state: "queued" }), "Sending to Feishu");
  assert.equal(said({ state: "sending" }), "Sending to Feishu");
  assert.equal(said({ state: "sent" }), "Sent to Feishu");
  assert.equal(said({ state: "answered" }), "Answered in Feishu");
  assert.equal(said({ state: "failed" }), "Failed to send to Feishu");
  assert.equal(said({ state: "superseded" }), "");
  assert.equal(said(undefined), "");
  assert.equal(said({ state: "sent" }, en, { state: "done" }), "");
  const reasons = {
    no_sinks: [
      "Not sent to Feishu: no notice channel is set",
      "未发到飞书：没有设置通知渠道",
    ],
    kind_not_taken: [
      "Not sent to Feishu: the notice setting leaves this kind out",
      "未发到飞书：通知设置没有勾选这类事项",
    ],
    not_card_sink: [
      "Not sent to Feishu: the notice channel is not the Foundry bot",
      "未发到飞书：通知渠道不是 Foundry 机器人",
    ],
    bot_not_paired: [
      "Not sent to Feishu: the Foundry bot has no direct chat with you",
      "未发到飞书：Foundry 机器人还没有和你的私聊",
    ],
    no_origin: [
      "Not sent to Feishu: the server has no Web address",
      "未发到飞书：服务器没有配置 Web 地址",
    ],
    assistant_unreadable: [
      "Not sent to Feishu: the assistant could not be read",
      "未发到飞书：读不到助理",
    ],
  };
  for (const [reason, [english, chinese]] of Object.entries(reasons)) {
    assert.equal(said({ skipped: reason }), english);
    assert.equal(said({ skipped: reason }, zh), chinese);
  }
  assert.equal(said({ state: "sent" }, zh), "已发到飞书");

  // The card states it in its fact line, the page's and the bar's alike.
  const { host, root } = await render({
    open: 2,
    bySession: { sess_1: 1, sess_2: 1 },
    items: [
      item({ id: "sent", notice: { state: "sent" } }),
      item({
        id: "skipped",
        sessionId: "sess_2",
        title: "Which day?",
        notice: { skipped: "bot_not_paired" },
      }),
    ],
  });
  try {
    const facts = [...host.querySelectorAll(".fdy-pending-item-card-sent")].map(
      (fact) => fact.textContent,
    );
    assert.deepEqual(facts.sort(), [
      "Not sent to Feishu: the Foundry bot has no direct chat with you",
      "Sent to Feishu",
    ]);
    assert.ok(
      host
        .querySelector(".fdy-pending-item-card-sent")
        .closest("p")
        .querySelector("time"),
      "in the line with its time",
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
