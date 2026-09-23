import assert from "node:assert/strict";
import test from "node:test";
import { nativeChatTranscript } from "../dist/native-chat-transcript.js";

const response = (payload) =>
  JSON.stringify({ type: "response_item", payload });
const completed = (item) =>
  JSON.stringify({
    type: "event_msg",
    payload: { type: "item_completed", item },
  });

test("native messages retain timestamps, including when mirrors omit them", () => {
  const at = "2026-09-08T06:00:00.000Z";
  const codex = {
    type: "response_item",
    timestamp: at,
    payload: {
      type: "message",
      id: "answer",
      role: "assistant",
      content: [{ type: "output_text", text: "Answer" }],
    },
  };
  const messages = nativeChatTranscript(
    [JSON.stringify(codex), JSON.stringify({ ...codex, timestamp: undefined })],
    "codex",
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].at, at);
  const claude = nativeChatTranscript(
    [
      JSON.stringify({
        uuid: "user",
        timestamp: at,
        message: { role: "user", content: "Question" },
      }),
      JSON.stringify({
        uuid: "answer",
        timestamp: "invalid",
        message: { role: "assistant", content: "Answer" },
      }),
    ],
    "claude",
  );
  assert.equal(claude[0].at, at);
  assert.equal(claude[1].at, undefined);
});
const message = (role, value, id = role) =>
  response({
    type: "message",
    id,
    role,
    content: [{ type: "output_text", text: value }],
  });

test("Codex public summaries survive mirrors and cumulative snapshots before the answer", () => {
  const lines = [message("user", "Explain ranking")];
  for (const [index, parts] of [
    ["First step"],
    ["First step", "Second step"],
  ].entries()) {
    const id = `reason-${index}`;
    lines.push(
      completed({
        type: "Reasoning",
        id,
        summary_text: parts,
        raw_content: [],
      }),
    );
    lines.push(
      response({
        type: "reasoning",
        id,
        summary: parts.map((text) => ({ type: "summary_text", text })),
        encrypted_content: "secret-ciphertext",
      }),
    );
  }
  const answer = "Long answer\n".repeat(150) + "\n```python\nrank()\n```";
  lines.push(message("assistant", answer));
  lines.push(
    completed({
      type: "AgentMessage",
      id: "assistant",
      content: [{ type: "text", text: answer }],
    }),
  );
  const messages = nativeChatTranscript(lines, "codex");
  assert.deepEqual(
    messages.map((m) => m.kind),
    ["user", "reasoning", "assistant"],
  );
  assert.equal(messages[1].text, "First step\n\nSecond step");
  assert.equal(messages[2].text, answer);
  assert.ok(!JSON.stringify(messages).includes("secret-ciphertext"));
});

test("reasoning does not leak encryption or invent content when no summary is saved", () => {
  const messages = nativeChatTranscript(
    [
      response({ type: "reasoning", summary: [], encrypted_content: "secret" }),
      message("assistant", "Answer"),
    ],
    "codex",
  );
  assert.deepEqual(
    messages.map((m) => m.kind),
    ["assistant"],
  );
});

test("Codex tools and commentary retain their types and chronology", () => {
  const messages = nativeChatTranscript(
    [
      response({
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ text: "Checking" }],
      }),
      response({
        type: "function_call",
        id: "call",
        name: "exec",
        arguments: "pwd",
      }),
      response({
        type: "function_call_output",
        call_id: "call",
        output: "/workspace",
      }),
      message(
        "assistant",
        "Codex: this is literal answer text\nUser: also literal",
      ),
    ],
    "codex",
  );
  assert.deepEqual(
    messages.map((m) => m.kind),
    ["commentary", "tool", "tool", "assistant"],
  );
  assert.equal(messages[1].title, "正在使用工具");
  assert.match(messages[1].text, /^exec/);
  assert.equal(messages[1].callId, messages[2].callId);
  assert.equal(messages[2].text, "/workspace");
});

test("Claude mixed content preserves thinking, tools, tool results and answer", () => {
  const record = (role, content) =>
    JSON.stringify({ type: role, message: { role, content } });
  const messages = nativeChatTranscript(
    [
      record("user", "Question"),
      record("assistant", [
        { type: "thinking", thinking: "Saved thinking" },
        { type: "tool_use", name: "Read", input: { path: "file" } },
      ]),
      record("user", [
        {
          type: "tool_result",
          content: [{ type: "text", text: "File content" }],
        },
      ]),
      record("assistant", [{ type: "text", text: "Answer" }]),
    ],
    "claude",
  );
  assert.deepEqual(
    messages.map((m) => m.kind),
    ["user", "reasoning", "tool", "tool", "assistant"],
  );
  assert.equal(messages[1].text, "Saved thinking");
  assert.equal(messages[3].text, "File content");
});

test("a bounded read explicitly marks unloaded history", () => {
  const messages = nativeChatTranscript(
    [message("assistant", "Answer")],
    "codex",
    true,
  );
  assert.equal(messages.at(-1).kind, "boundary");
});

test("identical tool executions with different IDs are not deduplicated", () => {
  const messages = nativeChatTranscript(
    [
      response({
        type: "function_call",
        id: "first",
        name: "exec",
        arguments: "pwd",
      }),
      response({
        type: "function_call",
        id: "second",
        name: "exec",
        arguments: "pwd",
      }),
    ],
    "codex",
  );
  assert.equal(messages.length, 2);
  assert.notEqual(messages[0].id, messages[1].id);
});
