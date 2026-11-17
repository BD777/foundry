import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);
const { firstSentence, sourceRef, summaryBody } =
  await import("../src/features/workspaces/workspace-upkeep-model.ts");

test("the first sentence ends at CJK punctuation even without spaces", () => {
  assert.equal(
    firstSentence("第一句说通道。第二句说续聊。第三句。"),
    "第一句说通道。",
  );
});

test("periods inside file names and numbers do not end the sentence", () => {
  assert.equal(
    firstSentence(
      "AGENTS.md (2.9 KB) is within budget. The intro repeats one fact.",
    ),
    "AGENTS.md (2.9 KB) is within budget.",
  );
});

test("the summary body drops the sentence the row already shows", () => {
  const summary =
    "AGENTS.md is within budget. The intro and the first bullet both say where the file is edited. Nothing else changed.";
  assert.equal(firstSentence(summary), "AGENTS.md is within budget.");
  assert.equal(
    summaryBody(summary),
    "The intro and the first bullet both say where the file is edited. Nothing else changed.",
  );
});

test("a one-sentence summary has no body to repeat", () => {
  assert.equal(summaryBody("CLAUDE.md points at AGENTS.md."), "");
  assert.equal(summaryBody("第一句就是全部。"), "");
  assert.equal(summaryBody(""), "");
});

test("a source ref reads as file and section, without its version hash", () => {
  assert.deepEqual(sourceRef("AGENTS.md#通道的事实@6960ab19"), {
    file: "AGENTS.md",
    section: "通道的事实",
  });
  assert.deepEqual(sourceRef("README.md"), { file: "README.md" });
  assert.deepEqual(sourceRef("AGENTS.md#intro"), {
    file: "AGENTS.md",
    section: "intro",
  });
});
