import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_VIRTUOSO_VIEWPORT,
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
