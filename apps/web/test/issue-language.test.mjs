import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./bundler-resolve.mjs", import.meta.url);
const { issuePhase, verificationMethod, verdictText, blockerText } =
  await import("../src/features/issue-detail/issue-language.ts");
const { candidateExports, changedEvidenceFiles, suggestedEvidenceFiles } =
  await import("../src/features/issue-detail/verification-actions.tsx");

test("stage guidance distinguishes an unconfirmed draft from execution and acceptance", () => {
  assert.match(
    issuePhase({ status: "pending", contractState: "draft" }).next,
    /no new implementation starts before you confirm/,
  );
  assert.equal(
    issuePhase({ status: "verifying", contractState: "confirmed" }).tab,
    "evidence",
  );
  assert.match(issuePhase({ status: "accepted" }).title, /integrated/);
  // A question from the execution points to the main chat, not to a blocker.
  const asked = issuePhase({
    status: "blocked",
    contractState: "confirmed",
    blockedReason: { kind: "needs_input", message: "Which version?" },
    question: {
      id: "q",
      kind: "input",
      text: "Which version?",
      runId: "r",
      askedAt: "",
    },
  });
  assert.equal(asked.title, "Waiting for your answer");
  assert.equal(asked.tab, "details");
});
test("verification wording preserves missing checker, stale results and independent judgment", () => {
  assert.match(
    verificationMethod({ evaluationMode: "agent" }),
    /independent Agent/,
  );
  assert.match(
    verificationMethod({ evaluationMode: "deterministic" }),
    /not ready yet/,
  );
  assert.match(
    verdictText({ freshness: "stale", effectiveVerdict: "pass" }),
    /no longer applies/,
  );
  assert.match(
    blockerText({ code: "evidence_missing" }),
    /Not enough actual material/,
  );
});
test("candidate suggestions use actual manifest paths, never invented evidence IDs", () => {
  const files = [
    { repoId: "root", path: "WELCOME.md", kind: "file" },
    { repoId: "root", path: "secret.txt", kind: "file" },
  ];
  assert.deepEqual(suggestedEvidenceFiles(files, "读取 WELCOME.md 原始文稿"), [
    files[0],
  ]);
  assert.deepEqual(suggestedEvidenceFiles(files, "截图证明页面效果"), []);
});

test("an agent judgment that names no file defaults to the files the candidate changed", () => {
  const changed = changedEvidenceFiles(
    {
      cwd: "/c",
      repositories: [
        {
          path: ".",
          baseline: "a",
          candidate: "b",
          truncated: false,
          diff: "diff --git a/greet.mjs b/greet.mjs\n+x\ndiff --git a/greet.test.mjs b/greet.test.mjs\n+y\n",
        },
        {
          path: "repos/unknown",
          baseline: "a",
          truncated: false,
          diff: "diff --git a/x b/x\n",
        },
      ],
    },
    [{ repoId: "root", relativePath: "." }],
  );
  assert.deepEqual([...changed].sort(), [
    "root:greet.mjs",
    "root:greet.test.mjs",
  ]);
  assert.match(
    blockerText({ code: "verification_pending" }),
    /no check result for this version/,
  );
});

test("a requirement is collected from the source it names", () => {
  const requirement = (fields) => ({
    id: "r",
    description: "Git change list of the candidate",
    minimumCount: 1,
    bindingPolicy: "system_observed",
    ...fields,
  });
  assert.deepEqual(
    candidateExports(
      requirement({ acceptedCarriers: ["data"], source: "candidate_changes" }),
    ),
    { files: false, changes: true },
  );
  assert.deepEqual(
    candidateExports(
      requirement({ acceptedCarriers: ["text_log"], source: "candidate_file" }),
    ),
    { files: true, changes: false },
  );
  assert.deepEqual(
    candidateExports(
      requirement({
        acceptedCarriers: ["image"],
        bindingPolicy: "system_or_human_attested",
        source: "human_upload",
      }),
    ),
    { files: false, changes: false },
  );
  // A contract confirmed before requirements named a source.
  assert.deepEqual(
    candidateExports(requirement({ acceptedCarriers: ["text_log"] })),
    { files: true, changes: false },
  );
});
