import assert from "node:assert/strict";
import test from "node:test";
import {
  sdkProcessEvent,
  sdkResponseMessage,
  claudeContentBlockProcessEvent,
  claudeProcessEvents,
  claudeMessageText,
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

test("Claude narration stays commentary in live, native and replayed frames", () => {
  const content = [
    { type: "thinking", thinking: "Reasoning summary" },
    {
      type: "thinking",
      thinking: "Checked the retry path. Updating the handler.",
    },
    {
      type: "tool_use",
      id: "tool-next",
      name: "Bash",
      input: { command: "pwd" },
    },
  ];
  const raw = {
    type: "assistant",
    uuid: "frame-1",
    narration_block_indexes: [1],
    message: {
      id: "request-1",
      role: "assistant",
      content,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
  };
  for (const frame of [raw, { ...raw, isReplay: true }]) {
    const live = claudeProcessEvents(frame).map((event) => event.message);
    const native = claudeTranscriptRecord(frame, "fallback");
    assert.deepEqual(
      live.map((item) => item.kind),
      ["reasoning", "commentary", "tool"],
    );
    assert.deepEqual(
      native.map((item) => item.kind),
      live.map((item) => item.kind),
    );
    assert.equal(live[1].id, "frame-1:1");
    assert.equal(native[1].id, live[1].id);
    assert.equal(live[1].text, content[1].thinking);
    assert.equal(live[1].requestUsage.requestId, "request-1");
    assert.equal(live[2].callId, "tool-next");
    assert.equal(live[2].status, "running");
    assert.equal(
      claudeMessageText(frame),
      "",
      "progress does not become a final answer",
    );
  }
  assert.deepEqual(
    claudeProcessEvents({ ...raw, parent_tool_use_id: "parent" }),
    [],
  );
});

test("Claude progress classification requires native evidence and readable text", () => {
  const cases = [
    [{ narration_block_indexes: [0] }, "Progress", "commentary"],
    [{ thinking_display: "updates" }, "Progress", "commentary"],
    [{}, "I will check the handler.", "reasoning"],
    [{ thinking_display: "summarized" }, "Progress", "reasoning"],
    [{ narration_block_indexes: [1] }, "Progress", "reasoning"],
    [{ narration_block_indexes: ["0"] }, "Progress", "reasoning"],
    [{ narration_block_indexes: "0" }, "Progress", "reasoning"],
    [
      { narration_block_indexes: [0], thinking_display: "updates" },
      "",
      "reasoning",
    ],
  ];
  for (const [metadata, text, kind] of cases) {
    const raw = {
      type: "assistant",
      ...metadata,
      message: {
        id: "request",
        role: "assistant",
        content: [{ type: "thinking", thinking: text }],
      },
    };
    const [live] = claudeProcessEvents(raw);
    assert.equal(live.message.kind, kind);
    const native = claudeTranscriptRecord(raw, "fallback");
    if (text) assert.equal(native[0].kind, kind);
    else assert.deepEqual(native, [], "empty history blocks stay hidden");
  }
});

test("event envelopes retain semantic metadata and allocate missing item identities", () => {
  const message = {
    id: "",
    kind: "reasoning",
    text: "Summary",
    title: "Thought",
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
