import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
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
  sessionFileEntry,
  SessionTurnFiles,
} from "../dist/session-files.js";
import { lineChangeCounts } from "../dist/session-file-diffs.js";
import {
  answerBlocks,
  candidatePath,
  privateDevicePath,
  resolveFileReferences,
} from "../dist/session-file-references.js";
import { safeWorkspaceFileRead } from "../dist/workspace-files.js";
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
    path: join(f.workspace, ".foundry", "workspace.json"),
    op: "modified",
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

test("files under the workspace's attachments are outputs; Foundry's own state is not", async (t) => {
  const f = fixture(t);
  await gitWorkspace(f.workspace);
  const foundry = join(f.workspace, ".foundry");
  const attachments = join(foundry, "attachments");
  mkdirSync(join(attachments, "20261011"), { recursive: true });
  mkdirSync(join(f.sessionsRoot, "sess_other"), { recursive: true });
  const decisions = join(attachments, "decisions.md");
  writeFileSync(decisions, "# Decisions\n");
  const shot = join(attachments, "20261011", "after.png");
  writeFileSync(shot, Buffer.from("89504e470d0a1a0a", "hex"));
  const internal = [
    join(f.sessionsRoot, "sess_other", "notes.md"),
    join(foundry, "workspace.json"),
    join(foundry, "preview.json"),
    join(foundry, "issues", "ISS-1.json"),
  ];
  mkdirSync(join(foundry, "issues"));
  for (const path of internal) writeFileSync(path, "{}\n");
  // A link inside the attachments that leads into Foundry's own state.
  const leak = join(attachments, "leak.md");
  symlinkSync(join(f.sessionsRoot, "sess_other", "notes.md"), leak);

  const files = f.turn("in_1");
  for (const path of [decisions, shot, ...internal, leak])
    await files.recordToolWrite({ path, op: "created", agent: "agent_3" });
  const references = await files.finish(
    [
      "The decision doc is `.foundry/attachments/decisions.md`.",
      "Not shown: `.foundry/workspace.json`, `.foundry/sessions/sess_other/notes.md`.",
    ].join("\n"),
  );

  assert.deepEqual(
    f.ledger().map((entry) => [entry.workspacePath, entry.origin, entry.op]),
    [
      [".foundry/attachments/decisions.md", "tool", "created"],
      [".foundry/attachments/20261011/after.png", "tool", "created"],
    ],
  );
  const recorded = f.events.map((event) => event.metadata.sessionFile);
  assert.deepEqual(
    recorded.map((file) => [file.workspacePath, file.agent, file.inGitRepo]),
    [
      // Attachments are Foundry's, never part of the work tree: Files.
      [".foundry/attachments/decisions.md", "agent_3", false],
      [".foundry/attachments/20261011/after.png", "agent_3", false],
    ],
  );
  assert.deepEqual(references, [
    {
      text: ".foundry/attachments/decisions.md",
      path: decisions,
      kind: "file",
    },
  ]);
  assert.equal(f.read(decisions).content, "# Decisions\n");
  assert.equal(f.read(shot).kind, "image");

  assert.equal(privateDevicePath(decisions, f.home, f.workspace), false);
  assert.equal(privateDevicePath(attachments, f.home, f.workspace), false);
  for (const path of [
    ...internal,
    join(attachments, "..", "workspace.json"),
    join(attachments, ".env"),
  ])
    assert.ok(privateDevicePath(resolve(path), f.home, f.workspace), path);
});

