import assert from "node:assert/strict";
import test from "node:test";
import { isForwardedClaudeSubagentMessage } from "../dist/sdk-messages.js";

test("identifies forwarded subagent records without hiding lifecycle events", () => {
  assert.equal(
    isForwardedClaudeSubagentMessage({
      type: "assistant",
      parent_tool_use_id: "tool_agent",
    }),
    true,
  );
  assert.equal(
    isForwardedClaudeSubagentMessage({
      type: "stream_event",
      parentToolUseId: "tool_agent",
    }),
    true,
  );
  assert.equal(
    isForwardedClaudeSubagentMessage({
      type: "system",
      subtype: "task_started",
      task_type: "local_agent",
    }),
    false,
  );
  assert.equal(
    isForwardedClaudeSubagentMessage({
      type: "assistant",
      parent_tool_use_id: null,
    }),
    false,
  );
});
