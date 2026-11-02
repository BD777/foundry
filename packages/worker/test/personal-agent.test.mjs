import "./fixtures/native-test-homes.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceFolder } from "../dist/workspace/workspace-registration.js";
import {
  managedRoots,
  readPersonalAgentSettings,
} from "../dist/workspace/personal-agent-settings.js";
import { buildClaudeLaunchPlan } from "../dist/session/session-launch-options.js";
import { activeRuntimeKey } from "../dist/session/runner/active-runtimes.js";
import {
  forgetPersonalAgentFiles,
  personalAgentFilesRevision,
  writePersonalAgentFiles,
} from "../dist/session/personal-agent-files.js";
import { commitIdentity, git } from "../dist/candidate-store/execution-git.js";
import { daemonDeviceRegistration } from "../dist/daemon/workspace-ops.js";

function scratch(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "foundry-pa-test-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("managed roots default to ~/Foundry, expand ~ and honour an empty list", (t) => {
  const dir = scratch(t);
  const home = join(dir, "home");
  const settings = join(dir, "personal-agent.json");
  assert.deepEqual(readPersonalAgentSettings(settings).managedRoots, [
    "~/Foundry",
  ]);
  assert.deepEqual(managedRoots(readPersonalAgentSettings(settings), home), [
    join(home, "Foundry"),
  ]);
  writeFileSync(
    settings,
    JSON.stringify({
      managedRoots: ["~/Projects", "relative/path", 7, "~/Projects", dir],
    }),
  );
  assert.deepEqual(managedRoots(readPersonalAgentSettings(settings), home), [
    join(home, "Projects"),
    dir,
  ]);
  writeFileSync(settings, JSON.stringify({ managedRoots: [] }));
  assert.deepEqual(managedRoots(readPersonalAgentSettings(settings), home), []);
});

test("the device reports its resolved managed roots", () => {
  const registration = daemonDeviceRegistration();
  assert.ok(Array.isArray(registration.device.managedRoots));
});

test("an empty project folder is created, with Git, only inside a managed root", async (t) => {
  const dir = scratch(t);
  const root = join(dir, "Foundry");
  const target = join(root, "notes", "garden");
  const created = await createWorkspaceFolder(
    target,
    { kind: "empty", gitInit: true },
    [root],
  );
  assert.equal(created, target);
  assert.ok(existsSync(join(target, ".git")));
});

test("a clone lands inside the managed root", async (t) => {
  const dir = scratch(t);
  const source = join(dir, "source");
  mkdirSync(source);
  await git(source, ["init", "-b", "main"]);
  writeFileSync(join(source, "README.md"), "hello\n");
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "first"], { env: commitIdentity });
  const root = join(dir, "Foundry");
  const target = join(root, "copy");
  await createWorkspaceFolder(
    target,
    { kind: "clone", url: source, gitInit: false },
    [root],
  );
  assert.equal(readFileSync(join(target, "README.md"), "utf8"), "hello\n");
});

test("paths outside the managed roots, the root itself and relative paths are refused", async (t) => {
  const dir = scratch(t);
  const root = join(dir, "Foundry");
  mkdirSync(root);
  for (const path of [
    join(dir, "elsewhere"),
    join(root, "..", "sibling"),
    root,
  ]) {
    await assert.rejects(
      createWorkspaceFolder(path, { kind: "empty", gitInit: false }, [root]),
      /not inside one|already exists/,
    );
  }
  await assert.rejects(
    createWorkspaceFolder(
      join(dir, "elsewhere"),
      { kind: "empty", gitInit: false },
      [root],
    ),
    /not inside one/,
  );
  assert.equal(existsSync(join(dir, "elsewhere")), false);
  assert.equal(existsSync(join(dir, "sibling")), false);
  await assert.rejects(
    createWorkspaceFolder("Foundry/new", { kind: "empty", gitInit: false }, [
      root,
    ]),
    /absolute folder path/,
  );
  await assert.rejects(
    createWorkspaceFolder(
      join(root, "new"),
      { kind: "empty", gitInit: false },
      [],
    ),
    /does not let the assistant create projects/,
  );
});

