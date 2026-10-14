import assert from "node:assert/strict";
import test from "node:test";
import {
  activeRuntimeKey,
  sessionPrompt,
  codexSandboxMode,
  claudeMaxTurns,
  claudePermissionMode,
  codexApprovalPolicy,
} from "../dist/runner.js";
import { nativeChatRecap } from "../dist/native-chat-records.js";
import {
  isPromptOnlySession,
  isUtilitySession,
} from "../dist/session-roles.js";
import { foundryToolsEndpoint } from "../dist/session-ambient.js";

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

/** A Personal Agent digest summary reads its prompt only, read-only, without Foundry's tools. */
test("a digest summary session is prompt-only and read-only", () => {
  const profile = {
    id: "p",
    runtime: "codex",
    codexSandboxMode: "danger-full-access",
  };
  const digest = {
    id: "digest-1",
    workspaceId: "ws",
    provider: "codex",
    source: "digest",
    prompt: "summary data",
    codexSandboxMode: "danger-full-access",
  };
  assert.equal(isUtilitySession(digest), true);
  assert.equal(isPromptOnlySession(digest), true);
  assert.equal(foundryToolsEndpoint(digest), undefined);
  assert.equal(sessionPrompt(digest, profile), "summary data");
  assert.equal(codexSandboxMode(digest, profile), "read-only");
  assert.equal(claudeMaxTurns(digest), 3);
});

/**
 * sess_1791953123332185876: a naming job ran in plan mode, so the model
 * wrote a plan file instead of the JSON title. Whatever the record, the
 * profile or the person's own defaults say, utility sessions never plan and
 * never ask.
 */
test("utility sessions run dontAsk, never plan mode, and Codex never asks", () => {
  const profile = {
    id: "p",
    runtime: "claude",
    claudePermissionMode: "plan",
    codexApprovalPolicy: "on-request",
  };
  for (const source of ["naming", "diagnostic", "digest"]) {
    const utility = {
      id: `${source}-1`,
      workspaceId: "ws",
      provider: "claude",
      source,
      prompt: "recap data",
      claudePermissionMode: "plan",
      codexApprovalPolicy: "on-request",
    };
    assert.equal(claudePermissionMode(utility, profile), "dontAsk", source);
    assert.equal(codexApprovalPolicy(utility, profile), "never", source);
  }
  const chat = {
    id: "chat-1",
    workspaceId: "ws",
    provider: "claude",
    source: "chat",
  };
  assert.equal(claudePermissionMode(chat, profile), "plan");
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

test("a native turn that went silent long ago was cut off, not running", () => {
  const lines = [
    JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: "keep digging" },
    }),
  ];
  assert.equal(nativeChatRecap(lines, "codex", new Date()).status, "running");
  assert.equal(
    nativeChatRecap(lines, "codex", new Date("2026-06-17T13:52:24Z")).status,
    "canceled",
  );
  const finished = [
    ...lines,
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
  ];
  assert.equal(
    nativeChatRecap(finished, "codex", new Date("2026-06-17T13:52:24Z")).status,
    "completed",
  );
});
