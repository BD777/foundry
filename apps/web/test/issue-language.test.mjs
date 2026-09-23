import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./bundler-resolve.mjs", import.meta.url);
const {
  issuePhase,
  isStatusQuestion,
  verificationMethod,
  verdictText,
  blockerText,
} = await import("../src/features/issue-detail/issue-language.ts");
const { suggestedEvidenceFiles } =
  await import("../src/features/issue-detail/verification-actions.tsx");

test("stage guidance distinguishes an unconfirmed draft from execution and acceptance", () => {
  assert.match(
    issuePhase({ status: "pending", contractState: "draft" }).next,
    /确认前不会/,
  );
  assert.equal(
    issuePhase({ status: "verifying", contractState: "confirmed" }).tab,
    "evidence",
  );
  assert.match(issuePhase({ status: "accepted" }).title, /集成/);
  assert.equal(isStatusQuestion("这里是什么状态？"), true);
  assert.equal(isStatusQuestion("继续"), false);
  assert.equal(isStatusQuestion("What is the status?"), true);
  assert.equal(isStatusQuestion("状态接口缺少参数时返回400"), false);
});
test("verification wording preserves missing checker, stale results and independent judgment", () => {
  assert.match(verificationMethod({ evaluationMode: "agent" }), /独立 Agent/);
  assert.match(
    verificationMethod({ evaluationMode: "deterministic" }),
    /尚未准备好/,
  );
  assert.match(
    verdictText({ freshness: "stale", effectiveVerdict: "pass" }),
    /不再适用/,
  );
  assert.match(blockerText({ code: "evidence_missing" }), /材料不足/);
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
