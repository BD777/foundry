import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  claudeFileWriteHooks,
  claudeToolFileWrite,
  codexFileWrites,
  mergeClaudeHooks,
  readSessionFile,
  readSessionFileDiff,
  readSessionFileLedger,
  SessionTurnFiles,
} from "../dist/session-files.js";
import { lineChangeCounts } from "../dist/session-file-diffs.js";
import {
  answerBlocks,
  candidatePath,
  privateDevicePath,
} from "../dist/session-file-references.js";
import { safeWorkspaceFileRead } from "../dist/session-helpers.js";
import { git, commitIdentity } from "../dist/execution-git.js";

const sessionId = "sess_files";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "foundry-session-files-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  const home = join(root, "home");
  for (const folder of [workspace, outside, home]) mkdirSync(folder);
  const sessionsRoot = join(workspace, ".foundry", "sessions");
  const events = [];
  const turn = (inputId, startedAt = Date.now()) =>
    new SessionTurnFiles({
      workspacePath: workspace,
      sessionsRoot,
      sessionId,
      inputId,
      startedAt,
      home,
      emit: async (label, detail, level, metadata) => {
        events.push({ label, detail, level, metadata });
      },
    });
  const ledger = () => readSessionFileLedger(sessionsRoot, sessionId);
  const read = (path) =>
    readSessionFile({ workspacePath: workspace, sessionId, path, home });
  return {
    root,
    workspace,
    outside,
    home,
    sessionsRoot,
    events,
    turn,
    ledger,
    read,
  };
}

async function gitWorkspace(workspace) {
  await git(workspace, ["init", "-b", "main"]);
  writeFileSync(join(workspace, "README.md"), "hi\n");
  writeFileSync(join(workspace, "unrelated.go"), "package main\n");
  await git(workspace, ["add", "."]);
  await git(workspace, ["commit", "-m", "init"], { env: commitIdentity });
}

test("only the session's own successful writes are attributed", async (t) => {
  const f = fixture(t);
  await gitWorkspace(f.workspace);
  const files = f.turn("in_1");
  mkdirSync(join(f.workspace, "notes"));
  writeFileSync(join(f.workspace, "notes", "plan.md"), "# Plan\n");
  await files.recordToolWrite({
    path: join(f.workspace, "notes", "plan.md"),
    op: "created",
    agent: "main",
  });
  // Another agent, an editor or a build changes a file meanwhile.
  writeFileSync(join(f.workspace, "unrelated.go"), "package main // edited\n");
  writeFileSync(join(f.workspace, "scratch.txt"), "shell output\n");
  const references = await files.finish("Wrote the plan.");

  assert.deepEqual(references, []);
  assert.deepEqual(
    f.ledger().map((entry) => [entry.workspacePath, entry.origin, entry.op]),
    [["notes/plan.md", "tool", "created"]],
  );
  assert.deepEqual(
    f.events.map((event) => event.metadata.sessionFile),
    [
      {
        path: join(f.workspace, "notes", "plan.md"),
        workspacePath: "notes/plan.md",
        origin: "tool",
        op: "created",
        inGitRepo: true,
        inputId: "in_1",
        agent: "main",
        bytes: 7,
      },
    ],
  );
});

test("a subagent's write outside the workspace is attributed to it", async (t) => {
  const f = fixture(t);
  const report = join(f.outside, "products", "omh.md");
  mkdirSync(join(f.outside, "products"));
  writeFileSync(report, "# OMH\n");
  const files = f.turn("in_1");
  await files.recordToolWrite({
    path: report,
    op: "created",
    agent: "agent_7",
  });
  await files.finish("");
  const [entry] = f.ledger();
  assert.equal(entry.path, report);
  assert.equal(entry.workspacePath, undefined);
  assert.equal(entry.agent, "agent_7");
  assert.equal(entry.inGitRepo, false);
  assert.deepEqual(entry.inputIds, ["in_1"]);
  // Private locations are never recorded, even when a tool wrote them.
  await f.turn("in_1").recordToolWrite({
    path: join(f.home, ".ssh", "config"),
    op: "modified",
    agent: "main",
  });
  await f.turn("in_1").recordToolWrite({
    path: join(f.workspace, ".foundry", "attachments", "a.png"),
    op: "created",
    agent: "main",
  });
  assert.equal(f.ledger().length, 1);
});

