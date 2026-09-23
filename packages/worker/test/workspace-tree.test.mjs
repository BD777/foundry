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
} from "../dist/session-helpers.js";
import { SessionOutputFiles } from "../dist/session-output-files.js";
import { git, commitIdentity } from "../dist/execution-git.js";

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

test("a run reports files it wrote, not files already modified before it", async (t) => {
  const temp = mkdtempSync(resolve(tmpdir(), "foundry-outputs-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  await git(temp, ["init", "-b", "main"]);
  writeFileSync(resolve(temp, "tracked.md"), "v1");
  writeFileSync(resolve(temp, "before.md"), "v1");
  await git(temp, ["add", "."]);
  await git(temp, ["commit", "-m", "init"], { env: commitIdentity });
  // Dirty before the run started: not this run's output.
  writeFileSync(resolve(temp, "before.md"), "edited earlier");

  const reported = [];
  const outputs = await SessionOutputFiles.start(
    temp,
    async (_label, detail, _level, metadata) => {
      reported.push([detail, metadata?.outputFile]);
    },
  );
  await outputs.reportToolWrites([
    resolve(temp, "notes/plan.md"),
    "../escape.md",
    ".git/config",
    ".foundry/state.json",
  ]);
  writeFileSync(resolve(temp, "tracked.md"), "v2");
  mkdirSync(resolve(temp, "summary-parts"));
  writeFileSync(resolve(temp, "summary-parts/01.md"), "new");
  writeFileSync(resolve(temp, "notes.md"), "shell output");
  await outputs.reportChangedOnDisk();
  await outputs.reportToolWrites(["notes/plan.md"]);

  assert.deepEqual(reported.map(([file]) => file).sort(), [
    "notes.md",
    "notes/plan.md",
    "summary-parts/01.md",
    "tracked.md",
  ]);
  assert.ok(reported.every(([detail, file]) => detail === file));
});
