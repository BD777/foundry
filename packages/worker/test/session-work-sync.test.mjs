import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostSchedules } from "../dist/session-work/host-schedules.js";

// DEV-085: the reconciler reads its device's work by cursor, reports only
// what changed, and backs off while nothing does.

function scratch(t) {
  const path = mkdtempSync(join(tmpdir(), "work-sync-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function schedule(id, overrides = {}) {
  const at = new Date().toISOString();
  return {
    id,
    sessionId: "session",
    threadId: "session",
    sourceId: id,
    workspaceId: "workspace",
    deviceId: "device",
    kind: "schedule",
    source: "foundry",
    title: `Schedule ${id}`,
    management: "managed",
    desiredState: "enabled",
    revision: 1,
    generation: 1,
    createdAt: at,
    updatedAt: at,
    // Once a year: the sweep never fires it during the test.
    spec: { schedule: "0 0 1 1 *", timeZone: "UTC", prompt: "yearly" },
    observation: { status: "unknown", at, confirmedRevision: 0 },
    allowedActions: ["pause", "stop"],
    ...overrides,
  };
}

/** A device work endpoint with the server's cursor semantics. */
function cursorServer({ pageSize = 100 } = {}) {
  const rows = new Map();
  const removed = new Map();
  let seq = 0;
  const server = {
    requests: [],
    put(item) {
      // The server stores and answers fields in its own order.
      const observation = Object.fromEntries(
        Object.entries(item.observation).reverse(),
      );
      rows.set(item.id, {
        seq: ++seq,
        item: structuredClone({ ...item, observation }),
      });
      removed.delete(item.id);
    },
    remove(id) {
      rows.delete(id);
      removed.set(id, ++seq);
    },
    async fetch(url, init) {
      const cursor = new URL(url).searchParams.get("cursor");
      const body = init?.body ? JSON.parse(init.body) : undefined;
      server.requests.push({
        method: init?.method || "GET",
        cursor,
        items: body?.items?.length ?? 0,
        bytes: init?.body?.length ?? 0,
      });
      for (const item of body?.items || []) {
        const stored = rows.get(item.id)?.item;
        server.put({ ...stored, ...item, revision: stored?.revision ?? 1 });
      }
      const since = Number(cursor?.split(".")[1] || 0);
      const changes = [
        ...[...rows.values()].map((r) => ({ seq: r.seq, item: r.item })),
        ...[...removed].map(([id, s]) => ({ seq: s, removed: id })),
      ]
        .filter((c) => c.seq > since)
        .sort((a, b) => a.seq - b.seq);
      const page = changes.slice(0, pageSize);
      const more = changes.length > pageSize;
      return new Response(
        JSON.stringify({
          items: page.filter((c) => c.item).map((c) => c.item),
          removedIds: page.filter((c) => c.removed).map((c) => c.removed),
          cursor: `epoch.${more ? page.at(-1).seq : seq}`,
          more,
          operations: [],
          barrier: false,
          coverage: {},
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  };
  return server;
}

async function supervisorFor(t, server) {
  const { WorkSupervisor } = await import("../dist/session-work/supervisor.js");
  const root = scratch(t);
  const supervisor = new WorkSupervisor(root, (url, init) =>
    server.fetch(url, init),
  );
  // Discovery finds nothing on this host.
  supervisor.hosts = new HostSchedules(join(root, "hosts.json"), (argv) => ({
    status: 0,
    stdout: argv[0] === "crontab" ? "" : "[]",
    stderr: "",
  }));
  supervisor.attach(
    {
      id: "session",
      threadId: "session",
      workspaceId: "workspace",
      deviceId: "device",
      provider: "claude",
      source: "chat",
    },
    root,
  );
  t.after(() => supervisor.stop());
  return { supervisor, root };
}

test("an unchanged inventory is read by cursor, reported once, and the sweep backs off", async (t) => {
  const server = cursorServer();
  server.put(schedule("work_a"));
  server.put(schedule("work_b"));
  const { supervisor, root } = await supervisorFor(t, server);
  await supervisor.start("http://isolated.invalid");
  supervisor.stop();
  const first = server.requests.splice(0);
  assert.equal(first[0].cursor, "", "the first read starts from scratch");
  assert.equal(
    first.reduce((n, r) => n + r.items, 0),
    2,
    "each item's first observation is reported once",
  );
  const saved = JSON.parse(readFileSync(join(root, "inventory.json"), "utf8"));
  assert.match(saved.cursor, /^epoch\.\d+$/, "the cursor survives a restart");

  // The sweep's own reports came back as changes; the next sweeps see none.
  await supervisor.tick();
  server.requests.splice(0);
  await supervisor.tick();
  assert.deepEqual(
    server.requests.map((r) => [r.method, r.items]),
    [["GET", 0]],
    "a sweep with nothing new is one read naming its cursor",
  );
  assert.match(server.requests[0].cursor, /^epoch\.\d+$/);
  const delays = [];
  for (let i = 0; i < 4; i++) delays.push(supervisor.nextDelay());
  assert.deepEqual(delays, [15000, 15000, 15000, 15000]);

  // A control from the server arrives as one changed item and resets the pace.
  server.put({ ...schedule("work_a"), desiredState: "paused", revision: 2 });
  server.requests.splice(0);
  await supervisor.tick();
  assert.equal(server.requests[0].method, "GET");
  assert.equal(
    server.requests.reduce((n, r) => n + r.items, 0),
    1,
    "only the controlled item is reported",
  );
  assert.equal(supervisor.nextDelay(), 3000);
});

test("deletions on the server leave the local inventory", async (t) => {
  const server = cursorServer();
  server.put(schedule("work_a"));
  server.put(schedule("work_b"));
  const { supervisor } = await supervisorFor(t, server);
  await supervisor.start("http://isolated.invalid");
  supervisor.stop();
  server.remove("work_b");
  await supervisor.tick();
  assert.match(supervisor.context("session"), /Schedule work_a/);
  assert.doesNotMatch(supervisor.context("session"), /Schedule work_b/);
});

test("a first read arrives in pages and reports are split to stay small", async (t) => {
  const server = cursorServer({ pageSize: 2 });
  const prompt = "x".repeat(6000);
  for (let i = 0; i < 9; i++)
    server.put(
      schedule(`work_${i}`, { spec: { ...schedule("x").spec, prompt } }),
    );
  const { supervisor } = await supervisorFor(t, server);
  await supervisor.start("http://isolated.invalid");
  supervisor.stop();
  const reports = server.requests.filter((r) => r.items > 0);
  assert.equal(
    reports.reduce((n, r) => n + r.items, 0),
    9,
    "every item is reported once",
  );
  assert.ok(reports.length >= 2, "the report was split");
  for (const r of reports)
    assert.ok(
      r.bytes <= 32 * 1024 + 8000,
      `a report of ${r.bytes} bytes exceeds the batch size`,
    );
  for (let i = 0; i < 9; i++)
    assert.match(supervisor.context("session"), new RegExp(`work_${i}\\b`));
});

test("a draining host keeps its sweep scheduled and resumes when draining ends", async (t) => {
  const server = cursorServer();
  const { supervisor } = await supervisorFor(t, server);
  await supervisor.start("http://isolated.invalid");
  supervisor.setDraining(true);
  server.requests.splice(0);
  await supervisor.tick();
  assert.equal(server.requests.length, 0, "a draining host sends nothing");
  assert.ok(supervisor.timer, "the next sweep is still scheduled");
  supervisor.setDraining(false);
  assert.ok(supervisor.timerDue - Date.now() <= 3000);
});

test("an unconfirmed control keeps the regular pace for two minutes, then backs off", async (t) => {
  const server = cursorServer();
  server.put(
    schedule("work_a", {
      desiredState: "stopped",
      revision: 2,
      observation: {
        status: "running",
        at: new Date().toISOString(),
        confirmedRevision: 1,
      },
    }),
  );
  const { supervisor } = await supervisorFor(t, server);
  // The device cannot confirm the stop: the item stays unconfirmed.
  supervisor.reconcile = async (item) => item.observation;
  await supervisor.start("http://isolated.invalid");
  supervisor.stop();
  // A sweep that reads nothing new.
  await supervisor.tick();
  const realNow = Date.now;
  t.after(() => (Date.now = realNow));
  const start = realNow();
  Date.now = () => start;
  assert.equal(supervisor.nextDelay(), 3000);
  Date.now = () => start + 60_000;
  assert.equal(supervisor.nextDelay(), 3000, "followed within two minutes");
  Date.now = () => start + 3 * 60_000;
  const delays = [];
  for (let i = 0; i < 3; i++) delays.push(supervisor.nextDelay());
  assert.deepEqual(delays, [6000, 12000, 15000]);
  // A newer control on the same item is followed again.
  supervisor.items.get("work_a").revision = 3;
  assert.equal(supervisor.nextDelay(), 3000);
});

test("a native task observed again unchanged is not reported again", async (t) => {
  const server = cursorServer();
  const { supervisor } = await supervisorFor(t, server);
  const task = (status, at) => ({
    id: "terminal-1",
    kind: "process",
    title: "long command",
    native: {
      runtime: "codex",
      version: "test",
      sessionId: "native",
      taskId: "terminal-1",
      discovery: "test",
      observation: "available",
      controls: {
        stop: "unavailable",
        pause: "unsupported",
        resume: "unsupported",
      },
    },
    observation: { status, at, startedAt: "2026-10-30T00:00:00.000Z" },
  });
  const id = [...supervisor.items.keys()].length;
  assert.equal(id, 0);
  supervisor.observeNativeWork(
    "session",
    task("running", "2026-10-30T00:00:01.000Z"),
  );
  assert.equal(supervisor.pending.size, 1, "a new task is reported");
  const [workId, first] = [...supervisor.pending][0];
  // As if the report was delivered just now.
  supervisor.pending.clear();
  supervisor.reported.set(workId, Date.now());

  supervisor.observeNativeWork(
    "session",
    task("running", "2026-10-30T00:00:04.000Z"),
  );
  assert.equal(supervisor.pending.size, 0, "only the time differs");
  assert.equal(
    supervisor.items.get(workId).observation.at,
    first.observation.at,
  );
  assert.equal(
    supervisor.items.get(workId).updatedAt,
    "2026-10-30T00:00:01.000Z",
  );

  // A running task is still refreshed now and then.
  supervisor.reported.set(workId, Date.now() - 11 * 60_000);
  supervisor.observeNativeWork(
    "session",
    task("running", "2026-10-30T00:11:00.000Z"),
  );
  assert.equal(supervisor.pending.size, 1, "the periodic refresh is sent");
  supervisor.pending.clear();
  supervisor.reported.set(workId, Date.now());

  supervisor.observeNativeWork(
    "session",
    task("completed", "2026-10-30T00:12:00.000Z"),
  );
  assert.equal(supervisor.pending.size, 1, "a real change is sent");
  assert.equal(supervisor.items.get(workId).observation.status, "completed");
});
