import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
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
  readSessionFileLedger,
  SessionTurnFiles,
} from "../dist/session-files.js";
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