test("failed writes are not recorded", async () => {
  // Only PostToolUse is observed: a failed tool reaches PostToolUseFailure.
  const recorded = [];
  const hooks = claudeFileWriteHooks((write) => recorded.push(write));
  assert.deepEqual(Object.keys(hooks), ["PostToolUse"]);
  const [matcher] = hooks.PostToolUse;
  await matcher.hooks[0]({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/x/report.md", content: "x" },
    tool_response: { type: "create", filePath: "/tmp/x/report.md" },
    agent_id: "agent_1",
  });
  await matcher.hooks[0]({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo hi > /tmp/x/b.md" },
  });
  assert.deepEqual(recorded, [
    { path: "/tmp/x/report.md", op: "created", agent: "agent_1" },
  ]);
  assert.deepEqual(
    claudeToolFileWrite({
      tool_name: "Edit",
      tool_input: { file_path: "/w/a.ts" },
      tool_response: { filePath: "/w/a.ts" },
    }),
    { path: "/w/a.ts", op: "modified", agent: "main" },
  );
  assert.deepEqual(
    codexFileWrites({
      type: "item.completed",
      item: {
        id: "1",
        type: "file_change",
        status: "failed",
        changes: [{ path: "/w/a.ts", kind: "update" }],
      },
    }),
    [],
  );
  assert.deepEqual(
    codexFileWrites({
      type: "item.started",
      item: {
        id: "1",
        type: "file_change",
        status: "completed",
        changes: [{ path: "/w/a.ts", kind: "add" }],
      },
    }),
    [],
  );
  assert.deepEqual(
    codexFileWrites({
      type: "item.completed",
      item: {
        id: "1",
        type: "file_change",
        status: "completed",
        changes: [
          { path: "/w/a.ts", kind: "add" },
          { path: "/w/b.ts", kind: "update" },
          { path: "/w/c.ts", kind: "delete" },
        ],
      },
    }).map((write) => write.op),
    ["created", "modified", "deleted"],
  );
  const merged = mergeClaudeHooks(
    { PostToolUse: [{ hooks: [] }], Stop: [{ hooks: [] }] },
    hooks,
  );
  assert.equal(merged.PostToolUse.length, 2);
  assert.equal(merged.Stop.length, 1);
});

test("a folder named before a list is the base of the list's files", async (t) => {
  const f = fixture(t);
  const products = join(f.outside, "fdy-groupscan", "products");
  mkdirSync(products, { recursive: true });
  for (const name of ["omh.md", "rev.md"])
    writeFileSync(join(products, name), `# ${name}\n`);
  const files = f.turn("in_2", Date.now() - 1000);
  const references = await files.finish(
    [
      `The reports are in \`${products}/\`:`,
      "",
      "- `omh.md` — OMH overview",
      "- `rev.md`",
      "- `missing.md`",
    ].join("\n"),
  );
  assert.deepEqual(references, [
    { text: "omh.md", path: join(products, "omh.md"), kind: "file" },
    { text: "rev.md", path: join(products, "rev.md"), kind: "file" },
    { text: `${products}/`, path: products, kind: "dir" },
  ]);
  assert.deepEqual(
    f.ledger().map((entry) => [entry.path, entry.origin, entry.op]),
    [
      [join(products, "omh.md"), "reference", "referenced"],
      [join(products, "rev.md"), "reference", "referenced"],
    ],
  );
  assert.deepEqual(
    f.events.map((event) => event.metadata.sessionFile.inputId),
    ["in_2", "in_2"],
  );
});

