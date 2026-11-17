import assert from "node:assert/strict";
import test from "node:test";

const { claudeManagedPrompt, codexManagedInput, leadingSkillInvocation } =
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

test("Codex gets the skill as its own skill input; drafts and non-leading names stay as typed", () => {
  assert.deepEqual(
    codexManagedInput("/foundry-orchestration brief it", managed),
    {
      text: "brief it",
      skill: {
        type: "skill",
        name: "foundry-orchestration",
        path: "/skills/foundry-orchestration/SKILL.md",
      },
    },
  );
  assert.equal(codexManagedInput("/foundry-orchestration", managed).text, "");
  assert.equal(
    codexManagedInput("/unit run", managed).skill?.name,
    "bits-unit-test-run",
  );
  assert.deepEqual(codexManagedInput("/unknown run", managed), {
    text: "/unknown run",
  });
  assert.deepEqual(codexManagedInput("/draft:example run", managed), {
    text: "/draft:example run",
  });
  assert.deepEqual(codexManagedInput("ask /foundry-orchestration", managed), {
    text: "ask /foundry-orchestration",
  });
});

test("a Codex turn's input names the skill first, then the text and images", () => {
  const session = { id: "sess_t", input: { id: "in_t", prompt: "x" } };
  const invoked = codexManagedInput(
    "/foundry-orchestration plan the next step",
    managed,
  );
  assert.deepEqual(codexSessionInput(session, invoked.text, invoked.skill), [
    {
      type: "skill",
      name: "foundry-orchestration",
      path: "/skills/foundry-orchestration/SKILL.md",
    },
    { type: "text", text: "plan the next step" },
  ]);
  assert.equal(codexSessionInput(session, "plain"), "plain");
});

test("the app server gets text elements only on text items", async () => {
  const { appServerInput } =
    await import("../dist/session/runner/codex-app-server.js");
  assert.deepEqual(
    appServerInput([
      { type: "skill", name: "s", path: "/p/SKILL.md" },
      { type: "text", text: "go" },
      { type: "local_image", path: "/i.png" },
    ]),
    [
      { type: "skill", name: "s", path: "/p/SKILL.md" },
      { type: "text", text: "go", text_elements: [] },
      { type: "localImage", path: "/i.png" },
    ],
  );
});
