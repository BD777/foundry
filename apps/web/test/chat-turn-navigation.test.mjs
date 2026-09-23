import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatTurnAnchors,
  chatReadingMessageIndex,
  chatTurnNavigationLeavesLatest,
  chatTurnReadingInset,
  findActiveChatTurnIndex,
  findActiveChatTurnIndexForMessage,
  normalizeChatTurnQuery,
  sampleChatTurnIndexes,
} from "../src/components/conversation/chat-turn-navigation.ts";

test("reading position excludes overscan before and after the visible turn", () => {
  const anchors = buildChatTurnAnchors([
    { id: "u1", role: "user", text: "One" },
    { id: "b1", role: "bot", text: "Long first answer" },
    { id: "u2", role: "user", text: "Two" },
    { id: "b2", role: "bot", text: "Long second answer" },
    { id: "u3", role: "user", text: "Three" },
  ]);
  const rendered = [
    { index: 1, offset: 100 },
    { index: 2, offset: 4000 },
    { index: 3, offset: 4100 },
    { index: 4, offset: 9000 },
  ];
  for (const probe of [4000, 4050, 6000, 8999]) {
    assert.equal(
      findActiveChatTurnIndexForMessage(
        anchors,
        chatReadingMessageIndex(rendered, probe),
      ),
      1,
      "overscan can include both the previous and final turns without selecting either",
    );
  }
  assert.equal(chatReadingMessageIndex(rendered, 9000), 4);
  assert.equal(chatReadingMessageIndex(rendered, 3500), 1);
  assert.equal(chatReadingMessageIndex([], 0), 0);
});

test("navigation follows the target position instead of the current bottom state", () => {
  assert.equal(chatTurnNavigationLeavesLatest(720, 1000), true);
  assert.equal(chatTurnNavigationLeavesLatest(999, 1000), false);
  assert.equal(chatTurnNavigationLeavesLatest(1000, 1000), false);
  assert.equal(chatTurnNavigationLeavesLatest(undefined, 1000), true);
});

test("builds turn anchors only from visible user messages", () => {
  const anchors = buildChatTurnAnchors([
    { id: "user-1", role: "user", text: "  First\n\nquery  " },
    { id: "process", kind: "process", role: "bot", text: "Working" },
    { id: "answer", role: "bot", text: "Answer" },
    { id: "boundary", kind: "boundary", role: "bot", text: "Earlier" },
    { id: "user-2", kind: "message", role: "user", text: "Second query" },
  ]);

  assert.deepEqual(
    anchors.map((anchor) => [anchor.id, anchor.messageIndex, anchor.query]),
    [
      ["user-1", 0, "First query"],
      ["user-2", 4, "Second query"],
    ],
  );
});

test("uses attachment names for an attachment-only user turn", () => {
  const [anchor] = buildChatTurnAnchors([
    {
      attachments: [
        {
          id: "attachment-1",
          kind: "file",
          mimeType: "text/plain",
          name: "notes.txt",
          path: "/tmp/notes.txt",
          size: 42,
        },
      ],
      id: "user-file",
      role: "user",
      text: "",
    },
  ]);

  assert.equal(anchor?.query, "notes.txt");
});

test("normalizes nested text and clamps the reading inset", () => {
  assert.equal(
    normalizeChatTurnQuery(["hello", ["from", "Foundry"]]),
    "hello from Foundry",
  );
  assert.equal(chatTurnReadingInset(200), 72);
  assert.equal(chatTurnReadingInset(600), 132);
  assert.equal(chatTurnReadingInset(1200), 160);
});

test("finds the active anchor with top and bottom guards", () => {
  const anchors = buildChatTurnAnchors([
    { id: "user-1", role: "user", text: "One" },
    { id: "bot-1", role: "bot", text: "Answer" },
    { id: "user-2", role: "user", text: "Two" },
    { id: "bot-2", role: "bot", text: "Answer" },
    { id: "user-3", role: "user", text: "Three" },
  ]);
  const measurements = [
    { start: 0 },
    { start: 120 },
    { start: 420 },
    { start: 560 },
    { start: 900 },
  ];

  assert.equal(findActiveChatTurnIndex(anchors, measurements, 500), 1);
  assert.equal(
    findActiveChatTurnIndex(anchors, measurements, 500, { atStart: true }),
    0,
  );
  assert.equal(
    findActiveChatTurnIndex(anchors, measurements, 500, { atEnd: true }),
    2,
  );
});

test("finds the active turn from a virtual message range", () => {
  const anchors = buildChatTurnAnchors([
    { id: "user-1", role: "user", text: "One" },
    { id: "bot-1", role: "bot", text: "Answer" },
    { id: "user-2", role: "user", text: "Two" },
    { id: "bot-2", role: "bot", text: "Answer" },
    { id: "user-3", role: "user", text: "Three" },
  ]);

  assert.equal(findActiveChatTurnIndexForMessage(anchors, 3), 1);
  assert.equal(findActiveChatTurnIndexForMessage(anchors, 3, true), 2);
});

test("samples long turn lists while preserving endpoints and pinned turns", () => {
  const indexes = sampleChatTurnIndexes(100, 8, [37]);

  assert.equal(indexes.length, 8);
  assert.equal(indexes[0], 0);
  assert.equal(indexes.at(-1), 99);
  assert.ok(indexes.includes(37));
  assert.deepEqual(
    indexes,
    [...indexes].sort((left, right) => left - right),
  );
});
