import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cleanupActiveClaudeRuntimes,
  emitForClaudeRuntime,
  handleActiveClaudeMessage,
  waitsForBackgroundWork,
} from "../dist/runner.js";
import { ClaudeBackgroundTaskTracker } from "../dist/agent-background-tasks.js";
import {
  activeClaudeRuntimes,
  clearOutOfBandSessionEventSink,
  setOutOfBandSessionEventSink,
} from "../dist/session-state.js";

function assistant(text) {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

function result(text) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
  };
}

test("a session judged on its answer keeps its turn until background tasks settle and Claude responds again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-claude-tasks-"));
  const messagesPath = join(directory, "messages.jsonl");
  const resultPath = join(directory, "result.md");
  writeFileSync(messagesPath, "");
  const events = [];
  let resolved;
  let watchdogClosed = false;
  let watchdogPaused = 0;
  const turn = {
    emit: async (label, detail) => events.push({ detail, label }),
    finalResult: "",
    messagesPath,
    nativeSessionId: "native_test",
    openTaskIds: new Set(),
    partialResult: "",
    reject: (error) => {
      throw error;
    },
    resolve: (value) => {
      resolved = value;
    },
    resultPath,
    waitForBackgroundTasks: true,
    watchdog: {
      close: () => {
        watchdogClosed = true;
      },
      pause: () => {
        watchdogPaused += 1;
      },
      touch: () => undefined,
    },
  };
  const runtime = {
    closed: false,
    input: { close: () => undefined },
    key: "runtime_test",
    lastUsed: 0,
    nativeSessionId: "native_test",
    pending: turn,
  };

  try {
    await handleActiveClaudeMessage(runtime, {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        { task_id: "task_a", task_type: "local_agent" },
        { task_id: "task_b", task_type: "local_agent" },
      ],
    });
    await handleActiveClaudeMessage(runtime, {
      type: "system",
      subtype: "task_started",
      task_id: "task_a",
      task_type: "local_agent",
    });
    await handleActiveClaudeMessage(runtime, {
      type: "system",
      subtype: "task_started",
      task_id: "task_b",
      task_type: "local_agent",
    });
    await handleActiveClaudeMessage(
      runtime,
      assistant("Both agents are running."),
    );
    await handleActiveClaudeMessage(
      runtime,
      result("Both agents are running."),
    );

    assert.equal(runtime.pending, turn);
    assert.equal(resolved, undefined);
    assert.equal(existsSync(resultPath), false);
    assert.deepEqual([...turn.openTaskIds].sort(), ["task_a", "task_b"]);
    assert.equal(
      turn.finalResult,
      "",
      "the continuation needs a fresh text buffer",
    );

    await handleActiveClaudeMessage(runtime, {
      type: "system",
      subtype: "task_notification",
      task_id: "task_a",
      status: "completed",
      summary: "A completed",
    });
    await handleActiveClaudeMessage(
      runtime,
      assistant("A is done; B is running."),
    );
    await handleActiveClaudeMessage(
      runtime,
      result("A is done; B is running."),
    );

    assert.equal(runtime.pending, turn);
    assert.deepEqual([...turn.openTaskIds], ["task_b"]);
    assert.equal(
      watchdogPaused,
      2,
      "waiting only on background work is not a stall",
    );

    await handleActiveClaudeMessage(runtime, {
      type: "system",
      subtype: "task_notification",
      task_id: "task_b",
      status: "completed",
      summary: "B completed",
    });
    await handleActiveClaudeMessage(runtime, assistant("Final synthesis."));
    await handleActiveClaudeMessage(runtime, result("Final synthesis."));

    assert.equal(runtime.pending, undefined);
    assert.deepEqual(resolved, {
      nativeSessionId: "native_test",
      response: "Final synthesis.",
    });
    assert.equal(readFileSync(resultPath, "utf8"), "Final synthesis.\n");
    assert.equal(watchdogClosed, true);
    assert.equal(
      events.filter(({ label }) => label === "Waiting for background tasks")
        .length,
      2,
    );
    assert.equal(
      events.filter(({ label }) => label === "Claude Agent SDK finished")
        .length,
      1,
    );

    const persisted = readFileSync(messagesPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      persisted.filter(
        (message) =>
          message.type === "system" && message.subtype === "task_notification",
      ).length,
      2,
      "notifications after the first result must remain in the Foundry transcript",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

// --- A chat's turn ends with Claude's answer --------------------------------

const lifecycle = (commandId, state) => ({
  type: "command_lifecycle",
  command_uuid: commandId,
  state,
});
const continuationResult = (text, extra = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  result: text,
  origin: { kind: "task-notification", producer: "session-task" },
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  ...extra,
});
const backgroundStart = [
  {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_bg",
          name: "Bash",
          input: { command: "sleep 720 && echo done", run_in_background: true },
        },
      ],
    },
  },
  {
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [
      {
        task_id: "bsleep",
        task_type: "local_bash",
        description: "Sleep 12 minutes",
      },
    ],
  },
  {
    type: "system",
    subtype: "task_started",
    task_id: "bsleep",
    tool_use_id: "toolu_bg",
    task_type: "local_bash",
    description: "Sleep 12 minutes",
    is_backgrounded: true,
  },
];
const backgroundEnd = [
  {
    type: "system",
    subtype: "task_updated",
    task_id: "bsleep",
    patch: { status: "completed", end_time: Date.now() },
  },
  {
    type: "system",
    subtype: "task_notification",
    task_id: "bsleep",
    status: "completed",
    summary: 'Background command "Sleep 12 minutes" completed (exit code 0)',
    output_file: "",
  },
  { type: "system", subtype: "background_tasks_changed", tasks: [] },
];

