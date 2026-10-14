// Replays SDK streams captured from a real Claude Code (see the fixture's
// `source`) through the runner: a session timer firing while no Foundry turn
// runs, with and without a subagent, after a resume, and Claude's follow-up
// to a finished background command.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  emitForClaudeRuntime,
  handleActiveClaudeMessage,
} from "../dist/runner.js";
import { ClaudeTimerTracker } from "../dist/agent-timers.js";
import { ClaudeBackgroundTaskTracker } from "../dist/agent-background-tasks.js";
import {
  activeClaudeRuntimes,
  clearOutOfBandSessionEventSink,
  setOutOfBandSessionEventSink,
  setSessionTurnSink,
} from "../dist/session-state.js";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("./fixtures/claude-timer-turns.json", import.meta.url),
    ),
    "utf8",
  ),
);

function runtimeFor(directory, known = []) {
  const runtime = {
    closed: false,
    foundrySessionId: "sess_timer",
    input: { close: () => undefined },
    key: "runtime_timer",
    lastUsed: Date.now(),
    messagesPath: join(directory, "messages.jsonl"),
    nativeSessionId: "native_timer",
  };
  writeFileSync(runtime.messagesPath, "");
  runtime.timers = new ClaudeTimerTracker(
    {
      emit: (event) => emitForClaudeRuntime(runtime, event),
      isActiveTurn: () => runtime.pending !== undefined,
      sessionId: () => runtime.foundrySessionId,
    },
    known,
  );
  runtime.background = new ClaudeBackgroundTaskTracker({
    emit: (event) => emitForClaudeRuntime(runtime, event),
    sessionId: () => runtime.foundrySessionId,
  });
  return runtime;
}

/** The person's first message, as the turn the capture opened with. */
function firstTurn(runtime, directory) {
  const events = [];
  const turn = {
    emit: async (label, detail, level, metadata) =>
      events.push({ detail, label, level, metadata }),
    events,
    finalResult: "",
    messagesPath: runtime.messagesPath,
    nativeSessionId: "native_timer",
    openTaskIds: new Set(),
    partialResult: "",
    reject: (error) => {
      throw error;
    },
    resolve: (value) => {
      turn.resolved = value;
    },
    resultPath: join(directory, "result.md"),
    waitForBackgroundTasks: false,
    liveness: { observe: () => [], close: () => undefined },
  };
  runtime.pending = turn;
  return turn;
}

async function replay(runtime, records) {
  const hooks = runtime.timers.hooks();
  for (const { kind, data } of records) {
    if (kind === "msg") await handleActiveClaudeMessage(runtime, data);
    else if (kind.startsWith("hook:") && hooks[kind.slice(5)])
      await hooks[kind.slice(5)][0].hooks[0](data);
  }
}

async function withOutOfBand(run) {
  const directory = mkdtempSync(join(tmpdir(), "foundry-timer-turns-"));
  const outOfBand = [];
  const sink = (sessionId, event) => outOfBand.push({ sessionId, ...event });
  setOutOfBandSessionEventSink(sink);
  try {
    await run(directory, outOfBand);
  } finally {
    clearOutOfBandSessionEventSink(sink);
    rmSync(directory, { force: true, recursive: true });
  }
}

test("a timer Claude fires while no turn runs is published as that timer's fire, subagents and all", async () => {
  await withOutOfBand(async (directory, outOfBand) => {
    const runtime = runtimeFor(directory);
    const turn = firstTurn(runtime, directory);
    await replay(runtime, fixture.timerFireWithSubagent);
    assert.equal(turn.resolved.response, "SCHEDULED");
    const all = outOfBand.filter((event) => event.metadata?.timerFire);
    // Each fire is published as it starts, then with its answer.
    const started = all.filter(
      (event) => !event.metadata.timerFire.completedAt,
    );
    const fires = all.filter((event) => event.metadata.timerFire.completedAt);
    assert.equal(fires.length, 2, "both fires in the capture are published");
    assert.deepEqual(
      started.map((event) => event.metadata.timerFire.startedAt),
      fires.map((event) => event.metadata.timerFire.startedAt),
      "each start and end name the same fire",
    );
    for (const fire of fires) {
      assert.equal(fire.label, "Scheduled task fired");
      assert.equal(fire.metadata.timerFire.origin, "scheduled");
      assert.equal(fire.metadata.timerFire.id, "84e70c6f");
      assert.match(fire.metadata.timerFire.prompt, /^TIMER-AGENT:/);
      assert.match(fire.metadata.timerFire.response, /^DONE-AGENT /);
      assert.ok(fire.metadata.timerFire.startedAt);
    }
    assert.equal(
      outOfBand.some((event) => event.label === "Background task continued"),
      false,
      "the subagent a timer's turn ran does not make it a background follow-up",
    );
  });
});

