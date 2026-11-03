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
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { ExecutionStore } from "../dist/candidate-store/execution-storage.js";
import { sandboxAvailable } from "../dist/sandbox/index.js";
import { issueSessionExecution } from "../dist/issue/issue-sessions.js";
import { runWorkspaceSession } from "../dist/session/index.js";
import { git, gitCommit } from "../dist/candidate-store/execution-git.js";
import {
  prepareIssueEnvironment,
  ensureRepository,
  snapshotEnvironment,
  cleanupEnvironment,
} from "../dist/issue/issue-environments.js";
import {
  prepareAcceptance,
  applyAcceptance,
} from "../dist/issue/workspace-acceptance.js";
import {
  sandboxCommand,
  executorEnvironment,
} from "../dist/issue/execution-sandbox.js";
import { initializeWorkspaceGit } from "../dist/workspace/repository-registry.js";
import { refreshCandidate } from "../dist/issue/candidate-refresh.js";
import { writeJSON } from "../dist/platform/storage.js";

test("request changes resolves source conflicts in candidate and requires a fresh revision", async (t) => {
  const { source, store } = await fixture(t);
  let environment = await prepareIssueEnvironment(
    source,
    "ws_test",
    "iss_conflict",
    store,
  );
  writeFileSync(resolve(environment.cwd, "AGENTS.md"), "candidate rules\n");
  environment = await snapshotEnvironment(environment, store);
  const oldRevision = environment.revision;
  writeFileSync(resolve(source, "AGENTS.md"), "accepted rules\n");
  await git(source, ["add", "AGENTS.md"]);
  await gitCommit(source, "User accepted another change");
  const conflict = await prepareAcceptance(
    "ws_test",
    environment.issueId,
    oldRevision,
    store,
  );
  assert.equal(conflict.status, "conflict");
  environment = await refreshCandidate(environment, store);
  assert.deepEqual(environment.conflicts, ["AGENTS.md"]);
  assert.match(
    readFileSync(resolve(environment.cwd, "AGENTS.md"), "utf8"),
    /<<<<<<< /,
  );
  await assert.rejects(
    snapshotEnvironment(environment, store),
    /conflict marker/,
  );
  writeFileSync(
    resolve(environment.cwd, "AGENTS.md"),
    "accepted and candidate rules\n",
  );
  environment = await snapshotEnvironment(environment, store);
  assert.equal(
    environment.conflicts,
    undefined,
    "a resolved candidate has no conflicts",
  );
  await assert.rejects(
    prepareAcceptance("ws_test", environment.issueId, oldRevision, store),
    /revision changed/,
  );
  const acceptance = await prepareAcceptance(
    "ws_test",
    environment.issueId,
    environment.revision,
    store,
  );
  assert.equal(acceptance.status, "prepared", acceptance.error);
  await applyAcceptance(
    "ws_test",
    environment.issueId,
    acceptance.id,
    environment.revision,
    store,
  );
  assert.equal(
    readFileSync(resolve(source, "AGENTS.md"), "utf8"),
    "accepted and candidate rules\n",
  );
});

test("acceptance journal resumes after one repository was already fast-forwarded", async (t) => {
  const { source, store } = await fixture(t);
  let environment = await prepareIssueEnvironment(
    source,
    "ws_test",
    "iss_resume",
    store,
  );
  const backend = store
    .registration("ws_test")
    .repositories.find((repo) => repo.relativePath === "repos/backend");
  environment = await ensureRepository(
    "ws_test",
    environment.issueId,
    backend.id,
    store,
  );
  writeFileSync(resolve(environment.cwd, "AGENTS.md"), "root candidate\n");
  writeFileSync(
    resolve(environment.cwd, "repos/backend/code.txt"),
    "child candidate\n",
  );
  environment = await snapshotEnvironment(environment, store);
  const acceptance = await prepareAcceptance(
    "ws_test",
    environment.issueId,
    environment.revision,
    store,
  );
  acceptance.status = "applying";
  writeJSON(
    resolve(
      environment.directory,
      "../../acceptances",
      acceptance.id,
      "acceptance.json",
    ),
    acceptance,
  );
  const first = acceptance.repositories[0];
  await git(first.sourcePath, ["merge", "--ff-only", first.target]);
  const result = await applyAcceptance(
    "ws_test",
    environment.issueId,
    acceptance.id,
    environment.revision,
    store,
  );
  assert.equal(result.status, "integrated");
  assert.equal(
    readFileSync(resolve(source, "AGENTS.md"), "utf8"),
    "root candidate\n",
  );
});

