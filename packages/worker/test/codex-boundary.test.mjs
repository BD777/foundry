import test from "node:test";
import assert from "node:assert/strict";
import { CodexBoundaryHold } from "../dist/runner/codex-boundary.js";
import {
  isNotSteerableError,
  registerActiveSessionSteerTarget,
  SessionNotSteerableError,
  steerActiveSession,
} from "../dist/session-control.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A boundary message waits while the model generates and goes in once a
// tool runs (after its response settled): Codex then reads it with the
// tool's result instead of preempting the response.
test("a held message enters while a tool runs, not while the model generates", async () => {
  const applied = [];
  const hold = new CodexBoundaryHold(() => {}, 20);
  hold.hold({
    steerId: "a",
    limitMs: 60_000,
    apply: async () => applied.push("a"),
  });
  hold.observe({ type: "item.started", item: { id: "r1", type: "reasoning" } });
  hold.observe({
    type: "item.completed",
    item: { id: "m1", type: "agent_message" },
  });
  await wait(40);
  assert.deepEqual(applied, [], "nothing enters while the model generates");
  hold.observe({
    type: "item.started",
    item: { id: "c1", type: "command_execution" },
  });
  await wait(40);
  await hold.settled();
  assert.deepEqual(applied, ["a"]);
  // One sent while that tool still runs goes in after the settle delay.
  hold.hold({
    steerId: "b",
    limitMs: 60_000,
    apply: async () => applied.push("b"),
  });
  await wait(40);
  await hold.settled();
  assert.deepEqual(applied, ["a", "b"]);
  hold.close();
});

test("a tool that ends before its response settles opens the boundary at its end", async () => {
  const applied = [];
  const hold = new CodexBoundaryHold(() => {}, 10_000);
  hold.hold({
    steerId: "a",
    limitMs: 60_000,
    apply: async () => applied.push("a"),
  });
  hold.observe({
    type: "item.started",
    item: { id: "c1", type: "mcp_tool_call" },
  });
  hold.observe({
    type: "item.completed",
    item: { id: "c1", type: "mcp_tool_call" },
  });
  await hold.settled();
  assert.deepEqual(applied, ["a"]);
  hold.close();
});

test("a message held past its limit enters anyway; one held at the turn's end stays undelivered", async () => {
  const applied = [];
  const hold = new CodexBoundaryHold(() => {}, 10);
  hold.hold({
    steerId: "late",
    limitMs: 15,
    apply: async () => applied.push("late"),
  });
  hold.hold({
    steerId: "kept",
    limitMs: 60_000,
    apply: async () => applied.push("kept"),
  });
  await wait(40);
  await hold.settled();
  assert.deepEqual(applied, ["late"]);
  assert.deepEqual(hold.pendingIds(), ["kept"]);
  hold.close();
  await wait(20);
  assert.deepEqual(applied, ["late"], "the ended turn delivers nothing more");
  assert.throws(() => hold.hold({ limitMs: 1, apply: async () => {} }));
});

test("a failed delivery is reported, the next still goes", async () => {
  const errors = [];
  const applied = [];
  const hold = new CodexBoundaryHold(
    (error, held) => errors.push(held.steerId),
    0,
  );
  hold.hold({
    steerId: "bad",
    limitMs: 60_000,
    apply: async () => {
      throw new Error("gone");
    },
  });
  hold.hold({
    steerId: "good",
    limitMs: 60_000,
    apply: async () => applied.push("good"),
  });
  hold.observe({
    type: "item.started",
    item: { id: "f", type: "file_change" },
  });
  await wait(20);
  await hold.settled();
  assert.deepEqual(errors, ["bad"]);
  assert.deepEqual(applied, ["good"]);
  hold.close();
});

// The refusal the server holds a message for, and the options a target gets.
test("a session without a turn refuses steers as not steerable; a target gets the delivery", async () => {
  await assert.rejects(
    steerActiveSession("sess_none", "hello"),
    (error) =>
      error instanceof SessionNotSteerableError && isNotSteerableError(error),
  );
  assert.ok(
    isNotSteerableError(
      new Error("Codex is not accepting input for an active turn."),
    ),
  );
  assert.ok(
    isNotSteerableError(
      new Error("Claude is not accepting steer input for this active turn."),
    ),
  );
  assert.ok(!isNotSteerableError(new Error("skill check failed")));
  const seen = [];
  const unregister = registerActiveSessionSteerTarget("sess_boundary", {
    provider: "codex",
    steer: async (message, attachments, steerId, sender, options) => {
      seen.push({ message, steerId, sender, options });
    },
  });
  await steerActiveSession("sess_boundary", "m", [], "id1", "sess_from", {
    delivery: "boundary",
    boundaryLimitMs: 900_000,
  });
  unregister();
  assert.deepEqual(seen, [
    {
      message: "m",
      steerId: "id1",
      sender: "sess_from",
      options: { delivery: "boundary", boundaryLimitMs: 900_000 },
    },
  ]);
});

// Through a Codex turn: a boundary steer waits while the model generates,
// enters once a tool runs, and Codex's echo of it reports it read; a plain
// steer goes in at once. Nothing is sent to a provider.
test("a Codex turn holds a boundary steer until a tool runs and reports it read", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runCodexStreamedTurn } =
    await import("../dist/runner/codex-stream.js");
  const { steerActiveSessionOnce } = await import("../dist/session-control.js");
  const root = mkdtempSync(join(tmpdir(), "codex-boundary-"));
  const id = "sess_boundary_turn";
  const steered = [];
  const emitted = [];
  let push;
  let end;
  const queue = [];
  const events = (async function* () {
    while (true) {
      if (queue.length) {
        const next = queue.shift();
        if (next === "end") return;
        yield next;
        continue;
      }
      await new Promise((resolve) => (push = resolve));
    }
  })();
  const send = (event) => {
    queue.push(event);
    push?.();
  };
  const thread = {
    runStreamed: async () => ({ events }),
    steer: async (input, steerId) => steered.push(steerId),
  };
  const state = {
    emit: async (label, detail) => emitted.push([label, detail]),
    eventsPath: join(root, "events.jsonl"),
    files: { recordToolWrite: async () => {} },
    thread: {},
    context: { follow: async () => {}, found: false },
    reportNativeSessionId: () => {},
    finalResult: "",
  };
  const running = runCodexStreamedTurn(state, thread, "go", id);
  try {
    await wait(20);
    await steerActiveSessionOnce(
      id,
      "held-1",
      "contract ready",
      [],
      "sess_from",
      {
        delivery: "boundary",
        boundaryLimitMs: 60_000,
      },
    );
    send({ type: "item.started", item: { id: "r", type: "reasoning" } });
    await wait(50);
    assert.deepEqual(
      steered,
      [],
      "a boundary steer does not preempt the response",
    );
    await steerActiveSessionOnce(id, "now-1", "stop now", [], "sess_from", {
      delivery: "interrupt",
    });
    assert.deepEqual(steered, ["now-1"]);
    send({
      type: "item.started",
      item: { id: "c", type: "command_execution" },
    });
    await wait(1_300);
    assert.deepEqual(steered, ["now-1", "held-1"]);
    send({ type: "foundry.input_consumed", clientId: "held-1" });
    send({ type: "foundry.input_consumed", clientId: "unknown" });
    await wait(50);
    assert.deepEqual(
      emitted.filter(([label]) => label === "Steered message read"),
      [["Steered message read", "held-1"]],
    );
  } finally {
    send("end");
    await running.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});
