import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_VIRTUOSO_VIEWPORT,
  chatFirstRowsShift,
  estimateChatMessageHeight,
} from "../src/components/conversation/chat-virtualization.ts";

test("does not cap very long Markdown messages to a single viewport", () => {
  const estimate = estimateChatMessageHeight({
    id: "long-answer",
    role: "bot",
    text: `# Summary\n\n${"A long answer with Markdown. ".repeat(180)}`,
  });

  assert.ok(estimate > 1200);
});

test("collapsed rows are estimated at their rendered height, row spacing included", () => {
  assert.equal(
    estimateChatMessageHeight({
      id: "p",
      kind: "process",
      role: "bot",
      text: "",
    }),
    56,
  );
  assert.equal(
    estimateChatMessageHeight({
      id: "b",
      kind: "boundary",
      role: "bot",
      text: "",
    }),
    43,
  );
});

test("fast scrolling keeps a rendered buffer ahead without over-rendering behind", () => {
  const { increaseViewportBy, minOverscanItemCount, overscan } =
    CHAT_VIRTUOSO_VIEWPORT;
  // The same buffer in both directions: people read history upwards and
  // catch up downwards.
  assert.equal(increaseViewportBy.top, increaseViewportBy.bottom);
  assert.ok(increaseViewportBy.bottom >= 1200);
  // Extra rows only ahead of the scroll; rows scrolled away from are not
  // mounted beyond the buffer, and a batch never adds many rows past it.
  assert.equal(overscan.reverse, 0);
  assert.ok(overscan.main > 0 && overscan.main <= increaseViewportBy.bottom);
  assert.ok(minOverscanItemCount.top <= 2 && minOverscanItemCount.bottom <= 2);
  // Opening a chat still renders as far above the latest message as before.
  assert.equal(increaseViewportBy.top + overscan.main, 1800);
});

// Rows as Virtuoso's `itemsRendered` reports them: position, message, offset.
const rendered = (...rows) =>
  rows.map(([originalIndex, id, offset]) => ({
    data: { id },
    offset,
    originalIndex,
  }));

test("the first message measured above the viewport moves the row being read by the difference", () => {
  // Scrolling up: the first message (a long prompt) mounted at its 96px
  // estimate, then measured at 500px, while "answer" is at the top.
  const mounted = rendered(
    [0, "prompt", 0],
    [1, "step", 96],
    [2, "answer", 152],
  );
  const measured = rendered(
    [0, "prompt", 0],
    [1, "step", 500],
    [2, "answer", 556],
  );
  assert.equal(chatFirstRowsShift(mounted, measured, 2), 404);
  // Shrinking moves it back up.
  assert.equal(chatFirstRowsShift(measured, mounted, 2), -404);
  // Nothing moved.
  assert.equal(chatFirstRowsShift(measured, measured, 2), 0);
});

test("leaves to Virtuoso every change it compensates itself", () => {
  const before = rendered([3, "step", 300], [4, "answer", 356]);
  const after = rendered(
    [2, "prompt", 200],
    [3, "step", 340],
    [4, "answer", 396],
  );
  // Virtuoso compensates unless both layouts start at the first message.
  assert.equal(chatFirstRowsShift(before, after, 4), 0);
  assert.equal(
    chatFirstRowsShift(
      rendered([1, "step", 96], [2, "answer", 152]),
      rendered([0, "prompt", 0], [1, "step", 500], [2, "answer", 556]),
      2,
    ),
    0,
  );
  // The first message itself at the top: it grows downwards, in view.
  assert.equal(
    chatFirstRowsShift(
      rendered([0, "prompt", 0], [1, "step", 96]),
      rendered([0, "prompt", 0], [1, "step", 500]),
      0,
    ),
    0,
  );
  // Rows added in front are useChatPrependAnchor's.
  assert.equal(
    chatFirstRowsShift(
      rendered([0, "prompt", 0], [1, "answer", 96]),
      rendered([0, "older", 0], [1, "prompt", 96], [2, "answer", 192]),
      1,
    ),
    0,
  );
  assert.equal(chatFirstRowsShift([], rendered([0, "prompt", 0]), 1), 0);
});
