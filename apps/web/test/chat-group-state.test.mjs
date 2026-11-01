import assert from "node:assert/strict";
import test from "node:test";
import { filterChatGroups } from "../src/features/chat/chat-group-state.ts";

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
