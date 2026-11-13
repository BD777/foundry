import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { writeWorkspaceFile, maxWorkspaceFileWriteBytes } =
  await import("../dist/session/files/workspace-file-write.js");

const root = realpathSync(mkdtempSync(join(tmpdir(), "foundry-write-file-")));
test.after(() => rmSync(root, { recursive: true, force: true }));

let count = 0;
function workspace() {
  const path = join(root, `ws-${++count}`);
  mkdirSync(path, { recursive: true });
  return path;
}

const sha = (text) => createHash("sha256").update(text).digest("hex");
const write = (ws, path, content, expectedSha256) =>
  writeWorkspaceFile(ws, {
    workspaceId: "ws_1",
    path,
    content,
    ...(expectedSha256 !== undefined ? { expectedSha256 } : {}),
  });
const code = (code) => (error) => error.code === code;

test("creates a file and its folders, and reports its hash", () => {
  const ws = workspace();
  const written = write(ws, "docs/notes/AGENTS.md", "hello\n");
  assert.deepEqual(written, {
    workspaceId: "ws_1",
    path: "docs/notes/AGENTS.md",
    sha256: sha("hello\n"),
    bytes: 6,
  });
  assert.equal(
    readFileSync(join(ws, "docs/notes/AGENTS.md"), "utf8"),
    "hello\n",
  );
});

test("replaces a file whose content matches the expected hash, else refuses", () => {
  const ws = workspace();
  writeFileSync(join(ws, "AGENTS.md"), "one");
  assert.equal(write(ws, "AGENTS.md", "two", sha("one")).sha256, sha("two"));
  assert.equal(readFileSync(join(ws, "AGENTS.md"), "utf8"), "two");
  assert.throws(
    () => write(ws, "AGENTS.md", "three", sha("one")),
    code("conflict"),
  );
  assert.equal(readFileSync(join(ws, "AGENTS.md"), "utf8"), "two");
  // Without an expected hash the file is replaced as is.
  write(ws, "AGENTS.md", "four");
  assert.equal(readFileSync(join(ws, "AGENTS.md"), "utf8"), "four");
});

test("an empty expected hash means the file must not exist", () => {
  const ws = workspace();
  write(ws, "new/AGENTS.md", "first", "");
  assert.equal(readFileSync(join(ws, "new/AGENTS.md"), "utf8"), "first");
  assert.throws(
    () => write(ws, "new/AGENTS.md", "second", ""),
    code("conflict"),
  );
  assert.equal(readFileSync(join(ws, "new/AGENTS.md"), "utf8"), "first");
  // A missing file never matches a hash.
  assert.throws(() => write(ws, "absent.md", "x", sha("x")), code("conflict"));
  assert.equal(existsSync(join(ws, "absent.md")), false);
});

test("paths that leave the workspace or reach .git are refused", () => {
  const ws = workspace();
  const outside = join(root, `outside-${count}`);
  mkdirSync(outside);
  mkdirSync(join(ws, ".git"));
  symlinkSync(outside, join(ws, "escape"));
  symlinkSync(join(outside, "target.md"), join(ws, "link.md"));
  symlinkSync(join(ws, ".git"), join(ws, "gitlink"));
  for (const path of [
    "../x.md",
    "a/../../x.md",
    "/etc/passwd",
    `${outside}/x.md`,
    ".git/config",
    "sub/.git/hooks/x",
    ".GIT/config",
    "escape/x.md",
    "escape/new/x.md",
    "link.md",
    "gitlink/config",
    "./AGENTS.md",
    "a//b.md",
    "",
  ])
    assert.throws(() => write(ws, path, "x"), code("invalid_path"), path);
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(existsSync(join(ws, "a")), false);
});

test("a link inside the workspace is written through, keeping the link", () => {
  const ws = workspace();
  writeFileSync(join(ws, "CLAUDE.md"), "old");
  symlinkSync("CLAUDE.md", join(ws, "AGENTS.md"));
  write(ws, "AGENTS.md", "new", sha("old"));
  assert.equal(readFileSync(join(ws, "CLAUDE.md"), "utf8"), "new");
  assert.equal(realpathSync(join(ws, "AGENTS.md")), join(ws, "CLAUDE.md"));
});

test("too large content is refused and nothing is written", () => {
  const ws = workspace();
  writeFileSync(join(ws, "AGENTS.md"), "keep");
  assert.throws(
    () => write(ws, "AGENTS.md", "x".repeat(maxWorkspaceFileWriteBytes + 1)),
    code("too_large"),
  );
  assert.equal(readFileSync(join(ws, "AGENTS.md"), "utf8"), "keep");
  assert.equal(maxWorkspaceFileWriteBytes, 512 * 1024);
});

test("a failed write leaves the old file and no temporary file behind", () => {
  const ws = workspace();
  writeFileSync(join(ws, "AGENTS.md"), "keep");
  // A folder in the file's place is refused before anything is written.
  mkdirSync(join(ws, "dir.md"));
  assert.throws(() => write(ws, "dir.md", "x"));
  assert.throws(
    () => write(ws, "AGENTS.md", "x", sha("other")),
    code("conflict"),
  );
  assert.equal(readFileSync(join(ws, "AGENTS.md"), "utf8"), "keep");
  assert.deepEqual(readdirSync(ws).sort(), ["AGENTS.md", "dir.md"]);
  assert.deepEqual(readdirSync(join(ws, "dir.md")), []);
});
