import assert from "node:assert/strict";
import test from "node:test";
import {
  activeRuntimeKey,
  sessionPrompt,
  codexSandboxMode,
  claudeMaxTurns,
} from "../dist/runner.js";
import { nativeChatRecap } from "../dist/native-chat.js";

test("recap cannot reuse the original runtime or inherit a prompt prefix", () => {
  const profile = {
    id: "same",
    runtime: "codex",
    promptPrefix: "original prefix",
  };
  const original = {
    id: "original",
    threadId: "original",
    workspaceId: "ws",
    provider: "codex",
    source: "chat",
  };
  const naming = {
    id: "naming-1",
    workspaceId: "ws",
    provider: "codex",
    source: "naming",
    prompt: "recap data",
    importedContext: "must not inherit",
  };
  assert.notEqual(
    activeRuntimeKey("codex", "/workspace", original, profile, {}),
    activeRuntimeKey("codex", "/workspace", naming, profile, {}),
  );
  assert.equal(sessionPrompt(naming, profile), "recap data");
  assert.equal(codexSandboxMode(naming, profile), "read-only");
  assert.equal(claudeMaxTurns(naming), 3);
});

/**
 * A profile's prompt prefix used to be prepended to every turn, resumed turns
 * included. The stored column stays for older rows, but nothing injects it.
 */
test("a stored prompt prefix is never prepended to a chat turn", () => {
  const profile = {
    id: "claude-1",
    runtime: "claude",
    promptPrefix: "/effort ultracode",
    claudeEffort: "high",
  };
  const session = {
    id: "ses_1",
    workspaceId: "ws",
    provider: "claude",
    source: "chat",
    prompt: "hello",
  };
  assert.equal(sessionPrompt(session, profile), "hello");
});
test("native recap retains recent exchanges and stable answer identity", () => {
  const lines = [];
  for (let i = 0; i < 4; i++) {
    lines.push(
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: `question ${i}` },
      }),
    );
    lines.push(
      JSON.stringify({
        type: "event_msg",
        timestamp: `time-${i}`,
        payload: { type: "agent_message", message: `answer ${i}` },
      }),
    );
  }
  const recap = nativeChatRecap(lines, "codex");
  assert.deepEqual(
    recap.recentMessages.map((m) => m.text),
    ["question 2", "answer 2", "question 3", "answer 3"],
  );
  assert.equal(
    nativeChatRecap([...lines, JSON.stringify({ type: "irrelevant" })], "codex")
      .answerRevision,
    recap.answerRevision,
  );
});

test("many Claude assistant records do not evict the latest user question", () => {
  const lines = [
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "Keep this question" },
    }),
  ];
  for (let i = 0; i < 40; i++)
    lines.push(
      JSON.stringify({
        type: "assistant",
        uuid: `answer-${i}`,
        message: {
          role: "assistant",
          content: [{ type: "text", text: `progress ${i}` }],
        },
      }),
    );
  const recap = nativeChatRecap(lines, "claude");
  assert.equal(recap.recentMessages[0].text, "Keep this question");
  assert.ok(recap.recentMessages.at(-1).text.includes("progress 39"));
  assert.equal(recap.recentMessages.length, 2);
});
