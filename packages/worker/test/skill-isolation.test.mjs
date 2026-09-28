import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  isolateSkillSession,
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
test("legacy resume resets native history; trusted identical policy resumes; workspace and selection changes reset", () => {
  const session = {
    nativeSessionId: randomUUID(),
    prompt: "continue",
    input: {
      id: randomUUID(),
      prompt: "continue",
      importedContext: "old skill body",
    },
  };
  const first = isolateSkillSession(session, "/workspace-a", managed);
  assert.equal(first.reset, true);
  assert.equal(first.session.nativeSessionId, undefined);
  assert.equal(first.session.input.importedContext, undefined);
  first.record(session.nativeSessionId);
  assert.equal(
    isolateSkillSession(session, "/workspace-a", managed).reset,
    false,
  );
  assert.equal(
    isolateSkillSession(session, "/workspace-b", managed).reset,
    true,
  );
  assert.equal(
    isolateSkillSession(session, "/workspace-a", {
      ...managed,
      pluginDir: "/managed/set-b",
    }).reset,
    true,
  );
  assert.equal(session.input.importedContext, "old skill body");
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
  const { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } =
    await import("node:fs");
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
  const run = isolateSkillSession(
    { id: "sess", nativeSessionId: "", input: { id: "in", prompt: "x" } },
    "/workspace-a",
    managed,
  );
  const receipt = join(
    root,
    "skill-isolation",
    `${createHash("sha256").update(nativeId).digest("hex")}.json`,
  );
  run.record(nativeId);
  const written = statSync(receipt);
  // Every message of a run reports the same id.
  for (let i = 0; i < 5; i++) run.record(nativeId);
  assert.equal(statSync(receipt).ino, written.ino);
  assert.equal(statSync(receipt).mtimeMs, written.mtimeMs);
  assert.notEqual(readFileSync(receipt, "utf8"), "");
  assert.deepEqual(readdirSync(join(root, "skill-isolation")), [
    receipt.split("/").pop(),
  ]);
  assert.equal(
    isolateSkillSession(
      {
        id: "sess",
        nativeSessionId: nativeId,
        input: { id: "in2", prompt: "y" },
      },
      "/workspace-a",
      managed,
    ).reset,
    false,
  );
});
