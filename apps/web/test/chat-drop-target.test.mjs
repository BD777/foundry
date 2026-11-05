import assert from "node:assert/strict";
import test from "node:test";
import { chatDropTarget } from "../src/features/chat/list/chat-drop-target.ts";

// Two groups as the list lays them out: header, rows, then a 6px gap.
const slots = [
  { top: 0, bottom: 30, groupId: "g1" },
  { top: 30, bottom: 70, groupId: "g1", chatId: "a" },
  { top: 70, bottom: 110, groupId: "g1", chatId: "b" },
  { top: 116, bottom: 146, groupId: "g2" },
  { top: 146, bottom: 186, groupId: "g2", chatId: "c" },
  { top: 192, bottom: 220, groupId: "" },
];

test("a row splits at its middle", () => {
  assert.deepEqual(chatDropTarget(slots, 40), {
    groupId: "g1",
    chatId: "a",
    edge: "before",
  });
  assert.deepEqual(chatDropTarget(slots, 60), {
    groupId: "g1",
    chatId: "a",
    edge: "after",
  });
});

test("a header or empty group takes the chat into that group", () => {
  assert.deepEqual(chatDropTarget(slots, 25), {
    groupId: "g1",
    edge: "before",
  });
  assert.deepEqual(chatDropTarget(slots, 200), { groupId: "", edge: "before" });
});

test("the gap between groups goes after the last row above it", () => {
  assert.deepEqual(chatDropTarget(slots, 113), {
    groupId: "g1",
    chatId: "b",
    edge: "after",
  });
  assert.deepEqual(chatDropTarget(slots, 189), {
    groupId: "g2",
    chatId: "c",
    edge: "after",
  });
});

test("the space below the list goes after its last slot", () => {
  const rows = slots.slice(0, 5);
  assert.deepEqual(chatDropTarget(rows, 600), {
    groupId: "g2",
    chatId: "c",
    edge: "after",
  });
});

test("above the first slot goes before it; no slots, no target", () => {
  assert.deepEqual(chatDropTarget(slots.slice(1), 5), {
    groupId: "g1",
    chatId: "a",
    edge: "before",
  });
  assert.equal(chatDropTarget([], 5), undefined);
});
