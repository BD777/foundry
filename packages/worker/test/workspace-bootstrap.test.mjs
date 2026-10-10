import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { ExecutionStore } from "../dist/execution-storage.js";
import {
  initializeWorkspaceGit,
  registerExecutionWorkspace,
  workspaceGitState,
} from "../dist/repository-registry.js";
import { issueEnvironmentAction } from "../dist/issue-environment-rpc.js";
import {
  prepareIssueEnvironment,
  ensureRepository,
  snapshotEnvironment,
} from "../dist/issue-environments.js";
import {
  prepareAcceptance,
  applyAcceptance,
} from "../dist/workspace-acceptance.js";
import { excludeFoundryRuntimeFromGit, git } from "../dist/execution-git.js";
import { writeJSON } from "../dist/storage.js";

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), "foundry-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = resolve(root, "source");
  mkdirSync(source);
  return { source, root, store: new ExecutionStore(resolve(root, "state")) };
}

test("uninitialized submodules in unrelated repositories do not block root workspace initialization", async (t) => {
  const { source, store } = fixture(t);
  writeFileSync(resolve(source, "notes.md"), "Root workspace asset");
  const project = resolve(source, "projects/large-project");
  mkdirSync(project, { recursive: true });
  await git(project, ["init", "-b", "main"]);
  await git(project, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "baseline",
  ]);
  const baseline = await git(project, ["rev-parse", "HEAD"]);
  await git(project, [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${baseline},vendor/uninitialized`,
  ]);
  await git(project, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "uninitialized dependency",
  ]);
  const registration = await initializeWorkspaceGit(
    source,
    "ws_optional",
    store,
  );
  assert.deepEqual(registration.errors, []);
  const dependency = registration.repositories.find(
    (repo) => repo.kind === "submodule",
  );
  assert.equal(dependency.status, "unavailable");
  assert.match(dependency.error, /Submodule is not initialized/);
  const environment = await prepareIssueEnvironment(
    source,
    "ws_optional",
    "iss_root",
    store,
  );
  assert.equal(
    readFileSync(resolve(environment.cwd, "notes.md"), "utf8"),
    "Root workspace asset",
  );
  assert.equal(environment.repositories.length, 1);
  await assert.rejects(
    ensureRepository("ws_optional", "iss_root", dependency.id, store),
    /Submodule is not initialized/,
  );
  assert.equal(
    store.environment("ws_optional", "iss_root").repositories.length,
    1,
  );
  assert.equal(
    (await git(source, ["ls-files"])).includes("projects/large-project"),
    false,
  );
});

test("arbitrary Workspace assets enter candidate and accept without untracked blockers", async (t) => {
  const { source, root, store } = fixture(t);
  for (const name of ["Docs", "Rules", "knowledge", "some/deep/project"]) {
    mkdirSync(resolve(source, name), { recursive: true });
    writeFileSync(resolve(source, name, "asset.txt"), name);
  }
  writeFileSync(resolve(source, ".gitignore"), "user-cache/\n");
  mkdirSync(resolve(source, "user-cache"));
  writeFileSync(resolve(source, "user-cache/tmp"), "ignore");
  writeFileSync(resolve(source, ".env"), "TOKEN=private");
  writeFileSync(resolve(root, "outside"), "outside");
  symlinkSync(resolve(root, "outside"), resolve(source, "outside-link"));
  const registration = await initializeWorkspaceGit(source, "ws_assets", store);
  assert.ok(registration.content.tracked.includes("knowledge/asset.txt"));
  assert.deepEqual(registration.content.untracked, []);
  assert.ok(registration.content.ignored.includes(".env"));
  // The person's own .gitignore is left exactly as it was.
  assert.equal(
    readFileSync(resolve(source, ".gitignore"), "utf8"),
    "user-cache/\n",
  );
  let env = await prepareIssueEnvironment(
    source,
    "ws_assets",
    "iss_assets",
    store,
  );
  for (const name of ["Docs", "Rules", "knowledge", "some/deep/project"])
    assert.equal(
      readFileSync(resolve(env.cwd, name, "asset.txt"), "utf8"),
      name,
    );
  assert.equal(existsSync(resolve(env.cwd, ".env")), false);
  writeFileSync(resolve(env.cwd, "knowledge/asset.txt"), "learned");
  env = await snapshotEnvironment(env, store);
  const acceptance = await prepareAcceptance(
    "ws_assets",
    "iss_assets",
    env.revision,
    store,
  );
  assert.equal(acceptance.status, "prepared", acceptance.error);
  await applyAcceptance(
    "ws_assets",
    "iss_assets",
    acceptance.id,
    env.revision,
    store,
  );
  assert.equal(
    readFileSync(resolve(source, "knowledge/asset.txt"), "utf8"),
    "learned",
  );
});

test("an empty Git root gets one recoverable baseline and retains its branch name", async (t) => {
  const { source, store } = fixture(t);
  await git(source, ["init", "-b", "existing"]);
  writeFileSync(resolve(source, "notes.txt"), "notes");
  const first = await initializeWorkspaceGit(source, "ws_empty", store);
  const head = await git(source, ["rev-parse", "HEAD"]);
  await initializeWorkspaceGit(source, "ws_empty", store);
  assert.equal(await git(source, ["rev-parse", "HEAD"]), head);
  assert.equal(first.repositories[0].baseline, "refs/heads/existing");
  assert.equal(existsSync(resolve(source, ".gitignore")), false);
  assert.equal(
    (
      readFileSync(resolve(source, ".git/info/exclude"), "utf8").match(
        /BEGIN Foundry/g,
      ) || []
    ).length,
    1,
  );
});

test("an existing user index is preserved and missing assets are visible", async (t) => {
  const { source, store } = fixture(t);
  await git(source, ["init", "-b", "main"]);
  writeFileSync(resolve(source, "draft.txt"), "user staged");
  await git(source, ["add", "draft.txt"]);
  const before = await git(source, ["ls-files", "--stage"]);
  await assert.rejects(
    initializeWorkspaceGit(source, "ws_staged", store),
    /user-staged/,
  );
  assert.equal(await git(source, ["ls-files", "--stage"]), before);
  await git(source, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "User baseline",
  ]);
  writeFileSync(resolve(source, "untracked.txt"), "visible gap");
  const registration = await registerExecutionWorkspace(
    source,
    "ws_staged",
    store,
  );
  assert.ok(registration.content.untracked.includes("untracked.txt"));
  assert.equal(await git(source, ["ls-files", "--stage"]), before);
});

test("initialization resumes its own staged journal after interruption", async (t) => {
  const { source, store } = fixture(t);
  await git(source, ["init", "-b", "main"]);
  writeFileSync(resolve(source, "notes.txt"), "before interruption");
  await git(source, ["add", "notes.txt"]);
  writeJSON(resolve(store.metadata("ws_resume"), "bootstrap.json"), {
    version: 1,
    status: "staging",
    files: ["notes.txt"],
    excluded: [],
  });
  const registration = await initializeWorkspaceGit(source, "ws_resume", store);
  assert.equal(registration.repositories[0].status, "ready");
  assert.ok(registration.content.tracked.includes("notes.txt"));
  assert.equal(
    JSON.parse(
      readFileSync(
        resolve(store.metadata("ws_resume"), "bootstrap.json"),
        "utf8",
      ),
    ).status,
    "complete",
  );
});

test("a workspace excluding every file still obtains a valid empty-content baseline", async (t) => {
  const { source, store } = fixture(t);
  writeFileSync(resolve(source, ".gitignore"), "*\n");
  writeFileSync(resolve(source, "excluded.txt"), "not selected");
  const registration = await initializeWorkspaceGit(
    source,
    "ws_ignored",
    store,
  );
  assert.equal(registration.repositories[0].status, "ready");
  assert.deepEqual(registration.content.tracked, []);
  assert.equal(readFileSync(resolve(source, ".gitignore"), "utf8"), "*\n");
});

test("registering a committed workspace again changes none of its tracked files", async (t) => {
  const { source } = fixture(t);
  const { initWorkspace } = await import("../dist/workspaces.js");
  const previous = process.env.FOUNDRY_STATE_ROOT;
  process.env.FOUNDRY_STATE_ROOT = resolve(source, "..", "registry-state");
  t.after(() => {
    if (previous === undefined) delete process.env.FOUNDRY_STATE_ROOT;
    else process.env.FOUNDRY_STATE_ROOT = previous;
  });
  await git(source, ["init", "-b", "main"]);
  initWorkspace(source);
  // A repository that commits everything Foundry wrote, including .foundry/.
  await git(source, ["add", "-A", "-f"]);
  await git(source, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "workspace",
  ]);
  await new Promise((done) => setTimeout(done, 10));
  initWorkspace(source);
  assert.equal(
    await git(source, ["status", "--porcelain", "--untracked-files=no"]),
    "",
  );
});

/** An existing repository with one commit, then Foundry's init + registration. */
async function existingRepository(t) {
  const fx = fixture(t);
  const { initWorkspace, readWorkspace } =
    await import("../dist/workspaces.js");
  const previous = process.env.FOUNDRY_STATE_ROOT;
  process.env.FOUNDRY_STATE_ROOT = resolve(fx.root, "registry-state");
  t.after(() => {
    if (previous === undefined) delete process.env.FOUNDRY_STATE_ROOT;
    else process.env.FOUNDRY_STATE_ROOT = previous;
  });
  const commit = (message) =>
    git(fx.source, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      message,
    ]);
  await git(fx.source, ["init", "-b", "main"]);
  writeFileSync(resolve(fx.source, "README.md"), "# project\n");
  await git(fx.source, ["add", "README.md"]);
  await commit("project");
  const register = async () => {
    initWorkspace(fx.source);
    return registerExecutionWorkspace(
      fx.source,
      readWorkspace(fx.source).id,
      fx.store,
    );
  };
  const log = async () =>
    (await git(fx.source, ["log", "--format=%an|%s"])).split("\n");
  return { ...fx, register, log, commit };
}

/** Every path in a folder outside `.git`, relative and sorted. */
function filesIn(root, prefix = "") {
  const out = [];
  for (const entry of readdirSync(resolve(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (path === ".git") continue;
    if (entry.isDirectory()) out.push(...filesIn(root, path));
    else out.push(path);
  }
  return out.sort();
}

test("registering an existing repository writes only under .foundry/, commits nothing and leaves it clean", async (t) => {
  const { source, store, register, log } = await existingRepository(t);
  const head = await git(source, ["rev-parse", "HEAD"]);
  await register();
  assert.deepEqual(await log(), ["Test|project"]);
  assert.equal(await git(source, ["rev-parse", "HEAD"]), head);
  assert.deepEqual(
    filesIn(source).filter((path) => !path.startsWith(".foundry/")),
    ["README.md"],
  );
  for (const path of ["AGENTS.md", "CONTEXT.md", ".foundry/skills.yaml"])
    assert.equal(existsSync(resolve(source, path)), false, path);
  assert.equal(existsSync(resolve(source, ".gitignore")), false);
  assert.equal(
    await git(source, ["status", "--porcelain", "--untracked-files=all"]),
    "",
  );
  // Registering again changes nothing either.
  const { workspaceId } = await register();
  assert.deepEqual(await log(), ["Test|project"]);
  assert.equal(
    await git(source, ["status", "--porcelain", "--untracked-files=all"]),
    "",
  );
  // Nothing of Foundry's stands between the person and Accept.
  let env = await prepareIssueEnvironment(source, workspaceId, "iss_1", store);
  writeFileSync(resolve(env.cwd, "README.md"), "# project, improved\n");
  env = await snapshotEnvironment(env, store);
  const acceptance = await prepareAcceptance(
    workspaceId,
    "iss_1",
    env.revision,
    store,
  );
  assert.equal(acceptance.status, "prepared", acceptance.error);
  await applyAcceptance(
    workspaceId,
    "iss_1",
    acceptance.id,
    env.revision,
    store,
  );
  assert.equal(
    readFileSync(resolve(source, "README.md"), "utf8"),
    "# project, improved\n",
  );
});

test("registering leaves the person's own AGENTS.md and staged files exactly as they were", async (t) => {
  const { source, register, log } = await existingRepository(t);
  const instructions = "# my own instructions\n\n- keep it short\n";
  writeFileSync(resolve(source, "AGENTS.md"), instructions);
  writeFileSync(resolve(source, "staged.txt"), "mine\n");
  await git(source, ["add", "staged.txt"]);
  await register();
  assert.deepEqual(await log(), ["Test|project"]);
  assert.equal(
    readFileSync(resolve(source, "AGENTS.md"), "utf8"),
    instructions,
  );
  assert.equal(
    await git(source, ["status", "--porcelain", "--untracked-files=all"]),
    "A  staged.txt\n?? AGENTS.md",
  );
});

test("files an earlier worker left under .foundry/ stay untouched and out of the way", async (t) => {
  const { source, register, log } = await existingRepository(t);
  mkdirSync(resolve(source, ".foundry"));
  const legacy = {
    ".foundry/skills.yaml": "skills:\n  visual-qa:\n    version: 0.9.0\n",
    ".foundry/preview.example.json": "{}\n",
    ".foundry/agent-profiles.local.example.json": "{}\n",
  };
  for (const [path, contents] of Object.entries(legacy))
    writeFileSync(resolve(source, path), contents);
  await register();
  assert.deepEqual(await log(), ["Test|project"]);
  for (const [path, contents] of Object.entries(legacy))
    assert.equal(readFileSync(resolve(source, path), "utf8"), contents);
  assert.equal(
    await git(source, ["status", "--porcelain", "--untracked-files=all"]),
    "",
  );
  // A preview configuration the person writes is theirs to commit.
  writeFileSync(resolve(source, ".foundry/preview.json"), '{"command":"x"}\n');
  assert.equal(
    await git(source, ["status", "--porcelain", "--untracked-files=all"]),
    "?? .foundry/preview.json",
  );
});

test("a new workspace gets only Foundry's identity file, and its resources name the real Issue storage", async (t) => {
  const { source } = fixture(t);
  const { initWorkspace, readWorkspace } =
    await import("../dist/workspaces.js");
  const { assetsForWorkspace } = await import("../dist/workspace-ops.js");
  const state = resolve(source, "..", "resources-state");
  const previous = process.env.FOUNDRY_STATE_ROOT;
  process.env.FOUNDRY_STATE_ROOT = state;
  t.after(() => {
    if (previous === undefined) delete process.env.FOUNDRY_STATE_ROOT;
    else process.env.FOUNDRY_STATE_ROOT = previous;
  });
  initWorkspace(source);
  assert.deepEqual(filesIn(source), [".foundry/workspace.json"]);
  assert.deepEqual(readdirSync(resolve(source, ".foundry")), [
    "workspace.json",
  ]);

  const workspace = readWorkspace(source);
  const root = new ExecutionStore().workspaceRoot(workspace.id);
  const assets = assetsForWorkspace(workspace, source);
  const detail = (kind) => assets.find((asset) => asset.kind === kind).detail;
  assert.equal(detail("worktree_pool"), resolve(root, "environments"));
  assert.equal(detail("artifact_archive"), resolve(root, "evidence-store"));
  assert.ok(assets.every((asset) => !asset.detail.includes("assets.yaml")));
});

test("setting up Git for a large folder commits every file and never stalls the worker", async (t) => {
  const { source, store } = fixture(t);
  // 400 directories of 10 files: 4000 files, over the old 100-file batches.
  for (let d = 0; d < 400; d++) {
    const directory = resolve(source, `area-${d % 20}`, `part-${d}`);
    mkdirSync(directory, { recursive: true });
    for (let f = 0; f < 10; f++)
      writeFileSync(resolve(directory, `note ${f}.md`), `${d}-${f}`);
  }
  // The event loop keeps turning while the folder is walked and staged.
  let longestStall = 0;
  let last = performance.now();
  const ticker = setInterval(() => {
    const now = performance.now();
    longestStall = Math.max(longestStall, now - last);
    last = now;
  }, 10);
  try {
    const registration = await initializeWorkspaceGit(
      source,
      "ws_large",
      store,
    );
    assert.deepEqual(registration.errors, []);
  } finally {
    clearInterval(ticker);
  }
  const tracked = (await git(source, ["ls-files"])).split("\n");
  assert.ok(tracked.includes("area-3/part-23/note 7.md"));
  assert.equal(
    tracked.filter((path) => path.endsWith(".md") && path.startsWith("area-"))
      .length,
    4000,
  );
  assert.ok(
    longestStall < 1000,
    `the worker stalled for ${Math.round(longestStall)} ms`,
  );
});

test("Foundry's session files stay out of a fresh repository, its worktrees and nested workspaces, through local excludes only", async (t) => {
  const { root } = fixture(t);
  const repo = resolve(root, "fresh");
  mkdirSync(repo);
  assert.equal(
    await excludeFoundryRuntimeFromGit(repo),
    false,
    "not a repository yet: nothing to exclude",
  );
  await git(repo, ["init", "-q", "-b", "main"]);
  mkdirSync(resolve(repo, ".foundry/sessions/sess_1"), { recursive: true });
  writeFileSync(resolve(repo, ".foundry/sessions/sess_1/files.json"), "{}");
  writeFileSync(resolve(repo, ".foundry/workspace.json"), "{}\n");
  writeFileSync(resolve(repo, ".foundry/repositories.yaml"), "version: 1\n");
  writeFileSync(resolve(repo, ".foundry/skills.yaml"), "skills: []\n");
  writeFileSync(resolve(repo, ".foundry/preview.json"), "{}\n");
  assert.equal(await excludeFoundryRuntimeFromGit(repo), true);
  await excludeFoundryRuntimeFromGit(repo);
  const untracked = async (cwd) =>
    (await git(cwd, ["status", "--porcelain", "--untracked-files=all"]))
      .split("\n")
      .filter(Boolean);
  // Only the preview configuration a person writes stays visible.
  assert.deepEqual(await untracked(repo), ["?? .foundry/preview.json"]);
  assert.equal(existsSync(resolve(repo, ".gitignore")), false);
  const exclude = readFileSync(resolve(repo, ".git/info/exclude"), "utf8");
  for (const entry of ["/.foundry/*", "!/.foundry/preview.json"])
    assert.equal(
      exclude.split("\n").filter((line) => line === entry).length,
      1,
      `idempotent: ${entry}`,
    );

  // A workspace in a subfolder anchors its entries there.
  const nested = resolve(repo, "apps/site");
  mkdirSync(resolve(nested, ".foundry/sessions/sess_2"), { recursive: true });
  writeFileSync(resolve(nested, ".foundry/sessions/sess_2/files.json"), "{}");
  writeFileSync(resolve(nested, ".foundry/workspace.json"), "{}\n");
  await excludeFoundryRuntimeFromGit(nested);
  assert.deepEqual(await untracked(repo), ["?? .foundry/preview.json"]);

  // A linked worktree writes the repository's shared excludes.
  writeFileSync(resolve(repo, "README.md"), "hi\n");
  await git(repo, ["add", "README.md", ".foundry/preview.json"]);
  await git(repo, ["commit", "-q", "-m", "init"], {
    env: {
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@localhost",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@localhost",
    },
  });
  const worktree = resolve(root, "worktree");
  await git(repo, ["worktree", "add", "-q", "-b", "side", worktree]);
  mkdirSync(resolve(worktree, ".foundry/sessions/sess_3"), { recursive: true });
  writeFileSync(resolve(worktree, ".foundry/sessions/sess_3/files.json"), "{}");
  assert.equal(await excludeFoundryRuntimeFromGit(worktree), true);
  assert.deepEqual(await untracked(worktree), []);
});

/**
 * Every path under `root`, including `.git`, with its contents, except
 * Foundry's own `.foundry/` data and the repository's local excludes.
 */
function snapshotTree(root, prefix = "") {
  const out = {};
  for (const entry of readdirSync(resolve(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (path === ".foundry" || path === ".git/info/exclude") continue;
    if (entry.isDirectory()) Object.assign(out, snapshotTree(root, path));
    else out[path] = readFileSync(resolve(root, path), "utf8");
  }
  return out;
}

test("registering a folder without Git, or a repository without commits, leaves it as it is", async (t) => {
  const { root, store } = fixture(t);
  const plain = resolve(root, "plain");
  mkdirSync(plain);
  writeFileSync(resolve(plain, "notes.md"), "notes\n");
  writeFileSync(resolve(plain, ".gitignore"), "tmp/\n");
  const before = snapshotTree(plain);
  await registerExecutionWorkspace(plain, "ws_plain", store);
  assert.deepEqual(snapshotTree(plain), before);
  assert.equal(existsSync(resolve(plain, ".git")), false);
  assert.equal(await workspaceGitState(plain), "needs_git");

  const unborn = resolve(root, "unborn");
  mkdirSync(unborn);
  await git(unborn, ["init", "-q", "-b", "main"]);
  writeFileSync(resolve(unborn, "notes.md"), "notes\n");
  const unbornBefore = snapshotTree(unborn);
  await registerExecutionWorkspace(unborn, "ws_unborn", store);
  assert.deepEqual(snapshotTree(unborn), unbornBefore);
  assert.equal(
    await git(unborn, ["rev-parse", "--verify", "HEAD"], { optional: true }),
    "",
  );
  assert.equal(await workspaceGitState(unborn), "needs_git");

  // An Issue cannot be prepared there, and trying changes nothing.
  for (const [path, id] of [
    [plain, "ws_plain"],
    [unborn, "ws_unborn"],
  ]) {
    const state = snapshotTree(path);
    await assert.rejects(
      prepareIssueEnvironment(path, id, "iss_1", store),
      /Issues need Git/,
    );
    assert.deepEqual(snapshotTree(path), state);
  }
});

test("confirmed Git setup initializes, keeps Foundry's files out and commits the folder's files", async (t) => {
  const { source, store } = fixture(t);
  writeFileSync(resolve(source, "notes.md"), "notes\n");
  writeFileSync(resolve(source, ".gitignore"), "tmp/\n");
  mkdirSync(resolve(source, "tmp"));
  writeFileSync(resolve(source, "tmp/scratch.txt"), "ignored\n");
  writeFileSync(resolve(source, ".env"), "TOKEN=private\n");
  mkdirSync(resolve(source, ".foundry"));
  writeFileSync(resolve(source, ".foundry/workspace.json"), "{}\n");
  writeFileSync(resolve(source, ".foundry/preview.json"), '{"command":"x"}\n');
  const action = (name) =>
    issueEnvironmentAction(
      {
        action: name,
        workspaceId: "ws_setup",
        issueId: "",
        revision: 0,
        sourcePath: source,
      },
      store,
    );
  assert.equal((await action("git_status")).status, "needs_git");
  assert.equal(existsSync(resolve(source, ".git")), false);
  assert.equal((await action("initialize_git")).status, "ready");

  assert.deepEqual(
    (await git(source, ["log", "--format=%an|%s"])).split("\n"),
    ["Foundry|Initialize Foundry workspace assets"],
  );
  assert.deepEqual((await git(source, ["ls-files"])).split("\n").sort(), [
    ".gitignore",
    "notes.md",
  ]);
  assert.equal(readFileSync(resolve(source, ".gitignore"), "utf8"), "tmp/\n");
  const exclude = readFileSync(resolve(source, ".git/info/exclude"), "utf8");
  assert.ok(exclude.split("\n").includes("/.foundry/*"));
  assert.ok(exclude.split("\n").includes(".env"));
  // The person's preview configuration stays theirs to commit.
  assert.equal(
    await git(source, ["status", "--porcelain", "--untracked-files=all"]),
    "?? .foundry/preview.json",
  );
  // Confirming again changes nothing.
  const head = await git(source, ["rev-parse", "HEAD"]);
  await action("initialize_git");
  assert.equal(await git(source, ["rev-parse", "HEAD"]), head);

  const environment = await prepareIssueEnvironment(
    source,
    "ws_setup",
    "iss_1",
    store,
  );
  assert.equal(
    readFileSync(resolve(environment.cwd, "notes.md"), "utf8"),
    "notes\n",
  );
});
