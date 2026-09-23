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
    importedContext: "old skill body",
    prompt: "continue",
  };
  const first = isolateSkillSession(session, "/workspace-a", managed);
  assert.equal(first.reset, true);
  assert.equal(first.session.nativeSessionId, undefined);
  assert.equal(first.session.importedContext, undefined);
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
  assert.equal(session.importedContext, "old skill body");
});

test("selected Claude slash commands resolve to the managed plugin namespace", async () => {
  const { claudeManagedPrompt } = await import("../dist/skill-isolation.js");
  assert.equal(
    claudeManagedPrompt("/selected explain", managed),
    "/foundry-workspace:selected explain",
  );
  assert.equal(claudeManagedPrompt("/compact", managed), "/compact");
});

test("repository instructions survive discovery isolation without reading above the Git root", async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { workspaceProjectInstructions } =
    await import("../dist/skill-isolation.js");
  const dir = mkdtempSync(join(tmpdir(), "skill-policy-docs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "project");
  mkdirSync(join(root, "nested"), { recursive: true });
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(dir, "CLAUDE.md"), "UNRELATED_ANCESTOR");
  writeFileSync(join(root, "AGENTS.md"), "PROJECT_GUIDANCE");
  writeFileSync(join(root, "nested", "CLAUDE.md"), "NESTED_GUIDANCE");
  symlinkSync(join(root, "nested"), join(dir, "alias"));
  const docs = workspaceProjectInstructions(join(dir, "alias"));
  assert.match(docs, /PROJECT_GUIDANCE/);
  assert.match(docs, /NESTED_GUIDANCE/);
  assert.doesNotMatch(docs, /UNRELATED_ANCESTOR/);
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