test("line suffixes, unique names, and refusals", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.workspace, "src"));
  writeFileSync(join(f.workspace, "src", "app.ts"), "export {};\n");
  writeFileSync(join(f.workspace, ".env"), "SECRET=1\n");
  mkdirSync(join(f.workspace, ".git"));
  writeFileSync(join(f.workspace, ".git", "config"), "[core]\n");
  mkdirSync(join(f.home, ".ssh"));
  writeFileSync(join(f.home, ".ssh", "notes.md"), "private\n");
  const deep = join(f.outside, "deep", "nested");
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, "unique-name.md"), "x\n");
  const old = join(f.outside, "old.md");
  writeFileSync(old, "old\n");
  const hourAgo = new Date(Date.now() - 3600_000);
  utimesSync(old, hourAgo, hourAgo);

  const first = f.turn("in_1");
  await first.recordToolWrite({
    path: join(deep, "unique-name.md"),
    op: "created",
    agent: "main",
  });
  await first.finish("");

  const references = await f
    .turn("in_2")
    .finish(
      [
        "See `src/app.ts:12` and [the app](src/app.ts#L3-L9).",
        "The summary is `unique-name.md`, also at `nowhere/else.md`.",
        `Refused: \`.env\`, \`.git/config\`, \`~/.ssh/notes.md\`, \`${old}\`.`,
      ].join("\n"),
    );
  assert.deepEqual(references, [
    {
      text: "src/app.ts:12",
      path: join(f.workspace, "src", "app.ts"),
      kind: "file",
    },
    {
      text: "src/app.ts#L3-L9",
      path: join(f.workspace, "src", "app.ts"),
      kind: "file",
    },
    {
      text: "unique-name.md",
      path: join(deep, "unique-name.md"),
      kind: "file",
    },
  ]);
  assert.equal(candidatePath("`npm run build`"), undefined);
  assert.equal(candidatePath("https://example.com/a.md"), undefined);
  assert.equal(candidatePath("/tmp/a/report.md:12:4,"), "/tmp/a/report.md");
  assert.ok(privateDevicePath(join(f.home, ".claude.json"), f.home));
  assert.ok(privateDevicePath("/srv/keys/server.pem", f.home));
  assert.ok(privateDevicePath("/srv/repo/id_ed25519", f.home));
  // A named file written earlier keeps its tool origin and gains the turn.
  const entry = f
    .ledger()
    .find((file) => file.path === join(deep, "unique-name.md"));
  assert.equal(entry.origin, "tool");
  assert.deepEqual(entry.inputIds, ["in_1", "in_2"]);
});

test("fenced code is not scanned and candidates are capped", () => {
  const blocks = answerBlocks(
    ["```", "`/tmp/a.md`", "```", "`/tmp/b.md`"].join("\n"),
  );
  assert.deepEqual(
    blocks.flatMap((block) => block.tokens.map((token) => token.path)),
    ["/tmp/b.md"],
  );
  const many = Array.from(
    { length: 300 },
    (_, index) => `\`f${index}.md\``,
  ).join(" ");
  assert.equal(answerBlocks(many).flatMap((block) => block.tokens).length, 200);
});

test("reads are bounded, sniff binaries, and follow the ledger", async (t) => {
  const f = fixture(t);
  const big = join(f.outside, "big.log");
  writeFileSync(big, "é".repeat(200 * 1024)); // 400 KB, two bytes per char
  const binary = join(f.outside, "data.bin.txt");
  writeFileSync(binary, Buffer.from([0x41, 0x00, 0x42]));
  const image = join(f.outside, "chart.png");
  writeFileSync(image, Buffer.from("89504e470d0a1a0a", "hex"));
  const moved = join(f.outside, "moved.md");
  writeFileSync(moved, "v1\n");
  const files = f.turn("in_1");
  for (const path of [big, binary, image, moved])
    await files.recordToolWrite({ path, op: "created", agent: "main" });
  await files.finish("");

  const text = f.read(big);
  assert.equal(text.kind, "text");
  assert.equal(text.truncated, true);
  assert.equal(text.bytes, 400 * 1024);
  assert.equal(Buffer.byteLength(text.content), 256 * 1024);
  assert.ok(!text.content.includes("�"));
  assert.equal(text.origin, "tool");
  assert.equal(text.insideWorkspace, false);
  assert.equal(f.read(binary).kind, "binary");
  assert.equal(f.read(binary).content, undefined);
  const png = f.read(image);
  assert.equal(png.kind, "image");
  assert.equal(png.mimeType, "image/png");
  assert.equal(
    png.dataBase64,
    Buffer.from("89504e470d0a1a0a", "hex").toString("base64"),
  );
  assert.equal(f.read(moved).changedSinceRecorded, false);

  writeFileSync(moved, "v2, edited later\n");
  const later = new Date(Date.now() + 5000);
  utimesSync(moved, later, later);
  assert.equal(f.read(moved).changedSinceRecorded, true);
  assert.throws(
    () => f.read(join(f.outside, "never-recorded.md")),
    /not one this chat/,
  );
  unlinkSync(moved);
  assert.equal(f.read(moved).kind, "missing");
  // A recorded path that now points elsewhere is refused.
  writeFileSync(join(f.home, "secret.md"), "secret\n");
  symlinkSync(join(f.home, "secret.md"), moved);
  assert.throws(() => f.read(moved), /resolves somewhere else/);
});

