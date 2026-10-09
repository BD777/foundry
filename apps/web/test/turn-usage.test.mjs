import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register("./bundler-resolve.mjs", import.meta.url);
const { sessionTranscriptEntries } =
  await import("../src/features/chat/transcript-adapters.ts");
const { projectTranscript } =
  await import("../src/features/chat/transcript-projection.ts");
const { chatMessages, chatMessagesForThread } =
  await import("../src/features/chat/chat-model.ts");
const { formatDuration, turnUsageSummary } =
  await import("../src/components/conversation/turn-usage.tsx");
const { i18n } = await import("../src/i18n/index.ts");

const usage = {
  durationMs: 34_200,
  inputTokens: 57_200,
  cacheReadTokens: 53_574,
  cacheWriteTokens: 3_042,
  outputTokens: 1_886,
  modelRequests: 7,
};

const event = (id, at, fields) => ({
  id,
  sessionId: "s",
  at,
  level: "info",
  detail: "",
  ...fields,
});

const userMessage = (id, at) =>
  event(id, at, {
    label: "User message",
    message: { id, kind: "user", text: "hi" },
  });

test("a turn's usage lands on the answer it ended with", () => {
  const session = {
    id: "s",
    status: "completed",
    events: [
      userMessage("u1", "2026-10-09T01:00:00.000Z"),
      event("think", "2026-10-09T01:00:02.000Z", {
        label: "Thinking",
        message: { id: "think", kind: "reasoning", text: "…" },
      }),
      event("thought", "2026-10-09T01:00:09.500Z", {
        label: "Finished thinking",
        message: { id: "thought", kind: "reasoning", text: "done" },
      }),
      event("a1", "2026-10-09T01:00:20.000Z", {
        label: "Response stream",
        message: { id: "a1", kind: "assistant", text: "answer" },
      }),
      event("fin1", "2026-10-09T01:00:20.100Z", {
        label: "Claude Agent SDK finished",
        detail: "/tmp/result.md",
        metadata: { turnUsage: usage },
      }),
      // A later turn that failed before answering keeps its usage to itself.
      userMessage("u2", "2026-10-09T01:01:00.000Z"),
      event("fin2", "2026-10-09T01:01:05.000Z", {
        label: "Codex SDK finished",
        detail: "/tmp/result.md",
        metadata: { turnUsage: { ...usage, outputTokens: 1 } },
      }),
    ],
  };
  const entries = sessionTranscriptEntries(session);
  const answers = entries.filter((entry) => entry.kind === "assistant");
  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0].usage, usage);
  assert.equal(
    entries.some((entry) => /finished/i.test(entry.title ?? "")),
    false,
    "the finishing event itself stays out of the transcript",
  );

  const messages = projectTranscript(entries);
  const process = messages.find((message) => message.kind === "process");
  assert.equal(process.durationMs, 7_500);
  assert.deepEqual(messages.find((m) => m.usage)?.usage, usage);

  const thread = chatMessagesForThread({
    id: "s",
    sessions: [session],
    title: "t",
  });
  assert.deepEqual(
    thread.find((message) => message.usage)?.usage,
    usage,
    "the chat thread view keeps the usage on its answer",
  );
});

test("durations and token counts read naturally in both languages", async () => {
  await i18n.changeLanguage("en");
  assert.equal(formatDuration(400), "1s");
  assert.equal(formatDuration(34_200), "34s");
  assert.equal(formatDuration(72_000), "1m 12s");
  assert.equal(formatDuration(3_780_000), "1h 3m");
  assert.equal(
    turnUsageSummary(usage),
    "34s · 57.2K in (94% cached) · 1.9K out",
  );
  assert.equal(
    turnUsageSummary({ ...usage, cacheReadTokens: 0 }),
    "34s · 57.2K in · 1.9K out",
  );
  await i18n.changeLanguage("zh-CN");
  assert.equal(formatDuration(72_000), "1 分 12 秒");
  assert.equal(
    turnUsageSummary(usage),
    "34 秒 · 输入 5.7万（缓存命中 94%） · 输出 1886",
  );
  await i18n.changeLanguage("en");
});

test("a sent message shows at once and leaves the previous turn settled", () => {
  const previousTurn = [
    userMessage("u1", "2026-10-09T01:00:00.000Z"),
    event("tool", "2026-10-09T01:00:05.000Z", {
      label: "Produced output file",
      message: { id: "tool", kind: "tool", text: "tools/x.py" },
    }),
  ];
  const sent = {
    id: "u2",
    prompt: "next question",
    at: "2026-10-09T01:02:00.000Z",
  };
  const session = {
    id: "s",
    status: "queued",
    input: sent,
    events: previousTurn,
  };
  const before = chatMessagesForThread({
    id: "s",
    sessions: [session],
    title: "t",
  });
  const last = before.at(-1);
  assert.equal(last.role, "user");
  assert.equal(last.text, "next question");
  assert.equal(
    before.some((message) => message.streaming),
    false,
    "the previous turn's last step must not look live again",
  );

  const after = chatMessagesForThread({
    id: "s",
    title: "t",
    sessions: [
      { ...session, events: [...previousTurn, userMessage("u2", sent.at)] },
    ],
  });
  const users = after.filter((message) => message.role === "user");
  assert.equal(
    users.length,
    2,
    "the arriving event replaces the pending message",
  );
  assert.equal(users.at(-1).id, last.id, "with the same identity");
});

test("an imported chat shows the turn usage read from the agent's log", () => {
  const usage = {
    durationMs: 4000,
    inputTokens: 1200,
    cacheReadTokens: 1000,
    cacheWriteTokens: 0,
    outputTokens: 80,
  };
  const messages = chatMessages({
    id: "native",
    provider: "claude",
    transcript: [
      { id: "u", kind: "user", text: "hi", at: "2026-10-09T01:00:00.000Z" },
      {
        id: "a",
        kind: "assistant",
        text: "hello",
        at: "2026-10-09T01:00:04.000Z",
        turnUsage: usage,
      },
    ],
  });
  const answer = messages.find((message) => message.text === "hello");
  assert.deepEqual(answer.usage, usage);
});
