import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The runtime's config home is a scratch folder, set before modules read it.
const root = realpathSync(mkdtempSync(join(tmpdir(), "foundry-question-")));
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
const cli = join(root, "agent-cli");
writeFileSync(cli, "#!/bin/sh\necho 0.0.0-test\n", { mode: 0o755 });
process.env.FOUNDRY_CLAUDE_BIN = cli;
test.after(() => rmSync(root, { recursive: true, force: true }));

register("./fixtures/fake-question-sdk-hooks.mjs", import.meta.url);
const { received, calls, question } =
  await import("./fixtures/fake-question-sdk.mjs");
const { closeAllActiveRuntimes } =
  await import("../dist/session/runner/active-runtimes.js");
const { runClaudeWorkspaceSession } =
  await import("../dist/session/runner/claude-turn.js");
const { steerActiveSession } =
  await import("../dist/session/session-helpers.js");
const { agentQuestionReplyText } = await import("@bd777/foundry-protocol");
const { claudeAsksPerson, claudeQuestions } =
  await import("../dist/session/runner/claude-questions.js");
test.after(() => closeAllActiveRuntimes());

const profile = { id: "claude_local", runtime: "claude", label: "Claude" };

function chatSession(overrides = {}) {
  const id = `sess_${randomUUID()}`;
  return {
    id,
    threadId: id,
    workspaceId: "ws",
    agentId: "agent",
    deviceId: "dev",
    provider: "claude",
    source: "chat",
    status: "running",
    title: "t",
    prompt: "Write the README",
    createdLabel: "now",
    updatedLabel: "running",
    input: { id: randomUUID(), prompt: "Write the README" },
    ...overrides,
  };
}

async function runTurn(session, waitMs = "60000") {
  process.env.FOUNDRY_CLAUDE_QUESTION_WAIT_MS = waitMs;
  const cwd = join(root, `ws-${randomUUID()}`);
  mkdirSync(cwd, { recursive: true });
  const events = [];
  received.length = 0;
  const finished = runClaudeWorkspaceSession(
    cwd,
    session,
    profile,
    async (label, detail, level, metadata, message, eventId) => {
      events.push({ label, detail, message, eventId });
    },
    async () => {},
    () => {},
  );
  return { events, finished };
}

async function until(condition, what) {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited > 5000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const asked = (events) =>
  events.find((event) => event.message?.questions?.length);

test("a person's chat sees Claude's question and its answer settles the call", async () => {
  const session = chatSession();
  const { events, finished } = await runTurn(session);
  await until(() => asked(events), "the question");

  const shown = asked(events);
  assert.equal(shown.label, "Response stream");
  assert.equal(shown.message.id, "toolu_" + calls.length);
  assert.equal(shown.message.kind, "assistant");
  assert.deepEqual(shown.message.questions, [
    {
      title: "Which greeting should the README use?",
      header: "Greeting",
      options: ["Hello (Recommended)", "Bonjour"],
      descriptions: ["Plain English", "French"],
      unranked: true,
    },
    {
      title: "Which extras?",
      header: "Extras",
      options: ["Emoji", "Signature"],
      multiSelect: true,
      unranked: true,
    },
  ]);
  assert.match(shown.message.text, /- Bonjour — French/);
  // The call is the question, not a tool step.
  assert.equal(
    events.some(
      (event) =>
        event.message?.kind === "tool" && event.message.id === shown.message.id,
    ),
    false,
  );
  // Other prompts are denied as before, without reaching the person.
  await until(() => calls.at(-1).denied, "the denied prompt");
  assert.equal(calls.at(-1).denied.behavior, "deny");
  assert.match(calls.at(-1).denied.message, /git push/);

  const reply = agentQuestionReplyText(
    shown.message.id,
    shown.message.questions,
    ["Bonjour", "Emoji, Signature"],
  );
  await steerActiveSession(
    session.id,
    reply,
    [],
    "question:" + shown.message.id,
  );
  const result = await finished;

  assert.deepEqual(calls.at(-1).result.updatedInput.answers, {
    "Which greeting should the README use?": "Bonjour",
    "Which extras?": "Emoji, Signature",
  });
  assert.deepEqual(
    calls.at(-1).result.updatedInput.questions,
    question.questions,
  );
  assert.match(result.response, /Bonjour/);
  // The answer settled the call; Claude did not also get it as a message.
  assert.equal(received.length, 1);
  const steered = events.find(
    (event) => event.label === "Steered into active turn",
  );
  assert.equal(steered.detail, reply.trim());
});

test("an unanswered question lets Claude go on: its tool reports no answer", async () => {
  const { events, finished } = await runTurn(chatSession(), "40");
  await finished;
  assert.ok(asked(events));
  assert.deepEqual(calls.at(-1).result, {
    behavior: "allow",
    updatedInput: { ...question, answers: {} },
  });
});

test("what the person writes instead of choosing is the question's response", async () => {
  const session = chatSession();
  const { events, finished } = await runTurn(session);
  await until(() => asked(events), "the question");
  await steerActiveSession(session.id, "Use both, and keep it short.", []);
  await finished;
  assert.deepEqual(calls.at(-1).result.updatedInput, {
    ...question,
    answers: {},
    response: "Use both, and keep it short.",
  });
  assert.equal(received.length, 1);
});

test("sessions no person holds never get the question tool", async () => {
  for (const session of [
    chatSession({ parentSessionId: "sess_parent" }),
    chatSession({ source: "agent" }),
    chatSession({ issueId: "iss_1" }),
    chatSession({ role: "planner" }),
  ]) {
    assert.equal(claudeAsksPerson(session), false);
    const { events, finished } = await runTurn(session);
    const result = await finished;
    assert.equal(calls.at(-1).canUseTool, false);
    assert.equal(result.response, "No question tool.");
    assert.equal(asked(events), undefined);
  }
  assert.equal(claudeAsksPerson(chatSession()), true);
});

test("a question without options takes free text", () => {
  assert.deepEqual(
    claudeQuestions({
      questions: [
        { question: "  What should it be called? ", kind: "text" },
        { question: "", options: [{ label: "x" }] },
      ],
    }),
    [{ title: "What should it be called?" }],
  );
});
