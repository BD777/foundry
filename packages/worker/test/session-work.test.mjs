import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cronEntries,
  HostSchedules,
} from "../dist/session-work/host-schedules.js";
import {
  retireNativeSchedule,
  readNativeSchedules,
} from "../dist/session-work/native-schedules.js";
import { WorkProcesses } from "../dist/session-work/processes.js";
import { nextZonedWorkFire, sessionWorkContext } from "@bd777/foundry-protocol";

function scratch(t) {
  const path = mkdtempSync(join(tmpdir(), "work-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
// Discovery may find unrelated timers on a fresh CI runner. These tests must
// select their own work and inject report failures for that work specifically.
function unrelatedHostSchedules(root) {
  return new HostSchedules(join(root, "fake-hosts.json"), (argv) => ({
    status: 0,
    stdout: argv[0] === "crontab" ? "0 * * * * /unrelated-host-job\n" : "[]",
    stderr: "",
  }));
}
function work(overrides = {}) {
  return {
    id: "work_test",
    sessionId: "session",
    threadId: "thread",
    sourceId: "native",
    workspaceId: "workspace",
    deviceId: "device",
    kind: "process",
    source: "foundry",
    title: "Test command",
    management: "managed",
    desiredState: "enabled",
    revision: 1,
    generation: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    spec: { argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] },
    observation: { status: "idle", at: "", confirmedRevision: 0 },
    allowedActions: ["stop"],
    ...overrides,
  };
}

test("a native durable source retires only its verified owner and retains unrelated records", (t) => {
  const root = scratch(t);
  mkdirSync(join(root, ".claude"));
  const path = join(root, ".claude/scheduled_tasks.json");
  const tasks = [
    {
      id: "mine",
      cron: "* * * * *",
      prompt: "inspect",
      createdAt: Date.now(),
      createdBySessionId: "native",
    },
    {
      id: "other",
      cron: "* * * * *",
      prompt: "other",
      createdAt: Date.now(),
      createdBySessionId: "another",
    },
  ];
  writeFileSync(path, JSON.stringify({ tasks, retainedMetadata: true }));
  assert.throws(
    () =>
      retireNativeSchedule(
        { workspacePath: root, nativeSessionId: "wrong" },
        "mine",
      ),
    /ownership/,
  );
  retireNativeSchedule(
    { workspacePath: root, nativeSessionId: "native" },
    "mine",
  );
  assert.deepEqual(
    readNativeSchedules(root).map((x) => x.id),
    ["other"],
  );
  assert.equal(JSON.parse(readFileSync(path)).retainedMetadata, true);
  assert.equal(
    JSON.parse(
      readFileSync(join(root, ".claude/scheduled_tasks.foundry-mine.json")),
    ).tasks.length,
    2,
  );
});

test("live native creator and malformed sources cannot be overwritten", (t) => {
  const root = scratch(t);
  mkdirSync(join(root, ".claude"));
  const path = join(root, ".claude/scheduled_tasks.json");
  writeFileSync(
    path,
    JSON.stringify({
      tasks: [
        {
          id: "mine",
          cron: "* * * * *",
          prompt: "inspect",
          createdAt: Date.now(),
          createdBySessionId: "native",
          createdByPid: process.pid,
        },
      ],
    }),
  );
  assert.throws(
    () =>
      retireNativeSchedule(
        { workspacePath: root, nativeSessionId: "native" },
        "mine",
      ),
    /still running/,
  );
  writeFileSync(path, JSON.stringify({ unknown: true }));
  assert.throws(() => readNativeSchedules(root), /Unrecognized/);
});

test("crontab pause/restore preserves other jobs and refuses ambiguous or concurrent writes", async (t) => {
  const root = scratch(t);
  let content = "MAILTO=\n*/30 * * * * /tmp/my-driver\n0 9 * * * /tmp/other\n";
  const command = (argv, input) => {
    if (argv[0] !== "crontab")
      return { status: 1, stdout: "", stderr: "no user bus" };
    if (argv[1] === "-") content = input;
    return { status: 0, stdout: content, stderr: "" };
  };
  const host = new HostSchedules(join(root, "host.json"), command);
  const entry = cronEntries(content)[0];
  host.record(entry, "session");
  const item = work({
    source: "crontab",
    sourceId: `crontab:${entry.id}`,
    desiredState: "paused",
  });
  await host.apply(item);
  assert.match(content, /# foundry-work/);
  assert.match(content, /0 9 \* \* \* \/tmp\/other/);
  item.desiredState = "enabled";
  await host.apply(item);
  assert.match(content, /\*\/30 \* \* \* \* \/tmp\/my-driver/);
  item.desiredState = "stopped";
  item.observation = {
    status: "stopped",
    confirmedRevision: 1,
    at: new Date().toISOString(),
  };
  await assert.rejects(host.apply(item), /pre-existing external executions/);
  item.desiredState = "enabled";
  await host.apply(item);
  content += "*/30 * * * * /tmp/my-driver\n";
  await assert.rejects(host.apply(item), /ambiguous/);
});

test("a real supervised process starts and stops under its recorded identity", async (t) => {
  const processes = new WorkProcesses(scratch(t));
  const item = work();
  await processes.start(item, tmpdir());
  assert.equal((await processes.inspect(item)).status, "running");
  await processes.pause(item);
  assert.equal((await processes.inspect(item)).status, "suspended");
  await processes.start(item, tmpdir());
  assert.equal((await processes.inspect(item)).status, "running");
  await processes.stop(item);
  assert.equal((await processes.inspect(item)).status, "stopped");
  const endedAt = (await processes.inspect(item)).endedAt;
  await processes.stop(item);
  assert.equal(
    (await processes.inspect(item)).endedAt,
    endedAt,
    "repeated stop rewrote the execution end time",
  );
});

test("pausing a supervised process that already failed confirms without a live process", async (t) => {
  const processes = new WorkProcesses(scratch(t));
  const item = work({
    spec: { argv: [process.execPath, "-e", "process.exit(1)"] },
  });
  await processes.start(item, tmpdir());
  const deadline = Date.now() + 5000;
  // "unknown" until the exit is recorded: the process can be gone first.
  while (
    ["running", "unknown"].includes((await processes.inspect(item)).status) &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await processes.inspect(item)).status, "failed");
  await processes.pause(item);
  assert.equal((await processes.inspect(item)).status, "failed");
});

test("the bounded recovery context retains old enabled and pending work after compaction", () => {
  const context = sessionWorkContext(
    [
      work({ id: "old_cron", kind: "schedule", source: "claude" }),
      work({ id: "pending_stop", desiredState: "stopped" }),
    ],
    true,
  );
  assert.match(context, /old_cron/);
  assert.match(context, /pending_stop/);
  assert.match(context, /control NOT confirmed/);
  assert.match(context, /Automatic work is STOPPED/);
});

test("scheduled instants use the declared zone and handle DST gaps and folds", () => {
  assert.equal(
    nextZonedWorkFire(
      "0 9 * * *",
      "Asia/Shanghai",
      new Date("2026-10-17T00:40:00Z"),
    ).toISOString(),
    "2026-10-17T01:00:00.000Z",
  );
  assert.equal(
    nextZonedWorkFire(
      "30 2 * * *",
      "America/New_York",
      new Date("2026-03-08T06:59:00Z"),
    ).toISOString(),
    "2026-03-09T06:30:00.000Z",
  );
  assert.equal(
    nextZonedWorkFire(
      "30 1 * * *",
      "America/New_York",
      new Date("2026-11-01T05:45:00Z"),
    ).toISOString(),
    "2026-11-01T06:30:00.000Z",
  );
  assert.equal(nextZonedWorkFire("invalid", "UTC", new Date()), undefined);
});

test("termination verifies the whole process group, including a child that ignores TERM", async (t) => {
  const root = scratch(t);
  const processes = new WorkProcesses(root);
  const item = work({
    spec: {
      argv: [
        process.execPath,
        "-e",
        `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000)`,
        join(root, "child.pid"),
      ],
    },
  });
  await processes.start(item, root);
  for (let n = 0; n < 100; n++) {
    try {
      readFileSync(join(root, "child.pid"));
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  const pid = Number(readFileSync(join(root, "child.pid"), "utf8"));
  await new Promise((r) => setTimeout(r, 100));
  await processes.stop(item);
  const { processIdentity } = await import("../dist/agent-processes.js");
  assert.equal(processIdentity(pid), undefined, "a child escaped group stop");
});

test("persisted ownership and pending controls survive supervisor recreation without a server", async (t) => {
  const { WorkSupervisor } = await import("../dist/session-work/supervisor.js");
  const root = scratch(t);
  writeFileSync(
    join(root, "inventory.json"),
    JSON.stringify({
      sessions: [
        {
          id: "session",
          threadId: "thread",
          workspaceId: "workspace",
          deviceId: "device",
          workspacePath: root,
        },
      ],
      items: [
        work({
          kind: "schedule",
          source: "claude",
          id: "old_timer",
          desiredState: "stopped",
        }),
      ],
      stoppedThreads: ["thread"],
    }),
  );
  const supervisor = new WorkSupervisor(root, async () => {
    throw new Error("offline");
  });
  await supervisor.start("http://isolated.invalid");
  supervisor.stop();
  assert.equal(
    supervisor.enabled(),
    true,
    "disconnect must never reenable a second scheduler",
  );
  assert.match(supervisor.context("session"), /old_timer/);
  assert.match(supervisor.context("session"), /Automatic work is STOPPED/);
  assert.match(supervisor.context("session"), /control NOT confirmed/);
});

test("a runtime failure after a verified revision is not sent as a stale observation", async (t) => {
  const { WorkSupervisor } = await import("../dist/session-work/supervisor.js");
  const root = scratch(t);
  const sent = [];
  const item = work({
    kind: "schedule",
    spec: { schedule: "invalid", prompt: "inspect" },
    observation: {
      status: "idle",
      at: new Date().toISOString(),
      confirmedRevision: 1,
    },
  });
  const supervisor = new WorkSupervisor(root, async (_url, init) => {
    if (init?.body) sent.push(...JSON.parse(init.body).items);
    return new Response(
      JSON.stringify({
        items: [item],
        operations: [],
        barrier: false,
        coverage: { hostSchedules: "not_observed", processes: "not_observed" },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  supervisor.attach(
    {
      id: "session",
      threadId: "thread",
      workspaceId: "workspace",
      deviceId: "device",
      provider: "claude",
      source: "chat",
    },
    root,
  );
  await supervisor.start("http://isolated.invalid");
  supervisor.stop();
  const observed = sent.find((w) => w.id === item.id)?.observation;
  assert.equal(observed.confirmedRevision, 1);
  assert.equal(observed.status, "unknown");
  assert.match(observed.error, /Invalid or unsupported schedule/);
});

test("a host entry appearing during a tool call is discovered without assuming ownership", async (t) => {
  const { WorkSupervisor } = await import("../dist/session-work/supervisor.js");
  const root = scratch(t);
  let raw = "";
  let writes = 0;
  const sent = [];
  const supervisor = new WorkSupervisor(root, async (_url, init) => {
    if (init?.body) sent.push(...JSON.parse(init.body).items);
    return new Response(
      JSON.stringify({
        items: [],
        operations: [],
        barrier: false,
        coverage: { hostSchedules: "not_observed", processes: "not_observed" },
      }),
    );
  });
  supervisor.hosts = new HostSchedules(
    join(root, "fake-hosts.json"),
    (argv) => {
      if (argv[0] === "crontab") {
        if (argv[1] === "-") {
          writes++;
          throw new Error("an unrelated source was mutated");
        }
        return { status: 0, stdout: raw, stderr: "" };
      }
      return { status: 0, stdout: "[]", stderr: "" };
    },
  );
  supervisor.attach(
    {
      id: "session",
      threadId: "thread",
      workspaceId: "workspace",
      deviceId: "device",
      provider: "claude",
      source: "chat",
    },
    root,
  );
  await supervisor.start("http://isolated.invalid");
  supervisor.stop();
  supervisor.toolStarting("session", "tool");
  raw = "17 */6 * * * /tmp/unrelated-job\n";
  supervisor.toolCompleted("tool");
  await supervisor.tick();
  const item = sent.find((w) => w.source === "crontab");
  assert.equal(item.management, "observed");
  assert.deepEqual(item.allowedActions, ["adopt"]);
  assert.equal(writes, 0);
});

test("an empty recovered conversation acknowledges its sweep only after reconciliation", async (t) => {
  const { WorkSupervisor } = await import("../dist/session-work/supervisor.js");
  const root = scratch(t);
  const posts = [];
  const scope = {
    id: "session",
    threadId: "session",
    workspaceId: "workspace",
    deviceId: "device",
    workspacePath: root,
  };
  const supervisor = new WorkSupervisor(root, async (_url, init) => {
    if (init?.body) posts.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({
        items: [],
        operations: [],
        scopes: [scope],
        stoppedThreads: ["session"],
        sweepRevision: 7,
        barrier: false,
        coverage: { hostSchedules: "not_observed", processes: "not_observed" },
      }),
    );
  });
  supervisor.hosts = new HostSchedules(
    join(root, "fake-hosts.json"),
    (argv) => ({
      status: 0,
      stdout: argv[0] === "crontab" ? "" : "[]",
      stderr: "",
    }),
  );
  await supervisor.start("http://isolated.invalid");
  supervisor.stop();
  assert.match(supervisor.context("session"), /Automatic work is STOPPED/);
  assert.ok(
    posts.some(
      (p) =>
        p.items.length === 0 &&
        p.coverage.sweepRevision === "7" &&
        p.coverage.observedAt,
    ),
    "empty inventory never acknowledged the completed discovery sweep",
  );
});

test("legacy unreconciled native sources are preserved instead of automatically migrated", async (t) => {
  const { WorkSupervisor } = await import("../dist/session-work/supervisor.js");
  const root = scratch(t);
  mkdirSync(join(root, ".claude"));
  writeFileSync(
    join(root, ".claude/scheduled_tasks.json"),
    JSON.stringify({
      tasks: [
        {
          id: "old_timer",
          cron: "0 9 1 1 *",
          prompt: "inspect",
          createdAt: Date.now(),
          createdBySessionId: "native_old",
        },
      ],
    }),
  );
  const item = work({
    kind: "schedule",
    source: "claude",
    sourceId: "old_timer",
    desiredState: "stopped",
    spec: {
      nativeSessionId: "native_old",
      schedule: "0 9 1 1 *",
      prompt: "inspect",
    },
  });
  const sent = [];
  const scope = {
    id: "session",
    threadId: "thread",
    deviceId: "device",
    workspaceId: "workspace",
    workspacePath: root,
    nativeSessionId: "native_new",
  };
  const supervisor = new WorkSupervisor(root, async (_url, init) => {
    if (init?.body) sent.push(...JSON.parse(init.body).items);
    return new Response(
      JSON.stringify({
        items: [item],
        scopes: [scope],
        operations: [],
        barrier: false,
        coverage: { hostSchedules: "not_observed", processes: "not_observed" },
      }),
    );
  });
  await supervisor.start("http://isolated.invalid");
  supervisor.stop();
  assert.equal(readNativeSchedules(root)[0].createdBySessionId, "native_old");
  assert.match(
    sent.find((w) => w.id === item.id).observation.error,
    /automatic migration is disabled/,
  );
});

test("native task identifiers cannot escape the private backup directory", (t) => {
  const root = scratch(t);
  mkdirSync(join(root, ".claude"));
  mkdirSync(join(root, ".claude", "scheduled_tasks.foundry-foo"));
  const id = "foo/../../outside";
  writeFileSync(
    join(root, ".claude/scheduled_tasks.json"),
    JSON.stringify({
      tasks: [
        {
          id,
          cron: "* * * * *",
          prompt: "inspect",
          createdAt: Date.now(),
          createdBySessionId: "native",
        },
      ],
    }),
  );
  retireNativeSchedule({ workspacePath: root, nativeSessionId: "native" }, id);
  assert.throws(() => readFileSync(join(root, "outside.json")), /ENOENT/);
  assert.deepEqual(readNativeSchedules(root), []);
});

test("a process group is not a background task, and native helpers stay runtime-owned", async () => {
  const { processRole, inspectDetachedProcess } =
    await import("../dist/session-work/detached-processes.js");
  const row = {
    pid: 70,
    parent: 60,
    state: "S",
    startTime: "boot:1",
    executable: "/usr/bin/go",
  };
  const read = (pid) => ({
    pid,
    parent: pid === 60 ? 50 : 1,
    state: "S",
    startTime: "boot:2",
    executable: "/usr/bin/node",
  });
  assert.equal(processRole(row, new Set([50]), read), "foreground");
  assert.equal(processRole(row, new Set(), read), "foreground");
  assert.equal(
    processRole({ ...row, parent: 1 }, new Set(), read),
    "background",
  );
  assert.equal(
    processRole(
      { ...row, parent: 1, executable: "/vendor/bin/codex-code-mode-host" },
      new Set(),
      read,
    ),
    "runtime",
  );
  assert.equal(
    inspectDetachedProcess("70:boot:1", () => row, new Set()).processRole,
    "foreground",
  );
});

test("external exits and PID reuse are terminal, while permission errors stay unknown", async () => {
  const { inspectDetachedProcess } =
    await import("../dist/session-work/detached-processes.js");
  const missing = () => {
    throw Object.assign(new Error("gone"), { code: "ENOENT" });
  };
  assert.equal(
    inspectDetachedProcess("70:boot:1", missing, new Set()).status,
    "completed",
  );
  const denied = () => {
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  };
  const uncertain = inspectDetachedProcess("70:boot:1", denied, new Set());
  assert.equal(uncertain.status, "unknown");
  assert.match(uncertain.error, /Cannot verify/);
  for (const row of [
    { state: "Z", startTime: "boot:1" },
    { state: "S", startTime: "boot:2" },
  ])
    assert.equal(
      inspectDetachedProcess("70:boot:1", () => row, new Set()).status,
      "completed",
    );
});

test(
  "a real foreground tool group is never discovered or signalled as standalone work",
  { skip: process.platform !== "linux" },
  async (t) => {
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const { processIdentity } = await import("../dist/agent-processes.js");
    const {
      discoverDetachedProcesses,
      inspectDetachedProcess,
      stopDetachedProcess,
    } = await import("../dist/session-work/detached-processes.js");
    const sessionId = `foreground-test-${process.pid}`;
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, FOUNDRY_SESSION_ID: sessionId },
    });
    await once(child, "spawn");
    t.after(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    });
    const id = `${child.pid}:${processIdentity(child.pid).startTime}`;
    assert.equal(inspectDetachedProcess(id).processRole, "foreground");
    assert.equal(
      discoverDetachedProcesses(new Set([sessionId])).some(
        (p) => p.pid === child.pid,
      ),
      false,
    );
    await assert.rejects(() => stopDetachedProcess(id), /refusing to signal/);
    assert.ok(processIdentity(child.pid));
    const closed = once(child, "exit");
    child.kill("SIGTERM");
    await closed;
    assert.equal(inspectDetachedProcess(id).status, "completed");
    await stopDetachedProcess(id);
  },
);

test("runtime and ordinary tool processes never enter compact recovery context", () => {
  const items = ["runtime", "foreground", undefined].map((processRole, index) =>
    work({
      id: `tool-${index}`,
      source: "process",
      observation: {
        status: "running",
        at: "",
        confirmedRevision: 0,
        processRole,
      },
    }),
  );
  const text = sessionWorkContext(items);
  assert.match(text, /0 outstanding work/);
  assert.doesNotMatch(text, /tool-0|tool-1|tool-2/);
  const orphan = work({
    id: "orphan",
    source: "process",
    observation: {
      status: "running",
      at: "",
      confirmedRevision: 1,
      processRole: "background",
    },
  });
  assert.match(sessionWorkContext([orphan]), /1 outstanding work/);
});

test("the quiet work context says nothing until there is something to report", () => {
  assert.equal(sessionWorkContext([], false, true), "");
  assert.equal(
    sessionWorkContext(
      [
        work({
          id: "done",
          observation: { status: "completed", at: "", confirmedRevision: 1 },
        }),
      ],
      false,
      true,
    ),
    "",
  );
  assert.match(sessionWorkContext([], true, true), /Automatic work is STOPPED/);
  assert.match(
    sessionWorkContext(
      [work({ id: "old_cron", kind: "schedule", source: "claude" })],
      false,
      true,
    ),
    /1 outstanding work item[\s\S]*old_cron/,
  );
});

test(
  "reconciliation repairs legacy foreground records and acknowledges actual exit",
  { skip: process.platform !== "linux" },
  async (t) => {
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const { processIdentity } = await import("../dist/agent-processes.js");
    const { WorkSupervisor } =
      await import("../dist/session-work/supervisor.js");
    const root = scratch(t);
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: "ignore",
    });
    await once(child, "spawn");
    t.after(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    });
    const item = work({
      source: "process",
      sourceId: `${child.pid}:${processIdentity(child.pid).startTime}`,
      spec: {},
      observation: {
        status: "running",
        at: new Date().toISOString(),
        confirmedRevision: 1,
      },
    });
    const observed = [];
    const supervisor = new WorkSupervisor(root, async (_url, init) => {
      if (init?.body) observed.push(...JSON.parse(init.body).items);
      return new Response(
        JSON.stringify({
          items: [item],
          operations: [],
          barrier: false,
          coverage: {},
        }),
        { status: 200 },
      );
    });
    supervisor.hosts = unrelatedHostSchedules(root);
    supervisor.attach(
      {
        id: "session",
        threadId: "thread",
        workspaceId: "workspace",
        deviceId: "device",
      },
      root,
    );
    await supervisor.start("http://isolated.invalid");
    supervisor.stop();
    await supervisor.tick();
    assert.equal(
      observed.findLast((w) => w.id === item.id).observation.processRole,
      "foreground",
    );
    assert.match(supervisor.context("session"), /1 outstanding/);
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    await supervisor.tick();
    const actual = observed.findLast((w) => w.id === item.id).observation;
    assert.equal(actual.status, "completed");
    assert.equal(actual.confirmedRevision, 1);
    assert.ok(actual.endedAt);
  },
);

async function scheduleHarness(t, item, reply) {
  const { WorkSupervisor } = await import("../dist/session-work/supervisor.js");
  const root = scratch(t);
  let current = structuredClone(item);
  const sent = [];
  let fires = 0;
  const supervisor = new WorkSupervisor(root, async (url, init) => {
    if (url.endsWith("/work-fire")) {
      fires++;
      if (reply.endedAt) current.spec.manualRunAt = undefined;
      return new Response(JSON.stringify(reply), { status: 200 });
    }
    if (init?.body)
      for (const update of JSON.parse(init.body).items) {
        if (update.id === current.id) {
          current.observation = update.observation;
          sent.push(structuredClone(update.observation));
        }
      }
    return new Response(
      JSON.stringify({
        items: [current],
        operations: [],
        barrier: false,
        coverage: {},
      }),
      { status: 200 },
    );
  });
  supervisor.attach(
    {
      id: "session",
      threadId: "thread",
      workspaceId: "workspace",
      deviceId: "device",
    },
    root,
  );
  t.after(() => supervisor.stop());
  return {
    supervisor,
    sent,
    get fires() {
      return fires;
    },
    get current() {
      return current;
    },
    root,
  };
}

test("duplicate terminal fire receipts never resurrect a failed or completed execution", async (t) => {
  for (const status of ["completed", "failed"]) {
    const at = new Date(Date.now() - 1000).toISOString();
    const item = work({
      kind: "schedule",
      spec: { at, prompt: "one shot" },
      observation: {
        status: "idle",
        at: new Date().toISOString(),
        nextFireAt: at,
        confirmedRevision: 1,
      },
    });
    const h = await scheduleHarness(t, item, {
      id: "run",
      status,
      startedAt: at,
      endedAt: at,
      error: status === "failed" ? "delivery failed" : undefined,
    });
    await h.supervisor.start("http://isolated.invalid");
    h.supervisor.stop();
    await h.supervisor.tick();
    assert.equal(h.fires, 1);
    assert.equal(h.sent.at(-1).status, status);
    assert.ok(h.sent.at(-1).endedAt);
    if (status === "failed")
      assert.match(h.sent.at(-1).error, /delivery failed/);
  }
});

test("execution host draining prevents new scheduled dispatch and cancellation resumes it", async (t) => {
  const at = new Date(Date.now() - 1000).toISOString();
  const h = await scheduleHarness(
    t,
    work({
      kind: "schedule",
      spec: { at, prompt: "once" },
      observation: {
        status: "idle",
        at: at,
        nextFireAt: at,
        confirmedRevision: 1,
      },
    }),
    { id: "run", status: "running", startedAt: at },
  );
  h.supervisor.setDraining(true);
  await h.supervisor.start("http://isolated.invalid");
  h.supervisor.stop();
  assert.equal(h.fires, 0);
  h.supervisor.setDraining(false);
  await h.supervisor.tick();
  assert.equal(h.fires, 1);
});

test("an uncertain scheduled execution cannot claim a verified stop", async (t) => {
  const h = await scheduleHarness(
    t,
    work({
      kind: "schedule",
      desiredState: "stopped",
      revision: 2,
      spec: { schedule: "* * * * *", prompt: "test" },
      observation: {
        status: "unknown",
        runId: "ambiguous",
        at: "",
        confirmedRevision: 1,
      },
    }),
    {},
  );
  await h.supervisor.start("http://isolated.invalid");
  h.supervisor.stop();
  assert.equal(h.fires, 0);
  assert.equal(h.sent.at(-1).confirmedRevision, 1);
  assert.match(h.sent.at(-1).error, /cannot yet be verified/);
});

test("pausing a definition before its first process start is quiescent", async (t) => {
  const h = await scheduleHarness(
    t,
    work({ desiredState: "paused", revision: 2 }),
    {},
  );
  await h.supervisor.start("http://isolated.invalid");
  h.supervisor.stop();
  assert.equal(h.sent.at(-1).status, "stopped");
  assert.equal(h.sent.at(-1).confirmedRevision, 2);
});

test("short managed commands retain their actual exit and signal exits are terminal", async (t) => {
  const root = scratch(t);
  const processes = new WorkProcesses(root);
  for (let n = 0; n < 10; n++) {
    const item = work({ id: "short_" + n, spec: { argv: ["/bin/true"] } });
    await processes.start(item, root);
    for (
      let i = 0;
      i < 100 &&
      !["completed", "failed", "stopped"].includes(
        (await processes.inspect(item)).status,
      );
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    assert.equal((await processes.inspect(item)).status, "completed");
  }
  const item = work({ id: "signal" });
  await processes.start(item, root);
  t.after(() => processes.stop(item));
  const record = JSON.parse(readFileSync(join(root, "processes.json"), "utf8"))[
    item.id
  ];
  process.kill(record.pid, "SIGTERM");
  for (
    let i = 0;
    i < 100 &&
    !["completed", "failed", "stopped"].includes(
      (await processes.inspect(item)).status,
    );
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  assert.equal((await processes.inspect(item)).status, "failed");
});

test("a rejected work report is isolated while other work remains controllable", async (t) => {
  const { WorkSupervisor } = await import("../dist/session-work/supervisor.js");
  const root = scratch(t);
  const at = new Date(Date.now() - 1000).toISOString();
  const rows = [
    work({ id: "bad", desiredState: "paused" }),
    work({
      id: "good",
      kind: "schedule",
      spec: { at, prompt: "wake" },
      observation: {
        status: "idle",
        nextFireAt: at,
        at: new Date().toISOString(),
        confirmedRevision: 1,
      },
    }),
  ];
  let fires = 0;
  let goodReported = false;
  const acknowledgedSweeps = [];
  const supervisor = new WorkSupervisor(root, async (url, init) => {
    if (url.endsWith("/work-fire")) {
      fires++;
      return new Response(
        JSON.stringify({ id: "run", status: "running", startedAt: at }),
        { status: 200 },
      );
    }
    if (init?.body) {
      const { items, coverage } = JSON.parse(init.body);
      if (coverage?.sweepRevision !== "0")
        acknowledgedSweeps.push(coverage?.sweepRevision);
      if (items.some((x) => x.id === "bad"))
        return new Response("invalid report", { status: 400 });
      for (const item of items) {
        if (item.id === "good") {
          goodReported = true;
          rows[1].observation = item.observation;
        }
      }
    }
    return new Response(
      JSON.stringify({
        items: rows,
        operations: [],
        barrier: false,
        coverage: {},
        sweepRevision: 9,
      }),
      { status: 200 },
    );
  });
  supervisor.attach(
    {
      id: "session",
      threadId: "thread",
      workspaceId: "workspace",
      deviceId: "device",
    },
    root,
  );
  await supervisor.start("http://isolated.invalid");
  supervisor.stop();
  await supervisor.tick();
  assert.equal(fires, 1);
  assert.equal(goodReported, true);
  assert.equal(rows[1].observation.status, "running");
  assert.match(supervisor.context("session"), /bad/);
  assert.deepEqual(
    acknowledgedSweeps,
    [],
    "a rejected batch falsely acknowledged the whole sweep",
  );
});

test("resume discards missed periods by revision even when the worker clock was ahead", async (t) => {
  const h = await scheduleHarness(
    t,
    work({
      kind: "schedule",
      revision: 2,
      generation: 2,
      spec: { schedule: "* * * * *", recurring: true, prompt: "periodic" },
      observation: {
        status: "stopped",
        confirmedRevision: 1,
        at: new Date(Date.now() + 3600000).toISOString(),
        nextFireAt: new Date(Date.now() - 60000).toISOString(),
      },
    }),
    { id: "unexpected", status: "running" },
  );
  await h.supervisor.start("http://isolated.invalid");
  h.supervisor.stop();
  assert.equal(h.fires, 0);
  assert.equal(h.sent.at(-1).status, "idle");
  assert.ok(Date.parse(h.sent.at(-1).nextFireAt) > Date.now());
});

test("a manual run of a stopped schedule survives subsequent reconciliation until explicitly stopped", async (t) => {
  const at = new Date(Date.now() - 1000).toISOString();
  const h = await scheduleHarness(
    t,
    work({
      kind: "schedule",
      desiredState: "stopped",
      revision: 2,
      generation: 2,
      spec: { schedule: "* * * * *", manualRunAt: at, prompt: "once" },
      observation: { status: "stopped", confirmedRevision: 1, at: "" },
    }),
    { id: "run", status: "running", startedAt: at },
  );
  let stops = 0;
  h.supervisor.configureRuntime({
    stopScheduledRun: async () => {
      stops++;
    },
    inspect: () => "unknown",
    stop: async () => {},
    stopChild: async () => {},
  });
  await h.supervisor.start("http://isolated.invalid");
  h.supervisor.stop();
  await h.supervisor.tick();
  assert.equal(h.fires, 1);
  assert.equal(stops, 0);
  assert.equal(h.sent.at(-1).status, "running");
  h.current.revision = 3;
  h.current.spec.manualRunAt = undefined;
  await h.supervisor.tick();
  assert.equal(stops, 1);
  assert.equal(h.sent.at(-1).confirmedRevision, 2);
});

test("unsent native observations are retried after a supervisor restart", async (t) => {
  const { WorkSupervisor } = await import("../dist/session-work/supervisor.js");
  const root = scratch(t);
  writeFileSync(
    join(root, "inventory.json"),
    JSON.stringify({
      sessions: [
        {
          id: "session",
          threadId: "thread",
          workspaceId: "workspace",
          deviceId: "device",
          workspacePath: root,
        },
      ],
      items: [
        work({
          source: "claude",
          observation: {
            status: "completed",
            endedAt: new Date().toISOString(),
            confirmedRevision: 1,
            at: new Date().toISOString(),
          },
        }),
      ],
      pendingIds: ["work_test"],
    }),
  );
  let retried = false;
  const supervisor = new WorkSupervisor(root, async (_url, init) => {
    if (
      init?.body &&
      JSON.parse(init.body).items.some((x) => x.id === "work_test")
    )
      retried = true;
    return new Response(
      JSON.stringify({
        items: [],
        operations: [],
        barrier: false,
        coverage: {},
      }),
      { status: 200 },
    );
  });
  await supervisor.start("http://isolated.invalid");
  supervisor.stop();
  assert.equal(retried, true);
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, "inventory.json"), "utf8")).pendingIds,
    [],
  );
});

