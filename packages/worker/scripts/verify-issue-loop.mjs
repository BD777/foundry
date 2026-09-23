#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
} from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";
import { ExecutionStore } from "../dist/execution-storage.js";
import { executeIssue } from "../dist/issue-execution.js";
import { issueEnvironmentAction } from "../dist/issue-environment-rpc.js";
import { ConcurrentTaskScheduler } from "../dist/task-scheduler.js";
import { git, gitCommit } from "../dist/execution-git.js";
import { queuePreview, runIssuePreview } from "../dist/issue-preview.js";
import { loginTestOwner, pairTestDevice } from "./server-session.mjs";

throw new Error(
  "legacy_verification_retired: this fixture auto-dispatches unconfirmed Issues and uses revision-only Accept. Use node --test packages/worker/test/evidence-api-e2e.test.mjs from the repository root.",
);

const root = resolve(process.argv[2]);
const port = Number(process.argv[3] ?? 41982);
const base = `http://127.0.0.1:${port}`;
const source = resolve(root, "source");
mkdirSync(resolve(source, ".foundry"), { recursive: true });
mkdirSync(resolve(source, "Docs"), { recursive: true });
writeFileSync(
  resolve(source, "Docs/context.md"),
  "Workspace assets survive initialization.\n",
);
writeFileSync(
  resolve(source, ".foundry/workspace.json"),
  JSON.stringify({
    id: "ws_loop",
    name: "Milestone verification",
    path: source,
    baseline: "main",
    schemaVersion: 1,
  }),
);
const library = resolve(source, "deep/library");
mkdirSync(library, { recursive: true });
if (!existsSync(resolve(library, ".git"))) {
  await git(library, ["init", "-b", "main"]);
  writeFileSync(resolve(library, "base.txt"), "library");
  await git(library, ["add", "."]);
  await gitCommit(library, "Fixture");
}
const store = new ExecutionStore(resolve(root, "state"));
const server = spawn(resolve(root, "server"), [], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    FOUNDRY_DB_PATH: resolve(root, "foundry.db"),
    FOUNDRY_WEB_ORIGIN: "http://127.0.0.1:41983",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (data) =>
  appendFileSync(resolve(root, "server.log"), data),
);
server.stderr.on("data", (data) =>
  appendFileSync(resolve(root, "server.log"), data),
);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let auth = {};
async function request(path, body) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...auth,
      "Content-Type": "application/json",
      ...(path === "/api/issues"
        ? { "Idempotency-Key": crypto.randomUUID() }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}
async function until(read, predicate) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(100);
  }
  throw new Error("Verification timed out");
}
for (let i = 0; i < 100; i++) {
  try {
    await request("/healthz");
    break;
  } catch {
    await sleep(100);
  }
}
{
  const session = {
    executable: resolve(root, "server"),
    env: { ...process.env, FOUNDRY_DB_PATH: resolve(root, "foundry.db") },
    base,
  };
  auth = {
    ...(await loginTestOwner({ ...session, origin: "http://127.0.0.1:41983" })),
    ...(await pairTestDevice({ ...session, deviceId: "dev_loop" })),
  };
}
const socket = new WebSocket(base.replace("http", "ws") + "/api/daemon/ws", {
  headers: auth,
});
const scheduler = new ConcurrentTaskScheduler(4);
let active = 0,
  peak = 0;
const send = (type, payload = {}, id) =>
  socket.send(JSON.stringify({ type, payload, ...(id ? { id } : {}) }));
