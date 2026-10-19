import assert from "node:assert/strict";
import test from "node:test";
import { CodexNativeWork } from "../dist/agent-runtime/work/codex.js";

function fixture(version = "0.163.0") {
  const rows = new Map([
    [
      "11",
      {
        processId: "11",
        itemId: "command-a",
        command: "sleep 60",
        cwd: "/tmp",
      },
    ],
    [
      "22",
      {
        processId: "22",
        itemId: "command-b",
        command: "sleep 90",
        cwd: "/tmp",
      },
    ],
  ]);
  const calls = [],
    snapshots = [];
  let failed = false;
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      assert.equal(params.threadId, "native-owner");
      if (failed) throw new Error("native connection unavailable");
      if (method.endsWith("/list")) return { data: [...rows.values()] };
      if (method.endsWith("/terminate")) {
        rows.delete(params.processId);
        return {};
      }
      throw new Error(method);
    },
  };
  const observer = new CodexNativeWork(
    client,
    "native-owner",
    version,
    (task) => snapshots.push(task),
  );
  return {
    observer,
    rows,
    calls,
    snapshots,
    fail() {
      failed = true;
    },
  };
}

test("Codex stops exactly the freshly enumerated terminal and verifies removal", async () => {
  const f = fixture();
  await f.observer.refresh();
  assert.equal(f.observer.canStop("native-owner:terminal:command-a:11"), true);
  await f.observer.stop("native-owner:terminal:command-a:11");
  assert.equal(f.rows.has("11"), false);
  assert.equal(f.rows.has("22"), true);
  assert.equal(
    f.observer.inspect("native-owner:terminal:command-a:11"),
    "stopped",
  );
  assert.deepEqual(
    f.calls.filter((c) => c.method.endsWith("/terminate")),
    [
      {
        method: "thread/backgroundTerminals/terminate",
        params: { threadId: "native-owner", processId: "11" },
      },
    ],
  );
});

test("unknown identity and lost connection cannot turn into a parent/runtime stop", async () => {
  const f = fixture();
  await assert.rejects(
    f.observer.stop("another-thread:terminal:11"),
    /ownership/,
  );
  f.fail();
  await assert.rejects(
    f.observer.stop("native-owner:terminal:command-a:11"),
    /ownership/,
  );
  assert.equal(f.observer.canStop("native-owner:terminal:command-a:11"), false);
  assert.equal(
    f.observer.inspect("native-owner:terminal:command-a:11"),
    "unknown",
  );
  assert.equal(
    f.calls.some((c) => /interrupt|terminate|clean/.test(c.method)),
    false,
  );
});

test("unverified native versions remain observable without fabricated controls", async () => {
  const f = fixture("0.150.0");
  await f.observer.refresh();
  assert.equal(f.observer.canStop("native-owner:terminal:command-a:11"), false);
  assert.equal(f.snapshots[0].native.controls.stop, "unknown");
  assert.equal(f.snapshots[0].native.controls.pause, "unsupported");
});

test("native agents are read-only and foreign threads do not leak into the inventory", () => {
  const f = fixture();
  const item = {
    type: "collabAgentToolCall",
    senderThreadId: "native-owner",
    tool: "spawnAgent",
    receiverThreadIds: ["child"],
    prompt: "Investigate",
    agentsStates: { child: { status: "running" } },
  };
  f.observer.observe("item/completed", { threadId: "foreign", item });
  assert.equal(f.snapshots.length, 0);
  f.observer.observe("item/completed", { threadId: "native-owner", item });
  assert.equal(f.snapshots[0].kind, "agent");
  assert.equal(f.observer.canStop("native-owner:agent:child"), false);
  f.observer.observe("item/completed", {
    threadId: "native-owner",
    item: {
      type: "subAgentActivity",
      agentThreadId: "child",
      agentPath: "/root/child",
      kind: "completed",
    },
  });
  assert.equal(f.observer.inspect("native-owner:agent:child"), "completed");
});

test("ordinary foreground command events are not classified as independent background work", () => {
  const f = fixture();
  f.observer.observe("item/started", {
    threadId: "native-owner",
    item: {
      type: "commandExecution",
      id: "foreground",
      processId: "7",
      status: "inProgress",
    },
  });
  assert.equal(f.snapshots.length, 0);
});

test("list absence proves no running terminal but never fabricates a successful exit", async () => {
  const f = fixture();
  await f.observer.refresh();
  f.rows.delete("11");
  await f.observer.refresh();
  const last = f.snapshots.filter((t) => t.id.endsWith(":11")).at(-1);
  assert.equal(last.observation.status, "unknown");
  assert.ok(last.observation.endedAt);
  f.observer.closedAfterExit();
  assert.equal(
    f.observer.inspect("native-owner:terminal:command-b:22"),
    "stopped",
  );
  assert.equal(f.observer.canStop("native-owner:terminal:command-b:22"), false);
});

test("a recycled process id cannot redirect an old task stop to a new command", async () => {
  const f = fixture();
  await f.observer.refresh();
  f.rows.set("11", {
    processId: "11",
    itemId: "replacement",
    command: "sleep 120",
    cwd: "/tmp",
  });
  await assert.rejects(
    f.observer.stop("native-owner:terminal:command-a:11"),
    /ownership/,
  );
  assert.equal(f.rows.has("11"), true);
  assert.equal(
    f.calls.some((c) => c.method.endsWith("/terminate")),
    false,
  );
});

test("an unavailable native inventory is reported even before any task was discovered", async () => {
  const notices = [];
  const observer = new CodexNativeWork(
    {
      request: async () => {
        throw new Error("method not supported");
      },
    },
    "native",
    "unknown",
    () => {},
    (message) => notices.push(message),
  );
  await observer.refresh();
  await observer.refresh();
  assert.equal(notices.length, 1);
  assert.match(
    observer.inventoryError(),
    /inventory unavailable.*method not supported/,
  );
});
