import assert from "node:assert/strict";
import test from "node:test";
import {
  createChatGroup,
  emptyChatGroupState,
  filterChatGroups,
  loadChatGroups,
  moveChatToGroup,
  saveChatGroups,
} from "../src/features/chat/chat-group-state.ts";

test("new groups go first, start expanded, and can receive the source chat atomically", () => {
  const first = createChatGroup(emptyChatGroupState(), "one", "chat");
  const second = createChatGroup(first, "two");
  assert.deepEqual(
    second.groups.map(({ id, name, collapsed }) => [id, name, collapsed]),
    [
      ["two", "新建分组 2", false],
      ["one", "新建分组", false],
    ],
  );
  assert.equal(second.membership.chat, "one");
  const moved = moveChatToGroup(second, "chat", "two");
  assert.equal(moved.membership.chat, "two");
  assert.equal(second.membership.chat, "one");
  assert.equal(moveChatToGroup(moved, "chat", "missing"), moved);
  assert.deepEqual(moveChatToGroup(moved, "chat").membership, {});
});

test("search finds whole groups by name and individual chats by title without duplicating rows", () => {
  const state = {
    groups: [
      { id: "work", name: "Project Alpha", collapsed: true },
      { id: "empty", name: "资料", collapsed: false },
    ],
    membership: { one: "work", two: "work", orphan: "missing" },
  };
  const chats = [
    { id: "one", title: "Release notes" },
    { id: "two", title: "Design" },
    { id: "free", title: "Release tasks" },
    { id: "orphan", title: "Imported chat" },
  ];
  const all = filterChatGroups(chats, state, "");
  assert.equal(all.groups.length, 2);
  assert.deepEqual(
    all.ungrouped.map((chat) => chat.id),
    ["free", "orphan"],
  );
  const byGroup = filterChatGroups(chats, state, "  ALPHA  ");
  assert.deepEqual(
    byGroup.groups[0].chats.map((chat) => chat.id),
    ["one", "two"],
  );
  assert.equal(byGroup.groups[0].collapsed, true);
  assert.deepEqual(byGroup.ungrouped, []);
  const byTitle = filterChatGroups(chats, state, "release");
  assert.deepEqual(
    byTitle.groups[0].chats.map((chat) => chat.id),
    ["one"],
  );
  assert.deepEqual(
    byTitle.ungrouped.map((chat) => chat.id),
    ["free"],
  );
  assert.equal(filterChatGroups(chats, state, "资料").groups[0].id, "empty");
  assert.deepEqual(filterChatGroups(chats, state, "absent"), {
    groups: [],
    ungrouped: [],
  });
});

test("storage restores names, membership and collapse state per workspace and tolerates invalid data", (t) => {
  const previousWindow = globalThis.window;
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const data = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, value),
    },
  };
  const state = createChatGroup(
    emptyChatGroupState(),
    "group",
    "temporarily-unloaded-chat",
  );
  state.groups[0] = { id: "group", name: "工作", collapsed: true };
  saveChatGroups("a", state);
  assert.deepEqual(loadChatGroups("a"), state);
  assert.deepEqual(loadChatGroups("b"), emptyChatGroupState());
  saveChatGroups("b", createChatGroup(emptyChatGroupState(), "other"));
  assert.deepEqual(loadChatGroups("a"), state);
  data.set("foundry.chatGroups.v1:a", "invalid JSON");
  assert.deepEqual(loadChatGroups("a"), emptyChatGroupState());
  data.set(
    "foundry.chatGroups.v1:a",
    JSON.stringify({
      groups: [
        null,
        { id: "bad", name: "  " },
        { id: "ok", name: " Valid " },
        { id: "ok", name: "Duplicate" },
      ],
      membership: { good: "ok", stale: "missing", bad: 10 },
    }),
  );
  assert.deepEqual(loadChatGroups("a"), {
    groups: [{ id: "ok", name: "Valid", collapsed: false }],
    membership: { good: "ok" },
  });
  Object.defineProperty(globalThis.window, "localStorage", {
    get() {
      throw new Error("Blocked");
    },
  });
  assert.deepEqual(loadChatGroups("a"), emptyChatGroupState());
  assert.doesNotThrow(() => saveChatGroups("a", state));
});