async function fixture(t) {
  const directory = mkdtempSync(resolve(tmpdir(), "foundry-env-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = resolve(directory, "source");
  mkdirSync(source);
  const store = new ExecutionStore(resolve(directory, "state"));
  await repository(source, {
    "AGENTS.md": "Shared workspace guidance",
    ".gitignore": ".foundry/\nrepos/\n",
  });
  const backend = resolve(source, "repos/backend");
  mkdirSync(backend, { recursive: true });
  await repository(backend, {
    "code.txt": "baseline\n",
    ".gitignore": "nested/\n",
  });
  const nested = resolve(backend, "nested/deep/common");
  mkdirSync(nested, { recursive: true });
  await repository(nested, { "shared.txt": "common\n" });
  return { source, backend, nested, store };
}
async function repository(path, files) {
  await git(path, ["init", "-b", "main"]);
  for (const [name, text] of Object.entries(files))
    writeFileSync(resolve(path, name), text);
  await git(path, ["add", "."]);
  await gitCommit(path, "Baseline");
}

test("parallel Issues share rules but isolate nested repositories and preserve retries", async (t) => {
  const { source, store } = await fixture(t);
  const environments = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      prepareIssueEnvironment(source, "ws_test", `iss_${i}`, store),
    ),
  );
  const registration = store.registration("ws_test");
  assert.equal(registration.repositories.length, 3);
  const nested = registration.repositories.find((repo) =>
    repo.relativePath.endsWith("common"),
  );
  for (const environment of environments) {
    assert.equal(
      readFileSync(resolve(environment.cwd, "AGENTS.md"), "utf8"),
      "Shared workspace guidance",
    );
    assert.equal(
      existsSync(resolve(environment.cwd, "repos/backend/.git")),
      false,
    );
  }
  const ready = await ensureRepository("ws_test", "iss_0", nested.id, store);
  assert.equal(ready.repositories.length, 3);
  writeFileSync(
    resolve(ready.cwd, nested.relativePath, "shared.txt"),
    "candidate\n",
  );
  assert.equal(
    readFileSync(resolve(source, nested.relativePath, "shared.txt"), "utf8"),
    "common\n",
  );
  assert.equal(
    (await prepareIssueEnvironment(source, "ws_test", "iss_0", store)).cwd,
    ready.cwd,
  );
  assert.equal(
    existsSync(resolve(environments[1].cwd, nested.relativePath, ".git")),
    false,
  );
  const review = await snapshotEnvironment(ready, store);
  const acceptance = await prepareAcceptance(
    "ws_test",
    "iss_0",
    review.revision,
    store,
  );
  assert.equal(acceptance.status, "prepared", acceptance.error);
  assert.equal(
    readFileSync(resolve(source, nested.relativePath, "shared.txt"), "utf8"),
    "common\n",
  );
  const accepted = await applyAcceptance(
    "ws_test",
    "iss_0",
    acceptance.id,
    review.revision,
    store,
  );
  assert.equal(accepted.status, "integrated");
  assert.equal(
    readFileSync(resolve(source, nested.relativePath, "shared.txt"), "utf8"),
    "candidate\n",
  );
  assert.equal(
    (
      await applyAcceptance(
        "ws_test",
        "iss_0",
        acceptance.id,
        review.revision,
        store,
      )
    ).status,
    "integrated",
  );
  await cleanupEnvironment(store.environment("ws_test", "iss_0"), store);
  assert.equal(existsSync(ready.cwd), false);
});

