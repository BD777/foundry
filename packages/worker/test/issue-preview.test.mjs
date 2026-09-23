import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  queuePreview,
  runIssuePreview,
  previewStatus,
  stopIssuePreview,
} from "../dist/issue-preview.js";
import { ExecutionStore } from "../dist/execution-storage.js";
import {
  prepareIssueEnvironment,
  snapshotEnvironment,
} from "../dist/issue-environments.js";
import { ConcurrentTaskScheduler } from "../dist/task-scheduler.js";

test(
  "preview respects source write boundary and holds a scheduler slot until stopped",
  { skip: !["darwin", "linux"].includes(process.platform), timeout: 15000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), "foundry-preview-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = resolve(root, "source");
    mkdirSync(resolve(source, ".foundry"), { recursive: true });
    writeFileSync(resolve(source, "notes.txt"), "original");
    const program = `const fs=require('node:fs');let denied=false;try{fs.writeFileSync(process.env.FOUNDRY_ROOT_WORKSPACE+'/notes.txt','BAD')}catch{denied=true}require('node:http').createServer((q,s)=>s.end(denied?'read-only':'BAD')).listen(Number(process.env.PORT),'127.0.0.1')`;
    writeFileSync(
      resolve(source, ".foundry/preview.json"),
      JSON.stringify({
        command: `${JSON.stringify(process.execPath)} -e ${"'" + program.replaceAll("'", "'\\''") + "'"}`,
        portStart: 45400,
        portEnd: 45500,
      }),
    );
    const store = new ExecutionStore(resolve(root, "state"));
    let env = await prepareIssueEnvironment(
      source,
      "ws_preview",
      "iss_preview",
      store,
    );
    env = await snapshotEnvironment(env, store);
    const scheduler = new ConcurrentTaskScheduler(1);
    queuePreview(env.issueId);
    const job = scheduler.schedule("preview", () =>
      runIssuePreview(env.workspaceId, env.issueId, store),
    );
    t.after(() => stopIssuePreview(env.issueId));
    let otherStarted = false;
    const second = scheduler.schedule("other", () => {
      otherStarted = true;
    });
    const deadline = Date.now() + 8000;
    while (
      previewStatus(env.issueId)?.state === "queued" &&
      Date.now() < deadline
    )
      await new Promise((done) => setTimeout(done, 50));
    const preview = previewStatus(env.issueId);
    assert.equal(preview.state, "running", preview.error);
    assert.equal(otherStarted, false);
    assert.equal(await (await fetch(preview.url)).text(), "read-only");
    assert.equal(
      readFileSync(resolve(source, "notes.txt"), "utf8"),
      "original",
    );
    await stopIssuePreview(env.issueId);
    await job;
    await second;
    assert.equal(otherStarted, true);
  },
);
