import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ClaudeBackgroundTaskTracker,
  backgroundExitCode,
  backgroundTasksPath,
  finishedBackgroundTasksKept,
  plainTerminalText,
  readBackgroundTaskOutput,
  verifiedTaskOutputPath,
} from "../dist/agent-background-tasks.js";

// Stream lines as Claude Code 2.1.295 emits them (trimmed to the fields read).
const bashToolUse = (id, command) => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: {
    content: [
      {
        type: "tool_use",
        id,
        name: "Bash",
        input: {
          command,
          description: "Sleep then echo",
          run_in_background: true,
        },
      },
    ],
  },
});
const listed = (...tasks) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks,
});
const started = (taskId, toolUseId, extra = {}) => ({
  type: "system",
  subtype: "task_started",
  task_id: taskId,
  tool_use_id: toolUseId,
  description: "Sleep then echo",
  task_type: "local_bash",
  is_backgrounded: true,
  ...extra,
});
const backgroundResult = (toolUseId, taskId, outputFile) => ({
  type: "user",
  parent_tool_use_id: null,
  tool_use_result: {
    stdout: "",
    stderr: "",
    interrupted: false,
    backgroundTaskId: taskId,
  },
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: `Command running in background with ID: ${taskId}. Output is being written to: ${outputFile}`,
      },
    ],
  },
});
const updated = (taskId, patch) => ({
  type: "system",
  subtype: "task_updated",
  task_id: taskId,
  patch,
});
const notified = (taskId, status, summary, outputFile = "") => ({
  type: "system",
  subtype: "task_notification",
  task_id: taskId,
  status,
  summary,
  output_file: outputFile,
});

function makeTracker(options = {}) {
  const events = [];
  const root = options.root;
  let clock = Date.parse("2026-10-09T15:00:00Z");
  const tracker = new ClaudeBackgroundTaskTracker({
    emit: (event) => events.push(event),
    sessionId: () => "sess_bg",
    sessionsRoot: root ? () => root : undefined,
    scratchDirectory: options.scratch ? () => options.scratch : undefined,
    now: () => clock,
  });
  const latest = () =>
    events.filter((event) => event.metadata?.backgroundTaskSnapshot).at(-1)
      ?.metadata.backgroundTaskSnapshot;
  return {
    events,
    latest,
    tick: (ms) => {
      clock += ms;
    },
    tracker,
  };
}

test("a background command runs, completes with its exit code, and keeps its log", () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-bg-"));
  try {
    const { latest, tick, tracker } = makeTracker({ root });
    const output = "/tmp/fdy-x/claude-1003/-ws/0a1/tasks/bodu0c8pc.output";
    tracker.observe(
      bashToolUse(
        "toolu_1",
        "API_KEY=sk-abcdefghijklmnop sleep 720 && echo done",
      ),
    );
    tracker.observe(
      listed({
        task_id: "bodu0c8pc",
        task_type: "local_bash",
        description: "Sleep then echo",
      }),
    );
    tracker.observe(started("bodu0c8pc", "toolu_1"));
    tracker.observe(backgroundResult("toolu_1", "bodu0c8pc", output));
    let snapshot = latest();
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0].status, "running");
    assert.equal(snapshot[0].kind, "command");
    assert.equal(snapshot[0].hasOutput, true);
    assert.equal(snapshot[0].command, undefined, "events never carry commands");
    assert.equal(tracker.hasRunning(), true);
    const record = tracker.record("bodu0c8pc");
    assert.equal(record.outputPath, output);
    assert.match(record.command, /\[REDACTED\]/);
    assert.doesNotMatch(record.command, /sk-abcdefghijklmnop/);

    tick(7 * 60_000);
    tracker.observe(
      updated("bodu0c8pc", {
        status: "completed",
        end_time: Date.parse("2026-10-09T15:07:00Z"),
      }),
    );
    tracker.observe(
      notified(
        "bodu0c8pc",
        "completed",
        'Background command "Sleep then echo" completed (exit code 0)',
        output,
      ),
    );
    tracker.observe(listed());
    snapshot = latest();
    assert.equal(snapshot[0].status, "completed");
    assert.equal(snapshot[0].exitCode, 0);
    assert.equal(snapshot[0].endedAt, "2026-10-09T15:07:00.000Z");
    assert.equal(tracker.hasRunning(), false);

    const persisted = JSON.parse(
      readFileSync(backgroundTasksPath(root, "sess_bg"), "utf8"),
    );
    assert.equal(persisted.tasks[0].outputPath, output);
    assert.match(persisted.tasks[0].command, /\[REDACTED\]/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a failing command reads failed with the exit code from Claude's summary", () => {
  const { latest, tracker } = makeTracker();
  tracker.observe(bashToolUse("toolu_2", "sleep 3; exit 7"));
  tracker.observe(
    listed({
      task_id: "b5fu6ea3n",
      task_type: "local_bash",
      description: "Exit 7",
    }),
  );
  tracker.observe(started("b5fu6ea3n", "toolu_2"));
  tracker.observe(
    notified(
      "b5fu6ea3n",
      "failed",
      'Background command "Run sleep 3 then exit 7 in background" failed with exit code 7',
    ),
  );
  const [task] = latest();
  assert.equal(task.status, "failed");
  assert.equal(task.exitCode, 7);
  assert.equal(backgroundExitCode("failed with exit code 144"), 144);
  assert.equal(backgroundExitCode("Sleep then echo"), undefined);
});

