import assert from "node:assert/strict";
import test from "node:test";

const { claudeManagedPrompt, codexManagedPrompt, leadingSkillInvocation } =
  await import("../dist/skills/skill-invocation.js");
const { codexSessionInput } =
  await import("../dist/session/runner/codex-options.js");

const managed = {
  pluginDir: "/plugin",
  skills: [
    { name: "foundry-orchestration", dir: "/skills/foundry-orchestration" },
    {
      name: "bits-unit-test-run",
      invocationName: "bits",
      aliases: ["unit"],
      dir: "/skills/bits",
    },
    {
      name: "example",
      invocationName: "draft:example",
      dir: "/skills/example",
      draft: { id: "draft_example" },
    },
  ],
};

test("a leading /name that names a selected skill is found by name, invocation name or alias", () => {
  assert.equal(
    leadingSkillInvocation("/foundry-orchestration brief it", managed)?.skill
      .name,
    "foundry-orchestration",
  );
  assert.equal(
    leadingSkillInvocation("/bits run", managed)?.skill.name,
    "bits-unit-test-run",
  );
  assert.equal(
    leadingSkillInvocation("/unit run", managed)?.skill.name,
    "bits-unit-test-run",
  );
  assert.equal(
    leadingSkillInvocation("  /foundry-orchestration", managed)?.rest,
    "",
  );
});

test("a /name that is not a selected skill, or is not leading, is not an invocation", () => {
  assert.equal(leadingSkillInvocation("/unknown brief", managed), undefined);
  assert.equal(
    leadingSkillInvocation("please /foundry-orchestration", managed),
    undefined,
  );
  assert.equal(
    leadingSkillInvocation("/foundry-orchestration", undefined),
    undefined,
  );
  assert.equal(
    leadingSkillInvocation("/foundry-orchestrationX brief", managed),
    undefined,
  );
});

test("Claude gets the plugin-namespaced name and keeps the rest as typed", () => {
  assert.equal(
    claudeManagedPrompt("/foundry-orchestration brief\nmore", managed),
    "/foundry-workspace:foundry-orchestration brief\nmore",
  );
  assert.equal(
    claudeManagedPrompt("/unit run", managed),
    "/foundry-workspace:bits-unit-test-run run",
  );
  assert.equal(claudeManagedPrompt("/unknown run", managed), "/unknown run");
  assert.equal(
    claudeManagedPrompt("/foundry-orchestration x", undefined),
    "/foundry-orchestration x",
  );
});

test("Codex gets the skill as a $name mention, drafts and non-leading names stay as typed", () => {
  assert.equal(
    codexManagedPrompt("/foundry-orchestration brief it", managed),
    "$foundry-orchestration brief it",
  );
  assert.equal(
    codexManagedPrompt("/foundry-orchestration", managed),
    "$foundry-orchestration",
  );
  assert.equal(
    codexManagedPrompt("/unit run", managed),
    "$bits-unit-test-run run",
  );
  assert.equal(codexManagedPrompt("/unknown run", managed), "/unknown run");
  assert.equal(
    codexManagedPrompt("/draft:example run", managed),
    "/draft:example run",
  );
  assert.equal(
    codexManagedPrompt("ask /foundry-orchestration", managed),
    "ask /foundry-orchestration",
  );
});

test("a Codex turn's input is the rewritten prompt as plain text", () => {
  const session = { id: "sess_t", input: { id: "in_t", prompt: "x" } };
  const prompt = codexManagedPrompt(
    "/foundry-orchestration plan the next step",
    managed,
  );
  assert.equal(
    codexSessionInput(session, prompt),
    "$foundry-orchestration plan the next step",
  );
});
