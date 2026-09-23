import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { ExecutionStore } from "../dist/execution-storage.js";
import { registerExecutionWorkspace } from "../dist/repository-registry.js";
import {
  prepareIssueEnvironment,
  ensureRepository,
  snapshotEnvironment,
} from "../dist/issue-environments.js";
import {
  prepareAcceptance,
  applyAcceptance,
} from "../dist/workspace-acceptance.js";
import { git } from "../dist/execution-git.js";
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
  const registration = await registerExecutionWorkspace(
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
  const registration = await registerExecutionWorkspace(
    source,
    "ws_assets",
    store,
  );
  assert.ok(registration.content.tracked.includes("knowledge/asset.txt"));
  assert.deepEqual(registration.content.untracked, []);
  assert.ok(registration.content.ignored.includes(".env"));
  assert.match(
    readFileSync(resolve(source, ".gitignore"), "utf8"),
    /user-cache/,
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
  const first = await registerExecutionWorkspace(source, "ws_empty", store);
  const head = await git(source, ["rev-parse", "HEAD"]);
  await registerExecutionWorkspace(source, "ws_empty", store);
  assert.equal(await git(source, ["rev-parse", "HEAD"]), head);
  assert.equal(first.repositories[0].baseline, "refs/heads/existing");
  assert.equal(
    (
      readFileSync(resolve(source, ".gitignore"), "utf8").match(
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
    registerExecutionWorkspace(source, "ws_staged", store),
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
  const registration = await registerExecutionWorkspace(
    source,
    "ws_resume",
    store,
  );
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
  const registration = await registerExecutionWorkspace(
    source,
    "ws_ignored",
    store,
  );
  assert.equal(registration.repositories[0].status, "ready");
  assert.deepEqual(registration.content.tracked, [".gitignore"]);
});