test("a stop Foundry asked for reads as stopped by the person", () => {
  const { latest, tracker } = makeTracker();
  tracker.observe(bashToolUse("toolu_3", "sleep 300"));
  tracker.observe(
    listed({
      task_id: "bor0kdzt2",
      task_type: "local_bash",
      description: "Sleep",
    }),
  );
  tracker.observe(started("bor0kdzt2", "toolu_3"));
  tracker.requestStop("bor0kdzt2");
  tracker.observe(
    updated("bor0kdzt2", { status: "killed", end_time: Date.now() }),
  );
  tracker.observe(
    notified(
      "bor0kdzt2",
      "stopped",
      "Run sleep 300 then echo never in background",
    ),
  );
  const [task] = latest();
  assert.equal(task.status, "stopped");
  assert.equal(task.stopReason, "user");
});

test("foreground tool calls never appear; one moved to the background does", () => {
  const { latest, events, tracker } = makeTracker();
  tracker.observe(started("bdpv9pqmv", "toolu_4", { is_backgrounded: false }));
  tracker.observe(notified("bdpv9pqmv", "completed", "Sleep 3 seconds"));
  assert.equal(events.length, 0, "a foreground command is not background work");

  tracker.observe(bashToolUse("toolu_5", "npm test"));
  tracker.observe(started("besqj2fxq", "toolu_5", { is_backgrounded: false }));
  assert.equal(events.length, 0);
  tracker.observe(updated("besqj2fxq", { is_backgrounded: true }));
  tracker.observe({
    type: "user",
    tool_use_result: { backgroundTaskId: "besqj2fxq" },
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_5",
          content:
            "Command did not complete within its 120s timeout and was moved to the background (ID: besqj2fxq). Output is being written to: /tmp/s/claude-1/p/n/tasks/besqj2fxq.output. You will be notified when it completes. If it is still running after 30m in the background, it will be stopped and you will be notified.",
        },
      ],
    },
  });
  const [task] = latest();
  assert.equal(task.id, "besqj2fxq");
  assert.equal(task.status, "running");
  assert.equal(task.timeLimitMs, 30 * 60_000);
  assert.equal(tracker.record("besqj2fxq").command, "npm test");
});

test("a monitor is its own kind, with the deadline Claude gave it", () => {
  const { latest, tracker } = makeTracker();
  tracker.observe({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_m",
          name: "Monitor",
          input: {
            command: "tail -f build.log",
            description: "Watch the build",
            timeout_ms: 60000,
            persistent: false,
          },
        },
      ],
    },
  });
  tracker.observe(
    listed({
      task_id: "bfzka4nm9",
      task_type: "local_bash",
      description: "Watch the build",
    }),
  );
  tracker.observe(
    started("bfzka4nm9", "toolu_m", { description: "Watch the build" }),
  );
  tracker.observe({
    type: "user",
    tool_use_result: {
      taskId: "bfzka4nm9",
      timeoutMs: 60000,
      persistent: false,
    },
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_m",
          content:
            "Monitor started (task bfzka4nm9, expires in 1m unless the source ends first).",
        },
      ],
    },
  });
  const [task] = latest();
  assert.equal(task.kind, "monitor");
  assert.equal(task.timeLimitMs, 60000);
  assert.equal(task.hasOutput, true);
});