test("a failed network report persists newly reconciled work before host exit", async (t) => {
  const { WorkSupervisor } = await import("../dist/session-work/supervisor.js");
  const root = scratch(t);
  const item = work({ source: "claude" });
  const supervisor = new WorkSupervisor(root, async (_url, init) => {
    if (init?.body && JSON.parse(init.body).items.some((w) => w.id === item.id))
      throw new Error("synthetic connection loss");
    return new Response(
      JSON.stringify({
        items: [item],
        operations: [],
        barrier: false,
        coverage: {},
      }),
    );
  });
  supervisor.hosts = unrelatedHostSchedules(root);
  supervisor.attach(
    {
      id: "session",
      threadId: "thread",
      workspaceId: "workspace",
      deviceId: "device",
    },
    root,
  );
  supervisor.configureRuntime({
    inspect: () => "running",
    stop: async () => {},
    stopScheduledRun: async () => {},
    stopChild: async () => {},
  });
  await supervisor.start("http://isolated.invalid");
  supervisor.stop();
  const saved = JSON.parse(readFileSync(join(root, "inventory.json"), "utf8"));
  assert.ok(saved.pendingIds.includes(item.id));
  assert.equal(
    saved.items.find((x) => x.id === item.id).observation.status,
    "running",
  );
});

