import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  recordSkillReceipt,
  skillReceiptConflicts,
  validateWorkspaceSkillPrompt,
  workspaceSkillInstructions,
} from "../dist/skill-isolation.js";
const managed = {
  pluginDir: "/managed/set-a",
  skills: [{ name: "selected", dir: "/managed/set-a/skills/selected" }],
};
test("unselected slash skill is rejected before inference or filesystem lookup", () => {
  for (const prompt of [
    "/ccm-domain-mapping explain",
    "$ccm-domain-mapping",
    "/other:ccm-domain-mapping explain",
  ])
    assert.throws(
      () => validateWorkspaceSkillPrompt(prompt, managed),
      /not configured/,
    );
  for (const prompt of [
    "/selected explain",
    "/foundry-workspace:selected explain",
    "ordinary coding",
    "/compact",
  ])
    assert.doesNotThrow(() => validateWorkspaceSkillPrompt(prompt, managed));
});
test("catalog points exclusively at managed copies and covers dependency references", () => {
  const policy = workspaceSkillInstructions(managed);
  assert.match(policy, /\/managed\/set-a\/skills\/selected\/SKILL.md/);
  assert.match(policy, /references another skill/);
  assert.match(
    workspaceSkillInstructions({ ...managed, skills: [] }),
    /No skills/,
  );
});
test("a workspace skill replaces the agent's own skill of the same name", () => {
  const policy = workspaceSkillInstructions({
    ...managed,
    officialSkills: [
      { name: "Selected", description: "the agent's own" },
      { name: "debug", description: "kept" },
    ],
  });
  const builtIn = policy
    .split("\n")
    .filter((line) => line.includes('"builtIn":true'))
    .map((line) => JSON.parse(line).name);
  assert.deepEqual(builtIn, ["debug"]);
  assert.match(policy, /workspace skill replaces it/);
});
test("a receipt names the workspace, never the skill set; none means no conflict", () => {
  const nativeId = randomUUID();
  // Started outside Foundry (or before receipts): nothing conflicts.
  assert.equal(skillReceiptConflicts(nativeId, "/workspace-a"), false);
  recordSkillReceipt(nativeId, "/workspace-a");
  assert.equal(skillReceiptConflicts(nativeId, "/workspace-a"), false);
  assert.equal(skillReceiptConflicts(nativeId, "/workspace-b"), true);
});

test("selected Claude slash commands resolve to the managed plugin namespace", async () => {
  const { claudeManagedPrompt } = await import("../dist/skill-isolation.js");
  assert.equal(
    claudeManagedPrompt("/selected explain", managed),
    "/foundry-workspace:selected explain",
  );
  assert.equal(claudeManagedPrompt("/compact", managed), "/compact");
});

test("arbitrary custom commands fail closed for managed workspace runs", async () => {
  const { runClaudeWorkspaceSession, runCodexWorkspaceSession } =
    await import("../dist/runner.js");
  for (const run of [runClaudeWorkspaceSession, runCodexWorkspaceSession])
    await assert.rejects(
      () =>
        run(
          "/unused",
          { prompt: "hello" },
          { command: "unrestricted-wrapper" },
          async () => {},
          async () => {},
          () => {},
          { ...managed, skills: [] },
        ),
      /cannot enforce workspace skill isolation/,
    );
});

test("a receipt is written once and never left empty by a rewrite", async (t) => {
  const { createHash } = await import("node:crypto");
  const {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
  } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "foundry-receipts-"));
  const previous = process.env.FOUNDRY_EXECUTION_SESSION_ROOT;
  process.env.FOUNDRY_EXECUTION_SESSION_ROOT = root;
  t.after(() => {
    if (previous === undefined)
      delete process.env.FOUNDRY_EXECUTION_SESSION_ROOT;
    else process.env.FOUNDRY_EXECUTION_SESSION_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const nativeId = randomUUID();
  const receipt = join(
    root,
    "skill-isolation",
    `${createHash("sha256").update(nativeId).digest("hex")}.json`,
  );
  recordSkillReceipt(nativeId, "/workspace-a");
  const written = statSync(receipt);
  // Every message of a run reports the same id.
  for (let i = 0; i < 5; i++) recordSkillReceipt(nativeId, "/workspace-a");
  assert.equal(statSync(receipt).ino, written.ino);
  assert.equal(statSync(receipt).mtimeMs, written.mtimeMs);
  assert.notEqual(readFileSync(receipt, "utf8"), "");
  assert.deepEqual(readdirSync(join(root, "skill-isolation")), [
    receipt.split("/").pop(),
  ]);
  // A receipt written when it also named the skill set still holds.
  const legacyId = randomUUID();
  mkdirSync(join(root, "skill-isolation"), { recursive: true });
  writeFileSync(
    join(
      root,
      "skill-isolation",
      `${createHash("sha256").update(legacyId).digest("hex")}.json`,
    ),
    JSON.stringify({
      version: "workspace-skills-v2",
      workspace: "/workspace-a",
      plugin: "/managed/set-a",
    }),
  );
  assert.equal(skillReceiptConflicts(legacyId, "/workspace-a"), false);
});