test("work a subagent started names it, and ends when it leaves the list", () => {
  const { latest, tracker } = makeTracker();
  tracker.observe(
    listed(
      { task_id: "a4c35", task_type: "local_agent", description: "Audit auth" },
      {
        task_id: "bsub1",
        task_type: "local_bash",
        description: "Run the suite",
        parent_task_id: "a4c35",
      },
    ),
  );
  let snapshot = latest();
  const sub = snapshot.find((task) => task.id === "bsub1");
  assert.equal(sub.ownerSubagentTaskId, "a4c35");
  assert.equal(snapshot.find((task) => task.id === "a4c35").kind, "subagent");
  // The subagent heard how its task ended; the main stream only sees it go.
  tracker.observe(
    listed({
      task_id: "a4c35",
      task_type: "local_agent",
      description: "Audit auth",
    }),
  );
  snapshot = latest();
  assert.equal(snapshot.find((task) => task.id === "bsub1").status, "ended");
  assert.equal(snapshot.find((task) => task.id === "a4c35").status, "running");
});

test("the Stop hook fills in kinds and commands the stream left out", async () => {
  const { latest, tracker } = makeTracker();
  tracker.observe(
    listed({ task_id: "bwf1", task_type: "local_bash", description: "Watch" }),
  );
  const [stop] = tracker.hooks().Stop[0].hooks;
  await stop({
    hook_event_name: "Stop",
    background_tasks: [
      {
        id: "bwf1",
        type: "monitor",
        status: "running",
        description: "Watch",
        command: "tail -f log",
      },
      { id: "bwf2", type: "workflow", status: "running", description: "Spec" },
    ],
  });
  const snapshot = latest();
  assert.equal(snapshot.find((task) => task.id === "bwf1").kind, "monitor");
  assert.equal(snapshot.find((task) => task.id === "bwf2").kind, "workflow");
  assert.equal(tracker.record("bwf1").command, "tail -f log");
  // A subagent's Stop is the subagent's.
  await stop({
    agent_id: "a1",
    background_tasks: [
      { id: "bwf3", type: "shell", status: "running", description: "x" },
    ],
  });
  assert.equal(tracker.record("bwf3"), undefined);
});

test(`keeps running tasks and the latest ${finishedBackgroundTasksKept} finished ones`, () => {
  const { latest, tick, tracker } = makeTracker();
  tracker.observe(
    listed({ task_id: "keep", task_type: "local_bash", description: "Long" }),
  );
  for (let index = 0; index < finishedBackgroundTasksKept + 5; index += 1) {
    const id = `b${index}`;
    tracker.observe(
      listed(
        { task_id: "keep", task_type: "local_bash", description: "Long" },
        { task_id: id, task_type: "local_bash", description: id },
      ),
    );
    tick(1000);
    tracker.observe(notified(id, "completed", "done (exit code 0)"));
  }
  const snapshot = latest();
  assert.equal(snapshot.length, finishedBackgroundTasksKept + 1);
  assert.equal(snapshot[0].id, "keep", "running work comes first");
  assert.equal(
    snapshot[1].id,
    `b${finishedBackgroundTasksKept + 4}`,
    "newest finished next",
  );
  assert.equal(
    snapshot.some((task) => task.id === "b0"),
    false,
  );
});

