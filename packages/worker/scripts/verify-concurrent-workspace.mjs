#!/usr/bin/env node
// Real providers, real HTTP/WS dispatch and production execution/Accept services.
// The small daemon adapter below substitutes device registration only; it uses
// an isolated ExecutionStore so this exercise cannot claim the user's real work.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  readdirSync,
  lstatSync,
  rmSync,
} from "node:fs";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { ExecutionStore } from "../dist/execution-storage.js";
import { registerExecutionWorkspace } from "../dist/repository-registry.js";
import { executeIssue } from "../dist/issue-execution.js";
import { issueEnvironmentAction } from "../dist/issue-environment-rpc.js";
import { ConcurrentTaskScheduler } from "../dist/task-scheduler.js";
import { cancelIssueExecution } from "../dist/execution-process.js";
import { git, gitCommit } from "../dist/execution-git.js";
import { loginTestOwner, pairTestDevice } from "./server-session.mjs";

throw new Error(
  "legacy_verification_retired: this fixture predates confirmed contracts and review-bound Accept. Use node --test packages/worker/test/evidence-api-e2e.test.mjs and packages/worker/test/evidence-integration.test.mjs from the repository root.",
);

const root = resolve(process.argv[2]);
const binary = resolve(process.argv[3]);
const port = Number(process.argv[4] ?? 41986);
const base = `http://127.0.0.1:${port}`;
const source = resolve(root, "workspace");
const resuming = process.argv.includes("--resume");
const reportRuntime = process.argv.includes("--codex-only")
  ? "codex"
  : "claude";
const retryAttempts = Number(
  process.argv
    .find((arg) => arg.startsWith("--retry-attempts="))
    ?.split("=")[1] ?? 1,
);
assert.ok(
  Number.isInteger(retryAttempts) && retryAttempts >= 1 && retryAttempts <= 5,
);
assert.ok(resuming || !existsSync(source), "Use a fresh exercise directory");
const savedBaseline = resuming
  ? JSON.parse(readFileSync(resolve(root, "baseline.json"), "utf8"))
  : undefined;
const workspaceId =
  savedBaseline?.workspaceId ?? `ws_verify_${randomUUID().replaceAll("-", "")}`;
