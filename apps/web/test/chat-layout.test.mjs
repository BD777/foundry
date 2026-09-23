import assert from "node:assert/strict";
import test from "node:test";
import {
  addChatGroup,
  emptyChatLayout,
  layoutGroupState,
  mergeLegacyGroups,
  moveChat,
  orderedChats,
} from "../src/features/chat/chat-layout.ts";
import { ChatLayoutSync } from "../src/features/chat/chat-layout-sync.ts";

const ids = ["a", "b", "c", "d"];
const chats = ids.map((id) => ({ id }));
const inGroup = (layout, groupId) =>
  layout.positions.filter((p) => p.groupId === groupId).map((p) => p.chatId);
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("group deletion is exclusive, uses the confirmed revision and preserves layout on failure", async () => {
  const initial = {
    ...emptyChatLayout(),
    revision: 3,
    groups: [{ id: "g", name: "Delete" }],
  };
  let published;
  let finish;
  let saves = 0;
  const sync = new ChatLayoutSync(initial, {
    load: async () => initial,
    save: async (next) => {
      saves++;
      return next;
    },
    changed: (next) => {
      published = next;
    },
    failed: () => {},
  });
  const deleting = sync.deleteGroup((revision) => {
    assert.equal(revision, 3);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  sync.enqueue((layout) => addChatGroup(layout, "concurrent", undefined, []));
  await assert.rejects(
    sync.deleteGroup(async () => initial),
    /正在同步/,
  );
  const deleted = { ...emptyChatLayout(), revision: 4 };
  finish(deleted);
  await deleting;
  assert.equal(saves, 0);
  assert.deepEqual(published, deleted);
  await assert.rejects(
    sync.deleteGroup(async () => {
      throw new Error("conflict");
    }),
    /conflict/,
  );
  assert.deepEqual(published, deleted);
  sync.enqueue((layout) => addChatGroup(layout, "next", undefined, []));
  await tick();
  assert.equal(saves, 1);
  sync.dispose();
});

test("group deletion cannot overtake an unsaved membership change", async () => {
  let finish;
  const sync = new ChatLayoutSync(emptyChatLayout(), {
    load: async () => emptyChatLayout(),
    save: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    changed: () => {},
    failed: () => {},
  });
  sync.enqueue((layout) => addChatGroup(layout, "g", "a", ["a"]));
  await assert.rejects(
    sync.deleteGroup(async () => {
      assert.fail("must not delete");
    }),
    /正在同步/,
  );
  finish({ ...emptyChatLayout(), revision: 1 });
  await tick();
  sync.dispose();
});

test("moves above/below in both directions, between groups and out to the ungrouped list", () => {
  let layout = addChatGroup(emptyChatLayout(), "g", undefined, ids);
  layout = moveChat(
    layout,
    "d",
    { groupId: "", chatId: "b", edge: "before" },
    ids,
  );
  assert.deepEqual(inGroup(layout, ""), ["a", "d", "b", "c"]);
  layout = moveChat(
    layout,
    "a",
    { groupId: "", chatId: "c", edge: "after" },
    ids,
  );
  assert.deepEqual(inGroup(layout, ""), ["d", "b", "c", "a"]);
  layout = moveChat(layout, "d", { groupId: "g", edge: "before" }, ids);
  layout = moveChat(
    layout,
    "b",
    { groupId: "g", chatId: "d", edge: "after" },
    ids,
  );
  assert.deepEqual(inGroup(layout, "g"), ["d", "b"]);
  assert.deepEqual(inGroup(layout, ""), ["c", "a"]);
  layout = moveChat(layout, "d", { groupId: "", edge: "before" }, ids);
  assert.deepEqual(inGroup(layout, ""), ["d", "c", "a"]);
  assert.equal(
    moveChat(layout, "b", { groupId: "g", chatId: "b", edge: "after" }, ids),
    layout,
  );
  assert.equal(
    moveChat(layout, "b", { groupId: "missing", edge: "before" }, ids),
    layout,
  );
  assert.equal(
    moveChat(layout, "b", { groupId: "g", chatId: "a", edge: "before" }, ids),
    layout,
  );
});

test("positions survive activity sorting, filtered/unloaded rows, and newly discovered chats", () => {
  let layout = moveChat(
    emptyChatLayout(),
    "c",
    { groupId: "", chatId: "a", edge: "before" },
    ids,
  );
  assert.deepEqual(
    orderedChats([...chats].reverse(), layout).map((c) => c.id),
    ["c", "a", "b", "d"],
  );
  layout = moveChat(layout, "d", { groupId: "", chatId: "c", edge: "after" }, [
    "c",
    "d",
  ]);
  assert.deepEqual(inGroup(layout, ""), ["c", "d", "a", "b"]);
  assert.deepEqual(
    orderedChats([{ id: "new" }, ...chats], layout).map((c) => c.id),
    ["new", "c", "d", "a", "b"],
  );
  assert.deepEqual(
    orderedChats(
      chats.filter((c) => c.id !== "a"),
      layout,
    ).map((c) => c.id),
    ["c", "d", "b"],
  );
});

test("legacy migration is idempotent and preserves server choices plus local collapse preferences", () => {
  const legacy = {
    groups: [{ id: "g", name: "Old name", collapsed: true }],
    membership: { a: "g", unloaded: "g" },
  };
  const initial = mergeLegacyGroups(emptyChatLayout(), legacy);
  assert.deepEqual(initial.groups, [{ id: "g", name: "Old name" }]);
  assert.equal(mergeLegacyGroups(initial, legacy), initial);
  const renamed = { ...initial, groups: [{ id: "g", name: "Server name" }] };
  const movedOut = moveChat(renamed, "a", { groupId: "", edge: "before" }, [
    "a",
  ]);
  assert.equal(mergeLegacyGroups(movedOut, legacy), movedOut);
  assert.deepEqual(layoutGroupState(movedOut, { g: true }), {
    groups: [{ id: "g", name: "Server name", collapsed: true }],
    membership: { unloaded: "g" },
  });
  assert.equal(layoutGroupState(movedOut, {}).groups[0].collapsed, false);
});

test("queued create/rename uses acknowledged revisions and drains across workspace unmount", async () => {
  const writes = [];
  const resolvers = [];
  const changes = [];
  const sync = new ChatLayoutSync(emptyChatLayout(), {
    save: (layout) => {
      writes.push(layout);
      return new Promise((resolve) => resolvers.push(resolve));
    },
    load: async () => emptyChatLayout(),
    changed: (layout, saving) => changes.push({ layout, saving }),
    failed: () => assert.fail("unexpected save failure"),
  });
  sync.enqueue((layout) => addChatGroup(layout, "g", "a", ids));
  sync.enqueue((layout) => ({
    ...layout,
    groups: layout.groups.map((g) => ({ ...g, name: "Renamed" })),
  }));
  assert.equal(writes.length, 1);
  assert.equal(changes.at(-1).layout.groups[0].name, "Renamed");
  sync.dispose();
  const count = changes.length;
  resolvers[0]({ ...writes[0], revision: 1 });
  await tick();
  assert.equal(writes[1].revision, 1);
  assert.equal(writes[1].groups[0].name, "Renamed");
  resolvers[1]({ ...writes[1], revision: 2 });
  await tick();
  assert.equal(
    changes.length,
    count,
    "old workspace must not update the new workspace UI",
  );
});

test("failed writes discard queued snapshots and recover the authoritative server layout", async () => {
  let reject;
  let shown;
  const errors = [];
  const remote = {
    revision: 7,
    groups: [{ id: "remote", name: "Other browser" }],
    positions: [],
  };
  const sync = new ChatLayoutSync(emptyChatLayout(), {
    save: () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
    load: async () => remote,
    changed: (layout) => {
      shown = layout;
    },
    failed: (message, ready) => errors.push({ message, ready }),
  });
  sync.enqueue((layout) => addChatGroup(layout, "local", undefined, []));
  sync.enqueue((layout) => addChatGroup(layout, "queued", undefined, []));
  reject(new Error("409 Conflict"));
  await tick();
  assert.deepEqual(shown, remote);
  assert.equal(errors.at(-1).ready, true);
  sync.dispose();
});

test("slow refresh cannot replace an optimistic move or an acknowledged newer revision", async () => {
  let resolveLoad;
  let shown;
  const sync = new ChatLayoutSync(emptyChatLayout(), {
    save: async (layout) => ({ ...layout, revision: layout.revision + 1 }),
    load: () =>
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    changed: (layout) => {
      shown = layout;
    },
    failed: () => assert.fail("unexpected failure"),
  });
  const refresh = sync.refresh();
  sync.enqueue((layout) => addChatGroup(layout, "g", undefined, []));
  await tick();
  resolveLoad(emptyChatLayout());
  await refresh;
  assert.equal(shown.revision, 1);
  assert.equal(shown.groups[0].id, "g");
  sync.dispose();
});
