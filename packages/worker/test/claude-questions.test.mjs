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
const {
  ClaudeQuestionGate,
  claudeAsksPerson,
  claudeQuestions,
  sessionQuestionsTo,
} = await import("../dist/session/runner/claude-questions.js");
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

test("who answers: the person's chat, a child's parent, or nobody", () => {
  const child = (questionsTo) =>
    chatSession({
      source: "agent",
      parentSessionId: "sess_parent",
      ...(questionsTo ? { questionsTo } : {}),
    });
  assert.equal(sessionQuestionsTo(chatSession()), "person");
  // The server resolved the chain: a child, a grandchild, an orphan.
  assert.equal(sessionQuestionsTo(child("parent")), "parent");
  // A server that says nothing: only the person's own chat asks.
  assert.equal(sessionQuestionsTo(child()), undefined);
  // A chain that reaches no person: the server says nothing.
  assert.equal(
    sessionQuestionsTo(
      chatSession({ questionsTo: undefined, source: "agent" }),
    ),
    undefined,
  );
  // Issues, roles and utility sessions never ask, whatever was sent.
  for (const session of [
    chatSession({ issueId: "iss_1", questionsTo: "person" }),
    chatSession({ role: "planner", questionsTo: "parent" }),
    chatSession({ source: "naming", questionsTo: "person" }),
  ])
    assert.equal(sessionQuestionsTo(session), undefined);
});

test("a child's question ends its turn and waits for its next message", async () => {
  const session = chatSession({
    source: "agent",
    parentSessionId: "sess_parent",
    questionsTo: "parent",
  });
  const { events, finished } = await runTurn(session);
  await finished;
  const shown = asked(events);
  assert.equal(shown.message.delivery, "next_turn");
  assert.equal(calls.at(-1).canUseTool, true);
  assert.equal(calls.at(-1).result.behavior, "deny");
  assert.match(
    calls.at(-1).result.message,
    /answer arrives as your next message/,
  );
  assert.match(calls.at(-1).result.message, /NOT answered/);
  assert.equal(calls.at(-1).denied.behavior, "deny");
});

const signal = () => new AbortController().signal;

test("a person approves or denies a plan; unanswered, it is denied", async () => {
  const shown = [];
  const gate = new ClaudeQuestionGate("person", {
    sessionId: "sess_plan",
    show: (message) => shown.push(message),
    waitMs: 60_000,
    afterPlan: "bypassPermissions",
  });
  const plan = { plan: "1. Edit README\n2. Run tests" };
  const approved = gate.canUseTool("ExitPlanMode", plan, {
    toolUseID: "toolu_plan",
    signal: signal(),
  });
  assert.equal(shown[0].id, "approval_toolu_plan");
  assert.deepEqual(shown[0].questions, [
    {
      title: "Approve this plan?",
      options: ["Approve", "Deny"],
      unranked: true,
      approval: true,
      detail: plan.plan,
    },
  ]);
  assert.equal(shown[0].delivery, undefined);
  assert.equal(gate.waits, true);
  assert.equal(
    gate.take(
      agentQuestionReplyText(shown[0].id, shown[0].questions, ["Approve"]),
    ),
    true,
  );
  // The approved plan leaves plan mode for the session's own mode.
  assert.deepEqual(await approved, {
    behavior: "allow",
    updatedInput: plan,
    updatedPermissions: [
      { type: "setMode", mode: "bypassPermissions", destination: "session" },
    ],
  });

  const denied = gate.canUseTool("ExitPlanMode", plan, {
    toolUseID: "toolu_plan2",
    signal: signal(),
  });
  assert.equal(gate.take("Split step 1 first"), true);
  const result = await denied;
  assert.equal(result.behavior, "deny");
  assert.match(result.message, /not approved: Split step 1 first/);

  const lapsed = [];
  const late = new ClaudeQuestionGate("person", {
    sessionId: "sess_plan_late",
    show: () => {},
    waitMs: 20,
    settled: (itemId) => lapsed.push(itemId),
  });
  const timedOut = await late.canUseTool("ExitPlanMode", plan, {
    toolUseID: "toolu_late",
    signal: signal(),
  });
  assert.equal(timedOut.behavior, "deny");
  assert.match(timedOut.message, /timed out after 20ms.*NOT performed/);
  // Unanswered, it settles (Pending closes it); answered ones above did not.
  assert.deepEqual(lapsed, ["approval_toolu_late"]);
  const ended = late.canUseTool("ExitPlanMode", plan, {
    toolUseID: "toolu_end",
    signal: signal(),
  });
  late.close();
  assert.equal((await ended).behavior, "deny");
  assert.deepEqual(lapsed, ["approval_toolu_late", "approval_toolu_end"]);
  // Other prompts are still denied at once.
  const bash = await late.canUseTool(
    "Bash",
    { command: "rm -rf x" },
    {
      toolUseID: "toolu_bash",
      signal: signal(),
    },
  );
  assert.equal(bash.behavior, "deny");
});