const store = new ExecutionStore(resolve(root, "state"));
const save = (path, text) => {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const saveJSON = (path, value) =>
  save(path, JSON.stringify(value, null, 2) + "\n");
const fixture = (path, text) => {
  if (!resuming) save(resolve(source, path), text);
};
fixture(
  "AGENTS.md",
  `# Expense workspace\n\nRead Docs/domain.md before implementation.\nUse integer cents for all calculations. Keep the public function contracts.\nAdd meaningful node:test coverage inside the repository you change.\nDo not change acceptance.mjs, other repositories, or create source symlinks.\nDo not stage or commit: Foundry does that after your turn.\n`,
);
fixture(
  "Docs/domain.md",
  "# Domain knowledge\n\nAmounts are decimal strings at the boundary and safe integer cents internally.\nNegative amounts represent refunds. Categories retain their exact nonempty name.\nThe independent repositories are packages/money and services/reports/core.\narchive/unused is deliberately outside the scope of this work.\n",
);
fixture(
  "Docs/capabilities.md",
  "# Accepted capabilities\n\nCapabilities: none.\n",
);
fixture(
  ".foundry/workspace.json",
  JSON.stringify({
    id: workspaceId,
    name: "Concurrent expense workspace",
    path: source,
    baseline: "main",
    schemaVersion: 1,
  }),
);
fixture(
  "packages/money/index.mjs",
  "export function parseMoney(value) { throw new Error('Not implemented'); }\n",
);
fixture(
  "services/reports/core/index.mjs",
  "export function summarize(entries) { throw new Error('Not implemented'); }\n",
);
fixture(
  "archive/unused/README.md",
  "This independent repository must remain untouched.\n",
);
const oracle = `import assert from 'node:assert/strict';
import { parseMoney } from './packages/money/index.mjs';
import { summarize } from './services/reports/core/index.mjs';
assert.equal(parseMoney('12.34'), 1234);
assert.equal(parseMoney('-0.05'), -5);
assert.equal(parseMoney('0'), 0);
assert.equal(parseMoney('7.5'), 750);
assert.equal(parseMoney('90071992547409.91'), Number.MAX_SAFE_INTEGER);
for (const value of ['', ' 1', '1 ', '1.234', '1e2', 'NaN', 'Infinity', '90071992547409.92', 1, null]) assert.throws(() => parseMoney(value));
assert.deepEqual(summarize([]), { totalCents: 0, categories: [] });
const rows = [ {category:'travel', amountCents:parseMoney('12.34')}, {category:'food', amountCents:parseMoney('7.5')}, {category:'travel', amountCents:parseMoney('-0.05')} ];
const before = structuredClone(rows);
assert.deepEqual(summarize(rows), {totalCents:1979,categories:[{category:'food',totalCents:750},{category:'travel',totalCents:1229}]});
assert.deepEqual(rows, before);
for (const entries of [null, {}, [{category:'', amountCents:1}], [{category:'x', amountCents:0.5}], [{category:'x', amountCents:NaN}], [{category:'x', amountCents:Number.MAX_SAFE_INTEGER},{category:'x',amountCents:1}]]) assert.throws(() => summarize(entries));
assert.deepEqual(summarize([{category:'__proto__',amountCents:1}]), {totalCents:1,categories:[{category:'__proto__',totalCents:1}]});
console.log('PASS: combined money/report contracts, boundary cases, safe integers, immutability');
`;
fixture("acceptance.mjs", oracle);
const repoPaths = [
  ".",
  "packages/money",
  "services/reports/core",
  "archive/unused",
];
for (const path of resuming ? [] : repoPaths.slice(1)) {
  const cwd = resolve(source, path);
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["add", "."]);
  await gitCommit(cwd, "Seed expense workspace");
}
if (!resuming) assert.equal(existsSync(resolve(source, ".git")), false);
const registration = await registerExecutionWorkspace(
  source,
  workspaceId,
  store,
);
assert.equal(registration.repositories.length, 4);
assert.ok(registration.repositories.every((repo) => repo.status === "ready"));
const fingerprint = () => {
  const hash = createHash("sha256");
  function visit(dir) {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".git") continue;
      const path = resolve(dir, name);
      if (lstatSync(path).isDirectory()) visit(path);
      else {
        hash.update(relative(source, path));
        hash.update(readFileSync(path));
      }
    }
  }
  visit(source);
  return hash.digest("hex");
};
const originalFingerprint = savedBaseline?.originalFingerprint ?? fingerprint();
assert.equal(
  fingerprint(),
  originalFingerprint,
  "Resume is supported before the first Accept only",
);
const originalHeads =
  savedBaseline?.originalHeads ??
  Object.fromEntries(
    await Promise.all(
      repoPaths.map(async (path) => [
        path,
        await git(resolve(source, path), ["rev-parse", "HEAD"]),
      ]),
    ),
  );