test("the ledger survives a worker restart", async (t) => {
  const f = fixture(t);
  const report = join(f.outside, "report.md");
  writeFileSync(report, "# Report\n");
  await f
    .turn("in_1")
    .recordToolWrite({ path: report, op: "created", agent: "main" });
  // A new process knows nothing but the ledger on disk.
  const raw = JSON.parse(
    readFileSync(join(f.sessionsRoot, sessionId, "files.json"), "utf8"),
  );
  assert.equal(raw.version, 1);
  assert.equal(f.read(report).content, "# Report\n");
  const next = f.turn("in_2");
  writeFileSync(report, "# Report v2\n");
  await next.recordToolWrite({ path: report, op: "modified", agent: "main" });
  await next.finish("");
  const [entry] = f.ledger();
  assert.equal(entry.op, "created");
  assert.deepEqual(entry.inputIds, ["in_1", "in_2"]);
  assert.throws(
    () => readSessionFileLedger(f.sessionsRoot, "../escape"),
    /invalid session id/,
  );
});

test("workspace reads stop at their limit", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, "large.txt"), "a".repeat(200 * 1024));
  const read = safeWorkspaceFileRead(f.workspace, {
    workspaceId: "ws",
    path: "large.txt",
  });
  assert.equal(read.truncated, true);
  assert.equal(read.content.length, 128 * 1024);
  assert.equal(resolve(f.workspace, read.path), join(f.workspace, "large.txt"));
});

/** A Claude write: PreToolUse keeps the before, the tool writes, PostToolUse. */
async function claudeWrite(files, path, content, agent = "main") {
  const hooks = claudeFileWriteHooks(
    (write) => files.recordToolWrite(write),
    (write) => files.captureBeforeWrite(write),
  );
  const input = {
    tool_name: "Write",
    tool_input: { file_path: path },
    ...(agent === "main" ? {} : { agent_id: agent }),
  };
  await hooks.PreToolUse[0].hooks[0](input);
  writeFileSync(path, content);
  await hooks.PostToolUse[0].hooks[0]({ ...input, tool_response: {} });
  // The PostToolUse hook records in the background; wait for it.
  await files.recordToolWrite({ path, op: "modified", agent });
}

const diffOf = (f, path, inputId) =>
  readSessionFileDiff({
    workspacePath: f.workspace,
    sessionsRoot: f.sessionsRoot,
    sessionId,
    path,
    inputId,
    home: f.home,
  });

