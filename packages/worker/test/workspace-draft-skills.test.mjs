import assert from "node:assert/strict";
import test from "node:test";
import {
  statSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { snapshotWorkspaceDrafts } from "../dist/skills/workspace-draft-skills.js";
import { withWorkspaceDraftSkills } from "../dist/skills/workspace-skill-runtime.js";
import { materializeSessionSkills } from "../dist/skills/skill-materializer.js";
import { claudeManagedPrompt } from "../dist/skills/skill-invocation.js";
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
  assert.equal(statSync(a.skills[0].dir).mode & 0o222, 0);
  assert.equal(statSync(a.skills[0].draft.snapshotPath).mode & 0o222, 0);
  assert.equal(statSync(join(a.skills[0].dir, "SKILL.md")).mode & 0o222, 0);
  assert.equal(a.skills[0].invocationName, "draft:example");
  assert.deepEqual(a.skills[0].aliases, ["example"]);
  assert.match(
    claudeManagedPrompt("/draft:example test", a),
    /^\/foundry-workspace:example/,
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
    /name: example/,
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
test("assistant runtime skill links are not workspace drafts", async (t) => {
  const root = fixture(t);
  const canonical = join(
    root,
    ".foundry",
    "assistant-skills",
    "assistant-projects",
  );
  mkdirSync(canonical, { recursive: true });
  writeFileSync(
    join(canonical, "SKILL.md"),
    "---\nname: assistant-projects\ndescription: Foundry managed.\n---\n",
  );
  for (const folder of [".claude/skills", ".agents/skills"]) {
    const link = join(root, folder, "assistant-projects");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(canonical, link, "dir");
  }
  draft(root, "user-method", "The person's method.", ".claude/skills");

  const { scanSkillRoots } = await import("../dist/skills/skill-scanner.js");
  assert.deepEqual(scanSkillRoots([join(root, ".agents/skills")]), []);
  const result = await snapshotWorkspaceDrafts("one", "one", root);
  assert.deepEqual(
    result.map((skill) => skill.name),
    ["user-method"],
  );
});
for (const libraryFolder of ["example", "different-package-folder"]) {
  test(`a draft shadows a library revision in ${libraryFolder} and gives way to a builtin`, async (t) => {
    const { combineWorkspaceDraftSkills } =
      await import("../dist/skills/workspace-skill-runtime.js");
    const { materializeSkillSnapshot } =
      await import("../dist/skills/skill-snapshots.js");
    const { createHash } = await import("node:crypto");
    const root = fixture(t);
    const source = draft(root, "example");
    const [ref] = await snapshotWorkspaceDrafts("one", "one", root);
    const data = Buffer.from(
      readFileSync(source, "utf8").replace("first", "library"),
    );
    const selected = await materializeSkillSnapshot(
      createHash("sha256")
        .update(`published-same-draft/${libraryFolder}`)
        .digest("hex"),
      (dir) => ({
        files: [{ path: `skills/${libraryFolder}/SKILL.md`, data }],
        value: {
          pluginDir: dir,
          skills: [
            { name: "example", dir: join(dir, "skills", libraryFolder) },
          ],
        },
      }),
    );
    const combined = await combineWorkspaceDraftSkills(selected, [ref]);
    assert.deepEqual(readdirSync(join(combined.pluginDir, "skills")), [
      "example",
    ]);
    assert.equal(combined.skills.length, 1);
    assert.match(
      readFileSync(join(combined.skills[0].dir, "SKILL.md"), "utf8"),
      /first/,
    );
    const builtin = await combineWorkspaceDraftSkills(
      {
        ...selected,
        skills: selected.skills.map((s) => ({ ...s, builtin: true })),
      },
      [ref],
    );
    assert.match(
      readFileSync(join(builtin.skills[0].dir, "SKILL.md"), "utf8"),
      /library/,
    );
    assert.equal(combined.skills[0].name, "example");
    assert.equal(
      claudeManagedPrompt("/draft:example run", combined),
      "/foundry-workspace:example run",
    );
  });
}

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
    await import("../dist/skills/skill-snapshots.js");
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
