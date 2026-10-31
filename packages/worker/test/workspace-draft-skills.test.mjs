import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { snapshotWorkspaceDrafts } from "../dist/workspace-draft-skills.js";
import { withWorkspaceDraftSkills } from "../dist/workspace-skill-runtime.js";
import { materializeSessionSkills } from "../dist/skill-materializer.js";
import { claudeManagedPrompt } from "../dist/skill-isolation.js";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "workspace-drafts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function draft(root, name, text = "first", folder = ".agents/skills") {
  const path = join(root, folder, name, "SKILL.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `---\nname: ${name}\ndescription: Test method\n---\n${text}\n`,
  );
  return path;
}
test("two sessions share project drafts but each execution holds its content version", async (t) => {
  const root = fixture(t);
  const path = draft(root, "example");
  const library = await materializeSessionSkills([], "", root);
  const context = {
    workspaceId: "workspace",
    executionRootId: "workspace",
    workspacePath: root,
  };
  const a = await withWorkspaceDraftSkills(library, context);
  const b = await withWorkspaceDraftSkills(library, context);
  assert.equal(a.pluginDir, b.pluginDir);
  assert.equal(a.skills[0].invocationName, "draft:example");
  assert.deepEqual(a.skills[0].aliases, ["example"]);
  assert.match(
    claudeManagedPrompt("/draft:example test", a),
    /^\/foundry-workspace:workspace-draft-/,
  );
  writeFileSync(path, readFileSync(path, "utf8").replace("first", "second"));
  const c = await withWorkspaceDraftSkills(library, context);
  assert.notEqual(c.pluginDir, a.pluginDir);
  assert.match(
    readFileSync(join(a.skills[0].dir, "SKILL.md"), "utf8"),
    /first/,
  );
  assert.match(
    readFileSync(join(c.skills[0].dir, "SKILL.md"), "utf8"),
    /second/,
  );
  assert.match(
    readFileSync(join(c.skills[0].dir, "SKILL.md"), "utf8"),
    /name: workspace-draft-/,
  );
});
test("draft references cannot cross workspace or Issue execution roots", async (t) => {
  const root = fixture(t);
  draft(root, "example");
  const a = await snapshotWorkspaceDrafts("one", "one", root);
  const b = await snapshotWorkspaceDrafts("two", "two", root);
  const issue = await snapshotWorkspaceDrafts("one", "issue:123", root);
  assert.notEqual(a[0].id, b[0].id);
  assert.notEqual(a[0].id, issue[0].id);
});
test("bad and conflicting drafts are explicit while unrelated drafts stay available", async (t) => {
  const root = fixture(t);
  draft(root, "good");
  draft(root, "duplicate");
  draft(root, "duplicate", "other", ".claude/skills");
  const path = draft(root, "bad");
  writeFileSync(path, "no frontmatter");
  const result = await snapshotWorkspaceDrafts("one", "one", root);
  assert.equal(result.find((x) => x.name === "good").status, "ready");
  assert.equal(result.find((x) => x.name === "bad").status, "invalid");
  assert.equal(result.filter((x) => x.status === "conflict").length, 2);
});
test("links at the root, package or supporting file boundary are refused", async (t) => {
  const root = fixture(t);
  const outside = fixture(t);
  draft(outside, "secret");
  mkdirSync(join(root, ".agents"));
  symlinkSync(join(outside, ".agents/skills"), join(root, ".agents/skills"));
  let result = await snapshotWorkspaceDrafts("one", "one", root);
  assert.equal(result[0].status, "invalid");
  assert.equal(result[0].snapshotPath, undefined);
  unlinkSync(join(root, ".agents/skills"));
  draft(root, "linked");
  symlinkSync(
    join(outside, ".agents/skills/secret/SKILL.md"),
    join(root, ".agents/skills/linked/ref.md"),
  );
  result = await snapshotWorkspaceDrafts("one", "one", root);
  assert.equal(result[0].status, "invalid");
  assert.match(result[0].error, /symbolic/);
});
test("governance names require explicit draft invocation and do not replace built-ins", async (t) => {
  const root = fixture(t);
  draft(root, "foundry");
  const combined = await withWorkspaceDraftSkills(
    await materializeSessionSkills([], "", root),
    { workspaceId: "one", executionRootId: "one", workspacePath: root },
  );
  assert.deepEqual(combined.skills[0].aliases, []);
  assert.equal(claudeManagedPrompt("/foundry test", combined), "/foundry test");
  assert.notEqual(
    claudeManagedPrompt("/draft:foundry test", combined),
    "/draft:foundry test",
  );
});