test("an existing target is never taken over", async (t) => {
  const dir = scratch(t);
  const root = join(dir, "Foundry");
  const existing = join(root, "mine");
  mkdirSync(existing, { recursive: true });
  writeFileSync(join(existing, "keep.txt"), "mine");
  await assert.rejects(
    createWorkspaceFolder(existing, { kind: "empty", gitInit: true }, [root]),
    /already exists/,
  );
  await assert.rejects(
    createWorkspaceFolder(
      existing,
      { kind: "clone", url: "https://example.invalid/r.git", gitInit: false },
      [root],
    ),
    /already exists/,
  );
  assert.equal(existsSync(join(existing, ".git")), false);
  assert.equal(readFileSync(join(existing, "keep.txt"), "utf8"), "mine");
  // A link inside the root to another folder inside it is taken too.
  symlinkSync(existing, join(root, "alias"));
  await assert.rejects(
    createWorkspaceFolder(
      join(root, "alias"),
      { kind: "empty", gitInit: false },
      [root],
    ),
    /already exists/,
  );
});

test("a new empty folder gets create's files, in subfolders, mode 0644", async (t) => {
  const dir = scratch(t);
  const root = join(dir, "Foundry");
  const target = join(root, "Assistant");
  await createWorkspaceFolder(
    target,
    {
      kind: "empty",
      gitInit: true,
      files: [
        { path: "AGENTS.md", content: "# Assistant\n你好\n" },
        { path: "notes/README.md", content: "notes\n" },
      ],
    },
    [root],
  );
  assert.equal(
    readFileSync(join(target, "AGENTS.md"), "utf8"),
    "# Assistant\n你好\n",
  );
  assert.equal(
    readFileSync(join(target, "notes/README.md"), "utf8"),
    "notes\n",
  );
  assert.equal(statSync(join(target, "AGENTS.md")).mode & 0o777, 0o644);
  assert.ok(existsSync(join(target, ".git")));
});

test("create's files never leave the folder, overwrite or come with a clone", async (t) => {
  const dir = scratch(t);
  const root = join(dir, "Foundry");
  for (const path of [
    "",
    "/etc/AGENTS.md",
    join(dir, "outside.md"),
    "../outside.md",
    "notes/../../outside.md",
    "./AGENTS.md",
    "notes//a.md",
    "notes/",
    "a\0b",
    "notes\\a.md",
    "C:/a.md",
    ".git/hooks/post-checkout",
    ".GIT/config",
  ]) {
    const target = join(root, "refused");
    await assert.rejects(
      createWorkspaceFolder(
        target,
        { kind: "empty", gitInit: true, files: [{ path, content: "x" }] },
        [root],
      ),
      /relative path inside it/,
      JSON.stringify(path),
    );
    assert.equal(
      existsSync(target),
      false,
      `${JSON.stringify(path)} made nothing`,
    );
  }
  assert.equal(existsSync(join(dir, "outside.md")), false);
  // A file named twice is not written over; nothing is left behind.
  const twice = join(root, "twice");
  await assert.rejects(
    createWorkspaceFolder(
      twice,
      {
        kind: "empty",
        gitInit: false,
        files: [
          { path: "AGENTS.md", content: "first" },
          { path: "AGENTS.md", content: "second" },
        ],
      },
      [root],
    ),
    /EEXIST/,
  );
  assert.equal(existsSync(twice), false);
  await assert.rejects(
    createWorkspaceFolder(
      join(root, "copy"),
      {
        kind: "clone",
        url: "https://example.invalid/r.git",
        gitInit: false,
        files: [{ path: "AGENTS.md", content: "x" }],
      },
      [root],
    ),
    /Only a new empty project folder takes files/,
  );
  assert.equal(existsSync(join(root, "copy")), false);
});

