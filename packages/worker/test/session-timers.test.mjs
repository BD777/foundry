import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionTimers, timerDueAt } from "../dist/session-timers.js";

// The real case: a chat's fleet inspection every 30 minutes, which Claude
// Code fires 9 min 5 s after :28 and :58 (its id's offset).
const inspection = {
  id: "9b17c9d2",
  kind: "cron",
  schedule: "28,58 * * * *",
  humanSchedule: "每 30 分钟",
  recurring: true,
  prompt: "巡检 20 台容器",
};

// The agent processes running each session.
const process_sess_1 = { name: "process 1" };
const process_sess_2 = { name: "process 2" };
const process_sess_3 = { name: "process 3" };

function clock(at) {
  const state = { now: new Date(at) };
  return {
    now: () => state.now,
    set: (value) => {
      state.now = new Date(value);
    },
  };
}

function timers(time, outcomes = []) {
  const sent = [];
  const kept = new SessionTimers({
    now: time.now,
    send: async (request) => {
      sent.push(request);
      return outcomes.shift() ?? "sent";
    },
  });
  return { kept, sent };
}

test("a session's timers are sent only while no process of the worker holds them", async () => {
  const time = clock("2026-10-11T02:00:00");
  const { kept, sent } = timers(time);
  assert.deepEqual(kept.attach("sess_1", "native_1", process_sess_1), []);
  kept.record("sess_1", "native_1", [inspection]);
  time.set("2026-10-11T02:40:00");
  await kept.tick();
  assert.equal(sent.length, 0, "the process fires its timers itself");

  // The worker restarts at 02:06 (the real case): its process is gone.
  time.set("2026-10-11T02:06:00");
  kept.detach("sess_1", "native_1", [inspection], process_sess_1);
  time.set("2026-10-11T02:37:04");
  await kept.tick();
  assert.equal(sent.length, 0, "not before Claude Code would fire it");
  time.set("2026-10-11T02:37:06");
  await kept.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, "sess_1");
  assert.equal(sent[0].nativeSessionId, "native_1");
  assert.equal(sent[0].timerId, "9b17c9d2");
  assert.equal(sent[0].prompt, "巡检 20 台容器");
  assert.equal(new Date(sent[0].dueAt).getMinutes(), 37);

  // Until the sent prompt's process runs the session, nothing more is sent.
  time.set("2026-10-11T02:39:00");
  await kept.tick();
  assert.equal(sent.length, 1);
  // That process resumes the session: Claude Code holds the timers again
  // and the device seeds what it kept.
  assert.deepEqual(
    kept.attach("sess_1", "native_1", process_sess_1).map((task) => task.id),
    ["9b17c9d2"],
  );
  time.set("2026-10-11T03:10:00");
  await kept.tick();
  assert.equal(sent.length, 1);
});

test("a recurring timer sent once is next due at its following time", async () => {
  const time = clock("2026-10-11T02:00:00");
  const { kept, sent } = timers(time);
  kept.attach("sess_1", "native_1", process_sess_1);
  kept.record("sess_1", "native_1", [inspection]);
  kept.detach("sess_1", "native_1", [inspection], process_sess_1);
  time.set("2026-10-11T02:38:00");
  await kept.tick();
  assert.equal(sent.length, 1);
  // The prompt never started a process (the device went away meanwhile):
  // after the wait the next time is sent, not the same one again.
  time.set("2026-10-11T03:08:00");
  await kept.tick();
  assert.equal(sent.length, 2);
  assert.equal(new Date(sent[1].dueAt).getMinutes(), 7);
  assert.ok(Date.parse(sent[1].dueAt) > Date.parse(sent[0].dueAt));
});

test("a busy session is tried again; a gone one is forgotten", async () => {
  const time = clock("2026-10-11T02:00:00");
  const { kept, sent } = timers(time, ["busy", "retry", "gone"]);
  kept.attach("sess_1", "native_1", process_sess_1);
  kept.record("sess_1", "native_1", [inspection]);
  kept.detach("sess_1", "native_1", [inspection], process_sess_1);
  time.set("2026-10-11T02:38:00");
  await kept.tick();
  await kept.tick();
  await kept.tick();
  assert.equal(sent.length, 3);
  assert.equal(sent[2].dueAt, sent[0].dueAt, "the same time until it is taken");
  assert.equal(kept.kept("sess_1"), undefined);
  await kept.tick();
  assert.equal(sent.length, 3);
});

test("deleted timers, expired ones and a new native session are never sent", async () => {
  const time = clock("2026-10-11T02:00:00");
  const { kept, sent } = timers(time);
  kept.attach("sess_1", "native_1", process_sess_1);
  kept.record("sess_1", "native_1", [inspection]);
  // CronDelete in the live process.
  kept.record("sess_1", "native_1", []);
  kept.detach("sess_1", "native_1", [], process_sess_1);
  time.set("2026-10-11T03:00:00");
  await kept.tick();
  assert.equal(sent.length, 0);

  kept.attach("sess_2", "native_2", process_sess_2);
  kept.record("sess_2", "native_2", [inspection]);
  kept.detach("sess_2", "native_2", [inspection], process_sess_2);
  // A week after Claude Code created it the timer is gone there too.
  time.set("2026-10-18T03:00:01");
  await kept.tick();
  assert.equal(sent.length, 0);
  assert.equal(kept.kept("sess_2"), undefined);

  kept.attach("sess_3", "native_3", process_sess_3);
  kept.record("sess_3", "native_3", [inspection]);
  kept.detach("sess_3", "native_3", [inspection], process_sess_3);
  // The session moved on to a new native session: the old one's timers do
  // not come back with it.
  assert.deepEqual(kept.attach("sess_3", "native_4", process_sess_3), []);
  kept.detach("sess_3", "native_4", [], process_sess_3);
  time.set("2026-10-18T04:00:00");
  await kept.tick();
  assert.equal(sent.length, 0);
});

