// Message channel chats (DEV-234): grouping a channel workspace's sessions
// by source conversation, the row's segment/continuation line, and the
// per-turn origin reaching the chat transcript.
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);

const { channelChatGroups } =
  await import("../src/features/chat/list/channel-chat-groups.ts");
const { channelOriginMark, channelSessionMeta, channelSessionTitle } =
  await import("../src/features/chat/session/chat-session-model.ts");
const { chatMessagesForThread } =
  await import("../src/features/chat/thread/chat-model.ts");
const { i18n } = await import("../src/i18n/index.ts");
const { sessionEventLabels } = await import("@bd777/foundry-protocol");

function origin(id, name, extra = {}) {
  return {
    assistantId: "agent_1",
    channelId: "mc_1",
    channelName: "openlark",
    source: "openlark",
    sessionKey: `oc_${id}`,
    conversation: { id: `oc_${id}`, kind: "group", name },
    segment: 0,
    sessionNew: true,
    newReason: "first",
    startedAt: "2026-11-16T06:00:00Z",
    lastAt: "2026-11-16T06:05:00Z",
    lastSender: { id: "u_1", name: name === "Ops" ? "张三" : "李四" },
    ...extra,
  };
}

function chat(id, time, channelOrigin) {
  return {
    id,
    title: id,
    status: "completed",
    unread: false,
    activityAt: time,
    channelOrigin,
    onSelect() {},
    onRename: async () => {},
    onAutoRename: async () => {},
    onMarkUnread() {},
    onNotify() {},
  };
}

test("a channel workspace groups its sessions by source conversation", () => {
  const groups = channelChatGroups([
    chat("s1", "2026-11-16T06:00:00Z", origin("a", "Ops")),
    chat("s2", "2026-11-16T08:00:00Z", {
      ...origin("a", "Ops", { sessionKey: "oc_a#t2" }),
      lastSender: { id: "u_2", name: "李四" },
      lastAt: "2026-11-16T08:00:00Z",
    }),
    chat("s3", "2026-11-16T07:00:00Z", origin("b", "Design")),
    chat("s4", "2026-11-16T09:00:00Z", undefined),
  ]);
  assert.deepEqual(
    groups.map((group) => [
      group.conversation.name,
      group.chats.map((entry) => entry.id),
      group.sessionKey,
      group.lastSender,
    ]),
    [
      ["Ops", ["s2", "s1"], "oc_a#t2", "李四"],
      ["Design", ["s3"], "oc_b", "李四"],
    ],
  );
});

test("a channel row says when its segment started and why", async () => {
  await i18n.changeLanguage("en");
  const fresh = channelSessionMeta(
    origin("a", "Ops", { segment: 1, sessionNew: true, newReason: "idle" }),
  );
  assert.match(fresh, /Segment 2/);
  assert.match(fresh, /New session after a break/);
  assert.match(
    channelSessionMeta(origin("a", "Ops", { sessionNew: false })),
    /Continued$/,
  );
  assert.equal(
    channelSessionMeta(origin("a", "Ops", { segment: 1 }), false),
    "Segment 2 · New session",
  );
  assert.ok(
    channelSessionTitle("openlark · Ops · 11-16 14:03", origin("a", "Ops")),
  );
  assert.equal(channelSessionTitle("我的会话", origin("a", "Ops")), undefined);
  assert.equal(channelOriginMark(origin("a", "Ops")), "openlark · Ops");
  assert.equal(
    channelOriginMark(
      origin("a", "", { conversation: { id: "oc_a", kind: "direct" } }),
    ),
    "openlark",
  );
});

test("a channel turn's origin reaches its chat message", async () => {
  const channelOrigin = {
    channelId: "mc_1",
    channelName: "Ops",
    source: "openlark",
    conversation: { id: "oc_a", kind: "group", name: "Ops" },
    thread: { id: "omt_1", isReply: true },
    segment: 0,
    sessionNew: true,
    newReason: "first",
    at: "2026-11-16T06:00:00Z",
    messages: [
      {
        id: "om_1",
        at: "2026-11-16T06:00:00Z",
        sender: { id: "u_1", name: "张三" },
        text: "/ai check the build",
        status: "done",
      },
    ],
  };
  const session = {
    id: "s1",
    threadId: "s1",
    workspaceId: "ws_channel",
    agentId: "agent_1",
    deviceId: "dev_1",
    provider: "claude",
    status: "completed",
    title: "Ops",
    prompt: "facts",
    input: { id: "in_1", prompt: "facts", channelOrigin },
    startedAt: "2026-11-16T06:00:00Z",
    completedAt: "2026-11-16T06:01:00Z",
    events: [
      {
        id: "ev_1",
        sessionId: "s1",
        at: "2026-11-16T06:00:00Z",
        label: sessionEventLabels.userMessage,
        level: "info",
        message: {
          id: "in_1",
          at: "2026-11-16T06:00:00Z",
          kind: "user",
          text: "facts",
        },
        metadata: { channelOrigin },
      },
      {
        id: "ev_2",
        sessionId: "s1",
        at: "2026-11-16T06:01:00Z",
        label: sessionEventLabels.responseStream,
        level: "info",
        detail: "done",
      },
    ],
  };
  const messages = chatMessagesForThread({
    id: "s1",
    title: "Ops",
    sessions: [session],
  });
  const turn = messages.find((message) => message.role === "user");
  assert.equal(turn?.channelOrigin?.conversation.name, "Ops");
  assert.equal(turn?.channelOrigin?.messages[0].text, "/ai check the build");
  assert.equal(turn?.text, "facts");
});
