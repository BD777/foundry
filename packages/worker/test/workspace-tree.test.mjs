import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  safeWorkspaceFileRead,
  safeWorkspaceTreeListing,
} from "../dist/session/files/workspace-files.js";
import { git } from "../dist/candidate-store/execution-git.js";

test("safeWorkspaceTreeListing lists directories and files correctly", (t) => {
  const temp = mkdtempSync(resolve(tmpdir(), "foundry-tree-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));

  mkdirSync(resolve(temp, "subfolder"));
  mkdirSync(resolve(temp, ".claude"));
  writeFileSync(resolve(temp, "hello.md"), "# Hello world");
  writeFileSync(resolve(temp, "subfolder/child.ts"), "export const x = 1;");
  writeFileSync(resolve(temp, ".DS_Store"), "ignore me");

  const rootEntries = safeWorkspaceTreeListing(temp, "");

  // Directories should come first, sorted alphabetically
  assert.equal(rootEntries[0]?.name, ".claude");
  assert.equal(rootEntries[0]?.isDirectory, true);
  assert.equal(rootEntries[1]?.name, "subfolder");
  assert.equal(rootEntries[1]?.isDirectory, true);

  // Files should follow directories
  assert.equal(rootEntries[2]?.name, "hello.md");
  assert.equal(rootEntries[2]?.isDirectory, false);
  assert.equal(rootEntries[2]?.extension, ".md");
  assert.equal(typeof rootEntries[2]?.size, "number");

  // .DS_Store should be ignored
  assert.equal(
    rootEntries.some((e) => e.name === ".DS_Store"),
    false,
  );

  // Subdirectory listing
  const subEntries = safeWorkspaceTreeListing(temp, "subfolder");
  assert.equal(subEntries.length, 1);
  assert.equal(subEntries[0]?.name, "child.ts");
  assert.equal(subEntries[0]?.path, "subfolder/child.ts");
  assert.equal(subEntries[0]?.extension, ".ts");

  // Path traversal attempts must be rejected
  assert.throws(
    () => safeWorkspaceTreeListing(temp, "../outside"),
    /outside the workspace/,
  );
});

test("a symlink cannot expose files outside the workspace", (t) => {
  const temp = mkdtempSync(resolve(tmpdir(), "foundry-tree-link-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const workspace = resolve(temp, "workspace");
  const outside = resolve(temp, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  writeFileSync(resolve(outside, "secret.txt"), "secret");
  symlinkSync(outside, resolve(workspace, "linked-dir"));
  symlinkSync(resolve(outside, "secret.txt"), resolve(workspace, "linked.txt"));
  assert.throws(
    () => safeWorkspaceTreeListing(workspace, "linked-dir"),
    /outside the workspace/,
  );
  assert.throws(
    () =>
      safeWorkspaceFileRead(workspace, {
        workspaceId: "ws",
        path: "linked.txt",
      }),
    /outside the paired workspace/,
  );
});

test("Git internals are neither listed nor readable", async (t) => {
  const temp = mkdtempSync(resolve(tmpdir(), "foundry-tree-git-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  await git(temp, ["init", "-b", "main"]);
  writeFileSync(resolve(temp, "README.md"), "hi");
  assert.deepEqual(
    safeWorkspaceTreeListing(temp).map((entry) => entry.name),
    ["README.md"],
  );
  assert.throws(() => safeWorkspaceTreeListing(temp, ".git"), /Git internals/);
  assert.throws(
    () =>
      safeWorkspaceFileRead(temp, { workspaceId: "ws", path: ".git/config" }),
    /Git internals/,
  );
});

test("links are listed by where they lead (DEV-231)", (t) => {
  const temp = mkdtempSync(resolve(tmpdir(), "foundry-tree-links-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const workspace = resolve(temp, "workspace");
  const outside = resolve(temp, "outside");
  mkdirSync(resolve(workspace, ".foundry/assistant-skills/helper"), {
    recursive: true,
  });
  mkdirSync(resolve(workspace, ".agents/skills"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(
    resolve(workspace, ".foundry/assistant-skills/helper/SKILL.md"),
    "# helper",
  );
  writeFileSync(resolve(outside, "secret.txt"), "secret");
  writeFileSync(resolve(workspace, "notes.md"), "notes");
  // As the Worker links assistant skills: relative, inside the workspace.
  symlinkSync(
    "../../.foundry/assistant-skills/helper",
    resolve(workspace, ".agents/skills/helper"),
  );
  symlinkSync("notes.md", resolve(workspace, "notes-link.md"));
  symlinkSync(outside, resolve(workspace, "away"));
  symlinkSync(resolve(outside, "secret.txt"), resolve(workspace, "away.txt"));
  symlinkSync(resolve(temp, "gone"), resolve(workspace, "gone"));

  const skills = safeWorkspaceTreeListing(workspace, ".agents/skills");
  assert.deepEqual(skills, [
    {
      extension: undefined,
      id: skills[0].id,
      isDirectory: true,
      name: "helper",
      path: ".agents/skills/helper",
      size: undefined,
      link: "workspace",
    },
  ]);
  const inside = safeWorkspaceTreeListing(workspace, ".agents/skills/helper");
  assert.equal(inside[0].path, ".agents/skills/helper/SKILL.md");
  assert.equal(inside[0].readOnly, undefined);
  const read = safeWorkspaceFileRead(workspace, {
    workspaceId: "ws",
    path: ".agents/skills/helper/SKILL.md",
  });
  assert.equal(read.content, "# helper");
  assert.equal(read.realPath, ".foundry/assistant-skills/helper/SKILL.md");
  assert.equal(read.readOnly, undefined);

  const root = new Map(
    safeWorkspaceTreeListing(workspace).map((entry) => [entry.name, entry]),
  );
  assert.equal(root.get("notes-link.md").link, "workspace");
  assert.equal(root.get("notes-link.md").size, 5);
  assert.equal(root.get("notes-link.md").isDirectory, false);
  for (const name of ["away", "away.txt"]) {
    const entry = root.get(name);
    assert.equal(entry.link, "outside", name);
    assert.equal(entry.isDirectory, false, name);
    assert.equal(entry.size, undefined, name);
    assert.equal(entry.extension, undefined, name);
    assert.equal(entry.readOnly, true, name);
  }
  assert.equal(root.get("gone").link, "missing");
  assert.equal(root.get("gone").readOnly, true);
  assert.equal(root.get("notes.md").link, undefined);
  assert.throws(
    () =>
      safeWorkspaceFileRead(workspace, { workspaceId: "ws", path: "away.txt" }),
    /outside the paired workspace/,
  );
  assert.throws(() =>
    safeWorkspaceFileRead(workspace, { workspaceId: "ws", path: "gone" }),
  );
});

test("a skill Foundry linked in from its snapshots is shown read-only (DEV-231)", (t) => {
  const state = process.env.FOUNDRY_STATE_ROOT;
  assert.ok(state, "the test runner sets a scratch state root");
  const temp = mkdtempSync(resolve(tmpdir(), "foundry-tree-managed-"));
  const set = resolve(state, "skill-sets", `test-${process.pid}-${Date.now()}`);
  t.after(() => {
    rmSync(temp, { recursive: true, force: true });
    rmSync(set, { recursive: true, force: true });
  });
  const skill = resolve(set, "skills", "review");
  mkdirSync(resolve(skill, "references"), { recursive: true });
  writeFileSync(resolve(skill, "SKILL.md"), "# review");
  writeFileSync(resolve(skill, "references", "guide.md"), "guide");
  const workspace = resolve(temp, "workspace");
  mkdirSync(resolve(workspace, ".agents/skills"), { recursive: true });
  mkdirSync(resolve(workspace, "elsewhere"));
  symlinkSync(skill, resolve(workspace, ".agents/skills/review"), "dir");
  // Not where Foundry links skills, or not a skill folder: still refused.
  symlinkSync(skill, resolve(workspace, "elsewhere/review"), "dir");
  symlinkSync(
    resolve(state, "skill-sets"),
    resolve(workspace, ".agents/skills/all-sets"),
    "dir",
  );

  const skills = new Map(
    safeWorkspaceTreeListing(workspace, ".agents/skills").map((entry) => [
      entry.name,
      entry,
    ]),
  );
  assert.equal(skills.get("review").link, "foundry");
  assert.equal(skills.get("review").isDirectory, true);
  assert.equal(skills.get("review").readOnly, true);
  assert.equal(skills.get("all-sets").link, "outside");
  assert.equal(
    safeWorkspaceTreeListing(workspace, "elsewhere")[0].link,
    "outside",
  );

  const files = safeWorkspaceTreeListing(workspace, ".agents/skills/review");
  assert.deepEqual(
    files.map((entry) => [entry.path, entry.isDirectory, entry.readOnly]),
    [
      [".agents/skills/review/references", true, true],
      [".agents/skills/review/SKILL.md", false, true],
    ],
  );
  const read = safeWorkspaceFileRead(workspace, {
    workspaceId: "ws",
    path: ".agents/skills/review/references/guide.md",
  });
  assert.equal(read.content, "guide");
  assert.equal(read.readOnly, true);
  assert.equal(read.realPath, undefined);
  assert.throws(
    () => safeWorkspaceTreeListing(workspace, "elsewhere/review"),
    /outside the workspace/,
  );
  assert.throws(
    () => safeWorkspaceTreeListing(workspace, ".agents/skills/all-sets"),
    /outside the workspace/,
  );
});