test("Accept rejects changed review and dirty source without modifying source", async (t) => {
  const { source, store } = await fixture(t);
  let environment = await prepareIssueEnvironment(
    source,
    "ws_test",
    "iss_dirty",
    store,
  );
  writeFileSync(resolve(environment.cwd, "AGENTS.md"), "candidate");
  environment = await snapshotEnvironment(environment, store);
  const acceptance = await prepareAcceptance(
    "ws_test",
    environment.issueId,
    environment.revision,
    store,
  );
  writeFileSync(resolve(source, "AGENTS.md"), "user draft");
  await assert.rejects(
    applyAcceptance(
      "ws_test",
      environment.issueId,
      acceptance.id,
      environment.revision,
      store,
    ),
    /The workspace has uncommitted changes \(AGENTS\.md\)\. Commit them/,
  );
  assert.equal(
    readFileSync(resolve(source, "AGENTS.md"), "utf8"),
    "user draft",
  );
  writeFileSync(resolve(environment.cwd, "new.txt"), "after review");
  await assert.rejects(
    prepareAcceptance(
      "ws_test",
      environment.issueId,
      environment.revision,
      store,
    ),
    /changed after review/,
  );
});

test(
  "executor sandbox blocks absolute and symlink writes to source, metadata, and unprepared repos",
  { skip: !sandboxAvailable("writable_tree") },
  async (t) => {
    const { source, store } = await fixture(t);
    const environment = await prepareIssueEnvironment(
      source,
      "ws_test",
      "iss_sandbox",
      store,
    );
    symlinkSync(source, resolve(environment.cwd, "source-link"));
    const registration = store.registration("ws_test");
    const env = executorEnvironment(environment);
    const self = sandboxCommand(environment, registration, "/bin/ps", [
      "-p",
      String(process.pid),
      "-o",
      "command=",
    ]);
    assert.throws(() =>
      execFileSync(self.command, self.args, {
        env,
        cwd: environment.cwd,
        stdio: "pipe",
      }),
    );
    const run = (path) => {
      const command = sandboxCommand(
        environment,
        registration,
        process.execPath,
        ["-e", "require('fs').writeFileSync(process.argv[1], 'probe')", path],
      );
      return execFileSync(command.command, command.args, {
        env,
        cwd: environment.cwd,
        stdio: "pipe",
      });
    };
    run(resolve(environment.cwd, "candidate.txt"));
    assert.throws(() => run(resolve(source, "AGENTS.md")));
    assert.throws(() => run(resolve(environment.cwd, "source-link/AGENTS.md")));
    assert.throws(() => run(resolve(environment.cwd, ".git")));
    assert.throws(() =>
      run(resolve(environment.directory, "environment.json")),
    );
    assert.throws(() => run(resolve(source, ".git/config")));
    assert.equal(
      readFileSync(resolve(source, "AGENTS.md"), "utf8"),
      "Shared workspace guidance",
    );
    if (process.platform !== "darwin") return;
    const profile = readFileSync(
      resolve(environment.directory, "executor.sb"),
      "utf8",
    );
    assert.match(profile, /\(deny process-info\*\)/);
    assert.match(profile, /\(allow process-info\* \(target self\)\)/);
    assert.match(profile, /apps\/server\/\.data/);
  },
);

test("confirmed Git setup in a non-Git workspace stages no independent repositories, secrets or Foundry files", async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), "foundry-init-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = resolve(directory, "source");
  mkdirSync(resolve(source, "deep/repo"), { recursive: true });
  await repository(resolve(source, "deep/repo"), { "code.txt": "independent" });
  writeFileSync(resolve(source, "AGENTS.md"), "Rules");
  writeFileSync(resolve(source, ".env"), "PRIVATE=value");
  const store = new ExecutionStore(resolve(directory, "state"));
  const registration = await initializeWorkspaceGit(source, "ws_init", store);
  assert.equal(registration.repositories.length, 2);
  assert.equal(await git(source, ["status", "--porcelain"]), "");
  assert.doesNotMatch(
    await git(source, ["ls-files"]),
    /code.txt|\.env|\.foundry|\.gitignore/,
  );
  assert.match(await git(source, ["ls-files"]), /AGENTS.md/);
  assert.equal(existsSync(resolve(source, ".gitignore")), false);
});