test("a symbolic link inside the root cannot lead the new folder out", async (t) => {
  const dir = scratch(t);
  const root = join(dir, "Foundry");
  const outside = join(dir, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  symlinkSync(outside, join(root, "escape"));
  await assert.rejects(
    createWorkspaceFolder(
      join(root, "escape", "project"),
      { kind: "empty", gitInit: false },
      [root],
    ),
    /not inside one/,
  );
  await assert.rejects(
    createWorkspaceFolder(
      join(root, "escape", "deeper", "project"),
      { kind: "empty", gitInit: false },
      [root],
    ),
    /not inside one/,
  );
  // A dangling link is refused as well, never followed.
  symlinkSync(join(outside, "planned"), join(root, "dangling"));
  await assert.rejects(
    createWorkspaceFolder(
      join(root, "dangling"),
      { kind: "empty", gitInit: false },
      [root],
    ),
    /not inside one|already exists/,
  );
  assert.equal(existsSync(join(outside, "project")), false);
  assert.equal(existsSync(join(outside, "deeper")), false);
  assert.equal(existsSync(join(outside, "planned")), false);
});

const files = [
  {
    path: "AGENTS.md",
    content: "You are Mo, the personal assistant of Ada inside Foundry.\n",
  },
  { path: ".foundry/assistant-examples.md", content: "# Examples\n" },
];
const claudeProfile = {
  id: "claude_native",
  runtime: "claude",
  label: "claude login",
  connectionType: "local_login",
};

test("the assistant's instructions are its folder's AGENTS.md, not an appended prompt", (t) => {
  const dir = scratch(t);
  const session = {
    id: "sess_pa_1",
    prompt: "hello",
    workspaceId: "ws_pa",
    role: "personal_agent",
  };
  t.after(() => forgetPersonalAgentFiles("ws_pa"));
  writePersonalAgentFiles(session, dir, files);
  assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), files[0].content);
  assert.equal(
    readFileSync(join(dir, ".foundry", "assistant-examples.md"), "utf8"),
    files[1].content,
  );
  const plan = buildClaudeLaunchPlan({
    workspacePath: dir,
    session,
    profile: claudeProfile,
  });
  assert.equal(plan.sdk.systemPrompt, undefined);
  // Only the files Foundry writes there; never outside the folder.
  assert.throws(
    () =>
      writePersonalAgentFiles(session, dir, [
        { path: "../escape.md", content: "x" },
      ]),
    /does not write/,
  );
});

// A timer's turn or a continuation may start a new runtime in a run that
// carries no files: it keeps the last revision, so the same runtime key.
test("new instructions change the runtime key; a run without them keeps it", (t) => {
  const dir = scratch(t);
  const session = {
    id: "sess_pa_2",
    prompt: "hello",
    workspaceId: "ws_pa2",
    role: "personal_agent",
  };
  t.after(() => forgetPersonalAgentFiles("ws_pa2"));
  const key = () => activeRuntimeKey("claude", dir, session, claudeProfile, {});
  writePersonalAgentFiles(session, dir, files);
  const first = key();
  writePersonalAgentFiles(session, dir, undefined);
  writePersonalAgentFiles(session, dir, []);
  assert.equal(key(), first);
  writePersonalAgentFiles(session, dir, [
    { path: "AGENTS.md", content: "You are Mo. Today is Friday.\n" },
  ]);
  assert.notEqual(key(), first);
  // Another workspace's forgetting leaves it; its own drops it.
  forgetPersonalAgentFiles("ws_other");
  assert.ok(personalAgentFilesRevision(session.id));
  forgetPersonalAgentFiles("ws_pa2");
  assert.equal(personalAgentFilesRevision(session.id), undefined);
});

test("only a personal_agent session takes the assistant's files", (t) => {
  const dir = scratch(t);
  const chat = { id: "sess_chat_1", prompt: "hi", workspaceId: "ws_1" };
  writePersonalAgentFiles(chat, dir, files);
  assert.equal(existsSync(join(dir, "AGENTS.md")), false);
  assert.equal(personalAgentFilesRevision(chat.id), undefined);
});
