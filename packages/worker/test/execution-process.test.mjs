import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  beginIssueExecution,
  cancelIssueExecution,
  finishIssueExecution,
} from "../dist/execution-process.js";
import { spawnProcessGroup } from "../dist/process-group.js";
import {
  sandboxCommand,
  executorEnvironment,
} from "../dist/execution-sandbox.js";
import { ExecutionStore } from "../dist/execution-storage.js";
import {
  prepareIssueEnvironment,
  ensureRepository,
} from "../dist/issue-environments.js";
import { git, gitCommit } from "../dist/execution-git.js";

test(
  "cancel stops executor and descendant tools, including a TERM-resistant child",
  { timeout: 8000 },
  async () => {
    const control = beginIssueExecution("iss_cancel_test");
    const program = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000);`;
    const child = spawnProcessGroup(
      process.execPath,
      ["-e", program],
      {},
      control.signal,
    );
    const closed = new Promise((done) => child.once("close", done));
    await new Promise((done) => child.stdout.once("data", done));
    cancelIssueExecution("iss_cancel_test");
    await closed;
    finishIssueExecution("iss_cancel_test");
    // Killed members linger as zombies until the OS reaps them, so the group
    // may answer signal 0 briefly after close; it must vanish shortly after.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        process.kill(-child.pid, 0);
      } catch {
        break;
      }
      await new Promise((done) => setTimeout(done, 25));
    }
    assert.throws(() => process.kill(-child.pid, 0));
  },
);

test(
  "Linux/macOS backend blocks original, git metadata and unprepared repo writes",
  { skip: !["darwin", "linux"].includes(process.platform), timeout: 30000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), "foundry-policy-"));
    t.after(() => rmSync(root, { force: true, recursive: true }));
    const source = resolve(root, "source");
    mkdirSync(resolve(source, "nested/repo"), { recursive: true });
    await git(resolve(source, "nested/repo"), ["init", "-b", "main"]);
    writeFileSync(resolve(source, "nested/repo/file.txt"), "child");
    await git(resolve(source, "nested/repo"), ["add", "."]);
    await gitCommit(resolve(source, "nested/repo"), "Child");
    writeFileSync(resolve(source, "AGENTS.md"), "rules");
    const store = new ExecutionStore(resolve(root, "state"));
    let env = await prepareIssueEnvironment(
      source,
      "ws_policy",
      "iss_policy",
      store,
    );
    const registration = store.registration("ws_policy");
    const childRepo = registration.repositories.find(
      (repo) => repo.relativePath === "nested/repo",
    );
    mkdirSync(resolve(env.cwd, "nested/repo"), { recursive: true });
    function write(path) {
      const spec = sandboxCommand(env, registration, process.execPath, [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1],'changed')",
        path,
      ]);
      return execFileSync(spec.command, spec.args, {
        env: executorEnvironment(env),
        cwd: env.cwd,
        stdio: "pipe",
      });
    }
    write(resolve(env.cwd, "good.txt"));
    assert.throws(() => write(resolve(source, "AGENTS.md")));
    assert.throws(() => write(resolve(source, ".git/config")));
    assert.throws(() => write(resolve(env.cwd, ".git")));
    assert.throws(() => write(resolve(env.cwd, "nested/repo/file.txt")));
    env = await ensureRepository(
      "ws_policy",
      "iss_policy",
      childRepo.id,
      store,
    );
    write(resolve(env.cwd, "nested/repo/file.txt"));
    assert.equal(
      readFileSync(resolve(source, "nested/repo/file.txt"), "utf8"),
      "child",
    );
    assert.equal(
      readFileSync(resolve(env.cwd, "nested/repo/file.txt"), "utf8"),
      "changed",
    );
  },
);