test("existing submodules use durable child worktrees and child-first Accept", async (t) => {
  const { source, backend, store } = await fixture(t);
  await git(source, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    backend,
    "module",
  ]);
  await gitCommit(source, "Register submodule");
  let environment = await prepareIssueEnvironment(
    source,
    "ws_test",
    "iss_module",
    store,
  );
  const repo = store
    .registration("ws_test")
    .repositories.find((item) => item.relativePath === "module");
  assert.equal(repo.kind, "submodule");
  environment = await ensureRepository(
    "ws_test",
    environment.issueId,
    repo.id,
    store,
  );
  writeFileSync(
    resolve(environment.cwd, "module/code.txt"),
    "submodule candidate\n",
  );
  environment = await snapshotEnvironment(environment, store);
  const acceptance = await prepareAcceptance(
    "ws_test",
    environment.issueId,
    environment.revision,
    store,
  );
  assert.equal(acceptance.status, "prepared", acceptance.error);
  await applyAcceptance(
    "ws_test",
    environment.issueId,
    acceptance.id,
    environment.revision,
    store,
  );
  assert.equal(await git(source, ["status", "--porcelain"]), "");
  await cleanupEnvironment(
    store.environment("ws_test", environment.issueId),
    store,
  );
  assert.equal(
    readFileSync(resolve(source, "module/code.txt"), "utf8"),
    "submodule candidate\n",
  );
});

test("an issue-backed session runs in the candidate inside the Issue sandbox", async (t) => {
  const { source, store } = await fixture(t);
  const ambient = {
    serverURL: "http://127.0.0.1:1",
    sessionToken: "child-token",
    workspaceID: "ws_test",
  };
  assert.throws(
    () => issueSessionExecution("ws_test", "iss_missing", "s", ambient, store),
    /issue environment for iss_missing is not available/,
  );
  const environment = await prepareIssueEnvironment(
    source,
    "ws_test",
    "iss_child",
    store,
  );
  environment.userFiles = "readable";
  store.saveEnvironment(environment);
  const execution = issueSessionExecution(
    "ws_test",
    "iss_child",
    "sess_child",
    ambient,
    store,
  );
  assert.equal(execution.cwd, environment.cwd);
  assert.equal(execution.stateRoot, environment.directory);
  assert.equal(execution.sandbox.profile.userFiles, "readable");
  assert.deepEqual(execution.sandbox.ambient, ambient);
  assert.ok(execution.sandbox.stderrFile.startsWith(environment.scratch));
  if (!sandboxAvailable("writable_tree")) return;
  const result = await runWorkspaceSession({
    cwd: execution.cwd,
    session: {
      id: "sess_child",
      provider: "claude",
      workspaceId: "ws_test",
      threadId: "sess_child",
      issueId: "iss_child",
      agentId: "",
      deviceId: "",
      status: "running",
      title: "Child",
      prompt: "Change guidance",
      createdLabel: "now",
      updatedLabel: "now",
    },
    profile: {
      runtime: "claude",
      id: "stand_in",
      label: "Stand-in",
      command: `echo child > AGENTS.md; (echo bad > '${resolve(source, "AGENTS.md")}') 2>/dev/null; echo ok`,
    },
    emit: async () => {},
    emitSetup: async () => {},
    reportNativeSessionId: () => {},
    sandbox: execution.sandbox,
  });
  assert.equal(result.response, "ok");
  assert.equal(
    readFileSync(resolve(environment.cwd, "AGENTS.md"), "utf8"),
    "child\n",
  );
  assert.equal(
    readFileSync(resolve(source, "AGENTS.md"), "utf8"),
    "Shared workspace guidance",
    "the source workspace is untouched",
  );
});
