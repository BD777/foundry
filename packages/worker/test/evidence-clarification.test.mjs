import test from "node:test";
import assert from "node:assert/strict";
import {
  validateClarificationResponse,
  parseClarificationResponse,
  readClarificationAnswer,
} from "../dist/evidence-clarification.js";
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
  assert.deepEqual(
    parseClarificationResponse(
      'I read src/app.ts.\n```json\n{"message":"Shall I start there?"}\n```',
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
});
