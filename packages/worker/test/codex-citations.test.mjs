import assert from "node:assert/strict";
import test from "node:test";

const { codexCitationsAsLinks } =
  await import("../dist/session/runner/codex-citations.js");
const { answerBlocks } =
  await import("../dist/session/files/session-file-references.js");

test("a Codex file citation becomes a Markdown link the answer's references find", () => {
  const answer = [
    "已按最终名单修正为 30 人。",
    "",
    ':codex-file-citation{path="/Users/me/workspace/outputs/signin/聚会签到表.docx" artifact_kind="document" purpose="output"}',
  ].join("\n");
  const linked = codexCitationsAsLinks(answer);
  assert.equal(
    linked.split("\n")[2],
    "[聚会签到表.docx](</Users/me/workspace/outputs/signin/聚会签到表.docx>)",
  );
  const tokens = answerBlocks(linked).flatMap((block) => block.tokens);
  assert.deepEqual(
    tokens.map(({ path, source }) => ({ path, source })),
    [
      {
        path: "/Users/me/workspace/outputs/signin/聚会签到表.docx",
        source: "link",
      },
    ],
  );
});

test("text without a citation, or a citation without a path, is unchanged", () => {
  assert.equal(codexCitationsAsLinks("plain `a.md`"), "plain `a.md`");
  const noPath = ':codex-file-citation{purpose="output"}';
  assert.equal(codexCitationsAsLinks(noPath), noPath);
});
