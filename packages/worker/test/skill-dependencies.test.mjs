import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSkillRoots } from "../dist/skill-scanner.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "foundry-deps-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skills = join(root, "skills");
  mkdirSync(skills);
  function add(name, text = "", parent = skills) {
    const dir = join(parent, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n${text}`);
    return dir;
  }
  return { root, skills, add };
}
test("cross-skill paths and explicit calls preserve evidence, missing names and cycles", (t) => {
  const { skills, add } = fixture(t);
  add("alpha", '[Beta](../beta/SKILL.md)\nSkill("missing")');
  add("beta", 'Skill(skill="alpha")');
  const rows = scanSkillRoots([skills]);
  const a = rows.find((s) => s.name === "alpha");
  assert.equal(
    a.dependencies.find((d) => d.skillName === "beta").strength,
    "required",
  );
  assert.equal(
    a.dependencies.find((d) => d.skillName === "missing").status,
    "missing",
  );
  assert.match(a.dependencies[0].evidence, /SKILL.md:4:/);
  assert.equal(
    rows.find((s) => s.name === "beta").dependencies[0].skillName,
    "alpha",
  );
});
test("embedded guides, URLs and CLI invocations are not cross-skill requirements", (t) => {
  const { skills, add } = fixture(t);
  const a = add(
    "alpha",
    "[beta](references/subskills/beta/GUIDE.md)\nRun `beta status`\nhttps://host/skills/beta/SKILL.md",
  );
  add("beta");
  mkdirSync(join(a, "references/subskills/beta"), { recursive: true });
  writeFileSync(
    join(a, "references/subskills/beta/GUIDE.md"),
    "self contained",
  );
  assert.deepEqual(
    scanSkillRoots([skills]).find((s) => s.name === "alpha").dependencies,
    [],
  );
});
test("nested markdown and scripts detect portable paths and unquoted skill mentions", (t) => {
  const { skills, add } = fixture(t);
  const a = add("alpha");
  add("beta");
  mkdirSync(join(a, "references"));
  writeFileSync(
    join(a, "references/work.md"),
    "Use the beta skill for review.\nUse skill absent-skill",
  );
  mkdirSync(join(a, "scripts"));
  writeFileSync(
    join(a, "scripts/run.py"),
    'path="/home/other/.codex/skills/beta/scripts/run.py"',
  );
  const deps = scanSkillRoots([skills]).find(
    (s) => s.name === "alpha",
  ).dependencies;
  assert.equal(deps.find((d) => d.skillName === "beta").strength, "required");
  assert.equal(
    deps.find((d) => d.skillName === "absent-skill").status,
    "missing",
  );
});
test("top-level links work, nested symlink loops are never traversed", (t) => {
  const { root, skills, add } = fixture(t);
  const a = add("alpha", 'Skill("beta")');
  const b = add("beta", "", join(root, "store"));
  symlinkSync(b, join(skills, "beta"));
  symlinkSync(a, join(a, "loop"));
  const deps = scanSkillRoots([skills]).find(
    (s) => s.name === "alpha",
  ).dependencies;
  assert.equal(deps[0].status, "resolved");
  assert.equal(deps[0].targetRoot, skills);
});
test("duplicate names prefer same root, otherwise remain ambiguous", (t) => {
  const { root, skills, add } = fixture(t);
  add("alpha", 'Skill("beta")');
  add("beta", "", join(root, "r2"));
  add("beta", "", join(root, "r3"));
  let rows = scanSkillRoots([skills, join(root, "r2"), join(root, "r3")]);
  assert.equal(rows[0].dependencies[0].status, "ambiguous");
  add("beta");
  rows = scanSkillRoots([skills, join(root, "r2"), join(root, "r3")]);
  assert.equal(rows[0].dependencies[0].targetRoot, skills);
});
test("ellipsis HTTP endpoints and arbitrary sibling worktrees do not create missing skills", (t) => {
  const { skills, add } = fixture(t);
  add(
    "alpha",
    "POST .../publish/\nworktree ../demo-task\n../references/invocation.md\nhttps://host/skills/nope/SKILL.md",
  );
  assert.deepEqual(scanSkillRoots([skills])[0].dependencies, []);
});

test("missing peer support files are retained without treating generic parent references as skills", (t) => {
  const { skills, add } = fixture(t);
  add(
    "alpha",
    "Read `../missing-peer/references/invocation.md`\nRead `../references/invocation.md`",
  );
  const deps = scanSkillRoots([skills])[0].dependencies;
  assert.equal(deps.length, 1);
  assert.equal(deps[0].skillName, "missing-peer");
  assert.equal(deps[0].status, "missing");
});

test("home-relative cross-runtime paths resolve through the device graph", (t) => {
  const { skills, add } = fixture(t);
  add(
    "alpha",
    "Use `~/.claude/skills/beta/SKILL.md` and `${HOME}/.codex/skills/gamma/SKILL.md`",
  );
  add("beta");
  add("gamma");
  const deps = scanSkillRoots([skills]).find(
    (s) => s.name === "alpha",
  ).dependencies;
  assert.deepEqual(
    deps.map((d) => [d.skillName, d.strength, d.status]),
    [
      ["beta", "required", "resolved"],
      ["gamma", "required", "resolved"],
    ],
  );
});

test("installation directories and explicit fallbacks remain advisory", (t) => {
  const { skills, add } = fixture(t);
  add(
    "alpha",
    "Installation updates `~/.agents/skills/beta/`.\nOptional fallback: read `${HOME}/.codex/skills/gamma/SKILL.md`.",
  );
  add("beta");
  add("gamma");
  const deps = scanSkillRoots([skills]).find(
    (s) => s.name === "alpha",
  ).dependencies;
  assert.deepEqual(
    deps.map((d) => [d.skillName, d.strength]),
    [
      ["beta", "related"],
      ["gamma", "related"],
    ],
  );
});
