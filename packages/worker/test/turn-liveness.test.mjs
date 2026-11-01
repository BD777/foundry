import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ClaudeTurnLiveness,
  CodexTurnLiveness,
  claudeOperationBounds,
  claudeToolBound,
  turnLivenessNoticeText,
  turnLivenessSettings,
} from "../dist/watchdog.js";
import { AgentSessionCanceledError } from "../dist/session-control.js";
import { claudeTurnLivenessError } from "../dist/runner/claude-turn.js";
import {
  cleanupActiveClaudeRuntimes,
  closeActiveClaudeRuntime,
} from "../dist/runner/active-runtimes.js";
import {
  handleActiveClaudeMessage,
  startActiveClaudePump,
} from "../dist/runner/claude-messages.js";
import { activeClaudeRuntimes } from "../dist/session-state.js";

const minute = 60_000;

function clock() {
  let now = 1_000_000;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

function claudeLiveness(overrides = {}) {
  const time = clock();
  const notices = [];
  const failures = [];
  const liveness = new ClaudeTurnLiveness(
    {
      quietNoticeMs: 10 * minute,
      graceMs: 2 * minute,
      ceilingMs: 0,
      checkIntervalMs: 1e9,
      now: time.now,
      onNotice: (notice) => notices.push(notice),
      onFailure: (failure) => failures.push(failure),
      ...overrides,
    },
    claudeOperationBounds({}),
  );
  return { liveness, time, notices, failures };
}

const toolUse = (id, name, input) => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const toolResult = (id, extra = {}) => ({
  type: "user",
  parent_tool_use_id: null,
  message: {
    content: [
      { type: "tool_result", tool_use_id: id, content: "ok", ...extra },
    ],
  },
});
const result = (text) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: text,
});
const assistant = (text) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