saveJSON(resolve(root, "baseline.json"), {
  workspaceId,
  originalFingerprint,
  originalHeads,
});
const server = spawn(binary, [], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    FOUNDRY_DB_PATH: resolve(root, "foundry.db"),
    FOUNDRY_WEB_ORIGIN: "http://127.0.0.1:41983",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
for (const stream of [server.stdout, server.stderr])
  stream.on("data", (data) =>
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
async function until(read, predicate, timeout = 900000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(500);
  }
  throw new Error("Exercise timed out");
}
let socket;
const scheduler = new ConcurrentTaskScheduler(2);
const recoveredSessions = new Map();
const intervals = resuming
    ? JSON.parse(readFileSync(resolve(root, "failure.json"), "utf8")).intervals
    : [],
  issueIds = [],
  errors = [];
let active = 0,
  peak =
    intervals.length >= 2 &&
    Math.min(intervals[0].end, intervals[1].end) >
      Math.max(intervals[0].start, intervals[1].start)
      ? 2
      : 0;
const log = (label, fields = {}) => {
  const event = { at: new Date().toISOString(), label, ...fields };
  appendFileSync(resolve(root, "progress.jsonl"), JSON.stringify(event) + "\n");
  console.log(JSON.stringify(event));
};
const send = (type, payload = {}, id) =>
  socket.send(JSON.stringify({ type, payload, ...(id ? { id } : {}) }));
const transport = {
  async startRun(issueId, run) {
    await request(`/api/daemon/issues/${issueId}/runs`, { run });
  },
  async appendRunEvent(runId, event) {
    await request(`/api/daemon/runs/${runId}/events`, { event });
    if (
      [
        "Candidate workspace ready",
        "Repository prepared",
        "Awaiting Workspace Accept",
        "Issue execution failed",
      ].includes(event.label)
    )
      log(event.label, { runId, detail: event.detail });
  },
  async completeIssue(issueId, input) {
    await request(`/api/daemon/issues/${issueId}/complete`, input);
  },
};
const get = (id) => request(`/api/issues/${id}`);
const retryHistory = [];
async function review(id, priorRun) {
  for (let attempt = 1; ; attempt++) {
    let issue = await until(
      () => get(id),
      (item) =>
        item.run?.id !== priorRun &&
        (["verifying", "blocked"].includes(item.status) ||
          (retryAttempts > 1 &&
            item.runtime === "claude" &&
            item.run?.events?.some((event) =>
              ["模型限流，等待重试", "模型请求重试"].includes(event.label),
            ))),
    );
    if (issue.status === "verifying") return issue;
    if (retryAttempts === 1 || issue.runtime !== "claude") {
      assert.equal(issue.status, "verifying", issue.run?.error);
    }
    const retryEvent = issue.run.events?.find((event) =>
      ["模型限流，等待重试", "模型请求重试"].includes(event.label),
    );
    if (!["blocked"].includes(issue.status)) {
      // The SDK reported this failed request and is waiting to retry. Stop its
      // internal retry loop before applying the caller's bounded backoff policy.
      await request(`/api/issues/${id}/environment/cancel`, {});
      issue = await until(
        () => get(id),
        (item) => ["blocked"].includes(item.status),
      );
    }
    const delayMs =
      attempt < retryAttempts
        ? Math.min(30000 * 2 ** (attempt - 1), 240000)
        : 0;
    retryHistory.push({
      attempt,
      issueId: id,
      runId: issue.run.id,
      at: new Date().toISOString(),
      detail: retryEvent?.detail ?? issue.run.error,
      delayMs,
    });
    saveJSON(resolve(root, "backoff-retries.json"), {
      mechanism:
        "Claude Agent SDK via production Issue execution; Foundry HTTP calls only control local Issue lifecycle",
      maxAttempts: retryAttempts,
      attempts: retryHistory,
    });
    log("Claude attempt failed", retryHistory.at(-1));
    if (attempt >= retryAttempts)
      throw new Error(
        `Claude failed all ${retryAttempts} backoff attempts: ${retryEvent?.detail ?? issue.run.error}`,
      );
    await sleep(delayMs);
    const retained = store.environment(workspaceId, id);
    if (!recoveredSessions.has(id))
      recoveredSessions.set(id, retained.nativeSessionId);
    assert.equal(
      retained.nativeSessionId,
      recoveredSessions.get(id),
      "Backoff must retain native session",
    );
    priorRun = issue.run.id;
    await request(`/api/issues/${id}/request-changes`, {
      expectedRunId: priorRun,
      message:
        "Retry the same unfinished task after a provider backoff. Keep the existing candidate, implementation and original requirements. Continue through Claude Agent SDK; do not call model HTTP endpoints yourself.",
    });
    log("Claude backoff retry started", {
      issueId: id,
      attempt: attempt + 1,
      waitedMs: delayMs,
    });
  }
}
async function inspect(issue, phase) {
  const diff = await request(`/api/issues/${issue.id}/candidate-review`);
  saveJSON(
    resolve(root, `evidence/${phase}-${issue.id}-${issue.runtime}-review.json`),
    diff,
  );
  assert.equal(diff.revision, issue.run.environmentRevision);
  return diff;
}
async function accept(issue) {
  const result = await request(`/api/issues/${issue.id}/accept`, {
    revision: issue.run.environmentRevision,
  });
  assert.equal(result.status, "integrated");
  log("Accepted", {
    issueId: issue.id,
    revision: issue.run.environmentRevision,
  });
}
function runNode(args, cwd, name) {
  const nodeArgs = args.includes("--test")
    ? ["--test-reporter=tap", ...args]
    : args;
  const output = execFileSync(process.execPath, nodeArgs, {
    cwd,
    encoding: "utf8",
    timeout: 30000,
  });
  if (args.includes("--test"))
    assert.match(
      output,
      /# tests [1-9]\d*/,
      "Generated test suite must contain tests",
    );
  save(resolve(root, `evidence/${name}.txt`), output);
  log("Tests passed", { name });
}
try {
  await until(
    async () => {
      try {
        return await request("/healthz");
      } catch {
        return null;
      }
    },
    Boolean,
    15000,
  );
  const session = {
    executable: binary,
    env: { ...process.env, FOUNDRY_DB_PATH: resolve(root, "foundry.db") },
    base,
  };
  auth = {
    ...(await loginTestOwner({ ...session, origin: "http://127.0.0.1:41983" })),
    ...(await pairTestDevice({
      ...session,
      deviceId: "dev_concurrent_verify",
    })),
  };
  socket = new WebSocket(base.replace("http", "ws") + "/api/daemon/ws", {
    headers: auth,
  });
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "registered") send("ready_for_issue");
    if (message.type === "run_issue") {
      const issue = message.payload.issue;
      void scheduler
        .schedule(`issue:${issue.id}`, async () => {
          const interval = {
            issueId: issue.id,
            runtime: issue.runtime,
            start: Date.now(),
          };
          intervals.push(interval);
          active++;
          peak = Math.max(peak, active);
          log("Run started", {
            issueId: issue.id,
            runtime: issue.runtime,
            active,
          });
          try {
            await executeIssue(base, source, issue, transport, store);
          } finally {
            interval.end = Date.now();
            active--;
            log("Run finished", { issueId: issue.id, active });
            if (socket.readyState === WebSocket.OPEN) send("ready_for_issue");
          }
        })
        .catch((error) => {
          errors.push(String(error));
          log("Dispatch error", { error: String(error) });
        });
    }
    if (message.type === "issue_environment") {
      void issueEnvironmentAction(message.payload, store).then(
        (result) => send("issue_environment_result", result, message.id),
        (error) =>
          send(
            "issue_environment_result",
            { error: String(error) },
            message.id,
          ),
      );
    }
  });
  await new Promise((done, reject) => {
    socket.once("open", done);
    socket.once("error", reject);
  });
  send("hello", {
    device: {
      id: "dev_concurrent_verify",
      label: "Isolated real-provider exercise",
      status: "connected",
      runtimeSettings: { maxConcurrentTasks: 2, activeRuntimeTtlMs: 60000 },
    },
    workspace: {
      id: workspaceId,
      name: "Concurrent expense workspace",
      localPath: source,
      baseline: "main",
      contextSummary: "Real multi-repository concurrent acceptance",
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
    (items) => items.some((item) => item.id === workspaceId),
    15000,
  );
  const tasks = [
    {
      runtime: "codex",
      title: "Implement exact monetary parsing",
      sourceInput: `Implement packages/money/index.mjs export parseMoney(value). Accept string decimal amounts with optional leading minus, digits, optionally a decimal point followed by 1 or 2 digits. Return exact safe integer cents; reject nonstrings, whitespace, exponent notation, invalid syntax, and values outside safe integer cents. Support negative refunds and the exact MAX_SAFE_INTEGER boundary. Add meaningful node:test tests inside packages/money and Docs/money.md explaining the domain decisions. Change the existing line in Docs/capabilities.md to exactly "Capabilities: money parsing." Do not implement report aggregation. Read AGENTS.md and domain guidance. Prepare only your target repository through the provided Foundry broker. Run your own tests and report results.`,
    },
    {
      runtime: reportRuntime,
      title: "Implement expense categorization",
      sourceInput: `Implement services/reports/core/index.mjs export summarize(entries). Input is an array of {category,amountCents}; category is a nonempty string, amountCents a safe integer (negative refunds allowed). Return {totalCents,categories:[{category,totalCents}]} with unique category totals sorted by category using JS lexical comparison. Empty input returns {totalCents:0,categories:[]}. Do not mutate inputs. Reject invalid input and unsafe intermediate/final sums. Safely handle category names such as __proto__. Add meaningful node:test tests inside this repository and Docs/reporting.md. Change the existing line in Docs/capabilities.md to exactly "Capabilities: expense reports." Do not implement money parsing. Read AGENTS.md and domain guidance. Prepare only your target repository through the provided Foundry broker. Run your own tests and report results.`,
    },
  ];
  for (const task of tasks) {
    const issue = resuming
      ? (await request(`/api/issues?workspaceId=${workspaceId}`)).find(
          (item) => item.title === task.title,
        )
      : await request("/api/issues", { workspaceId, ...task });
    assert.ok(issue, "Original Issue must survive restart");
    issueIds.push(issue.id);
    if (resuming && ["blocked"].includes(issue.status)) {
      const retained = store.environment(workspaceId, issue.id);
      recoveredSessions.set(issue.id, retained.nativeSessionId);
      saveJSON(resolve(root, `evidence/recovery-${issue.runtime}.json`), {
        previousRunId: issue.run.id,
        status: issue.run.status,
        nativeSessionRetained: Boolean(retained.nativeSessionId),
        cwd: retained.cwd,
      });
      await request(`/api/issues/${issue.id}/request-changes`, {
        expectedRunId: issue.run.id,
        message:
          "The previous run stopped while awaiting the model response. Continue the same task in this candidate. Complete the implementation, tests and documentation from the original request. Missing optional CLAUDE.md is normal; use the existing AGENTS.md and Docs/domain.md.",
      });
    }
  }
  let [money, reports] = await Promise.all(issueIds.map((id) => review(id)));
  await scheduler.whenIdle();
  for (const [id, nativeSessionId] of recoveredSessions)
    assert.equal(
      store.environment(workspaceId, id).nativeSessionId,
      nativeSessionId,
      "Recovery must reuse the native session",
    );
  assert.equal(peak, 2);
  const overlapMs =
    Math.min(intervals[0].end, intervals[1].end) -
    Math.max(intervals[0].start, intervals[1].start);
  assert.ok(overlapMs > 1000, "Real provider runs must overlap");
  assert.equal(
    fingerprint(),
    originalFingerprint,
    "Source changed before Accept",
  );
  for (const path of repoPaths)
    assert.equal(
      await git(resolve(source, path), ["rev-parse", "HEAD"]),
      originalHeads[path],
    );
  assert.notEqual(money.run.executionCwd, reports.run.executionCwd);
  for (const [issue, path] of [
    [money, "packages/money"],
    [reports, "services/reports/core"],
  ]) {
    const environment = store.environment(workspaceId, issue.id);
    assert.deepEqual(
      environment.repositories.map((repo) => repo.relativePath).sort(),
      [".", path].sort(),
    );
    assert.ok(environment.nativeSessionId);
    await inspect(issue, "initial");
    runNode(
      ["--test"],
      resolve(issue.run.executionCwd, path),
      `${issue.id}-${issue.runtime}-candidate-tests`,
    );
  }
  // Independent oracles exercise output behavior, not the generated tests alone.
  const moneyURL = pathToFileURL(
    resolve(money.run.executionCwd, "packages/money/index.mjs"),
  ).href;
  const reportURL = pathToFileURL(
    resolve(reports.run.executionCwd, "services/reports/core/index.mjs"),
  ).href;
  runNode(
    [
      "--input-type=module",
      "-e",
      oracle
        .replace("'./packages/money/index.mjs'", JSON.stringify(moneyURL))
        .replace(
          "'./services/reports/core/index.mjs'",
          JSON.stringify(reportURL),
        ),
    ],
    source,
    "independent-cross-candidate-oracle",
  );
  assert.equal(
    readFileSync(
      resolve(reports.run.executionCwd, "Docs/capabilities.md"),
      "utf8",
    ),
    "# Accepted capabilities\n\nCapabilities: expense reports.\n",
  );
  const nativeId = store.environment(workspaceId, reports.id).nativeSessionId;
  const retainedCwd = reports.run.executionCwd;
  log("Concurrent isolation verified", {
    peak,
    overlapMs,
    sourceFingerprint: originalFingerprint,
  });
  await accept(money);
  assert.equal(
    await git(resolve(source, "services/reports/core"), ["rev-parse", "HEAD"]),
    originalHeads["services/reports/core"],
  );
  const afterMoney = fingerprint();
  const conflict = await fetch(`${base}/api/issues/${reports.id}/accept`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ revision: reports.run.environmentRevision }),
  });
  const conflictText = await conflict.text();
  assert.ok(
    !conflict.ok,
    "Conflicting root change must not be silently accepted",
  );
  assert.match(conflictText, /conflict|merge/i);
  assert.equal(
    fingerprint(),
    afterMoney,
    "Conflict partially modified accepted source",
  );
  saveJSON(resolve(root, "evidence/conflict.json"), {
    status: conflict.status,
    body: conflictText,
  });
  log("Conflict blocked without source changes", { status: conflict.status });
  const priorRun = reports.run.id;
  const previousFeedbackCount =
    reports.messages?.filter((item) => item.role === "user").length ?? 0;
  await request(`/api/issues/${reports.id}/request-changes`, {
    expectedRunId: priorRun,
    message: `Money parsing has now been accepted. Resolve the Docs/capabilities.md merge conflict, retaining both capabilities in one line exactly: "Capabilities: money parsing; expense reports." Preserve Docs/money.md and your reporting implementation/tests. The previously accepted repository packages/money is visible in the original workspace for read-only validation; you do not need to prepare or modify it. Run your reporting tests again, verify both knowledge documents, and finish so Foundry can accept the combined Workspace.`,
  });
  reports = await review(reports.id, priorRun);
  await scheduler.whenIdle();
  assert.equal(reports.run.executionCwd, retainedCwd);
  assert.equal(
    store.environment(workspaceId, reports.id).nativeSessionId,
    nativeId,
  );
  assert.equal(
    fingerprint(),
    afterMoney,
    "Feedback execution changed source before Accept",
  );
  assert.equal(
    reports.messages.filter((item) => item.role === "user").length,
    previousFeedbackCount + 1,
  );
  await inspect(reports, "resolved");
  runNode(
    ["--test"],
    resolve(reports.run.executionCwd, "services/reports/core"),
    "resolved-report-tests",
  );
  await accept(reports);
  runNode(["acceptance.mjs"], source, "accepted-workspace-oracle");
  for (const path of ["packages/money", "services/reports/core"])
    runNode(
      ["--test"],
      resolve(source, path),
      `accepted-${path.replaceAll("/", "-")}-tests`,
    );
  assert.match(
    readFileSync(resolve(source, "Docs/capabilities.md"), "utf8"),
    /^Capabilities: money parsing; expense reports\.$/m,
  );
  for (const path of ["Docs/money.md", "Docs/reporting.md", "AGENTS.md"])
    assert.ok(readFileSync(resolve(source, path), "utf8").length > 20);
  assert.equal(
    await git(resolve(source, "archive/unused"), ["rev-parse", "HEAD"]),
    originalHeads["archive/unused"],
  );
  assert.equal(readFileSync(resolve(source, "acceptance.mjs"), "utf8"), oracle);
  const runs = await request(`/api/runs?workspaceId=${workspaceId}`);
  assert.equal(runs.filter((run) => run.status === "completed").length, 3);
  assert.ok(
    runs.every((run) =>
      ["completed", "canceled", "failed"].includes(run.status),
    ),
  );
  for (const id of issueIds) {
    assert.equal((await get(id)).status, "accepted");
    await request(`/api/issues/${id}/environment/cleanup`, {});
    assert.equal(store.environment(workspaceId, id).status, "cleaned");
  }
  for (const path of repoPaths)
    assert.equal(
      (await git(resolve(source, path), ["status", "--porcelain"])).trim(),
      "",
    );
  assert.deepEqual(errors, []);
  const result = {
    status: "passed",
    workspace: source,
    workspaceId,
    runtimes: [money.runtime, reports.runtime],
    maxWorkers: 2,
    peakConcurrentIssues: peak,
    overlapMs,
    runs: runs.map((run) => ({
      id: run.id,
      issueId: run.issueId,
      runtime: run.runtime,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      environmentRevision: run.environmentRevision,
    })),
    intervals,
    checks: [
      "non-Git root bootstrap with existing assets",
      "deep independent repo discovery",
      `real ${money.runtime} + ${reports.runtime} concurrency`,
      "lazy preparation leaves unused repositories untouched",
      "source content and HEADs unchanged before Accept",
      "generated candidate tests and independent behavioral oracle",
      "cross-repo conflict prevents partial application",
      "Request changes resumes same native session and CWD",
      "agent resolves root document conflict",
      "final Workspace integration tests",
      "all source repositories clean",
      "candidate worktrees cleaned; source work preserved",
    ],
    boundary:
      "Real Go server HTTP/WS and production execution/sandbox/scheduler/Accept; isolated daemon registration adapter, no browser clicks in this exercise.",
  };
  saveJSON(resolve(root, "result.json"), result);
  log("EXERCISE PASSED", {
    workspace: source,
    evidence: resolve(root, "result.json"),
  });
} catch (error) {
  saveJSON(resolve(root, "failure.json"), {
    error: String(error),
    stack: error.stack,
    intervals,
  });
  throw error;
} finally {
  for (const id of issueIds) cancelIssueExecution(id);
  await scheduler.whenIdle();
  socket?.close();
  server.kill("SIGTERM");
  // Keep the reviewable Workspace and evidence, but not copied login material.
  for (const id of issueIds) {
    const environment = store.environment(workspaceId, id);
    if (!environment) continue;
    for (const path of [
      "codex/auth.json",
      "codex/config.toml",
      "claude/.credentials.json",
    ])
      rmSync(resolve(environment.scratch, path), { force: true });
  }
}