test("schedule expiry disables future runs without fabricating the current execution outcome", async (t) => {
  for (const status of ["running", "unknown"]) {
    const h = await scheduleHarness(
      t,
      work({
        kind: "schedule",
        spec: {
          schedule: "* * * * *",
          recurring: true,
          prompt: "test",
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        },
        observation: {
          status,
          at: new Date().toISOString(),
          confirmedRevision: 1,
          runId: "inflight",
        },
      }),
      {},
    );
    await h.supervisor.start("http://isolated.invalid");
    h.supervisor.stop();
    assert.equal(h.current.observation.status, status);
    assert.equal(h.current.observation.endedAt, undefined);
    assert.equal(h.fires, 0);
  }
});

test("native schedule definitions cannot overwrite their independent current execution", async (t) => {
  const { WorkSupervisor } = await import("../dist/session-work/supervisor.js");
  const root = scratch(t);
  const supervisor = new WorkSupervisor(root);
  supervisor.attach(
    {
      id: "session",
      threadId: "thread",
      workspaceId: "workspace",
      deviceId: "device",
      nativeSessionId: "native",
    },
    root,
  );
  const task = {
    id: "timer",
    kind: "cron",
    prompt: "inspect",
    schedule: "* * * * *",
    recurring: true,
    humanSchedule: "every minute",
  };
  const read = () =>
    JSON.parse(readFileSync(join(root, "inventory.json"), "utf8")).items[0];
  supervisor.observeTimers("session", [task], "2.1.295", "native");
  supervisor.observeTimerRun(
    "session",
    { id: "timer", startedAt: "2026-10-19T01:00:00Z" },
    false,
    "native",
  );
  supervisor.observeTimers("session", [task], "2.1.295", "native");
  assert.equal(read().observation.status, "running");
  assert.equal(read().native.lastRun.id, "timer@2026-10-19T01:00:00Z");
  supervisor.observeTimers("session", [], "2.1.295", "native");
  assert.equal(read().spec.recurring, false);
  assert.equal(read().observation.status, "running");
  assert.equal(read().observation.endedAt, undefined);
  supervisor.observeTimerRun(
    "session",
    {
      id: "timer",
      startedAt: "2026-10-19T01:00:00Z",
      completedAt: "2026-10-19T01:01:00Z",
    },
    false,
    "native",
  );
  supervisor.observeTimerRun(
    "session",
    { id: "timer", startedAt: "2026-10-19T01:00:00Z" },
    false,
    "native",
  );
  assert.equal(read().observation.status, "completed");
  assert.equal(read().native.lastRun.status, "completed");
  assert.match(sessionWorkContext([read()]), /0 outstanding work item/);
  supervisor.observeTimerRun(
    "session",
    { id: "timer", startedAt: "2026-10-19T02:00:00Z" },
    false,
    "foreign-native",
  );
  assert.equal(read().native.lastRun.startedAt, "2026-10-19T01:00:00Z");
});

