// The turn file record suite again, with records on their own thread as the
// execution host runs them: same events, ledgers and diffs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";
import { startTurnFilesThread } from "../dist/session/files/session-files-thread.js";
import {
  readSessionFileLedger,
  SessionTurnFiles,
} from "../dist/session/files/session-files.js";

const thread = startTurnFilesThread();
await import("./session-files.test.mjs");

test("a stopped thread fails its records, and the next record starts another", async (t) => {
  assert.equal(isMainThread, true);
  const root = mkdtempSync(join(tmpdir(), "foundry-files-thread-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const sessionsRoot = join(workspace, ".foundry", "sessions");
  const events = [];
  const turn = (inputId) =>
    new SessionTurnFiles({
      workspacePath: workspace,
      sessionsRoot,
      sessionId: "sess_thread",
      inputId,
      startedAt: Date.now(),
      emit: async (label, detail, level, metadata) => {
        events.push(metadata.sessionFile);
      },
    });
  const lost = turn("in_1");
  await thread.stop();
  writeFileSync(join(workspace, "a.txt"), "a\n");
  await assert.rejects(
    lost.recordToolWrite({
      path: join(workspace, "a.txt"),
      op: "created",
      agent: "main",
    }),
    /Turn file record thread stopped/,
  );
  const next = turn("in_2");
  await next.recordToolWrite({
    path: join(workspace, "a.txt"),
    op: "created",
    agent: "main",
  });
  await next.finish("Wrote a.txt.");
  assert.deepEqual(
    readSessionFileLedger(sessionsRoot, "sess_thread").map(
      (entry) => entry.workspacePath,
    ),
    ["a.txt"],
  );
  assert.equal(events[0].workspacePath, "a.txt");
  await thread.stop();
});
