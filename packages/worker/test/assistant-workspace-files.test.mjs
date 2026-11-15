import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { manageWorkspaceFile } =
  await import("../dist/session/files/workspace-file-write.js");
const {
  withManagedBlock,
  writePersonalAgentFiles,
  personalAgentFilesRevision,
} = await import("../dist/session/personal-agent-files.js");

const root = realpathSync(mkdtempSync(join(tmpdir(), "foundry-dev223-")));
test.after(() => rmSync(root, { recursive: true, force: true }));

let count = 0;
function workspace() {
  const path = join(root, `ws-${++count}`);
  mkdirSync(path, { recursive: true });
  return path;
}
const sha = (text) => createHash("sha256").update(text).digest("hex");
const code = (code) => (error) => error.code === code;

const block = (body) =>
  `<!-- foundry:managed:start (kept current by Foundry) -->\n${body}\n<!-- foundry:managed:end -->`;

test("the managed block replaces only itself and keeps the person's text", () => {
  const current = `${block("old facts")}\n\nMy own rule.\n`;
  assert.equal(
    withManagedBlock(current, block("new facts"), "default"),
    `${block("new facts")}\n\nMy own rule.\n`,
  );
});

test("a missing AGENTS.md becomes the block and the default", () => {
  assert.equal(
    withManagedBlock(undefined, block("facts"), "# What you are for\n"),
    `${block("facts")}\n\n# What you are for\n`,
  );
});

test("an AGENTS.md Foundry wrote whole before is replaced by block and default", () => {
  const legacy =
    "You are A.\n\n# What you are for\n\nx\n\n# The person's rules\n\n- a\n\n# What the person confirmed (newest first)\n\nNothing yet.\n";
  assert.equal(
    withManagedBlock(legacy, block("facts"), "# What you are for\n\nx\n"),
    `${block("facts")}\n\n# What you are for\n\nx\n`,
  );
});

test("a person's file without a block gets it on top, nothing lost", () => {
  assert.equal(
    withManagedBlock("Only mine.\n", block("facts"), "default"),
    `${block("facts")}\n\nOnly mine.\n`,
  );
});

test("a run writes the block into AGENTS.md and an edit of the rest renews the runtime", () => {
  const ws = workspace();
  writeFileSync(join(ws, "AGENTS.md"), `${block("old")}\n\nMine.\n`);
  const session = { id: "sess_1", role: "personal_agent", workspaceId: "ws_1" };
  const files = [
    {
      path: "AGENTS.md",
      content: block("facts"),
      managedBlock: true,
      seed: "default",
    },
  ];
  writePersonalAgentFiles(session, ws, files);
  assert.equal(
    readFileSync(join(ws, "AGENTS.md"), "utf8"),
    `${block("facts")}\n\nMine.\n`,
  );
  const first = personalAgentFilesRevision("sess_1");
  writeFileSync(join(ws, "AGENTS.md"), `${block("facts")}\n\nMine, edited.\n`);
  writePersonalAgentFiles(session, ws, files);
  assert.equal(
    readFileSync(join(ws, "AGENTS.md"), "utf8"),
    `${block("facts")}\n\nMine, edited.\n`,
  );
  assert.notEqual(personalAgentFilesRevision("sess_1"), first);
});

test("a malformed managed block is refused", () => {
  const ws = workspace();
  const session = { id: "sess_2", role: "personal_agent", workspaceId: "ws_1" };
  assert.throws(() =>
    writePersonalAgentFiles(session, ws, [
      { path: "AGENTS.md", content: "no markers", managedBlock: true },
    ]),
  );
  assert.throws(() =>
    writePersonalAgentFiles(session, ws, [
      {
        path: ".foundry/project-index.md",
        content: block("x"),
        managedBlock: true,
      },
    ]),
  );
});

test("manage_file renames a file into a new folder over the content seen", () => {
  const ws = workspace();
  writeFileSync(join(ws, "a.md"), "hello");
  assert.throws(
    () =>
      manageWorkspaceFile(ws, {
        workspaceId: "w",
        op: "rename",
        path: "a.md",
        toPath: "notes/b.md",
        expectedSha256: sha("other"),
      }),
    code("conflict"),
  );
  manageWorkspaceFile(ws, {
    workspaceId: "w",
    op: "rename",
    path: "a.md",
    toPath: "notes/b.md",
    expectedSha256: sha("hello"),
  });
  assert.equal(existsSync(join(ws, "a.md")), false);
  assert.equal(readFileSync(join(ws, "notes/b.md"), "utf8"), "hello");
});

test("manage_file refuses to overwrite, leave the workspace, touch .git, links or folders", () => {
  const ws = workspace();
  writeFileSync(join(ws, "a.md"), "a");
  writeFileSync(join(ws, "b.md"), "b");
  mkdirSync(join(ws, "dir"));
  mkdirSync(join(ws, ".git"));
  symlinkSync(join(ws, "a.md"), join(ws, "link.md"));
  const rename = (path, toPath) => () =>
    manageWorkspaceFile(ws, { workspaceId: "w", op: "rename", path, toPath });
  assert.throws(rename("a.md", "b.md"), code("exists"));
  assert.throws(rename("a.md", "../out.md"), code("invalid_path"));
  assert.throws(rename("a.md", ".git/x"), code("invalid_path"));
  assert.throws(rename("link.md", "c.md"), code("invalid_path"));
  assert.throws(rename("dir", "dir2"), code("invalid_path"));
  assert.throws(rename("none.md", "c.md"), code("missing"));
  assert.equal(readFileSync(join(ws, "b.md"), "utf8"), "b");
});

test("manage_file deletes a file only over the content seen", () => {
  const ws = workspace();
  writeFileSync(join(ws, "a.md"), "a");
  assert.throws(
    () =>
      manageWorkspaceFile(ws, {
        workspaceId: "w",
        op: "delete",
        path: "a.md",
        expectedSha256: sha("b"),
      }),
    code("conflict"),
  );
  manageWorkspaceFile(ws, {
    workspaceId: "w",
    op: "delete",
    path: "a.md",
    expectedSha256: sha("a"),
  });
  assert.equal(existsSync(join(ws, "a.md")), false);
});
