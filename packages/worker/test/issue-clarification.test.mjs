import test from "node:test";
import assert from "node:assert/strict";
import {
  validateClarificationResponse,
  parseClarificationResponse,
  readClarificationAnswer,
} from "../dist/issue-clarification.js";
import {
  stageJSONObject,
  normalizeVerificationShape,
} from "../dist/evidence-agent.js";

test("clarification accepts questions but cannot forge a confirmed contract or empty proposal", () => {
  assert.deepEqual(
    validateClarificationResponse({ message: "What should change?" }),
    { message: "What should change?" },
  );
  assert.throws(
    () => validateClarificationResponse({ message: "Done", confirmation: {} }),
    /invalid_clarification/,
  );
  assert.throws(
    () =>
      validateClarificationResponse({
        message: "Proposed",
        proposedContent: {
          goal: { text: "hi", media: [] },
          inScope: [],
          outOfScope: [],
          constraints: [],
          criteria: [],
        },
      }),
    /observable_criterion/,
  );
});

test("prose is a chat message and only JSON can carry a proposal", () => {
  assert.deepEqual(
    parseClarificationResponse(
      '```json\n{"message":"What should change?"}\n```',
    ),
    { message: "What should change?" },
  );
  // What the Agent wrote before the block is part of its reply.
  assert.deepEqual(
    parseClarificationResponse(
      'I read src/app.ts.\n```json\n{"message":"Shall I start there?"}\n```',
    ),
    { message: "I read src/app.ts.\n\nShall I start there?" },
  );
  assert.deepEqual(
    parseClarificationResponse(
      'Shall I start there?\n```json\n{"message":"Shall I start there?"}\n```',
    ),
    { message: "Shall I start there?" },
  );
  // A tool-using turn that simply answers must reach the person unchanged.
  assert.deepEqual(
    parseClarificationResponse(
      "看完了：README 第 8 行的规则在 src/pricing.js 里没有实现。",
    ),
    { message: "看完了：README 第 8 行的规则在 src/pricing.js 里没有实现。" },
  );
  // A block that only looks like code stays prose instead of failing the turn.
  assert.deepEqual(
    parseClarificationResponse("对比一下：\n```\nfoo(1, 2)\n```"),
    { message: "对比一下：\n```\nfoo(1, 2)\n```" },
  );
  assert.throws(
    () =>
      parseClarificationResponse(
        '```json\n{"message":"ok","proposedContent":{"goal":{"text":"hi","media":[]},"inScope":[],"outOfScope":[],"constraints":[],"criteria":[]}}\n```',
      ),
    /observable_criterion/,
  );
});

test("a malformed proposal still delivers the message instead of losing the turn", () => {
  const answer = readClarificationAnswer(
    '```json\n{"message":"我建议先补齐折扣边界。","proposedContent":{"goal":{"text":"x","media":[]},"inScope":[],"outOfScope":[],"constraints":[],"criteria":[]}}\n```',
  );
  assert.match(answer.message, /我建议先补齐折扣边界。/);
  assert.match(answer.message, /没有保存/);
  assert.equal(answer.proposedContent, undefined);
  // Text that only looks like JSON is delivered as an ordinary message.
  assert.equal(
    readClarificationAnswer("```json\n{invalid\n```").message,
    "```json\n{invalid\n```",
  );
  // A structured answer with neither a usable message nor a usable proposal
  // stays an error instead of an invented reply.
  assert.throws(() =>
    readClarificationAnswer(
      '{"proposedContent":{"goal":{"text":"x","media":[]},"inScope":[],"outOfScope":[],"constraints":[],"criteria":[]}}',
    ),
  );
});

test("an answer written as an object literal is still read", () => {
  assert.deepEqual(
    stageJSONObject(
      "{'verdict': 'pass', 'limitations': ['none: it\\'s fine']}",
    ),
    { verdict: "pass", limitations: ["none: it's fine"] },
  );
  assert.equal(stageJSONObject("no object here"), undefined);
});

test("judgment shape is aligned without changing what was judged", () => {
  const evidence = [
    {
      id: "ev_1",
      materials: [{ materialId: "mat_1", role: "primary" }],
    },
  ];
  const aligned = normalizeVerificationShape(
    {
      verdict: "pass",
      summary: "ok",
      reasoning: "ok",
      limitations: "只看了这一个文件",
      unmetRequirementIds: null,
      findings: [
        {
          id: "f1",
          statement: "s",
          expected: { value: 0 },
          observed: 0,
          verdict: "pass",
          evidenceCitations: [
            { evidenceId: "F-1", materialId: "mat_1", selector: null },
            { evidenceId: "ev_x", materialId: "mat_unknown" },
          ],
        },
      ],
    },
    evidence,
  );
  assert.deepEqual(aligned.limitations, ["只看了这一个文件"]);
  assert.deepEqual(aligned.unmetRequirementIds, []);
  const finding = aligned.findings[0];
  assert.equal(finding.expected, '{"value":0}');
  assert.equal(finding.observed, "0");
  assert.deepEqual(finding.referenceCitations, []);
  // A known material identifies its evidence; an unknown one is left to fail.
  assert.deepEqual(finding.evidenceCitations, [
    { evidenceId: "ev_1", materialId: "mat_1" },
    { evidenceId: "ev_x", materialId: "mat_unknown" },
  ]);
  assert.equal(aligned.verdict, "pass");
  // Unmet requirements name the criterion's requirements: the criterion's
  // own id means all of them, and an unknown id is dropped.
  const criterion = {
    id: "shout-coverage",
    evidenceRequirements: [{ id: "req_a" }, { id: "req_b" }],
  };
  assert.deepEqual(
    normalizeVerificationShape(
      {
        verdict: "inconclusive",
        unmetRequirementIds: ["shout-coverage", "nope"],
      },
      evidence,
      criterion,
    ).unmetRequirementIds,
    ["req_a", "req_b"],
  );
  assert.deepEqual(
    normalizeVerificationShape(
      { verdict: "fail", unmetRequirementIds: ["req_b"] },
      evidence,
      criterion,
    ).unmetRequirementIds,
    ["req_b"],
  );
});

