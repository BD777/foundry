import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeStreamLog } from "../dist/session/runner/claude-stream-log.js";

const stream = (event, parent = null) => ({
  type: "stream_event",
  event,
  parent_tool_use_id: parent,
});
const delta = (index, partial_json) =>
  stream({
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json },
  });

test("a block's deltas are folded into progress and stop summaries", () => {
  let now = 0;
  const log = new ClaudeStreamLog(() => now);
  const messageStart = stream({ type: "message_start" });
  assert.deepEqual(log.lines(messageStart), [messageStart]);
  const start = stream({
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", name: "Write" },
  });
  assert.deepEqual(log.lines(start), [start]);
  now = 1000;
  assert.deepEqual(log.lines(delta(1, "ab")), []);
  now = 6000;
  assert.deepEqual(log.lines(delta(1, "cdé")), [
    {
      type: "foundry_stream_summary",
      end: "progress",
      index: 1,
      parent_tool_use_id: null,
      block: "tool_use",
      name: "Write",
      deltas: 2,
      bytes: 6,
      ms: 6000,
    },
  ]);
  now = 7000;
  assert.deepEqual(log.lines(delta(1, "f")), []);
  now = 8000;
  const stop = stream({ type: "content_block_stop", index: 1 });
  const [summary, raw] = log.lines(stop);
  assert.deepEqual(
    {
      end: summary.end,
      deltas: summary.deltas,
      bytes: summary.bytes,
      ms: summary.ms,
    },
    { end: "stop", deltas: 3, bytes: 7, ms: 8000 },
  );
  assert.equal(raw, stop);
  assert.deepEqual(log.interrupted(), []);
  const assistant = { type: "assistant", message: { content: [] } };
  assert.deepEqual(log.lines(assistant), [assistant]);
});

test("blocks still streaming are reported as interrupted, per subagent", () => {
  let now = 0;
  const log = new ClaudeStreamLog(() => now);
  log.lines(
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text" },
    }),
  );
  log.lines(
    stream(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
      "toolu_sub",
    ),
  );
  log.lines(
    stream(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hi" },
      },
      "toolu_sub",
    ),
  );
  now = 3000;
  const lines = log.interrupted();
  assert.deepEqual(
    lines.map(({ end, parent_tool_use_id, deltas, bytes, ms }) => ({
      end,
      parent_tool_use_id,
      deltas,
      bytes,
      ms,
    })),
    [
      {
        end: "interrupted",
        parent_tool_use_id: null,
        deltas: 0,
        bytes: 0,
        ms: 3000,
      },
      {
        end: "interrupted",
        parent_tool_use_id: "toolu_sub",
        deltas: 1,
        bytes: 2,
        ms: 3000,
      },
    ],
  );
  assert.deepEqual(log.interrupted(), []);
});

test("a block restarted at the same index first closes the old one", () => {
  const log = new ClaudeStreamLog(() => 0);
  log.lines(
    stream({
      type: "content_block_start",
      index: 2,
      content_block: { type: "thinking" },
    }),
  );
  const again = stream({
    type: "content_block_start",
    index: 2,
    content_block: { type: "text" },
  });
  const [closed, raw] = log.lines(again);
  assert.equal(closed.end, "interrupted");
  assert.equal(closed.block, "thinking");
  assert.equal(raw, again);
});