test("a file named before it exists links as pending and opens once written", async (t) => {
  const f = fixture(t);
  await gitWorkspace(f.workspace);
  const attachments = join(f.workspace, ".foundry", "attachments");
  mkdirSync(attachments, { recursive: true });
  mkdirSync(join(f.workspace, "docs"));
  const design = join(attachments, "design.md");
  const later = join(f.workspace, "docs", "later.md");
  const swapped = join(f.workspace, "docs", "swapped.md");
  const gone = join(f.workspace, "docs", "gone.md");
  writeFileSync(gone, "old\n");
  const first = f.turn("in_0");
  await first.recordToolWrite({ path: gone, op: "created", agent: "main" });
  await first.finish("");
  unlinkSync(gone);
  f.events.length = 0;

  // The answer ends while a background subagent still writes the doc.
  const files = f.turn("in_1");
  const references = await files.finish(
    [
      "The design will be at `.foundry/attachments/design.md`; see also",
      "[the follow-up](docs/later.md) and `docs/swapped.md`.",
      "Not linked: `docs/gone.md` (removed), `notes.md` (a name, not a",
      "location), `nowhere/else.md` (no such folder), `docs/drafts`",
      "(no extension) and `.foundry/sessions/sess_files/next.md`.",
    ].join("\n"),
  );
  assert.deepEqual(references, [
    {
      text: ".foundry/attachments/design.md",
      path: design,
      kind: "file",
      pending: true,
    },
    { text: "docs/later.md", path: later, kind: "file", pending: true },
    { text: "docs/swapped.md", path: swapped, kind: "file", pending: true },
  ]);
  // Not an output yet: nothing is reported, the ledger keeps the names.
  assert.deepEqual(f.events, []);
  assert.deepEqual(
    f
      .ledger()
      .filter((entry) => entry.pending)
      .map((entry) => [entry.workspacePath, entry.origin, entry.inputIds]),
    [
      [".foundry/attachments/design.md", "reference", ["in_1"]],
      ["docs/later.md", "reference", ["in_1"]],
      ["docs/swapped.md", "reference", ["in_1"]],
    ],
  );
  assert.equal(f.read(design).kind, "missing");

  // The subagent's write after the turn: recorded, no longer pending.
  writeFileSync(design, "# Design\n");
  const between = f.turn("in_1");
  await between.recordToolWrite({
    path: design,
    op: "created",
    agent: "agent_9",
  });
  await between.finish("");
  const entry = f.ledger().find((file) => file.path === design);
  assert.equal(entry.pending, undefined);
  assert.equal(entry.origin, "tool");
  assert.equal(entry.op, "created");
  assert.deepEqual(
    f.events.map((event) => [
      event.label,
      event.metadata.sessionFile.workspacePath,
      event.metadata.sessionFile.origin,
      event.metadata.sessionFile.inGitRepo,
    ]),
    [["Recorded file", ".foundry/attachments/design.md", "tool", false]],
  );
  assert.equal(f.read(design).content, "# Design\n");

  // Written some other way (a shell command): a read still finds it.
  writeFileSync(later, "# Later\n");
  const read = f.read(later);
  assert.equal(read.content, "# Later\n");
  assert.equal(read.origin, "reference");
  assert.equal(read.insideWorkspace, true);
  // A name that now leads somewhere else is refused.
  writeFileSync(join(f.home, "secret.md"), "secret\n");
  symlinkSync(join(f.home, "secret.md"), swapped);
  assert.throws(() => f.read(swapped), /resolves somewhere else/);

  // Named again once it exists: an ordinary reference, now reported.
  f.events.length = 0;
  const next = await f.turn("in_2").finish("Done: `docs/later.md`.");
  assert.deepEqual(next, [
    { text: "docs/later.md", path: later, kind: "file" },
  ]);
  assert.equal(
    f.ledger().find((file) => file.path === later).pending,
    undefined,
  );
  assert.deepEqual(
    f.events.map((event) => event.metadata.sessionFile.op),
    ["referenced"],
  );
});

test("a pending name outside the workspace must be in a temporary folder", (t) => {
  const f = fixture(t);
  const reports = join(f.outside, "reports");
  mkdirSync(reports);
  const resolveIn = (allowedRoots) =>
    resolveFileReferences({
      answer: `The report will be \`${reports}/q3.md\`.`,
      workspacePath: f.workspace,
      recorded: [],
      turnStartedAt: Date.now(),
      allowedRoots,
      home: f.home,
    }).map(({ path, pending, insideWorkspace }) => ({
      path,
      pending,
      insideWorkspace,
    }));
  assert.deepEqual(resolveIn([f.outside]), [
    { path: join(reports, "q3.md"), pending: true, insideWorkspace: false },
  ]);
  assert.deepEqual(resolveIn([]), []);
});