const transport = {
  async startRun(issueId, run) {
    await request(`/api/daemon/issues/${issueId}/runs`, { run });
  },
  async appendRunEvent(runId, event) {
    await request(`/api/daemon/runs/${runId}/events`, { event });
  },
  async completeIssue(issueId, input) {
    await request(`/api/daemon/issues/${issueId}/complete`, input);
  },
};
socket.on("message", async (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.type === "registered") {
    send("ready_for_issue");
    return;
  }
  if (message.type === "run_issue") {
    const issue = message.payload.issue;
    void scheduler
      .schedule(`issue:${issue.id}`, async () => {
        active++;
        peak = Math.max(peak, active);
        try {
          await executeIssue(base, source, issue, transport, store);
        } finally {
          active--;
          send("ready_for_issue");
        }
      })
      .catch((error) => console.error(String(error)));
  }
  if (message.type === "issue_environment") {
    try {
      const payload = message.payload;
      if (payload.action === "preview_start") {
        queuePreview(payload.issueId);
        void scheduler.schedule(`issue:${payload.issueId}`, () =>
          runIssuePreview(payload.workspaceId, payload.issueId, store),
        );
        send(
          "issue_environment_result",
          { status: "preview_queued", revision: payload.revision },
          message.id,
        );
      } else
        send(
          "issue_environment_result",
          await issueEnvironmentAction(payload, store),
          message.id,
        );
    } catch (error) {
      send("issue_environment_result", { error: String(error) }, message.id);
    }
  }
});
await new Promise((done) => socket.once("open", done));
send("hello", {
  device: {
    id: "dev_loop",
    label: "Verification device",
    status: "connected",
    runtimeSettings: { maxConcurrentTasks: 4, activeRuntimeTtlMs: 60000 },
  },
  workspace: {
    id: "ws_loop",
    name: "Milestone verification",
    localPath: source,
    baseline: "main",
    contextSummary: "Non-Git multi-repository verification",
    acceptedCount: 0,
    resolvedCount: 0,
  },
  providerHealth: [],
  assets: [],
  agents: [],
  agentProfiles: [],
  workspaceFiles: [],
});
await until(
  () => request("/api/workspaces"),
  (items) => items.some((item) => item.id === "ws_loop"),
);
try {
  const create = (title) =>
    request("/api/issues", {
      workspaceId: "ws_loop",
      runtime: "mock",
      title,
      sourceInput: title,
    });
  const first = await create("Parallel candidate A");
  const second = await create("Parallel candidate B");
  const additional = [];
  for (let index = 0; index < 4; index++)
    additional.push(await create(`Parallel candidate ${index + 3}`));
  const get = (id) => request(`/api/issues/${id}`);
  let a = await until(
    () => get(first.id),
    (item) => item.status === "verifying",
  );
  const b = await until(
    () => get(second.id),
    (item) => item.status === "verifying",
  );
  const extraReviews = [];
  for (const issue of additional)
    extraReviews.push(
      await until(
        () => get(issue.id),
        (item) => item.status === "verifying",
      ),
    );
  assert.equal(peak, 4);
  assert.notEqual(a.run.executionCwd, b.run.executionCwd);
  assert.equal(existsSync(resolve(source, `foundry-result-${a.id}.md`)), false);
  assert.ok(existsSync(resolve(a.run.executionCwd, "Docs/context.md")));
  const initialRun = a.run.id;
  const initialCwd = a.run.executionCwd;
  await request(`/api/issues/${a.id}/request-changes`, {
    message: "Improve the workspace knowledge",
    expectedRunId: a.run.id,
  });
  a = await until(
    () => get(a.id),
    (item) => item.status === "verifying" && item.run.id !== initialRun,
  );
  assert.equal(a.run.executionCwd, initialCwd);
  assert.equal(a.messages.filter((item) => item.role === "user").length, 1);
  const runs = await request("/api/runs?workspaceId=ws_loop");
  assert.equal(runs.length, 7);
  const diff = await request(`/api/issues/${a.id}/candidate-review`);
  assert.equal(diff.revision, a.run.environmentRevision);
  assert.ok(diff.review.repositories[0].diff.includes("foundry-result"));
  const stale = await fetch(`${base}/api/issues/${a.id}/accept`, {
    method: "POST",
    headers: {
      ...auth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ revision: 0 }),
  });
  assert.equal(stale.status, 409);
  for (const issue of [a, b, ...extraReviews]) {
    const accepted = await request(`/api/issues/${issue.id}/accept`, {
      revision: issue.run.environmentRevision,
    });
    assert.equal(accepted.status, "accepted");
    await request(`/api/issues/${issue.id}/environment/cleanup`, {});
  }
  assert.ok(existsSync(resolve(source, `foundry-result-${a.id}.md`)));
  const browserIssue = await create("Browser follow-up verification");
  await until(
    () => get(browserIssue.id),
    (item) => item.status === "verifying",
  );
  const summary = {
    status: "passed",
    peakConcurrentIssues: peak,
    runs: runs.length,
    checks: [
      "non-Git assets",
      "independent simultaneous candidates",
      "feedback persistence",
      "same CWD on retry",
      "full Run history",
      "actual multi-repo diff RPC",
      "stale revision rejected",
      "device-confirmed Accept",
      "cleanup",
    ],
    browserIssueId: browserIssue.id,
    api: base,
  };
  writeFileSync(resolve(root, "result.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  if (process.argv.includes("--serve")) {
    console.log("Verification service ready for browser checks");
    await new Promise((done) => {
      process.once("SIGTERM", done);
      process.once("SIGINT", done);
    });
  }
} finally {
  socket.close();
  await scheduler.whenIdle();
  server.kill("SIGTERM");
}
