import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeToolUseDetail,
  hasMeaningfulToolPayload,
  sdkToolCallDetail,
} from "../dist/session/runner/sdk-messages.js";

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

test("a null, empty or object-free error writes no Error section", () => {
  const call = {
    result: { id: "sess_child" },
    server: "foundry",
    tool: "create_session",
  };
  assert.equal(
    sdkToolCallDetail({ ...call, error: null }, true),
    'foundry.create_session\n\nResult\n\n```json\n{\n  "id": "sess_child"\n}\n```',
  );
  assert.doesNotMatch(sdkToolCallDetail({ ...call, error: "" }, true), /Error/);
  assert.doesNotMatch(sdkToolCallDetail({ ...call, error: {} }, true), /Error/);
  assert.doesNotMatch(
    sdkToolCallDetail({ ...call, error: false }, true),
    /Error/,
  );
});

test("a real error is written as the Error section", () => {
  assert.equal(
    sdkToolCallDetail(
      { error: "not allowed", server: "foundry", tool: "send_message" },
      true,
    ),
    "foundry.send_message\n\nError\n\nnot allowed",
  );
  assert.equal(
    sdkToolCallDetail(
      { error: { message: "boom" }, server: "foundry", tool: "send_message" },
      true,
    ),
    "foundry.send_message\n\nError\n\nboom",
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
