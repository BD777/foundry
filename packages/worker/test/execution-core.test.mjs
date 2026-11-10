import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executionHostStoppedError,
  processLabels,
} from "@bd777/foundry-protocol";
import {
  ExecutionCore,
  sessionSchedulingKey,
} from "../dist/daemon/execution-core.js";
import { HostExecutions } from "../dist/execution-host/executions.js";
import { ControlOutcomeUnknownError } from "../dist/session/session-control.js";
import { writeAgentSessionCompletionMarker } from "../dist/session/session-helpers.js";
import { SessionExecutionRegistry } from "../dist/session/session-state.js";
import { ConcurrentTaskScheduler } from "../dist/platform/task-scheduler.js";
import { writeFileAtomicAsync } from "../dist/platform/storage.js";

const pause = (ms = 0) => new Promise((done) => setTimeout(done, ms));

function session(id, fields = {}) {
  return {
    id,
    workspaceId: "ws_core",
    provider: "codex",
    status: "queued",
    input: { id: `${id}_in`, prompt: "go" },
    ...fields,
  };
}

/** A run each test finishes when it wants, recording what it was given. */
function controlledRuns() {
  const runs = [];
  const run = (serverURL, workspacePath, transport, payload) =>
    new Promise((resolve, reject) =>
      runs.push({ workspacePath, payload, resolve, reject }),
    );
  return { runs, run };
}

function core(t, options = {}) {
  const sent = [];
  const settled = [];
  const failures = [];
  const { runs, run } = controlledRuns();
  const registry = new SessionExecutionRegistry();
  const executions = new ExecutionCore({
    serverURL: "http://127.0.0.1:1",
    transport: { send: (type, payload) => sent.push({ type, payload }) },
    scheduler: new ConcurrentTaskScheduler(options.limit ?? 4),
    claims: registry,
    asksForIssues: options.asksForIssues ?? true,
    settled: () => settled.push(true),
    failed: (error) => failures.push(error),
    run,
  });
  t.after(() => assert.deepEqual(failures, []));
  return { executions, registry, sent, settled, runs };
}

test("everything for one Issue shares its key; other sessions run one input at a time each", () => {
  assert.equal(
    sessionSchedulingKey(
      session("sess_exec", { issueId: "iss_1", role: "issue_execution" }),
    ),
    "issue:iss_1",
  );
  assert.equal(
    sessionSchedulingKey(
      session("sess_clarify", {
        issueId: "iss_1",
        role: "issue_clarification",
      }),
    ),
    "issue:iss_1",
  );
  assert.equal(
    sessionSchedulingKey(session("sess_child", { issueId: "iss_1" })),
    "issue:iss_1",
  );
  assert.equal(
    sessionSchedulingKey(session("sess_chat")),
    "session:ws_core:codex:sess_chat",
  );
});

test("an input is accepted once, runs in its folder and settles with a request for Issues", async (t) => {
  const { executions, registry, sent, settled, runs } = core(t);
  const payload = {
    session: session("sess_issue", {
      issueId: "iss_run",
      role: "issue_execution",
    }),
  };
  assert.equal(
    executions.accept(payload, () => "/work"),
    true,
  );
  assert.equal(
    executions.accept(payload, () => "/work"),
    false,
    "a repeated dispatch never runs it again",
  );
  await pause();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].workspacePath, "/work");
  assert.equal(executions.scheduled(), 1);
  assert.equal(registry.isActive("sess_issue", "sess_issue_in"), true);
  runs[0].resolve();
  await pause();
  assert.equal(registry.isActive("sess_issue", "sess_issue_in"), false);
  assert.equal(executions.scheduled(), 0);
  assert.deepEqual(settled, [true]);
  assert.deepEqual(
    sent.map((message) => message.type),
    ["ready_for_issue"],
  );
});

test("a failed run is reported as the input's failure; a chat asks for no Issue", async (t) => {
  const { executions, sent, runs } = core(t);
  executions.accept({ session: session("sess_fail") }, () => "/work");
  await pause();
  runs[0].reject(new Error("native process exited"));
  await pause();
  assert.deepEqual(
    sent.map((message) => message.type),
    ["session_event", "session_completed"],
  );
  assert.equal(sent[1].payload.sessionId, "sess_fail");
  assert.equal(sent[1].payload.inputId, "sess_fail_in");
  assert.equal(sent[1].payload.error, "native process exited");
});

test("a folder gone when the input starts fails the input", async (t) => {
  const { executions, sent, runs } = core(t);
  executions.accept({ session: session("sess_moved") }, () => {
    throw new Error("The folder no longer exists on this device.");
  });
  await pause();
  assert.equal(runs.length, 0);
  const completed = sent.find(
    (message) => message.type === "session_completed",
  );
  assert.equal(
    completed.payload.error,
    "The folder no longer exists on this device.",
  );
});