test("a child's plan approval is relayed; once approved, its next call passes", async () => {
  const shown = [];
  const host = {
    sessionId: `sess_${randomUUID()}`,
    show: (m) => shown.push(m),
    afterPlan: "acceptEdits",
  };
  const gate = new ClaudeQuestionGate("parent", host);
  const first = await gate.canUseTool(
    "ExitPlanMode",
    { plan: "p" },
    {
      toolUseID: "toolu_a",
      signal: signal(),
    },
  );
  assert.equal(first.behavior, "deny");
  assert.match(first.message, /allows the same call once/);
  assert.equal(shown[0].delivery, "next_turn");
  assert.equal(gate.waits, false);
  // A denial (any other answer) allows nothing.
  gate.observe(
    agentQuestionReplyText(shown[0].id, shown[0].questions, ["Not yet"]),
  );
  const again = await gate.canUseTool(
    "ExitPlanMode",
    { plan: "p" },
    {
      toolUseID: "toolu_b",
      signal: signal(),
    },
  );
  assert.equal(again.behavior, "deny");
  // The approval comes with a later turn, perhaps in a new process.
  const next = new ClaudeQuestionGate("parent", host);
  next.observe(
    "Message from your parent:\n" +
      agentQuestionReplyText(shown[1].id, shown[1].questions, ["approve"]),
  );
  const allowed = await next.canUseTool(
    "ExitPlanMode",
    { plan: "p" },
    {
      toolUseID: "toolu_c",
      signal: signal(),
    },
  );
  assert.equal(allowed.behavior, "allow");
  assert.deepEqual(allowed.updatedPermissions, [
    { type: "setMode", mode: "acceptEdits", destination: "session" },
  ]);
  // Approved once: the call after it asks again.
  const after = await next.canUseTool(
    "ExitPlanMode",
    { plan: "p" },
    {
      toolUseID: "toolu_d",
      signal: signal(),
    },
  );
  assert.equal(after.behavior, "deny");
});

test("an approved plan continues in the mode the session runs in without planning", async () => {
  const { claudePermissionModeAfterPlan, claudeRootBypassRefusal } =
    await import("../dist/session/runner/claude-options.js");
  const plan = chatSession({ claudePermissionMode: "plan" });
  const expectBypass = claudeRootBypassRefusal("bypassPermissions")
    ? "acceptEdits"
    : "bypassPermissions";
  assert.equal(claudePermissionModeAfterPlan(plan, profile), expectBypass);
  assert.equal(
    claudePermissionModeAfterPlan(plan, {
      ...profile,
      claudePermissionMode: "acceptEdits",
    }),
    "acceptEdits",
  );
  assert.equal(
    claudePermissionModeAfterPlan(plan, {
      ...profile,
      claudePermissionMode: "plan",
    }),
    expectBypass,
  );
  assert.equal(
    claudePermissionModeAfterPlan(
      chatSession({ claudePermissionMode: "default" }),
      profile,
    ),
    "default",
  );
});
