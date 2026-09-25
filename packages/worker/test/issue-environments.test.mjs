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
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { ExecutionStore } from "../dist/execution-storage.js";
import { sandboxAvailable } from "../dist/sandbox/index.js";
import { git, gitCommit } from "../dist/execution-git.js";
import {
  prepareIssueEnvironment,
  ensureRepository,
  snapshotEnvironment,
  cleanupEnvironment,
} from "../dist/issue-environments.js";
import {
  prepareAcceptance,
  applyAcceptance,
} from "../dist/workspace-acceptance.js";
import {
  sandboxCommand,
  executorEnvironment,
} from "../dist/execution-sandbox.js";
import { executeIssue } from "../dist/issue-execution.js";
import { registerExecutionWorkspace } from "../dist/repository-registry.js";
import { runIssueExecutor } from "../dist/issue-executor.js";
import { refreshCandidate } from "../dist/candidate-refresh.js";
import { writeJSON } from "../dist/storage.js";

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
  assert.match(environment.error, /conflict/i);
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

test("mock runs reuse one Issue environment and archive each attempt outside source", async (t) => {
  const { source, store } = await fixture(t);
  mkdirSync(resolve(source, ".foundry"));
  writeJSON(resolve(source, ".foundry/workspace.json"), {
    id: "ws_test",
    path: source,
    name: "Test",
    baseline: "main",
    schemaVersion: 1,
  });
  const issue = {
    id: "iss_mock",
    contractState: "confirmed",
    currentContractRevision: 2,
    workspaceId: "ws_test",
    shortId: "ISS-mock",
    title: "Write",
    sourceInput: "Write report",
    runtime: "mock",
    skills: [],
    acceptanceCriteria: [],
    checks: [],
  };
  const contractContent = JSON.parse(
    readFileSync(
      new URL("../../protocol/test/evidence-fixtures.json", import.meta.url),
      "utf8",
    ),
  ).find((item) => item.name === "observable agent criterion").value;
  const actor = { kind: "local_owner", id: "owner", displayName: "Owner" };
  const digest = `sha256:${"a".repeat(64)}`;
  issue.executionContract = {
    ...contractContent,
    schemaVersion: 1,
    id: "contract_mock",
    workspaceId: issue.workspaceId,
    issueId: issue.id,
    revision: 2,
    origin: "user",
    createdAt: "2026-09-10T00:00:00Z",
    createdBy: actor,
    contentDigest: digest,
    status: "confirmed",
    confirmation: { actor, at: "2026-09-10T00:00:00Z", contentDigest: digest },
  };
  const completions = [];
  const transport = {
    async startRun() {},
    async appendRunEvent() {},
    async completeIssue(_id, input) {
      completions.push(input);
    },
  };
  await executeIssue("", source, issue, transport, store);
  await executeIssue(
    "",
    source,
    { ...issue, checks: ["Changes requested"] },
    transport,
    store,
  );
  assert.equal(completions.length, 2);
  for (const completion of completions)
    assert.equal(completion.error, undefined, completion.error);
  assert.notEqual(completions[0].runId, completions[1].runId);
  assert.equal(completions[0].environmentId, completions[1].environmentId);
  assert.notEqual(
    completions[0].artifact.primaryUri,
    completions[1].artifact.primaryUri,
  );
  assert.equal(
    existsSync(resolve(source, "foundry-result-iss_mock.md")),
    false,
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
    /uncommitted/,
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

test("new non-Git workspace bootstraps guidance without staging independent repositories or secrets", async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), "foundry-init-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = resolve(directory, "source");
  mkdirSync(resolve(source, "deep/repo"), { recursive: true });
  await repository(resolve(source, "deep/repo"), { "code.txt": "independent" });
  writeFileSync(resolve(source, "AGENTS.md"), "Rules");
  writeFileSync(resolve(source, ".env"), "PRIVATE=value");
  const store = new ExecutionStore(resolve(directory, "state"));
  const registration = await registerExecutionWorkspace(
    source,
    "ws_init",
    store,
  );
  assert.equal(registration.repositories.length, 2);
  assert.equal(await git(source, ["status", "--porcelain"]), "");
  assert.doesNotMatch(await git(source, ["ls-files"]), /code.txt|\.env/);
  assert.match(await git(source, ["ls-files"]), /repositories.yaml/);
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

test(
  "real executor boundary prepares a repository between turns",
  { skip: !sandboxAvailable("writable_tree"), timeout: 30_000 },
  async (t) => {
    const { source, store } = await fixture(t);
    mkdirSync(resolve(source, ".foundry"));
    writeFileSync(
      resolve(source, ".foundry/workspace.json"),
      JSON.stringify({
        id: "ws_test",
        name: "Fixture",
        path: source,
        baseline: "main",
        schemaVersion: 1,
      }),
    );
    const toolPath = resolve(import.meta.dirname, "../dist/repository-tool.js");
    const script = resolve(source, ".foundry/probe.mjs");
    writeFileSync(
      script,
      `import { existsSync, writeFileSync } from 'node:fs';\nimport { execFileSync } from 'node:child_process';\nimport { resolve } from 'node:path';\nprocess.stdin.resume();\nprocess.stdin.on('end', () => {\nconst tool = ${JSON.stringify(toolPath)};\nconst repos = JSON.parse(execFileSync(process.execPath, [tool, 'list'], {encoding:'utf8'}));\nconst repo = repos.find(r => r.relativePath === 'repos/backend');\nif (!existsSync(resolve('repos/backend/.git'))) {\n console.log(execFileSync(process.execPath, [tool, 'prepare', repo.id], {encoding:'utf8'}));\n} else {\n writeFileSync(resolve('repos/backend/code.txt'), 'executor candidate\\n');\n let denied = false; try { writeFileSync(resolve(process.env.FOUNDRY_ROOT_WORKSPACE, 'AGENTS.md'), 'bad'); } catch { denied = true; }\n if (!denied) process.exit(3);\n console.log('Changed backend and verified original is read-only.');\n}\n});\n`,
    );
    // Exercise the native CLI fallback boundary instead of an arbitrary
    // profile command, which cannot guarantee workspace skill isolation.
    const native = resolve(source, ".foundry/fake-claude");
    writeFileSync(
      native,
      `#!${process.execPath}
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('Claude Code test fixture'); process.exit(0); }
if (args.includes('stream-json')) process.exit(1);
const index = args.indexOf('--setting-sources');
if (index < 0 || args[index + 1] !== '') process.exit(4);
const child = spawnSync(process.execPath, [${JSON.stringify(script)}], {stdio:'inherit'});
process.exit(child.status ?? 1);
`,
    );
    chmodSync(native, 0o755);
    const previousClaude = process.env.FOUNDRY_CLAUDE_BIN;
    process.env.FOUNDRY_CLAUDE_BIN = native;
    t.after(() => {
      if (previousClaude === undefined) delete process.env.FOUNDRY_CLAUDE_BIN;
      else process.env.FOUNDRY_CLAUDE_BIN = previousClaude;
    });
    const issue = {
      id: "iss_executor",
      workspaceId: "ws_test",
      shortId: "ISS-executor",
      title: "Change backend",
      sourceInput: "Change backend",
      status: "producing",
      priority: "medium",
      runtime: "claude",
      skills: [],
      acceptanceCriteria: [],
      checks: [],
      updatedLabel: "now",
    };
    const initial = await prepareIssueEnvironment(
      source,
      "ws_test",
      issue.id,
      store,
    );
    const result = await runIssueExecutor(
      initial,
      issue,
      "run_fixture",
      async () => {},
      store,
      {
        runtime: "claude",
        id: "fixture",
      },
    );
    assert.match(result.response, /Changed backend/);
    assert.equal(
      readFileSync(resolve(source, "repos/backend/code.txt"), "utf8"),
      "baseline\n",
    );
    const environment = store.environment("ws_test", issue.id);
    assert.equal(environment.repositories.length, 2);
    assert.equal(
      readFileSync(resolve(environment.cwd, "repos/backend/code.txt"), "utf8"),
      "executor candidate\n",
    );
  },
);