test("work dies with its agent process, and a new process says so", () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-bg-"));
  try {
    const first = makeTracker({ root });
    first.tracker.observe(
      listed({
        task_id: "bdead",
        task_type: "local_bash",
        description: "Serve",
      }),
    );
    // A crash leaves the record as running; the next process reads it.
    const next = makeTracker({ root });
    next.tracker.attach();
    const [task] = next.latest();
    assert.equal(task.status, "stopped");
    assert.equal(task.stopReason, "agent_exit");

    first.tracker.close();
    assert.equal(first.latest()[0].stopReason, "agent_exit");
    first.tracker.observe(
      listed({ task_id: "bafter", task_type: "local_bash", description: "x" }),
    );
    assert.equal(
      first.tracker.record("bafter"),
      undefined,
      "a closed tracker hears nothing",
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("output is the task's own log in the session's scratch directory, as plain redacted text", () => {
  const scratch = mkdtempSync(join(tmpdir(), "fdy-"));
  const root = mkdtempSync(join(tmpdir(), "foundry-bg-"));
  try {
    const tasks = join(scratch, "claude-1003", "-ws", "0a1", "tasks");
    mkdirSync(tasks, { recursive: true });
    const output = join(tasks, "bodu0c8pc.output");
    writeFileSync(
      output,
      "\u001b[32mPASS\u001b[0m suite\nprogress 10%\rprogress 100%\nAuthorization: Bearer abc.def.ghi\n",
    );
    const { tracker } = makeTracker({ root, scratch });
    tracker.observe(
      listed({
        task_id: "bodu0c8pc",
        task_type: "local_bash",
        description: "Suite",
      }),
    );
    // No path recorded yet: the log is found under the scratch directory.
    let read = readBackgroundTaskOutput({
      sessionId: "sess_bg",
      taskId: "bodu0c8pc",
      record: tracker.record("bodu0c8pc"),
      scratchDirectory: scratch,
    });
    assert.equal(read.kind, "text");
    assert.match(
      read.content,
      /^PASS suite\nprogress 100%\nAuthorization: .*\[REDACTED\]/,
    );
    assert.doesNotMatch(read.content, /abc\.def\.ghi|\u001b/);
    assert.equal(read.truncated, false);

    // Once the process is gone, the persisted record serves the read.
    tracker.observe(
      notified("bodu0c8pc", "completed", "done (exit code 0)", output),
    );
    read = readBackgroundTaskOutput({
      sessionId: "sess_bg",
      taskId: "bodu0c8pc",
      sessionsRoot: root,
    });
    assert.equal(read.kind, "text");

    writeFileSync(
      output,
      `first line cut\n${"x".repeat(70 * 1024)}\nlast line\n`,
    );
    read = readBackgroundTaskOutput({
      sessionId: "sess_bg",
      taskId: "bodu0c8pc",
      sessionsRoot: root,
    });
    assert.equal(read.truncated, true);
    assert.ok(read.content.length <= 64 * 1024);
    assert.match(read.content, /last line\n$/);
    assert.doesNotMatch(read.content, /first line cut/);

    assert.throws(
      () =>
        readBackgroundTaskOutput({
          sessionId: "sess_bg",
          taskId: "bnone",
          sessionsRoot: root,
        }),
      /not one of this chat's/,
    );
  } finally {
    rmSync(scratch, { force: true, recursive: true });
    rmSync(root, { force: true, recursive: true });
  }
});

test("a log path must be the task's own regular file inside the scratch directory", () => {
  const scratch = mkdtempSync(join(tmpdir(), "fdy-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
  try {
    const tasks = join(scratch, "claude-1", "p", "n", "tasks");
    mkdirSync(tasks, { recursive: true });
    writeFileSync(join(tasks, "bok.output"), "ok\n");
    assert.equal(
      verifiedTaskOutputPath(scratch, "bok", join(tasks, "bok.output")),
      join(tasks, "bok.output"),
    );
    writeFileSync(join(elsewhere, "secret.output"), "secret\n");
    symlinkSync(join(elsewhere, "secret.output"), join(tasks, "blink.output"));
    assert.throws(
      () =>
        verifiedTaskOutputPath(scratch, "blink", join(tasks, "blink.output")),
      /regular file/,
    );
    mkdirSync(join(elsewhere, "tasks"));
    writeFileSync(join(elsewhere, "tasks", "bout.output"), "x\n");
    assert.throws(
      () =>
        verifiedTaskOutputPath(
          scratch,
          "bout",
          join(elsewhere, "tasks", "bout.output"),
        ),
      /outside/,
    );
    assert.throws(
      () => verifiedTaskOutputPath(scratch, "bok", join(tasks, "other.output")),
      /own log/,
    );
    assert.throws(
      () => verifiedTaskOutputPath(scratch, "../x", join(tasks, "bok.output")),
      /not valid/,
    );
    // A directory link inside the scratch tree resolves elsewhere.
    mkdirSync(join(scratch, "claude-1", "q"));
    symlinkSync(
      join(elsewhere, "tasks"),
      join(scratch, "claude-1", "q", "tasks"),
    );
    assert.throws(
      () =>
        verifiedTaskOutputPath(
          scratch,
          "bout",
          join(scratch, "claude-1", "q", "tasks", "bout.output"),
        ),
      /resolves somewhere else/,
    );
  } finally {
    rmSync(scratch, { force: true, recursive: true });
    rmSync(elsewhere, { force: true, recursive: true });
  }
});

test("terminal text keeps what a terminal would show", () => {
  assert.equal(plainTerminalText("a\rb\r\nc\u001b]0;title\u0007d"), "b\ncd");
});
