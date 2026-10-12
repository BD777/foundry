import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);
const { linkedChatOutcome } =
  await import("../src/features/chat/use-linked-chat-session.ts");
const { linkedChatNotice, startedElsewhereNotice } =
  await import("../src/features/chat/chat-thread-notice.ts");
const { sessionsHoldChat } =
  await import("../src/features/chat/chat-session-model.ts");
const { navigateAppRoute } = await import("../src/app/navigation.ts");
const { i18n } = await import("../src/i18n/index.ts");

function session(id, extra = {}) {
  return {
    id,
    threadId: id,
    workspaceId: "ws_1",
    source: "verification",
    status: "completed",
    events: [{ id: "evt_1" }],
    ...extra,
  };
}

test("a session read by id shows in its own workspace, its transcript loaded as any chat's", () => {
  const outcome = linkedChatOutcome(session("sess_v"), "ws_1");
  assert.equal(outcome.state, "found");
  assert.equal(outcome.session.id, "sess_v");
  assert.equal(outcome.session.events, undefined);
});

test("a session read by id from another workspace is named, not shown", () => {
  assert.deepEqual(linkedChatOutcome(session("sess_v"), "ws_2"), {
    state: "elsewhere",
    workspaceId: "ws_1",
  });
});

test("a chat by link that is listed or found needs no notice", () => {
  const noop = () => {};
  assert.equal(linkedChatNotice({ state: "none" }, "x", [], noop), undefined);
  assert.equal(
    linkedChatNotice({ state: "found", session: session("x") }, "x", [], noop),
    undefined,
  );
  assert.equal(
    linkedChatNotice({ state: "loading" }, "x", [], noop)?.title,
    i18n.t("chat:thread.openingTitle"),
  );
});

test("a chat in another workspace links there by name", (t) => {
  const pushed = stubWindow(t, "/chats/sess_v", "?workspace=ws_2");
  const notice = linkedChatNotice(
    { state: "elsewhere", workspaceId: "ws_1" },
    "sess_v",
    [{ id: "ws_1", name: "alpha" }],
    () => {},
  );
  assert.equal(notice.title, i18n.t("chat:thread.elsewhereTitle"));
  assert.match(notice.message, /alpha/);
  assert.match(notice.action.label, /alpha/);
  notice.action.onSelect();
  assert.deepEqual(pushed, ["/chats/sess_v?workspace=ws_1"]);

  const unnamed = linkedChatNotice(
    { state: "elsewhere", workspaceId: "ws_9" },
    "sess_v",
    [],
    () => {},
  );
  assert.match(
    unnamed.message,
    new RegExp(i18n.t("chat:thread.otherWorkspace")),
  );
});

test("a chat that is gone says so and leads to the chat list", () => {
  let shown = 0;
  const notice = linkedChatNotice({ state: "missing" }, "gone", [], () => {
    shown += 1;
  });
  assert.equal(notice.title, i18n.t("chat:thread.missingTitle"));
  assert.equal(notice.action.showsList, true);
  notice.action.onSelect();
  assert.equal(shown, 1);
});

test("a lookup that failed offers a retry", () => {
  let retried = 0;
  const notice = linkedChatNotice(
    { state: "failed", retry: () => (retried += 1) },
    "x",
    [],
    () => {},
  );
  assert.equal(notice.action.label, i18n.t("chat:thread.retry"));
  notice.action.onSelect();
  assert.equal(retried, 1);
});

test("an unlisted session links to its Issue", (t) => {
  const pushed = stubWindow(t, "/chats/sess_i", "?workspace=ws_1");
  startedElsewhereNotice(
    session("sess_i", { source: "issue", issueId: "iss_7" }),
  ).action.onSelect();
  assert.deepEqual(pushed, ["/issues/iss_7?workspace=ws_1"]);
  assert.equal(
    startedElsewhereNotice(session("sess_n", { source: "naming" })).action,
    undefined,
  );
});

test("a list holds a chat by its session, thread or native id", () => {
  const sessions = [
    session("sess_2", { threadId: "sess_1" }),
    { ...session("sess_3"), threadId: "", nativeSessionId: "native_3" },
  ];
  assert.equal(sessionsHoldChat(sessions, "sess_1"), true);
  assert.equal(sessionsHoldChat(sessions, "sess_2"), true);
  assert.equal(sessionsHoldChat(sessions, "native_3"), true);
  assert.equal(sessionsHoldChat(sessions, "sess_9"), false);
});

test("in-app navigation keeps the workspace shown unless told another", (t) => {
  const pushed = stubWindow(t, "/workspace", "?workspace=ws_1");
  navigateAppRoute({ view: "chats", selectedChatId: "a" });
  navigateAppRoute({ view: "chats", selectedChatId: "b" }, "ws_2");
  assert.deepEqual(pushed, [
    "/chats/a?workspace=ws_1",
    "/chats/b?workspace=ws_2",
  ]);
});

function stubWindow(t, pathname, search) {
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
    location: { pathname, search, hash: "" },
    history: { pushState: (_state, _title, url) => pushed.push(url) },
    dispatchEvent: () => true,
  };
  return pushed;
}
