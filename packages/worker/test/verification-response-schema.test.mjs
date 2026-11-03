import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Profiles are read from the state root when the modules load.
const home = realpathSync(mkdtempSync(join(tmpdir(), "foundry-judge-schema-")));
process.env.HOME = home;
process.env.FOUNDRY_STATE_ROOT = join(home, ".foundry");
mkdirSync(join(home, ".foundry"));
writeFileSync(
  join(home, ".foundry/agent-profiles.local.json"),
  JSON.stringify({
    profiles: [{ id: "codex_p", runtime: "codex", label: "X", model: "gpt" }],
  }),
);
const cli = join(home, "agent-cli");
writeFileSync(cli, "#!/bin/sh\necho 0.0.0-test\n", { mode: 0o755 });
process.env.FOUNDRY_CODEX_BIN = cli;
test.after(() => rmSync(home, { recursive: true, force: true }));

register("./fixtures/fake-agent-sdk-hooks.mjs", import.meta.url);
const { calls, codexAnswers } = await import("./fixtures/fake-agent-sdk.mjs");
const { judgeWithAgent } =
  await import("../dist/issue/evidence/evidence-agent.js");
const { EvidenceStore } = await import("../dist/material/evidence-store.js");
const { ExecutionStore } =
  await import("../dist/candidate-store/execution-storage.js");
const { sandboxAvailable } = await import("../dist/sandbox/index.js");
const { Ajv2020 } = createRequire(
  new URL("../../protocol/package.json", import.meta.url),
)("ajv/dist/2020.js");

const supported = { skip: !sandboxAvailable("readonly_agent") };

function judgment(root, { withEvidence }) {
  const store = new EvidenceStore(
    "ws_fixture",
    "iss_fixture",
    "dev_fixture",
    { kind: "daemon", id: "dev_fixture", displayName: "Synthetic test" },
    new ExecutionStore(join(root, "state")),
  );
  const material = store.sealMaterial(
    "hello.txt",
    "text_log",
    Buffer.from("hi"),
  );
  const input = {
    id: "input_fixture",
    inputDigest: "sha256:input",
    bindingStatus: "bound",
    bindingNotes: [],
  };
  const evidence = withEvidence
    ? [
        {
          id: "ev_fixture",
          issueId: "iss_fixture",
          workspaceId: "ws_fixture",
          verificationInputId: input.id,
          claims: [{ criterionId: "only-hello-changed", requirementId: "r" }],
          materials: [{ materialId: material.id }],
          source: { kind: "candidate_file" },
          candidateBinding: "system_observed",
        },
      ]
    : [];
  const criterion = {
    id: "only-hello-changed",
    title: "No unrelated changes",
    statement: "The only repository change is the addition of hello.txt.",
    required: true,
    proofKind: "constraint_compliance",
    evaluationMode: "agent",
    rubric: { text: "Pass only if hello.txt is the sole change.", media: [] },
    evidenceRequirements: [],
  };
  return {
    material,
    options: {
      contract: {
        issueId: "iss_fixture",
        workspaceId: "ws_fixture",
        goal: { text: "Create hello.txt containing hi.", media: [] },
        criteria: [criterion],
      },
      criterion,
      input,
      verification: {
        executor: {
          kind: "agent",
          harness: "codex",
          profileId: "codex_p",
          requestedModel: "gpt",
          promptTemplateVersion: "foundry-verification/v2",
        },
      },
      evidence,
      store,
      directory: join(root, "verifier"),
    },
  };
}

function finding(citations) {
  return {
    id: "only-hello-changed",
    statement: "hello.txt is the only repository change.",
    expected: "Only hello.txt is added.",
    observed: "The change summary lists only A hello.txt.",
    verdict: "pass",
    evidenceCitations: citations,
    referenceCitations: [],
  };
}
const result = (verdict, findings) => ({
  verdict,
  summary: "s",
  reasoning: "r",
  findings,
  limitations: [],
  unmetRequirementIds: [],
});

test(
  "Codex is asked natively for a judgment whose pass passes and cites evidence",
  supported,
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "foundry-judge-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    calls.length = 0;
    const { material, options } = judgment(root, { withEvidence: true });
    const cite = [{ evidenceId: "ev_fixture", materialId: material.id }];
    codexAnswers.push(
      JSON.stringify({ judgment: result("pass", [finding(cite)]) }),
    );
    const judged = await judgeWithAgent(options);
    assert.equal(judged.result.verdict, "pass");
    assert.deepEqual(judged.result.findings[0].evidenceCitations, cite);

    // The schema travels as Codex's own output schema, not as prompt text.
    const schema = calls[0].run.outputSchema;
    assert.ok(schema, "the verifier passes a native output schema");
    assert.doesNotMatch(calls[0].input[0].text, /JSON Schema/);
    const valid = new Ajv2020({ strict: false }).compile(schema);
    assert.equal(valid({ judgment: result("pass", [finding(cite)]) }), true);
    // What Codex returned on the scratch stack (ISS-107): a pass whose
    // finding cites nothing, which the store refuses with
    // pass_requires_cited_passing_findings.
    assert.equal(valid({ judgment: result("pass", [finding([])]) }), false);
    assert.equal(valid({ judgment: result("pass", []) }), false);
    assert.equal(
      valid({
        judgment: result("pass", [
          finding(cite),
          { ...finding([]), id: "note", verdict: "inconclusive" },
        ]),
      }),
      false,
    );
    assert.equal(
      valid({ judgment: result("inconclusive", [finding([])]) }),
      true,
    );
  },
);

test(
  "with no evidence to cite, the judgment cannot be a pass",
  supported,
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "foundry-judge-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    calls.length = 0;
    const { options } = judgment(root, { withEvidence: false });
    const answer = result("inconclusive", [
      { ...finding([]), verdict: "inconclusive" },
    ]);
    codexAnswers.push(JSON.stringify({ judgment: answer }));
    const judged = await judgeWithAgent(options);
    assert.equal(judged.result.verdict, "inconclusive");
    const valid = new Ajv2020({ strict: false }).compile(
      calls[0].run.outputSchema,
    );
    assert.equal(valid({ judgment: answer }), true);
    assert.equal(valid({ judgment: result("pass", [finding([])]) }), false);
  },
);