test("a turn's diff runs from before its first write to after its last", async (t) => {
  const f = fixture(t);
  await gitWorkspace(f.workspace);
  const readme = join(f.workspace, "README.md");
  const other = join(f.workspace, "unrelated.go");
  const files = f.turn("in_1");
  await claudeWrite(files, readme, "hi\nthere\n");
  // Another agent edits a different file meanwhile.
  writeFileSync(other, "package main // someone else\n");
  await claudeWrite(files, readme, "hello\nthere\nfriend\n", "agent_3");
  await files.finish("Edited the readme.");

  const diff = await diffOf(f, readme, "in_1");
  assert.equal(diff.source, "hook");
  assert.equal(
    diff.before,
    "hi\n",
    "the before is kept once, at the first write",
  );
  assert.equal(diff.after, "hello\nthere\nfriend\n");
  assert.equal(diff.beforeLabel, "beforeEdits");
  assert.equal(diff.afterLabel, "afterEdits");
  assert.equal(diff.mayIncludeOtherEdits, false);
  assert.deepEqual([diff.added, diff.removed], [3, 1]);
  // The other agent's file is not this session's: it has no diff at all.
  await assert.rejects(diffOf(f, other), /not one this chat's tools wrote/);
  const counted = f.events
    .map((event) => event.metadata.sessionFile)
    .filter((record) => record.added !== undefined);
  assert.deepEqual(
    counted.map((record) => [
      record.added,
      record.removed,
      record.totalAdded,
      record.totalRemoved,
    ]),
    [[3, 1, 3, 1]],
  );
  // Copies of intermediate writes are dropped when the turn ends.
  const baselines = join(
    f.sessionsRoot,
    sessionId,
    "inputs",
    "in_1",
    "baselines",
  );
  assert.equal(readdirSync(baselines).length, 2);

  // A later turn: its own diff, and the session's from the first before.
  writeFileSync(readme, "hello\nthere\nfriend\n");
  const second = f.turn("in_2");
  await claudeWrite(second, readme, "hello\nfriend\n");
  await second.finish("");
  assert.deepEqual(
    [
      (await diffOf(f, readme, "in_2")).before,
      (await diffOf(f, readme, "in_2")).after,
    ],
    ["hello\nthere\nfriend\n", "hello\nfriend\n"],
  );
  const whole = await diffOf(f, readme);
  assert.deepEqual(
    [whole.before, whole.after, whole.inputId],
    ["hi\n", "hello\nfriend\n", undefined],
  );
  assert.equal(whole.mayIncludeOtherEdits, false);
  await assert.rejects(
    diffOf(f, other, "in_2"),
    /not one this chat's tools wrote/,
  );
});

test("another process editing the same file between writes is labelled", async (t) => {
  const f = fixture(t);
  await gitWorkspace(f.workspace);
  const readme = join(f.workspace, "README.md");
  const files = f.turn("in_1");
  await claudeWrite(files, readme, "hi\nsession\n");
  writeFileSync(readme, "hi\nsession\nsomeone else\n");
  await claudeWrite(
    files,
    readme,
    "hi\nsession\nsomeone else\nsession again\n",
  );
  await files.finish("");
  const diff = await diffOf(f, readme, "in_1");
  // Included, not hidden: the diff says so.
  assert.equal(diff.mayIncludeOtherEdits, true);
  assert.equal(diff.after, "hi\nsession\nsomeone else\nsession again\n");
  // After the session's last write: shown as the session left it.
  writeFileSync(readme, "rewritten by an editor\n");
  const later = await diffOf(f, readme, "in_1");
  assert.equal(later.changedSince, true);
  assert.equal(later.after, "hi\nsession\nsomeone else\nsession again\n");
});

test("new, large and binary files", async (t) => {
  const f = fixture(t);
  const files = f.turn("in_1");
  const created = join(f.outside, "new.md");
  await claudeWrite(files, created, "# New\n");
  const large = join(f.outside, "large.txt");
  writeFileSync(large, "x".repeat(1024 * 1024 + 1));
  await claudeWrite(files, large, "y".repeat(1024 * 1024 + 1));
  const binary = join(f.outside, "data.bin");
  writeFileSync(binary, Buffer.from([1, 0, 2]));
  await claudeWrite(files, binary, Buffer.from([1, 0, 3]));
  await files.finish("");

  const fresh = await diffOf(f, created, "in_1");
  assert.deepEqual(
    [fresh.beforeLabel, fresh.before, fresh.after],
    ["empty", "", "# New\n"],
  );
  assert.deepEqual([fresh.added, fresh.removed], [1, 0]);
  const big = await diffOf(f, large);
  assert.equal(big.tooLarge, true);
  assert.equal(big.before, undefined);
  const bin = await diffOf(f, binary);
  assert.equal(bin.binary, true);
  assert.equal(bin.after, undefined);
  // Neither keeps a copy: only the new file's text was stored.
  const baselines = join(
    f.sessionsRoot,
    sessionId,
    "inputs",
    "in_1",
    "baselines",
  );
  assert.equal(readdirSync(baselines).length, 1);
  // A turn without a kept before (an older worker) is unavailable, plainly.
  const older = join(f.outside, "older.md");
  writeFileSync(older, "x\n");
  const turn2 = f.turn("in_2");
  await turn2.recordToolWrite({ path: older, op: "modified", agent: "main" });
  await turn2.finish("");
  assert.equal((await diffOf(f, older)).unavailable, "noBaseline");
});

test("Codex diffs come from a turn-start snapshot; the user's index is untouched", async (t) => {
  const f = fixture(t);
  await gitWorkspace(f.workspace);
  writeFileSync(join(f.workspace, "README.md"), "hi\nstaged\n");
  await git(f.workspace, ["add", "README.md"]);
  writeFileSync(join(f.workspace, "README.md"), "hi\nstaged\nunstaged\n");
  writeFileSync(join(f.workspace, "untracked.txt"), "loose\n");
  // `git status` may refresh the index itself: read it first.
  writeFileSync(join(f.workspace, ".gitignore"), "*.log\n");
  writeFileSync(join(f.workspace, "build.log"), "built\n");
  const statusBefore = await git(f.workspace, ["status", "--porcelain"]);
  const index = join(f.workspace, ".git", "index");
  const indexBefore = readFileSync(index);
  const indexMtime = statSync(index).mtimeMs;

  const files = f.turn("in_1");
  await files.snapshotWorkTree();
  assert.deepEqual(readFileSync(index), indexBefore);
  assert.equal(statSync(index).mtimeMs, indexMtime);
  // Only Foundry's own session folder appears (the manifest).
  assert.equal(
    (await git(f.workspace, ["status", "--porcelain"]))
      .split("\n")
      .filter((line) => line !== "?? .foundry/")
      .join("\n"),
    statusBefore,
    "nothing staged or unstaged changed",
  );
  assert.equal(
    readdirSync(join(f.sessionsRoot, sessionId, "inputs", "in_1")).some(
      (name) => name.endsWith(".index"),
    ),
    false,
    "the temporary index is removed",
  );

  writeFileSync(join(f.workspace, "README.md"), "hi\nby codex\n");
  writeFileSync(join(f.workspace, "added.txt"), "new\n");
  writeFileSync(join(f.workspace, "build.log"), "rebuilt\n");
  for (const write of codexFileWrites({
    type: "item.completed",
    item: {
      type: "file_change",
      status: "completed",
      changes: [
        { path: join(f.workspace, "README.md"), kind: "update" },
        { path: join(f.workspace, "added.txt"), kind: "add" },
        { path: join(f.workspace, "build.log"), kind: "update" },
      ],
    },
  }))
    await files.recordToolWrite(write);
  await files.finish("");

  const readme = await diffOf(f, join(f.workspace, "README.md"), "in_1");
  assert.equal(readme.source, "git-snapshot");
  assert.equal(readme.beforeLabel, "turnStart");
  assert.equal(readme.mayIncludeOtherEdits, true);
  // The work tree as the turn started, unstaged edits included.
  assert.equal(readme.before, "hi\nstaged\nunstaged\n");
  assert.equal(readme.after, "hi\nby codex\n");
  // A file Git ignores was not in the snapshot: no "before", not "new".
  assert.equal(
    (await diffOf(f, join(f.workspace, "build.log"))).unavailable,
    "noBaseline",
  );
  const added = await diffOf(f, join(f.workspace, "added.txt"));
  assert.deepEqual(
    [added.beforeLabel, added.before, added.after],
    ["empty", "", "new\n"],
  );
  assert.deepEqual(readFileSync(index), indexBefore);
  assert.equal(existsSync(join(f.workspace, ".git", "index.lock")), false);
});

test("line counts match a minimal diff", () => {
  assert.deepEqual(lineChangeCounts("a\nb\nc\n", "a\nB\nc\nd\n"), {
    added: 2,
    removed: 1,
  });
  assert.deepEqual(lineChangeCounts("", "x\n"), { added: 1, removed: 0 });
  assert.deepEqual(lineChangeCounts("same\n", "same\n"), {
    added: 0,
    removed: 0,
  });
  assert.equal(
    lineChangeCounts("a\n".repeat(50), "b\n".repeat(50), 10),
    undefined,
  );
});