test("an input that finished here before is reported again, not run", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "execution-core-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const { executions, sent, settled, runs } = core(t);
  const done = session("sess_done");
  writeAgentSessionCompletionMarker(workspace, done, {
    response: "Saved answer.",
    nativeSessionId: "native_done",
  });
  assert.equal(
    executions.accept({ session: done }, () => workspace),
    true,
  );
  await pause();
  assert.equal(runs.length, 0);
  assert.deepEqual(settled, [true]);
  assert.deepEqual(sent, [
    {
      type: "session_completed",
      payload: {
        sessionId: "sess_done",
        inputId: "sess_done_in",
        nativeSessionId: "native_done",
        response: "Saved answer.",
      },
    },
  ]);
});

test("an Issue's sessions wait for each other and say why; a once worker asks for nothing more", async (t) => {
  const { executions, sent, runs } = core(t, { asksForIssues: false });
  executions.accept(
    {
      session: session("sess_exec", {
        issueId: "iss_one",
        role: "issue_execution",
      }),
    },
    () => "/work",
  );
  executions.accept(
    { session: session("sess_child", { issueId: "iss_one" }) },
    () => "/work",
  );
  executions.accept({ session: session("sess_chat") }, () => "/work");
  await pause();
  assert.deepEqual(
    runs.map((run) => run.payload.session.id),
    ["sess_exec", "sess_chat"],
  );
  const waiting = sent.find(
    (message) => message.payload.event?.label === processLabels.waitingForSlot,
  );
  assert.equal(waiting.payload.event.sessionId, "sess_child");
  assert.match(waiting.payload.event.detail, /previous turn is still running/);
  runs[0].resolve();
  await pause();
  assert.deepEqual(
    runs.map((run) => run.payload.session.id),
    ["sess_exec", "sess_chat", "sess_child"],
  );
  runs[1].resolve();
  runs[2].resolve();
  await pause();
  assert.equal(
    sent.some((message) => message.type === "ready_for_issue"),
    false,
  );
});

function host(t, root, options = {}) {
  const received = [];
  const { runs, run } = controlledRuns();
  let changes = 0;
  const executions = new HostExecutions({
    root,
    serverURL: "http://127.0.0.1:1",
    scheduler: new ConcurrentTaskScheduler(4),
    changed: () => changes++,
    failed: (error) => assert.fail(error),
    run,
    ...options,
  });
  const socket = {
    readyState: 1,
    send: (data) => received.push(JSON.parse(data)),
  };
  executions.transport.bind(socket);
  t.after(() => executions.transport.unbind(socket));
  return { executions, received, runs, changes: () => changes };
}

test("the host's claims outlive it: a repeated dispatch never reruns, an interrupted input is reported", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "host-executions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = host(t, root);
  const finished = { session: session("sess_finished") };
  const interrupted = { session: session("sess_interrupted") };
  const request = (payload) => ({ workspacePath: "/work", payload });
  assert.deepEqual(await first.executions.run(request(finished)), {
    status: "active",
  });
  await first.executions.run(request(interrupted));
  await pause();
  assert.equal(first.changes(), 2, "each accepted input is announced");
  first.runs[0].resolve();
  await pause();
  await first.executions.flush();
  assert.deepEqual(
    first.executions.active().map((claim) => claim.sessionId),
    ["sess_interrupted"],
  );
  assert.deepEqual(
    Object.values(
      JSON.parse(readFileSync(join(root, "claims.json"), "utf8")),
    ).map((claim) => [claim.sessionId, claim.status]),
    [
      ["sess_finished", "completed"],
      ["sess_interrupted", "active"],
    ],
    "claims are kept on disk",
  );

  // The host process is replaced while sess_interrupted runs.
  const second = host(t, root);
  await second.executions.reportInterrupted();
  const report = second.received.find(
    (envelope) =>
      envelope.type === "session_completed" &&
      envelope.payload.sessionId === "sess_interrupted",
  );
  assert.equal(report.payload.error, executionHostStoppedError);
  assert.deepEqual(await second.executions.run(request(finished)), {
    status: "completed",
  });
  assert.deepEqual(await second.executions.run(request(interrupted)), {
    status: "completed",
  });
  await pause();
  assert.equal(second.runs.length, 0, "neither input runs a second time");
  assert.deepEqual(second.executions.active(), []);
});