test("a temporary root, the workspace or home is never a folder reference", (t) => {
  const f = fixture(t);
  const reports = join(f.outside, "reports");
  mkdirSync(reports);
  const report = join(reports, "q3.md");
  writeFileSync(report, "# Q3\n");
  writeFileSync(join(f.workspace, "plan.md"), "# Plan\n");
  const references = resolveFileReferences({
    // Seen live: "/tmp" alone, its recorded files inside, became a folder.
    answer: [
      `Scratch lives in \`${f.root}\`, \`${f.outside}\`, \`${f.home}\` and \`${f.workspace}\`.`,
      "",
      `The report is in \`${reports}/\`.`,
    ].join("\n"),
    workspacePath: f.workspace,
    recorded: [
      { path: report, origin: "tool" },
      { path: join(f.workspace, "plan.md"), origin: "tool" },
      { path: join(f.home, "notes.md"), origin: "tool" },
    ],
    turnStartedAt: Date.now(),
    allowedRoots: [f.outside],
    home: f.home,
  });
  assert.deepEqual(
    references.map(({ path, kind }) => ({ path, kind })),
    [{ path: reports, kind: "dir" }],
  );
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

test("a recorded file is named by its absolute or its workspace path", async (t) => {
  const f = fixture(t);
  await gitWorkspace(f.workspace);
  const calc = join(f.workspace, "calc.py");
  const files = f.turn("in_1");
  await claudeWrite(files, calc, "def add(a, b):\n    return a + b\n");
  await files.finish("Wrote calc.py.");

  for (const path of [calc, "calc.py", "./calc.py"]) {
    const diff = await diffOf(f, path);
    assert.equal(diff.path, calc, path);
    assert.equal(diff.after, "def add(a, b):\n    return a + b\n", path);
    assert.equal(f.read(path).path, calc, path);
  }
  await assert.rejects(
    diffOf(f, "README.md"),
    /not one this chat's tools wrote/,
  );
  await assert.rejects(
    diffOf(f, "../calc.py"),
    /not one this chat's tools wrote/,
  );
});

test("a workspace path two recorded files share names neither", () => {
  const entry = (path, workspacePath) => ({
    path,
    workspacePath,
    origin: "tool",
    op: "modified",
    inGitRepo: false,
    inputIds: ["in_1"],
    agent: "main",
    realpath: path,
  });
  const files = [
    entry("/w/link/calc.py", "calc.py"),
    entry("/w/calc.py", "calc.py"),
  ];
  assert.equal(sessionFileEntry(files, "/w", "/w/calc.py"), files[1]);
  assert.throws(
    () => sessionFileEntry(files, "/w", "calc.py"),
    /names more than one file/,
  );
  assert.equal(sessionFileEntry(files, "/w", "other.py"), undefined);
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

test("a Codex snapshot works while Foundry's session folders are git-ignored", async (t) => {
  // The worker lists `.foundry/sessions/` in info/exclude; git 2.39 then
  // refused an exclude pathspec for the session folder inside it.
  const f = fixture(t);
  await gitWorkspace(f.workspace);
  writeFileSync(join(f.workspace, "notes.txt"), "alpha\nbeta\n");
  // A repository may track files under .foundry/ (earlier workers committed
  // some); the snapshot starts from a copy of that index.
  mkdirSync(join(f.workspace, ".foundry"), { recursive: true });
  writeFileSync(join(f.workspace, ".foundry", "skills.yaml"), "skills: []\n");
  await git(f.workspace, ["add", ".foundry/skills.yaml"]);
  // An earlier turn's records already sit in the ignored session folder.
  const earlier = join(f.sessionsRoot, "sess_earlier", "inputs", "in_0");
  mkdirSync(earlier, { recursive: true });
  writeFileSync(join(earlier, "changes.json"), "{}\n");
  const exclude = join(f.workspace, ".git", "info", "exclude");
  mkdirSync(join(f.workspace, ".git", "info"), { recursive: true });
  appendFileSync(exclude, "/.foundry/sessions/\n");
  const files = f.turn("in_1");
  await files.snapshotWorkTree();
  writeFileSync(join(f.workspace, "notes.txt"), "alpha\nBETA\n");
  for (const write of codexFileWrites({
    type: "item.completed",
    item: {
      type: "file_change",
      status: "completed",
      changes: [{ path: join(f.workspace, "notes.txt"), kind: "update" }],
    },
  }))
    await files.recordToolWrite(write);
  await files.finish("");
  const notes = await diffOf(f, join(f.workspace, "notes.txt"), "in_1");
  assert.equal(notes.source, "git-snapshot");
  assert.equal(notes.before, "alpha\nbeta\n");
  assert.equal(notes.after, "alpha\nBETA\n");
  assert.deepEqual([notes.added, notes.removed], [1, 1]);
});

async function codexTurnWrites(files, paths) {
  for (const write of codexFileWrites({
    type: "item.completed",
    item: {
      type: "file_change",
      status: "completed",
      changes: paths.map((path) => ({ path, kind: "update" })),
    },
  }))
    await files.recordToolWrite(write);
}

test("a Codex snapshot covers only the workspace inside a larger repository", async (t) => {
  // byte-dev: the workspace is a folder of a repository with no commits and
  // gigabytes of untracked siblings, reached through a symlinked home.
  const root = mkdtempSync(join(tmpdir(), "foundry-snapshot-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "data", "ccm");
  const real = join(repo, "projects", "omh");
  mkdirSync(real, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  symlinkSync(join(root, "data"), join(root, "home"));
  const workspace = join(root, "home", "ccm", "projects", "omh");
  const sibling = join(repo, "projects", "other");
  mkdirSync(sibling);
  writeFileSync(join(sibling, "big.txt"), "sibling\n");
  writeFileSync(join(real, "plan.md"), "one\n");
  // A nested worktree is its own repository: recorded, never entered.
  const nested = join(real, ".worktrees", "feature");
  mkdirSync(nested, { recursive: true });
  await git(nested, ["init", "-b", "main"]);
  writeFileSync(join(nested, "code.txt"), "nested\n");
  await git(nested, ["add", "."]);
  await git(nested, ["commit", "-m", "init"], { env: commitIdentity });

  const sessionsRoot = join(workspace, ".foundry", "sessions");
  const f = { workspace, sessionsRoot, home: join(root, "user-home") };
  const turn = (inputId) =>
    new SessionTurnFiles({
      workspacePath: workspace,
      sessionsRoot,
      sessionId,
      inputId,
      startedAt: Date.now(),
      home: f.home,
      emit: async () => {},
    });
  const files = turn("in_1");
  await files.snapshotWorkTree();
  const manifest = JSON.parse(
    readFileSync(
      join(sessionsRoot, sessionId, "inputs", "in_1", "changes.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.source, "git-snapshot");
  assert.equal(manifest.gitSnapshot.scope.prefix, "projects/omh/");
  const listed = await git(repo, [
    "ls-tree",
    "-r",
    "--name-only",
    manifest.gitSnapshot.tree,
  ]);
  assert.deepEqual(listed.split("\n").sort(), [
    "projects/omh/.worktrees/feature",
    "projects/omh/plan.md",
  ]);
  assert.equal(
    existsSync(join(sessionsRoot, sessionId, "git-snapshot.index")),
    true,
    "the index is kept for the next turn",
  );

  writeFileSync(join(real, "plan.md"), "one\ntwo\n");
  writeFileSync(join(nested, "code.txt"), "nested\nedited\n");
  writeFileSync(join(sibling, "big.txt"), "sibling\nedited\n");
  await codexTurnWrites(files, [
    join(workspace, "plan.md"),
    join(workspace, ".worktrees", "feature", "code.txt"),
    join(sibling, "big.txt"),
  ]);
  await files.finish("");
  const plan = await diffOf(f, join(workspace, "plan.md"), "in_1");
  assert.deepEqual([plan.before, plan.after], ["one\n", "one\ntwo\n"]);
  // Not "new": the nested repository and the sibling have no "before".
  for (const path of [
    join(workspace, ".worktrees", "feature", "code.txt"),
    join(sibling, "big.txt"),
  ])
    assert.equal((await diffOf(f, path, "in_1")).unavailable, "noBaseline");

  // The next turn starts from the kept index and sees the new state.
  const second = turn("in_2");
  await second.snapshotWorkTree();
  writeFileSync(join(real, "plan.md"), "one\ntwo\nthree\n");
  await codexTurnWrites(second, [join(workspace, "plan.md")]);
  await second.finish("");
  const next = await diffOf(f, join(workspace, "plan.md"), "in_2");
  assert.deepEqual(
    [next.before, next.after],
    ["one\ntwo\n", "one\ntwo\nthree\n"],
  );
});

test("an unreadable file does not cost the Codex snapshot", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads every file");
  const f = fixture(t);
  await gitWorkspace(f.workspace);
  const locked = join(f.workspace, "locked.bin");
  writeFileSync(locked, "secret\n");
  chmodSync(locked, 0o000);
  const files = f.turn("in_1");
  await files.snapshotWorkTree();
  writeFileSync(join(f.workspace, "README.md"), "hi\nedited\n");
  await codexTurnWrites(files, [join(f.workspace, "README.md")]);
  await files.finish("");
  const readme = await diffOf(f, join(f.workspace, "README.md"), "in_1");
  assert.equal(readme.source, "git-snapshot");
  assert.deepEqual([readme.before, readme.after], ["hi\n", "hi\nedited\n"]);
});

test("a session whose snapshot ran out of time takes no more", async (t) => {
  const f = fixture(t);
  await gitWorkspace(f.workspace);
  mkdirSync(join(f.sessionsRoot, sessionId), { recursive: true });
  writeFileSync(join(f.sessionsRoot, sessionId, "git-snapshot.skipped"), "\n");
  const files = f.turn("in_1");
  await files.snapshotWorkTree();
  assert.equal(
    existsSync(
      join(f.sessionsRoot, sessionId, "inputs", "in_1", "changes.json"),
    ),
    false,
  );
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
