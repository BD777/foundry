import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

// The pid ledger lives under the home directory and is resolved at import.
const home = mkdtempSync(join(tmpdir(), "foundry-authpids-"));
mkdirSync(join(home, ".foundry"));
process.env.HOME = home;

const {
  forgetAuthorizationPid,
  reapAbandonedAuthorizations,
  recordAuthorizationPid,
} = await import("../dist/profile-authorization.js");

const ledgerPath = join(home, ".foundry", "authorization-pids.json");
const readLedger = () => JSON.parse(readFileSync(ledgerPath, "utf8"));

test("a finished login leaves no entry behind", () => {
  recordAuthorizationPid("codex", 424242);
  assert.deepEqual(readLedger().codex, [424242]);
  forgetAuthorizationPid("codex", 424242);
  assert.equal(readLedger().codex, undefined);
});

test("a login left running by an earlier daemon is killed before the next one", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  recordAuthorizationPid("codex", child.pid);

  assert.deepEqual(reapAbandonedAuthorizations("codex"), [child.pid]);
  await exited;
  assert.equal(readLedger().codex, undefined);
});

test("reaping ignores pids that are already gone", () => {
  recordAuthorizationPid("claude", 999999);
  assert.deepEqual(reapAbandonedAuthorizations("claude"), []);
  assert.equal(readLedger().claude, undefined);
});