test("silence while a tool runs is not a stall; past the tool's own bound it looks stuck, once", () => {
  const { liveness, time, notices, failures } = claudeLiveness();
  try {
    liveness.observe(
      toolUse("toolu_ping", "Bash", {
        command: "ping -c 400 x",
        timeout: 300_000,
      }),
    );
    time.advance(6 * minute);
    liveness.check();
    assert.deepEqual(notices, [], "inside its 5 min timeout + grace");
    time.advance(2 * minute);
    liveness.check();
    assert.equal(notices.length, 1);
    assert.equal(notices[0].kind, "overdue");
    assert.match(
      turnLivenessNoticeText(notices[0]),
      /Bash has been running for 8 min, past its 5 min limit \(the command's timeout\)/,
    );
    time.advance(60 * minute);
    liveness.check();
    assert.equal(notices.length, 1, "no repeated notices, no quiet notice");
    assert.deepEqual(failures, [], "an hour of silence fails nothing");

    const finished = liveness.observe(toolResult("toolu_ping"));
    assert.equal(finished.length, 1);
    assert.equal(finished[0].id, "toolu_ping");
    assert.equal(finished[0].failed, false);
    assert.match(finished[0].detail, /Bash/);
    assert.equal(liveness.inFlight().length, 0);
  } finally {
    liveness.close();
  }
});

test("quiet with nothing in flight is reported once per quiet spell and never fails the turn", () => {
  const { liveness, time, notices, failures } = claudeLiveness();
  try {
    liveness.observe(result("intermediate"));
    time.advance(9 * minute);
    liveness.check();
    assert.deepEqual(notices, []);
    time.advance(minute);
    liveness.check();
    assert.deepEqual(
      notices.map((notice) => notice.kind),
      ["quiet"],
    );
    assert.match(
      turnLivenessNoticeText(notices[0]),
      /No progress for 10 min and nothing is known to be running/,
    );
    time.advance(30 * minute);
    liveness.check();
    assert.equal(notices.length, 1);
    liveness.observe({ type: "system", subtype: "task_progress" });
    time.advance(10 * minute);
    liveness.check();
    assert.equal(notices.length, 2, "a new quiet spell is reported again");
    assert.deepEqual(failures, []);
  } finally {
    liveness.close();
  }
});

test("background work the turn waits on is expected silence", () => {
  const { liveness, time, notices } = claudeLiveness({
    backgroundBusy: () => true,
  });
  try {
    liveness.observe(result("waiting for the sleep"));
    time.advance(45 * minute);
    liveness.check();
    assert.deepEqual(notices, []);
  } finally {
    liveness.close();
  }
});

test("a model request is bounded by API_TIMEOUT_MS from its last stream event; keep-alive pings count", () => {
  const { liveness, time, notices } = claudeLiveness();
  try {
    liveness.observe({
      type: "system",
      subtype: "status",
      status: "requesting",
    });
    for (let i = 0; i < 20; i += 1) {
      time.advance(minute);
      liveness.observe({ type: "stream_event", event: { type: "ping" } });
      liveness.check();
    }
    assert.deepEqual(notices, [], "a long but streaming request is fine");
    time.advance(12 * minute);
    liveness.check();
    assert.equal(notices.length, 1);
    assert.match(
      turnLivenessNoticeText(notices[0]),
      /model request has had no response .*10 min limit \(API_TIMEOUT_MS\)/,
    );
    liveness.observe({ type: "stream_event", event: { type: "message_stop" } });
    assert.equal(liveness.inFlight().length, 0);
  } finally {
    liveness.close();
  }
});

test("a retry waits out its delay plus the request timeout; compaction is in flight until it ends", () => {
  const { liveness, time, notices } = claudeLiveness();
  try {
    liveness.observe({
      type: "system",
      subtype: "api_retry",
      attempt: 2,
      max_retries: 10,
      retry_delay_ms: 5 * minute,
    });
    time.advance(16 * minute);
    liveness.check();
    assert.deepEqual(notices, []);
    liveness.observe({ type: "stream_event", event: { type: "message_stop" } });
    liveness.observe({
      type: "system",
      subtype: "status",
      status: "compacting",
    });
    assert.deepEqual(
      liveness.inFlight().map((op) => op.kind),
      ["compaction"],
    );
    liveness.observe({ type: "system", subtype: "compact_boundary" });
    assert.equal(liveness.inFlight().length, 0);
  } finally {
    liveness.close();
  }
});

test("a new process that sends nothing fails start-up in the spawn phase", () => {
  const { liveness, time, failures, notices } = claudeLiveness({
    startupTimeoutMs: 3 * minute,
    firstResponseTimeoutMs: 12 * minute,
  });
  time.advance(3 * minute - 1);
  liveness.check();
  assert.deepEqual(failures, []);
  time.advance(1);
  liveness.check();
  assert.deepEqual(failures, [
    { kind: "startup", phase: "spawn", waitedMs: 3 * minute },
  ]);
  assert.deepEqual(notices, []);
  const error = claudeTurnLivenessError(
    failures[0],
    "noise\nError: keychain locked; waiting for unlock\n",
  );
  assert.equal(error.subtype, "startup_timeout");
  assert.match(error.message, /did not start/);
  assert.match(error.message, /phase: starting the process/);
  assert.match(error.message, /keychain locked; waiting for unlock/);
});

test("a new process that never reaches the model fails in the first-response phase; a retry ends start-up", () => {
  const hung = claudeLiveness({
    startupTimeoutMs: 3 * minute,
    firstResponseTimeoutMs: 12 * minute,
  });
  hung.time.advance(minute);
  hung.liveness.observe({ type: "system", subtype: "init" });
  hung.liveness.observe({
    type: "system",
    subtype: "status",
    status: "requesting",
  });
  hung.time.advance(12 * minute);
  hung.liveness.check();
  assert.equal(hung.failures.length, 1);
  assert.equal(hung.failures[0].phase, "first response");
  assert.match(
    claudeTurnLivenessError(hung.failures[0]).message,
    /never reached the model .*phase: sign-in or first response/,
  );

  const retrying = claudeLiveness({
    startupTimeoutMs: 3 * minute,
    firstResponseTimeoutMs: 12 * minute,
  });
  try {
    retrying.liveness.observe({ type: "system", subtype: "init" });
    retrying.liveness.observe({
      type: "system",
      subtype: "api_retry",
      retry_delay_ms: 1000,
    });
    retrying.time.advance(30 * minute);
    retrying.liveness.check();
    assert.deepEqual(retrying.failures, []);
  } finally {
    retrying.liveness.close();
  }
});

test("the per-turn ceiling is the only time limit on a running turn", () => {
  const { liveness, time, failures } = claudeLiveness({
    ceilingMs: 12 * 60 * minute,
  });
  liveness.observe(toolUse("toolu_task", "Task", { prompt: "long" }));
  time.advance(11 * 60 * minute);
  liveness.check();
  assert.deepEqual(failures, []);
  time.advance(60 * minute);
  liveness.check();
  assert.equal(failures[0].kind, "ceiling");
  assert.match(
    claudeTurnLivenessError(failures[0]).message,
    /12 h.*FOUNDRY_TURN_MAX_DURATION_MS/,
  );
});

test("liveness settings default to a 10 min notice, 3 min start-up, 12 h ceiling", () => {
  assert.deepEqual(turnLivenessSettings({}), {
    quietNoticeMs: 600_000,
    startupTimeoutMs: 180_000,
    graceMs: 120_000,
    ceilingMs: 43_200_000,
  });
  assert.equal(
    turnLivenessSettings({ FOUNDRY_TURN_MAX_DURATION_MS: "0" }).ceilingMs,
    0,
  );
  assert.equal(
    turnLivenessSettings({ FOUNDRY_TURN_QUIET_NOTICE_MS: "60000" })
      .quietNoticeMs,
    60_000,
  );
});

test("tool bounds are Claude Code's own", () => {
  const defaults = claudeOperationBounds({});
  assert.deepEqual(claudeToolBound("Bash", { command: "ls" }, defaults), {
    boundMs: 120_000,
    boundSource: "BASH_DEFAULT_TIMEOUT_MS",
  });
  assert.equal(
    claudeToolBound("Bash", { command: "x", timeout: 3_600_000 }, defaults)
      .boundMs,
    600_000,
    "clamped to BASH_MAX_TIMEOUT_MS",
  );
  assert.equal(
    claudeToolBound(
      "Bash",
      { command: "x", timeout: 3_600_000 },
      claudeOperationBounds({ BASH_MAX_TIMEOUT_MS: "7200000" }),
    ).boundMs,
    3_600_000,
  );
  assert.equal(
    claudeToolBound(
      "Bash",
      { command: "x", run_in_background: true },
      defaults,
    ),
    undefined,
  );
  assert.deepEqual(claudeToolBound("mcp__foundry__wait", {}, defaults), {
    boundMs: 100_000_000,
    boundSource: "MCP_TOOL_TIMEOUT",
  });
  assert.equal(claudeToolBound("Task", {}, defaults), undefined);
  assert.equal(
    claudeOperationBounds({ API_TIMEOUT_MS: "1200000" }).apiTimeoutMs,
    1_200_000,
  );
});

test("a Codex command in flight is not a silent model stream", () => {
  const time = clock();
  const notices = [];
  const liveness = new CodexTurnLiveness({
    quietNoticeMs: 10 * minute,
    graceMs: 2 * minute,
    ceilingMs: 0,
    checkIntervalMs: 1e9,
    now: time.now,
    onNotice: (notice) => notices.push(notice),
    onFailure: () => assert.fail("Codex quiet never fails"),
  });
  try {
    liveness.observe({ type: "turn.started" });
    liveness.observe({
      type: "item.started",
      item: { id: "cmd_1", type: "command_execution", command: "make" },
    });
    time.advance(40 * minute);
    liveness.check();
    assert.deepEqual(notices, []);
    liveness.observe({
      type: "item.completed",
      item: { id: "cmd_1", type: "command_execution" },
    });
    time.advance(8 * minute);
    liveness.check();
    assert.equal(notices.length, 1);
    assert.match(turnLivenessNoticeText(notices[0]), /stream_idle_timeout_ms/);
  } finally {
    liveness.close();
  }
});

// --- In the runner ---------------------------------------------------------

function fixture(directory, { waitForBackgroundTasks = false } = {}) {
  const events = [];
  const time = clock();
  const turn = {
    emit: async (label, detail, level, metadata, message) =>
      events.push({ label, detail, level, metadata, message }),
    finalResult: "",
    messagesPath: join(directory, "messages.jsonl"),
    nativeSessionId: "native_live",
    openTaskIds: new Set(),
    partialResult: "",
    reject: (error) => {
      turn.rejected = error;
    },
    resolve: (value) => {
      turn.resolved = value;
    },
    resultPath: join(directory, "result.md"),
    startedAt: Date.now(),
    waitForBackgroundTasks,
  };
  turn.liveness = new ClaudeTurnLiveness(
    {
      quietNoticeMs: 10 * minute,
      graceMs: 2 * minute,
      ceilingMs: 0,
      checkIntervalMs: 1e9,
      now: time.now,
      backgroundBusy: () => turn.openTaskIds.size > 0,
      onNotice: (notice) => events.push({ label: "Notice", notice }),
      onFailure: (failure) => events.push({ label: "failure", failure }),
    },
    claudeOperationBounds({}),
  );
  writeFileSync(turn.messagesPath, "");
  const runtime = {
    closed: false,
    foundrySessionId: "sess_live",
    input: { close: () => undefined },
    key: "runtime_live",
    lastUsed: Date.now(),
    nativeSessionId: "native_live",
    pending: turn,
  };
  return { turn, runtime, events, time };
}

test("a long foreground tool reads as running until its result, and its silence fails nothing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-liveness-"));
  try {
    const { turn, runtime, events, time } = fixture(directory);
    await handleActiveClaudeMessage(
      runtime,
      toolUse("toolu_ping", "Bash", { command: "ping -c 120 127.0.0.1" }),
    );
    const started = events.find(
      (event) => event.message?.callId === "toolu_ping",
    );
    assert.equal(started.label, "Using tool");
    assert.equal(started.message.status, "running");
    time.advance(30 * minute);
    turn.liveness.check();
    assert.equal(events.filter((event) => event.label === "failure").length, 0);
    assert.equal(runtime.pending, turn);
    await handleActiveClaudeMessage(runtime, toolResult("toolu_ping"));
    const finished = events.findLast(
      (event) => event.message?.callId === "toolu_ping",
    );
    assert.equal(finished.label, "Used tool");
    assert.equal(finished.message.status, "completed");
    assert.equal(finished.message.id, started.message.id);
    assert.equal(finished.message.text, started.message.text);
    await handleActiveClaudeMessage(
      runtime,
      toolUse("toolu_bad", "Read", { file_path: "/missing" }),
    );
    await handleActiveClaudeMessage(
      runtime,
      toolResult("toolu_bad", { is_error: true }),
    );
    assert.equal(events.at(-1).label, "Tool failed");
    assert.equal(events.at(-1).message.status, "failed");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("an answered turn that waits for background work completes with its answer when stopped", async () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-liveness-"));
  try {
    const { turn, runtime, events } = fixture(directory, {
      waitForBackgroundTasks: true,
    });
    await handleActiveClaudeMessage(runtime, {
      type: "system",
      subtype: "task_started",
      task_id: "bmon",
      task_type: "local_bash",
    });
    await handleActiveClaudeMessage(runtime, assistant("Here is the answer."));
    await handleActiveClaudeMessage(runtime, result("Here is the answer."));
    assert.equal(runtime.pending, turn, "still waiting for the monitor");

    closeActiveClaudeRuntime(runtime, new AgentSessionCanceledError());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(turn.rejected, undefined, "not failed, not canceled");
    assert.deepEqual(turn.resolved, {
      nativeSessionId: "native_live",
      response: "Here is the answer.",
    });
    assert.equal(
      readFileSync(turn.resultPath, "utf8"),
      "Here is the answer.\n",
    );
    const note = events.find(
      (event) => event.label === "Notice" && event.level === "warning",
    );
    assert.match(note.detail, /it was stopped before the background work/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("an answered turn keeps its answer when the agent process dies", async () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-liveness-"));
  try {
    const { turn, runtime, events } = fixture(directory, {
      waitForBackgroundTasks: true,
    });
    await handleActiveClaudeMessage(runtime, {
      type: "system",
      subtype: "task_started",
      task_id: "bmon",
    });
    await handleActiveClaudeMessage(runtime, assistant("Done; monitoring."));
    await handleActiveClaudeMessage(runtime, result("Done; monitoring."));
    closeActiveClaudeRuntime(
      runtime,
      new Error("Claude Agent SDK stream ended before a result message"),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(turn.resolved.response, "Done; monitoring.");
    assert.match(
      events.find((event) => event.label === "Notice").detail,
      /stream ended before a result message/,
    );

    // Without an answer, the same end is a failure.
    const { turn: unanswered, runtime: other } = fixture(directory, {
      waitForBackgroundTasks: true,
    });
    closeActiveClaudeRuntime(other, new Error("process exited with code 1"));
    assert.match(unanswered.rejected.message, /exited with code 1/);
    assert.equal(unanswered.resolved, undefined);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("the idle reaper never reaps a runtime that is busy with a turn or its own continuation", () => {
  const saved = new Map(activeClaudeRuntimes);
  activeClaudeRuntimes.clear();
  const directory = mkdtempSync(join(tmpdir(), "foundry-liveness-"));
  try {
    const turnBusy = fixture(directory).runtime;
    turnBusy.key = "turn_busy";
    const continuing = {
      ...fixture(directory).runtime,
      key: "continuing",
      pending: undefined,
      continuation: { startedAt: 0, finalResult: "", partialResult: "" },
    };
    const idle = {
      ...fixture(directory).runtime,
      key: "idle",
      pending: undefined,
    };
    for (const runtime of [turnBusy, continuing, idle]) {
      runtime.lastUsed = 0;
      activeClaudeRuntimes.set(runtime.key, runtime);
    }
    cleanupActiveClaudeRuntimes();
    assert.deepEqual([...activeClaudeRuntimes.keys()].sort(), [
      "continuing",
      "turn_busy",
    ]);
    assert.equal(turnBusy.closed, false);
    assert.equal(turnBusy.pending.rejected, undefined);
    assert.equal(idle.closed, true);
    turnBusy.pending.liveness.close();
  } finally {
    activeClaudeRuntimes.clear();
    for (const [key, runtime] of saved) activeClaudeRuntimes.set(key, runtime);
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a runtime that ends after a newer one took its key leaves the newer one registered and open", async (t) => {
  const stale = {
    "an error result": {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["boom"],
    },
    "an answer without text": result(""),
  };
  for (const [name, message] of Object.entries(stale))
    await t.test(name, async () => {
      const saved = new Map(activeClaudeRuntimes);
      activeClaudeRuntimes.clear();
      const directory = mkdtempSync(join(tmpdir(), "foundry-liveness-"));
      try {
        const newer = fixture(directory);
        newer.turn.liveness.close();
        newer.runtime.pending = undefined;
        activeClaudeRuntimes.set(newer.runtime.key, newer.runtime);
        // The process the newer one replaced, under the same key.
        const { runtime } = fixture(directory);
        await handleActiveClaudeMessage(runtime, message);
        assert.equal(runtime.closed, true);
        assert.equal(
          activeClaudeRuntimes.get(runtime.key),
          newer.runtime,
          "the newer runtime is still registered",
        );
        assert.equal(newer.runtime.closed, false);
      } finally {
        activeClaudeRuntimes.clear();
        for (const [key, runtime] of saved)
          activeClaudeRuntimes.set(key, runtime);
        rmSync(directory, { force: true, recursive: true });
      }
    });
});

test("a reaped process that exits after a newer one took its key leaves the newer one registered and open", async () => {
  const saved = new Map(activeClaudeRuntimes);
  activeClaudeRuntimes.clear();
  const directory = mkdtempSync(join(tmpdir(), "foundry-liveness-"));
  try {
    const reaped = fixture(directory);
    reaped.turn.liveness.close();
    reaped.runtime.pending = undefined;
    reaped.runtime.lastUsed = 0;
    // The SDK stream of a process that ends only when it exits.
    let exit;
    let streamEnded = false;
    const stream = (async function* () {
      try {
        await new Promise((resolve) => {
          exit = resolve;
        });
      } finally {
        streamEnded = true;
      }
    })();
    startActiveClaudePump(reaped.runtime, stream);
    activeClaudeRuntimes.set(reaped.runtime.key, reaped.runtime);
    cleanupActiveClaudeRuntimes();
    assert.equal(reaped.runtime.closed, true);
    assert.equal(activeClaudeRuntimes.has(reaped.runtime.key), false);

    // A new process for the same key, started before the old one exited.
    const newer = fixture(directory);
    newer.turn.liveness.close();
    newer.runtime.pending = undefined;
    activeClaudeRuntimes.set(newer.runtime.key, newer.runtime);
    exit();
    for (let waited = 0; !streamEnded; waited += 5) {
      if (waited > 2000) throw new Error("the old process never exited");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // The pump's finally runs right after the stream ends.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      activeClaudeRuntimes.get(newer.runtime.key),
      newer.runtime,
      "the newer runtime is still registered",
    );
    assert.equal(newer.runtime.closed, false);
  } finally {
    activeClaudeRuntimes.clear();
    for (const [key, runtime] of saved) activeClaudeRuntimes.set(key, runtime);
    rmSync(directory, { force: true, recursive: true });
  }
});