test("publishing identical draft content keeps one callable method with an explicit draft alias", async (t) => {
  const { combineWorkspaceDraftSkills } =
    await import("../dist/workspace-skill-runtime.js");
  const { materializeSkillSnapshot } =
    await import("../dist/skill-snapshots.js");
  const { createHash } = await import("node:crypto");
  const root = fixture(t);
  const source = draft(root, "example");
  const [ref] = await snapshotWorkspaceDrafts("one", "one", root);
  const data = readFileSync(source);
  const selected = await materializeSkillSnapshot(
    createHash("sha256").update("published-same-draft").digest("hex"),
    (dir) => ({
      files: [{ path: "skills/example/SKILL.md", data }],
      value: {
        pluginDir: dir,
        skills: [{ name: "example", dir: join(dir, "skills/example") }],
      },
    }),
  );
  const combined = await combineWorkspaceDraftSkills(selected, [ref]);
  assert.equal(combined.skills.length, 1);
  assert.equal(combined.skills[0].name, "example");
  assert.equal(
    claudeManagedPrompt("/draft:example run", combined),
    "/foundry-workspace:example run",
  );
});

test("explicit draft dependencies are copied with their relative layout and change the locked version", async (t) => {
  const root = fixture(t);
  draft(root, "a", "Read ../b/SKILL.md before answering.");
  const b = draft(root, "b", "DEPENDENCY_V1");
  const before = await snapshotWorkspaceDrafts("one", "one", root);
  const a = before.find((s) => s.name === "a");
  assert.equal(a.status, "ready", a.error);
  assert.match(
    readFileSync(join(dirname(a.snapshotPath), "../b/SKILL.md"), "utf8"),
    /DEPENDENCY_V1/,
  );
  const combined = await withWorkspaceDraftSkills(
    await materializeSessionSkills([], "", root),
    { workspaceId: "one", executionRootId: "one", workspacePath: root },
  );
  const runtimeA = combined.skills.find((s) => s.invocationName === "draft:a");
  assert.match(
    readFileSync(join(runtimeA.dir, "../b/SKILL.md"), "utf8"),
    /DEPENDENCY_V1/,
  );
  writeFileSync(
    b,
    readFileSync(b, "utf8").replace("DEPENDENCY_V1", "DEPENDENCY_V2"),
  );
  const after = (await snapshotWorkspaceDrafts("one", "one", root)).find(
    (s) => s.name === "a",
  );
  assert.notEqual(a.digest, after.digest);
  assert.match(
    readFileSync(join(dirname(a.snapshotPath), "../b/SKILL.md"), "utf8"),
    /DEPENDENCY_V1/,
  );
  assert.match(
    readFileSync(join(dirname(after.snapshotPath), "../b/SKILL.md"), "utf8"),
    /DEPENDENCY_V2/,
  );
});

test("a draft may bind an explicitly selected library dependency without reading a host installation", async (t) => {
  const { materializeSkillSnapshot } =
    await import("../dist/skill-snapshots.js");
  const { createHash } = await import("node:crypto");
  const root = fixture(t);
  draft(root, "a", "Read ../library-method/SKILL.md before answering.");
  const selected = await materializeSkillSnapshot(
    createHash("sha256").update("draft-library-dependency").digest("hex"),
    (dir) => ({
      files: [
        {
          path: "skills/library-method/SKILL.md",
          data: Buffer.from(
            "---\nname: library-method\ndescription: Library dependency\n---\nTRUSTED_LIBRARY\n",
          ),
        },
      ],
      value: {
        pluginDir: dir,
        skills: [
          { name: "library-method", dir: join(dir, "skills/library-method") },
        ],
      },
    }),
  );
  const before = await snapshotWorkspaceDrafts("one", "one", root);
  assert.equal(before[0].status, "invalid");
  const combined = await withWorkspaceDraftSkills(selected, {
    workspaceId: "one",
    executionRootId: "one",
    workspacePath: root,
  });
  const a = combined.skills.find((s) => s.invocationName === "draft:a");
  assert.ok(a);
  assert.match(
    readFileSync(join(a.dir, "../library-method/SKILL.md"), "utf8"),
    /TRUSTED_LIBRARY/,
  );
});
