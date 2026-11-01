import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionTimers } from "../dist/session-timers.js";

// The real case: a chat's fleet inspection every 30 minutes.
const inspection = {
  id: "9b17c9d2",
  kind: "cron",
  schedule: "28,58 * * * *",
  humanSchedule: "每 30 分钟",
  recurring: true,
  prompt: "巡检 20 台容器",
};

test("the next process of a session is handed the timers the last one held", () => {
  const kept = new SessionTimers();
  const first = { name: "process 1" };
  assert.deepEqual(kept.attach("sess_1", "native_1", first), []);
  kept.record("sess_1", "native_1", [inspection]);
  kept.detach("sess_1", "native_1", [inspection], first);
  assert.deepEqual(kept.attach("sess_1", "native_1", { name: "process 2" }), [
    inspection,
  ]);
});

test("deleted timers and a new native session's are not handed over", () => {
  const kept = new SessionTimers();
  const process = { name: "process" };
  kept.attach("sess_1", "native_1", process);
  kept.record("sess_1", "native_1", [inspection]);
  // CronDelete in the live process.
  kept.record("sess_1", "native_1", []);
  kept.detach("sess_1", "native_1", [], process);
  assert.deepEqual(kept.attach("sess_1", "native_1", process), []);

  kept.record("sess_2", "native_2", [inspection]);
  // The session moved on to a new native session.
  assert.deepEqual(kept.attach("sess_2", "native_3", process), []);
  // One native session's timers belong to one Foundry session.
  kept.record("sess_3", "native_4", [inspection]);
  kept.attach("sess_4", "native_4", process);
  assert.deepEqual(kept.attach("sess_3", "native_4", process), []);
});

test("an old process ending after a new one took the session leaves the timers to the new one", () => {
  const kept = new SessionTimers();
  const older = { name: "older" };
  const newer = { name: "newer" };
  kept.attach("sess_1", "native_1", older);
  kept.record("sess_1", "native_1", [inspection]);
  kept.attach("sess_1", "native_1", newer);
  // CronDelete in the new process; the old one's end is reported after it.
  kept.record("sess_1", "native_1", []);
  kept.detach("sess_1", "native_1", [inspection], older);
  kept.detach("sess_1", "native_1", [inspection], older);
  assert.deepEqual(kept.attach("sess_1", "native_1", newer), []);
});

test("kept timers survive a restart in a private file", () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-session-timers-"));
  const path = join(directory, "session-timers.json");
  try {
    const before = new SessionTimers(path);
    before.attach("sess_1", "native_1", { name: "process" });
    before.record("sess_1", "native_1", [inspection]);
    // The worker dies without closing anything.
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(
      JSON.parse(readFileSync(path, "utf8")).sessions[0].timers[0].id,
      "9b17c9d2",
    );

    const after = new SessionTimers();
    after.load(path);
    assert.deepEqual(after.attach("sess_1", "native_1", { name: "next" }), [
      inspection,
    ]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