test("a clarification turn reads its references as files, read-only in the workspace", async () => {
  const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "clarification-"));
  process.env.FOUNDRY_STATE_ROOT = join(root, "state");
  const {
    clarificationExecution,
    clarificationInput,
    clarificationReply,
    recordClarificationReply,
    recoveredClarificationCompletion,
  } = await import("../dist/issue-clarification.js");
  const workspacePath = join(root, "project");
  (await import("node:fs")).mkdirSync(workspacePath);
  const session = {
    id: "sess_c",
    workspaceId: "ws_c",
    issueId: "iss_c",
    deviceId: "dev_c",
    role: "issue_clarification",
    input: { id: "input_1", prompt: "Which file?" },
  };
  const ambient = {
    serverURL: "http://127.0.0.1:1",
    sessionToken: "t",
    workspaceID: "ws_c",
  };
  const execution = clarificationExecution(session, workspacePath, ambient);
  const profile = execution.sandbox.profile;
  assert.equal(execution.cwd, workspacePath);
  assert.deepEqual(profile.readRoots, [workspacePath]);
  assert.equal(profile.writeRoots.includes(workspacePath), false);
  assert.equal(profile.userFiles, "hidden");
  assert.equal(execution.sandbox.env.HOME, profile.writeRoots[0]);

  const material = {
    id: "mat_ref",
    name: "style.txt",
    mimeType: "text/plain",
  };
  const store = {
    getMaterial: (id) => {
      assert.equal(id, "mat_ref");
      return material;
    },
    readMaterial: () => Buffer.from("See you, <name>!"),
  };
  const draft = {
    revision: 2,
    goal: {
      text: "Add farewell",
      media: [{ materialId: "mat_ref", role: "context" }],
    },
    criteria: [],
  };
  const turn = {
    draft,
    messages: [{ role: "user", text: "earlier" }],
    message: "Which file?",
  };
  const fresh = clarificationInput(session, turn, workspacePath, store);
  const body = JSON.parse(fresh.prompt);
  assert.match(body.instruction, /read-only|Never change anything/);
  assert.ok(body.instruction.includes(workspacePath));
  assert.deepEqual(body.earlierMessages, turn.messages);
  assert.equal(body.message, "Which file?");
  assert.equal(fresh.id, "input_1");
  assert.equal(fresh.attachments.length, 1);
  assert.equal(
    readFileSync(fresh.attachments[0].path, "utf8"),
    "See you, <name>!",
  );
  assert.ok(
    execution.sandbox.profile.protectedReadRoots.some((r) =>
      fresh.attachments[0].path.startsWith(r),
    ),
  );
  // A session that kept its context gets only the new turn.
  const resumed = JSON.parse(
    clarificationInput(
      { ...session, nativeSessionId: "native" },
      turn,
      workspacePath,
      store,
    ).prompt,
  );
  assert.equal(resumed.instruction, undefined);
  assert.equal(resumed.earlierMessages, undefined);
  assert.ok(resumed.reminder);

  // A proposal citing a reference that was never supplied is not saved.
  const proposal = {
    goal: { text: "x", media: [{ materialId: "mat_other", role: "context" }] },
    inScope: [],
    outOfScope: [],
    constraints: [],
    criteria: [
      {
        id: "c1",
        title: "t",
        statement: "s",
        required: true,
        proofKind: "functional",
        evaluationMode: "agent",
        rubric: { text: "r", media: [] },
        evidenceRequirements: [
          {
            id: "r1",
            description: "d",
            acceptedCarriers: ["document"],
            minimumCount: 1,
            bindingPolicy: "system_observed",
          },
        ],
      },
    ],
  };
  const reply = clarificationReply(
    "```json\n" +
      JSON.stringify({
        message: "Here is a draft.",
        proposedContent: proposal,
      }) +
      "\n```",
    turn,
  );
  assert.equal(reply.proposedContent, undefined);
  assert.match(reply.message, /Here is a draft\./);

  // A reply this device recorded is reported again; otherwise it is lost.
  assert.match(
    recoveredClarificationCompletion("ws_c", "iss_c", "sess_c", "input_1")
      .error,
    /lost/,
  );
  recordClarificationReply("ws_c", "iss_c", "input_1", {
    message: "greet.mjs",
  });
  const recovered = recoveredClarificationCompletion(
    "ws_c",
    "iss_c",
    "sess_c",
    "input_1",
  );
  assert.deepEqual(recovered.clarificationResult, { message: "greet.mjs" });
  assert.equal(recovered.error, undefined);
  assert.ok(existsSync(join(root, "state")));
});
