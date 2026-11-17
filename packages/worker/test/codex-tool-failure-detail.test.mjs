import test from "node:test";
import assert from "node:assert/strict";
import { sdkToolCallDetail } from "../dist/session/runner/sdk-messages.js";

test("a failed Codex tool call keeps its error, bounded", () => {
  const detail = sdkToolCallDetail(
    {
      server: "foundry",
      tool: "send_message",
      arguments: { sessionId: "sess_1" },
      error: { message: "x".repeat(5_000) },
    },
    true,
  );
  assert.match(detail, /foundry\.send_message/);
  assert.match(detail, /Error\n\nx+/);
  assert.ok(detail.length < 1_600, `detail is ${detail.length} characters`);
});
