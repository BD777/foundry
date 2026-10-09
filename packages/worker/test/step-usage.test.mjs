import assert from "node:assert/strict";
import test from "node:test";
import { claudeProcessEvent } from "../dist/sdk-messages.js";
import { claudeRequestUsage, claudeSubagentUsage } from "../dist/turn-usage.js";

// Claude Agent SDK assistant message: one content block of a model request,
// carrying that request's usage under message.usage.
const assistant = (id, block, usage) => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: { id, role: "assistant", content: [block], usage },
});

test("a step carries the tokens of the model request that produced it", () => {
  const message = assistant(
    "msg_1",
    { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
    {
      input_tokens: 10,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 90,
      output_tokens: 40,
    },
  );
  assert.deepEqual(claudeRequestUsage(message), {
    requestId: "msg_1",
    inputTokens: 1000,
    cacheReadTokens: 900,
    cacheWriteTokens: 90,
    outputTokens: 40,
  });
  const event = claudeProcessEvent(message);
  assert.equal(event?.message?.kind, "tool");
  assert.equal(event?.message?.requestUsage?.requestId, "msg_1");
  assert.equal(
    claudeRequestUsage({ type: "assistant", message: {} }),
    undefined,
  );
});

test("subagent progress and completion carry the subagent's own usage", () => {
  const usage = { total_tokens: 12345, tool_uses: 6, duration_ms: 61000 };
  for (const subtype of ["task_progress", "task_notification"]) {
    const event = claudeProcessEvent({
      type: "system",
      subtype,
      task_id: "t1",
      tool_use_id: "toolu_task",
      status: "completed",
      summary: "done",
      description: "Explore",
      usage,
    });
    assert.deepEqual(event?.metadata?.subagentUsage, {
      totalTokens: 12345,
      toolUses: 6,
      durationMs: 61000,
    });
  }
  assert.equal(claudeSubagentUsage({ type: "system" }), undefined);
});