function chatFixture(directory, commandId = "in_1") {
  const messagesPath = join(directory, "messages.jsonl");
  writeFileSync(messagesPath, "");
  const runtime = {
    closed: false,
    foundrySessionId: "sess_chat",
    input: { close: () => undefined },
    key: `runtime_${commandId}`,
    lastUsed: Date.now(),
    nativeSessionId: "native_chat",
  };
  runtime.background = new ClaudeBackgroundTaskTracker({
    emit: (event) => emitForClaudeRuntime(runtime, event),
    sessionId: () => runtime.foundrySessionId,
  });
  return { messagesPath, runtime };
}

function chatTurn(runtime, directory, commandId) {
  const events = [];
  const turn = {
    commandId,
    behindContinuation: Boolean(runtime.continuation),
    emit: async (label, detail, level, metadata) =>
      events.push({ detail, label, level, metadata }),
    events,
    finalResult: "",
    messagesPath: join(directory, "messages.jsonl"),
    nativeSessionId: "native_chat",
    openTaskIds: new Set(),
    partialResult: "",
    reject: (error) => {
      throw error;
    },
    resolve: (value) => {
      turn.resolved = value;
    },
    resultPath: join(directory, `${commandId}.result.md`),
    waitForBackgroundTasks: false,
    watchdog: {
      close: () => undefined,
      pause: () => undefined,
      touch: () => undefined,
    },
  };
  runtime.pending = turn;
  return turn;
}

async function feed(runtime, ...messages) {
  for (const message of messages)
    await handleActiveClaudeMessage(runtime, message);
}