test("claims migrate to active plus the recent completion window in one compact write", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "host-claims-migration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  const recent = new Date(now - 60 * 60 * 1000).toISOString();
  const stale = new Date(now - 25 * 60 * 60 * 1000).toISOString();
  const active = `sess_${now}_active`;
  const recentDone = `sess_${now}_recent`;
  const staleDone = `sess_${now}_stale`;
  const legacyDone = `sess_${now - 48 * 60 * 60 * 1000}_legacy`;
  writeFileSync(
    join(root, "claims.json"),
    `${JSON.stringify(
      {
        [`${active}/input_active`]: {
          sessionId: active,
          inputId: "input_active",
          status: "active",
        },
        [`${recentDone}/input_recent`]: {
          sessionId: recentDone,
          inputId: "input_recent",
          status: "completed",
          completedAt: recent,
        },
        [`${staleDone}/input_stale`]: {
          sessionId: staleDone,
          inputId: "input_stale",
          status: "completed",
          completedAt: stale,
        },
        [`${legacyDone}/input_legacy`]: {
          sessionId: legacyDone,
          inputId: "input_legacy",
          status: "completed",
        },
      },
      null,
      2,
    )}\n`,
  );
  let writes = 0;
  const first = host(t, root, {
    claimWriteDelayMs: 1_000,
    writeClaims: async (path, contents, options) => {
      writes++;
      await writeFileAtomicAsync(path, contents, options);
    },
  });

  await first.executions.flush();

  const raw = readFileSync(join(root, "claims.json"), "utf8");
  const migrated = JSON.parse(raw);
  assert.equal(writes, 1, "the startup cleanup is coalesced into one write");
  assert.equal(raw.trim().split("\n").length, 1, "claims are stored compactly");
  assert.deepEqual(
    Object.values(migrated)
      .map((claim) => claim.sessionId)
      .sort(),
    [active, recentDone].sort(),
  );
  assert.deepEqual(first.executions.active(), [
    { sessionId: active, inputId: "input_active" },
  ]);
});

test("rapid accepted claims share one durable write", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "host-claims-batch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let writes = 0;
  const first = host(t, root, {
    claimWriteDelayMs: 20,
    writeClaims: async (path, contents, options) => {
      writes++;
      await writeFileAtomicAsync(path, contents, options);
    },
  });
  const request = (id) => ({
    workspacePath: "/work",
    payload: { session: session(id) },
  });

  await Promise.all([
    first.executions.run(request("sess_batch_a")),
    first.executions.run(request("sess_batch_b")),
  ]);

  assert.equal(writes, 1);
  assert.deepEqual(
    first.executions
      .active()
      .map((claim) => claim.sessionId)
      .sort(),
    ["sess_batch_a", "sess_batch_b"],
  );
});

test("a coalesced claims write preserves a claim added by another host", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "host-claims-merge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = host(t, root, { claimWriteDelayMs: 20 });
  const local = "sess_merge_local";
  const remote = "sess_merge_remote";

  const writing = first.executions.run({
    workspacePath: "/work",
    payload: { session: session(local) },
  });
  writeFileSync(
    join(root, "claims.json"),
    JSON.stringify({
      [`${remote}/input_remote`]: {
        sessionId: remote,
        inputId: "input_remote",
        status: "active",
      },
    }),
  );
  await writing;

  assert.deepEqual(
    Object.values(JSON.parse(readFileSync(join(root, "claims.json"), "utf8")))
      .map((claim) => claim.sessionId)
      .sort(),
    [local, remote],
  );
});

test("a pending coalesced claim write flushes on process exit", (t) => {
  const root = mkdtempSync(join(tmpdir(), "host-claims-exit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "claims.json");
  const storageURL = new URL("../dist/platform/storage.js", import.meta.url)
    .href;
  const script = `
    import { CoalescedJSONWriter } from ${JSON.stringify(storageURL)};
    const state = {};
    const writer = new CoalescedJSONWriter(${JSON.stringify(path)}, () => state, { delayMs: 60_000 });
    state.claim = { status: "active" };
    writer.change();
    process.exit(0);
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 5_000 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    claim: { status: "active" },
  });
});

test("the host applies a steer at most once and reports an ended input stopped", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "host-controls-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "controls.json"),
    JSON.stringify({ "sess_steered/steer_lost": "pending" }),
  );
  const { executions, runs } = host(t, root);
  const steer = (inputId) => ({
    sessionId: "sess_steered",
    inputId,
    message: "and also this",
    attachments: [],
  });
  await assert.rejects(
    executions.steer(steer("steer_lost")),
    ControlOutcomeUnknownError,
    "a steer whose outcome an earlier host lost is never applied again",
  );
  await assert.rejects(
    executions.steer(steer("steer_new")),
    /not accepting active steer input/,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, "controls.json"), "utf8")),
    { "sess_steered/steer_lost": "pending" },
    "a refused steer may be sent again",
  );
  await assert.rejects(executions.steer({ ...steer(), inputId: undefined }));

  await executions.run({
    workspacePath: "/work",
    payload: { session: session("sess_ended") },
  });
  await pause();
  runs[0].resolve();
  await pause();
  assert.deepEqual(
    await executions.cancel({
      sessionId: "sess_ended",
      inputId: "sess_ended_in",
    }),
    { inputId: "sess_ended_in", stopped: true },
  );
});