test("a native run ending during inventory sync retains its newer run identity and receipt", async (t) => {
  const { WorkSupervisor } = await import("../dist/session-work/supervisor.js");
  const root = scratch(t);
  let supervisor,
    old,
    reported = false;
  supervisor = new WorkSupervisor(root, async (_url, init) => {
    if (init?.body) {
      const item = JSON.parse(init.body).items.find((item) => item.native);
      if (item) {
        old = item;
        if (!reported) {
          reported = true;
          supervisor.observeTimerRun(
            "session",
            {
              id: "timer",
              startedAt: "2026-10-19T01:00:00Z",
              completedAt: "2026-10-19T01:01:00Z",
            },
            false,
            "native",
          );
        }
      }
    }
    return new Response(
      JSON.stringify({
        items: old ? [old] : [],
        operations: [],
        coverage: {
          hostSchedules: "observed",
          processes: "managed_native_and_attributed",
        },
      }),
    );
  });
  supervisor.attach(
    {
      id: "session",
      threadId: "thread",
      workspaceId: "workspace",
      deviceId: "device",
      nativeSessionId: "native",
    },
    root,
  );
  supervisor.observeTimers(
    "session",
    [
      {
        id: "timer",
        kind: "wakeup",
        prompt: "inspect",
        schedule: "0 9 * * *",
        recurring: false,
        humanSchedule: "once",
      },
    ],
    "2.1.295",
    "native",
  );
  supervisor.observeTimerRun(
    "session",
    { id: "timer", startedAt: "2026-10-19T01:00:00Z" },
    false,
    "native",
  );
  await supervisor.start("http://isolated.invalid");
  supervisor.stop();
  const item = JSON.parse(readFileSync(join(root, "inventory.json"), "utf8"))
    .items[0];
  assert.equal(item.native.lastRun.status, "completed");
  assert.equal(item.observation.status, "completed");
});