test("a chat's turn ends with Claude's answer while its background command keeps running", async () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-chat-bg-"));
  const outOfBand = [];
  const sink = (sessionId, event) => outOfBand.push({ sessionId, ...event });
  setOutOfBandSessionEventSink(sink);
  try {
    const { runtime } = chatFixture(directory);
    const turn = chatTurn(runtime, directory, "in_1");
    await feed(
      runtime,
      lifecycle("in_1", "queued"),
      lifecycle("in_1", "started"),
      ...backgroundStart,
      assistant("Started it; I will report when it is done."),
      result("Started it; I will report when it is done."),
      lifecycle("in_1", "completed"),
    );
    assert.deepEqual(turn.resolved, {
      nativeSessionId: "native_chat",
      response: "Started it; I will report when it is done.",
    });
    assert.equal(runtime.pending, undefined, "the composer is free again");
    assert.equal(runtime.closed, false, "the agent process keeps running");
    assert.equal(runtime.background.hasRunning(), true);
    assert.equal(
      turn.events.some(({ label }) => label === "Waiting for background tasks"),
      false,
    );
    const running = turn.events.findLast(
      (event) => event.metadata?.backgroundTaskSnapshot,
    );
    assert.equal(running.metadata.backgroundTaskSnapshot[0].status, "running");

    // Twelve minutes later Claude hears the command ended and answers on its own.
    await feed(
      runtime,
      ...backgroundEnd,
      { type: "stream_event", event: { type: "message_start" } },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "The sleep finished: done." },
        },
      },
      assistant("The sleep finished: done."),
      continuationResult("The sleep finished: done."),
    );
    const continued = outOfBand.find(
      (event) => event.label === "Background task continued",
    );
    assert.equal(continued.sessionId, "sess_chat");
    assert.equal(continued.metadata.timerFire.origin, "background");
    assert.equal(
      continued.metadata.timerFire.response,
      "The sleep finished: done.",
    );
    assert.match(
      continued.metadata.timerFire.prompt,
      /completed \(exit code 0\)/,
    );
    assert.equal(continued.metadata.turnUsage.outputTokens, 5);
    const finished = outOfBand.findLast(
      (event) => event.metadata?.backgroundTaskSnapshot,
    );
    assert.equal(
      finished.metadata.backgroundTaskSnapshot[0].status,
      "completed",
    );
    assert.equal(finished.metadata.backgroundTaskSnapshot[0].exitCode, 0);
    const lifecycleEvents = outOfBand.filter(
      (event) => event.label === "Subtask completed",
    );
    assert.equal(
      lifecycleEvents.length,
      1,
      "task lifecycle still reaches the side panel",
    );

    // A result the harness replays for an old notification answers nothing.
    const before = outOfBand.length;
    await feed(runtime, continuationResult("", { num_turns: 0 }));
    assert.equal(outOfBand.length, before);
    assert.equal(runtime.continuation, undefined);
  } finally {
    clearOutOfBandSessionEventSink(sink);
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a message sent while Claude continues on its own waits its turn, then gets its own answer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-chat-bg-"));
  try {
    const { runtime } = chatFixture(directory);
    runtime.commandLifecycle = true;
    // Between turns a background task ends and Claude starts answering it.
    await feed(
      runtime,
      ...backgroundStart,
      ...backgroundEnd,
      assistant("Reading the log"),
    );
    assert.ok(runtime.continuation);
    // The person's next message (with a screenshot) is dispatched meanwhile.
    const turn = chatTurn(runtime, directory, "in_2");
    assert.equal(turn.behindContinuation, true);
    await feed(
      runtime,
      lifecycle("in_2", "queued"),
      assistant("The sleep finished cleanly."),
      continuationResult("The sleep finished cleanly."),
    );
    assert.equal(
      turn.resolved,
      undefined,
      "Claude's own follow-up is not the answer",
    );
    const continued = turn.events.find(
      (event) => event.label === "Background task continued",
    );
    assert.equal(
      continued.metadata.timerFire.response,
      "The sleep finished cleanly.",
    );
    await feed(
      runtime,
      lifecycle("in_2", "started"),
      assistant("The screenshot shows the login page."),
      result("The screenshot shows the login page."),
    );
    assert.equal(
      turn.resolved.response,
      "The screenshot shows the login page.",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a message Claude takes into its own follow-up is answered by that follow-up", async () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-chat-bg-"));
  try {
    const { runtime } = chatFixture(directory);
    runtime.commandLifecycle = true;
    await feed(runtime, ...backgroundStart, ...backgroundEnd, {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_ls",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
    });
    const turn = chatTurn(runtime, directory, "in_3");
    // Claude Code drains the queued input at a tool boundary (merge).
    await feed(
      runtime,
      lifecycle("in_3", "queued"),
      lifecycle("in_3", "started"),
      assistant("second"),
      lifecycle("in_3", "completed"),
      continuationResult("second"),
    );
    assert.equal(turn.resolved.response, "second");
    assert.equal(
      turn.events.some((event) => event.label === "Background task continued"),
      false,
      "a follow-up without text before the input publishes nothing",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("without command lifecycle reports, a turn sent during a follow-up starts after its result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-chat-bg-"));
  try {
    const { runtime } = chatFixture(directory);
    await feed(
      runtime,
      ...backgroundStart,
      ...backgroundEnd,
      assistant("Checking"),
    );
    const turn = chatTurn(runtime, directory, "in_4");
    await feed(
      runtime,
      assistant("Checked."),
      continuationResult("Checked."),
      assistant("Your answer."),
      result("Your answer."),
    );
    assert.equal(turn.resolved.response, "Your answer.");
    assert.equal(
      turn.events.find((event) => event.label === "Background task continued")
        ?.metadata.timerFire.response,
      "Checked.",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("the idle reaper keeps agent processes with running background work or timers", () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-chat-bg-"));
  const saved = new Map(activeClaudeRuntimes);
  activeClaudeRuntimes.clear();
  try {
    const busy = chatFixture(directory, "busy").runtime;
    busy.background.observe(backgroundStart[1]);
    const timed = chatFixture(directory, "timed").runtime;
    timed.timers = {
      close: () => undefined,
      snapshot: () => [{ id: "cron_1" }],
    };
    const idle = chatFixture(directory, "idle").runtime;
    for (const runtime of [busy, timed, idle]) {
      runtime.lastUsed = 0;
      activeClaudeRuntimes.set(runtime.key, runtime);
    }
    cleanupActiveClaudeRuntimes();
    assert.deepEqual(
      [...activeClaudeRuntimes.keys()].sort(),
      [busy.key, timed.key].sort(),
    );
    assert.equal(idle.closed, true);
    assert.equal(busy.closed, false);
  } finally {
    activeClaudeRuntimes.clear();
    for (const [key, runtime] of saved) activeClaudeRuntimes.set(key, runtime);
    rmSync(directory, { force: true, recursive: true });
  }
});

test("only a person's chat ends its turn before background work settles", () => {
  assert.equal(waitsForBackgroundWork({ source: "chat" }), false);
  assert.equal(waitsForBackgroundWork({}), false);
  assert.equal(
    waitsForBackgroundWork({ source: "chat", issueId: "iss_1" }),
    true,
  );
  assert.equal(
    waitsForBackgroundWork({ source: "issue", role: "issue_execution" }),
    true,
  );
  assert.equal(waitsForBackgroundWork({ source: "agent" }), true);
  assert.equal(waitsForBackgroundWork({ source: "verification" }), true);
});
