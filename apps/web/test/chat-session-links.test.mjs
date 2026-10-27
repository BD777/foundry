import assert from "node:assert/strict";
import test from "node:test";

const {
  chatSessionLink,
  chatStartedByLabel,
  chatThreadsFromSessions,
  sessionLinkView,
  unlistedLinkedSessionIds,
} = await import("../src/features/chat/chat-session-model.ts");
const { chatMessageItems, chatViewMessages } =
  await import("../src/features/chat/chat-message-items.ts");
const { i18n } = await import("../src/i18n/index.ts");

function session(id, extra = {}) {
  return {
    id,
    threadId: id,
    workspaceId: "ws_1",
    status: "completed",
    title: id,
    prompt: id,
    ...extra,
  };
}

const titleOf = (thread) => `${thread.id} as listed`;
const another = i18n.t("chat:listRow.anotherSession");

test("a chat started from another workspace names its starter as the server does", () => {
  const child = session("sess_child", {
    source: "agent",
    parentSessionId: "sess_assistant",
  });
  const threads = chatThreadsFromSessions([child]);
  const named = new Map([
    [
      "sess_assistant",
      { id: "sess_assistant", workspaceId: "ws_pa", title: "Plan the week" },
    ],
  ]);
  assert.equal(
    chatStartedByLabel(child, threads, titleOf, named),
    i18n.t("chat:listRow.startedBy", { title: "Plan the week" }),
  );
  assert.deepEqual(chatSessionLink("sess_assistant", threads, titleOf, named), {
    sessionId: "sess_assistant",
    title: "Plan the week",
    workspaceId: "ws_pa",
  });
  // Not viewable, or not named yet: "another session".
  for (const unknown of [new Map([["sess_assistant", null]]), new Map()])
    assert.equal(
      chatStartedByLabel(child, threads, titleOf, unknown),
      i18n.t("chat:listRow.startedBy", { title: another }),
    );
});

test("a listed starter is named as the list shows it, without asking the server", () => {
  const parent = session("sess_parent");
  const child = session("sess_child", {
    source: "agent",
    parentSessionId: "sess_parent",
  });
  const threads = chatThreadsFromSessions([parent, child]);
  assert.deepEqual(chatSessionLink("sess_parent", threads, titleOf), {
    sessionId: "sess_parent",
    title: "sess_parent as listed",
    workspaceId: "ws_1",
  });
  assert.deepEqual(
    unlistedLinkedSessionIds(threads, ["sess_sender", "sess_parent"]),
    ["sess_sender"],
  );
  const orphans = chatThreadsFromSessions([
    session("sess_a", { parentSessionId: "sess_gone" }),
    session("sess_b", { parentSessionId: "sess_gone" }),
  ]);
  assert.deepEqual(unlistedLinkedSessionIds(orphans), ["sess_gone"]);
});

test("a known link opens its session in its workspace; an unknown one opens nothing", (t) => {
  const pushed = stubWindow(t);
  const view = sessionLinkView("sess_assistant", {
    sessionId: "sess_assistant",
    title: "Plan the week",
    workspaceId: "ws_pa",
  });
  assert.equal(view.label, "Plan the week");
  view.onOpen();
  assert.deepEqual(pushed, ["/chats/sess_assistant?workspace=ws_pa"]);
  assert.deepEqual(sessionLinkView("sess_hidden", null), {
    sessionId: "sess_hidden",
    label: another,
  });
});

test("messages another session sent name it above them; the person's own do not", () => {
  const at = "2026-10-15T10:00:00Z";
  const child = session("sess_child", {
    parentSessionId: "sess_parent",
    input: { id: "in_3", prompt: "mine" },
    events: [
      {
        id: "evt_in_1",
        sessionId: "sess_child",
        at,
        label: "User message",
        detail: "",
        level: "info",
        message: { id: "in_1", kind: "user", text: "research", at },
        metadata: { sentBySessionId: "sess_parent" },
      },
      {
        id: "evt_in_2",
        sessionId: "sess_child",
        at,
        label: "Steered into active turn",
        detail: "also read the docs",
        level: "info",
        metadata: { sentBySessionId: "sess_parent" },
      },
      {
        id: "evt_answer",
        sessionId: "sess_child",
        at,
        label: "Response stream",
        detail: "done",
        level: "info",
        message: { id: "answer_1", kind: "assistant", text: "done", at },
      },
      {
        id: "evt_in_3",
        sessionId: "sess_child",
        at,
        label: "User message",
        detail: "",
        level: "info",
        message: { id: "in_3", kind: "user", text: "mine", at },
      },
    ],
  });
  const [thread] = chatThreadsFromSessions([child]);
  const { messages } = chatViewMessages({
    outbox: [],
    suppressedResponseFingerprints: new Set(),
    thread,
  });
  const asked = [];
  const items = chatMessageItems(messages, {
    agentActive: false,
    onTurnIntoIssue: () => {},
    senderOf: (id) => {
      asked.push(id);
      return { sessionId: id, label: "Parent chat" };
    },
  });
  const users = items.filter((item) => item.role === "user");
  assert.deepEqual(
    users.map((item) => [item.text, item.sentBy?.label]),
    [
      ["research", "Parent chat"],
      ["also read the docs", "Parent chat"],
      ["mine", undefined],
    ],
  );
  assert.deepEqual(asked, ["sess_parent", "sess_parent"]);
  assert.ok(items.every((item) => item.role === "user" || !item.sentBy));
});

function stubWindow(t) {
  const previousWindow = globalThis.window;
  const previousPopState = globalThis.PopStateEvent;
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousPopState === undefined) delete globalThis.PopStateEvent;
    else globalThis.PopStateEvent = previousPopState;
  });
  globalThis.PopStateEvent ??= class PopStateEvent extends Event {};
  const pushed = [];
  globalThis.window = {
    location: {
      pathname: "/chats/sess_child",
      search: "?workspace=ws_1",
      hash: "",
    },
    history: { pushState: (_state, _title, url) => pushed.push(url) },
    dispatchEvent: () => true,
  };
  return pushed;
}

test("archived parents are labelled in listed and server-named links without changing their destination", () => {
  const parent = session("sess_archived_parent", {
    archivedAt: "2026-10-27T03:00:00Z",
  });
  const child = session("sess_child", {
    source: "agent",
    parentSessionId: parent.id,
  });
  const listed = chatThreadsFromSessions([parent, child]);
  const link = chatSessionLink(parent.id, listed, titleOf);
  const label = i18n.t("chat:archive.linkTitle", {
    title: `${parent.id} as listed`,
  });
  assert.equal(link.title, label);
  assert.equal(sessionLinkView(parent.id, link).label, label);
  assert.equal(
    chatStartedByLabel(child, listed, titleOf),
    i18n.t("chat:listRow.startedBy", { title: label }),
  );
  const named = new Map([
    [
      parent.id,
      {
        id: parent.id,
        title: "Parent",
        workspaceId: "ws_1",
        archivedAt: parent.archivedAt,
      },
    ],
  ]);
  const namedLink = chatSessionLink(
    parent.id,
    chatThreadsFromSessions([child]),
    titleOf,
    named,
  );
  assert.equal(
    namedLink.title,
    i18n.t("chat:archive.linkTitle", { title: "Parent" }),
  );
  assert.equal(namedLink.sessionId, parent.id);
  assert.equal(namedLink.workspaceId, "ws_1");
});
