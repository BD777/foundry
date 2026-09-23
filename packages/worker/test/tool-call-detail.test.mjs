import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeToolUseDetail,
  hasMeaningfulToolPayload,
  sdkToolCallDetail,
} from "../dist/sdk-messages.js";

test("does not serialize empty tool arguments or results", () => {
  assert.equal(claudeToolUseDetail({ input: {}, name: "Bash" }), "Bash");
  assert.equal(
    sdkToolCallDetail(
      { arguments: {}, result: [], server: "local", tool: "inspect" },
      true,
    ),
    "local.inspect",
  );
});

test("keeps meaningful nested tool payloads", () => {
  assert.equal(hasMeaningfulToolPayload({ input: { command: "pwd" } }), true);
  assert.match(
    sdkToolCallDetail(
      {
        arguments: { path: "/tmp/input.txt" },
        result: { content: [{ text: "done" }] },
        server: "local",
        tool: "inspect",
      },
      true,
    ),
    /Arguments[\s\S]*Result/,
  );
});
