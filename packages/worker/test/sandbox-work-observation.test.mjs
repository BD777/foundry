import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordWorkToolStarting,
  recordWorkToolCompleted,
} from "../dist/session-work/supervisor.js";

test("a sandboxed SDK observer never creates device-global supervisor state", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-observer-"));
  const before = process.env.FOUNDRY_STATE_ROOT;
  t.after(() => {
    if (before === undefined) delete process.env.FOUNDRY_STATE_ROOT;
    else process.env.FOUNDRY_STATE_ROOT = before;
    rmSync(root, { recursive: true, force: true });
  });
  const blocked = join(root, "governance");
  writeFileSync(blocked, "not a directory");
  process.env.FOUNDRY_STATE_ROOT = blocked;
  assert.doesNotThrow(() => {
    recordWorkToolStarting("session", "tool");
    recordWorkToolCompleted("tool");
  });
  assert.equal(readFileSync(blocked, "utf8"), "not a directory");
});
