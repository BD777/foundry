import assert from "node:assert/strict";
import test from "node:test";
import {
  sdkProcessEvent,
  sdkResponseMessage,
  claudeContentBlockProcessEvent,
} from "../dist/sdk-messages.js";
import { sessionEvent } from "../dist/session-helpers.js";
import { codexTranscriptRecord } from "../dist/transcript-adapters/codex.js";
import { claudeTranscriptRecord } from "../dist/transcript-adapters/claude.js";

test("Codex managed and file adapters preserve command identity and lifecycle", () => {
  for (const type of ["item.started", "item.completed"]) {
    const raw = {
      type,
      item: {
        id: "command-1",
        type: "command_execution",
        command: "pwd",
        aggregated_output: "/workspace",
        status: type === "item.completed" ? "completed" : "in_progress",
      },
    };
    const managed = sdkProcessEvent(raw).message;
    const [native] = codexTranscriptRecord(raw, "fallback");
    assert.equal(managed.kind, native.kind);
    assert.equal(managed.callId, native.callId);
    assert.equal(managed.status, native.status);
    assert.equal(managed.text, native.text);
  }
});

test("Claude managed and file adapters preserve tool identity with existing detail formatting", () => {
  const block = {
    type: "tool_use",
    id: "tool-1",
    name: "Read",
    input: { path: "file" },
  };
  const live = claudeContentBlockProcessEvent(block, false);
  const [native] = claudeTranscriptRecord(
    { message: { role: "assistant", content: [block] } },
    "fallback",
  );
  assert.equal(live.message.kind, native.kind);
  assert.equal(live.message.callId, native.callId);
  assert.equal(live.message.status, native.status);
  assert.equal(live.message.text, live.detail);
});

test("Codex commentary is explicit and never masquerades as a final answer", () => {
  const message = sdkResponseMessage(
    { item: { id: "commentary", type: "agent_message", phase: "commentary" } },
    "Checking",
  );
  assert.equal(message.kind, "commentary");
  assert.equal(message.id, "commentary");
});

test("event envelopes retain semantic metadata and allocate missing item identities", () => {
  const message = {
    id: "",
    kind: "reasoning",
    text: "Summary",
    title: "思考完成",
  };
  const event = sessionEvent(
    "s",
    "label",
    "Summary",
    "info",
    "event-1",
    undefined,
    message,
  );
  assert.deepEqual(event.message, { ...message, id: "event-1" });
});