test("a one-shot timer missed while nothing ran is sent once at once", async () => {
  const time = clock("2026-10-11T02:00:00");
  const { kept, sent } = timers(time);
  const reminder = {
    id: "1f000000",
    kind: "wakeup",
    schedule: "15 2 11 10 *",
    humanSchedule: "单次",
    recurring: false,
    prompt: "check the build",
  };
  kept.attach("sess_1", "native_1", process_sess_1);
  kept.record("sess_1", "native_1", [reminder]);
  kept.detach("sess_1", "native_1", [reminder], process_sess_1);
  time.set("2026-10-11T02:30:00");
  await kept.tick();
  assert.equal(sent.length, 1);
  assert.equal(new Date(sent[0].dueAt).getMinutes(), 15);
  assert.deepEqual(kept.kept("sess_1"), [], "a one-shot timer fires once");
});

test("kept timers survive a restart and are due from then on", async () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-session-timers-"));
  const path = join(directory, "session-timers.json");
  try {
    const time = clock("2026-10-11T01:00:00");
    const before = new SessionTimers({ now: time.now, path });
    before.attach("sess_1", "native_1", process_sess_1);
    before.record("sess_1", "native_1", [inspection]);
    // The worker dies without closing anything.
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(
      JSON.parse(readFileSync(path, "utf8")).sessions[0].timers[0].id,
      "9b17c9d2",
    );

    time.set("2026-10-11T02:10:00");
    const sent = [];
    const after = new SessionTimers({
      now: time.now,
      path,
      send: async (request) => {
        sent.push(request);
        return "sent";
      },
    });
    after.load();
    // 02:07 passed while nothing ran (Claude Code skips it too).
    await after.tick();
    assert.equal(sent.length, 0);
    time.set("2026-10-11T02:37:10");
    await after.tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].timerId, "9b17c9d2");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a recurring timer is due at Claude Code's time after the process ended", () => {
  const due = timerDueAt(
    { ...inspection, firstSeenAt: "2026-10-10T06:27:14" },
    new Date("2026-10-11T02:06:00").toISOString(),
  );
  assert.equal(due.getHours(), 2);
  assert.equal(due.getMinutes(), 37);
  assert.equal(due.getSeconds(), 5);
});

test("an old process ending after a new one took the session leaves the timers to the new one", async () => {
  const time = clock("2026-10-11T02:00:00");
  const { kept, sent } = timers(time);
  const older = { name: "older" };
  const newer = { name: "newer" };
  kept.attach("sess_1", "native_1", older);
  kept.record("sess_1", "native_1", [inspection]);
  // A new process for the session (another model, say) starts first; the
  // old one's end is reported after it.
  kept.attach("sess_1", "native_1", newer);
  kept.detach("sess_1", "native_1", [inspection], older);
  kept.detach("sess_1", "native_1", [inspection], older);
  time.set("2026-10-11T03:00:00");
  await kept.tick();
  assert.equal(sent.length, 0, "the running process fires them itself");
});

test("timers the server knows are adopted unless the worker keeps or runs the session's own", async () => {
  // An older worker ran the session and kept nothing; the new one connects
  // at 15:26 and the server sends the timers it knows.
  const time = clock("2026-10-11T15:26:00");
  const { kept, sent } = timers(time);
  const fromServer = {
    sessionId: "sess_1",
    nativeSessionId: "native_1",
    timers: [{ ...inspection, firstSeenAt: "2026-10-10T06:27:13Z" }],
  };
  assert.equal(kept.adopt([fromServer]), true);
  assert.equal(kept.adopt([fromServer]), false, "sent again on reconnect");
  time.set("2026-10-11T15:37:04");
  await kept.tick();
  assert.equal(sent.length, 0, "not before Claude Code would fire it");
  time.set("2026-10-11T15:37:06");
  await kept.tick();
  assert.equal(sent.length, 1, "due at its first time after the adoption");
  assert.equal(sent[0].sessionId, "sess_1");
  assert.equal(sent[0].nativeSessionId, "native_1");
  assert.equal(sent[0].timerId, inspection.id);
  assert.equal(sent[0].prompt, inspection.prompt);
  assert.equal(new Date(sent[0].dueAt).getMinutes(), 37);

  // A session the worker keeps or runs keeps its own timers.
  kept.record("sess_2", "native_2", [inspection]);
  assert.equal(
    kept.adopt([
      { sessionId: "sess_2", nativeSessionId: "native_2", timers: [] },
    ]),
    false,
  );
  assert.equal(kept.attach("sess_3", "native_3", process_sess_3).length, 0);
  assert.equal(
    kept.adopt([
      {
        sessionId: "sess_3",
        nativeSessionId: "native_3",
        timers: [{ ...inspection, firstSeenAt: "2026-10-11T00:00:00Z" }],
      },
    ]),
    false,
  );
  assert.equal(kept.kept("sess_3"), undefined);

  // A recurring timer a week old was deleted by Claude Code.
  assert.equal(
    kept.adopt([
      {
        sessionId: "sess_4",
        nativeSessionId: "native_4",
        timers: [{ ...inspection, firstSeenAt: "2026-10-03T00:00:00Z" }],
      },
    ]),
    false,
  );
});