test("a resumed session's timer fires as that timer, known before Claude lists it", async () => {
  await withOutOfBand(async (directory, outOfBand) => {
    const runtime = runtimeFor(directory, [
      {
        id: "e9470d6a",
        kind: "cron",
        schedule: "*/1 * * * *",
        humanSchedule: "每 1 分钟",
        recurring: true,
        prompt: "TIMER-PING: reply with the single word PONG and nothing else.",
      },
    ]);
    await replay(runtime, fixture.resumedTimerFire);
    const fires = outOfBand.filter(
      (event) => event.metadata?.timerFire?.completedAt,
    );
    assert.ok(fires.length >= 1);
    assert.equal(fires[0].metadata.timerFire.origin, "scheduled");
    assert.equal(fires[0].metadata.timerFire.id, "e9470d6a");
    assert.equal(fires[0].metadata.timerFire.response, "PONG");
    assert.equal(
      outOfBand.some((event) => event.metadata?.timerSnapshot),
      false,
      "the same timers reported again change nothing",
    );
  });
});

test("Claude's follow-up to a finished background command stays a background turn", async () => {
  await withOutOfBand(async (directory, outOfBand) => {
    const runtime = runtimeFor(directory);
    const turn = firstTurn(runtime, directory);
    await replay(runtime, fixture.backgroundFollowUp);
    assert.equal(turn.resolved.response, "STARTED");
    const continued = outOfBand.filter((event) => event.metadata?.timerFire);
    assert.equal(continued.length, 1);
    assert.equal(continued[0].label, "Background task continued");
    assert.equal(continued[0].metadata.timerFire.origin, "background");
    assert.equal(continued[0].metadata.timerFire.response, "FINISHED");
  });
});

/**
 * What the server is told of the turns Claude runs on its own, each with
 * the published events it came after.
 */
async function withSessionTurns(run) {
  const told = [];
  await withOutOfBand(async (directory, outOfBand) => {
    setSessionTurnSink((sessionId, running) =>
      told.push({
        sessionId,
        running,
        after: outOfBand
          .filter((event) => event.metadata?.timerFire)
          .map((event) =>
            event.metadata.timerFire.completedAt ? "end" : "start",
          ),
      }),
    );
    try {
      await run(directory, told);
    } finally {
      setSessionTurnSink(undefined);
    }
  });
  return told;
}

test("Claude's follow-up to background work is told to the server as a turn from its first message to its answer", async () => {
  let resolvedBefore;
  const told = await withSessionTurns(async (directory, turns) => {
    const runtime = runtimeFor(directory);
    const turn = firstTurn(runtime, directory);
    const hooks = runtime.timers.hooks();
    for (const { kind, data } of fixture.backgroundFollowUp) {
      if (kind === "msg") await handleActiveClaudeMessage(runtime, data);
      else if (kind.startsWith("hook:") && hooks[kind.slice(5)])
        await hooks[kind.slice(5)][0].hooks[0](data);
      if (turns.length === 1 && resolvedBefore === undefined)
        resolvedBefore = Boolean(turn.resolved);
    }
    assert.equal(runtime.ownTurnSessionId, undefined);
  });
  assert.deepEqual(
    told.map(({ sessionId, running }) => [sessionId, running]),
    [
      ["sess_timer", true],
      ["sess_timer", false],
    ],
  );
  assert.equal(resolvedBefore, true, "it starts after the person's turn ended");
  assert.deepEqual(told[0].after, [], "before its answer is published");
  assert.deepEqual(told[1].after, ["end"], "it ends with its answer");
});

test("each timer Claude fires while no turn runs is told as a turn of its own", async () => {
  const told = await withSessionTurns(async (directory) => {
    const runtime = runtimeFor(directory);
    firstTurn(runtime, directory);
    await replay(runtime, fixture.timerFireWithSubagent);
  });
  assert.deepEqual(
    told.map(({ running }) => running),
    [true, false, true, false],
  );
  assert.deepEqual(
    told.map(({ after }) => after.at(-1)),
    ["start", "end", "start", "end"],
    "each runs from its fire's start to its end",
  );
});

test("a server that registers the worker is told the turns Claude runs on its own now", () => {
  const runtime = { closed: false, ownTurnSessionId: "sess_running" };
  activeClaudeRuntimes.set("runtime_own_turn", runtime);
  const told = [];
  try {
    setSessionTurnSink((sessionId, running) => told.push([sessionId, running]));
  } finally {
    setSessionTurnSink(undefined);
    activeClaudeRuntimes.delete("runtime_own_turn");
  }
  assert.deepEqual(told, [["sess_running", true]]);
});
