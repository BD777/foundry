// node --test scripts/pa-eval-journal.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { appendRow, journalKey, readJournal } from "./pa-eval-journal.mjs";

const scratch = () => mkdtempSync(resolve(tmpdir(), "pa-journal-test-"));

test("rows come back by repetition and case", () => {
  const dir = scratch();
  try {
    const file = resolve(dir, "rows.jsonl");
    appendRow(file, 1, { id: "hw-a", decision: "ask" });
    appendRow(file, 2, {
      id: "hw-a",
      decision: "project",
      workspaceId: "ws_1",
    });
    appendRow(file, 1, { id: "hw-b", decision: "answer" });
    const done = readJournal(file);
    assert.equal(done.size, 3);
    assert.equal(done.get(journalKey(1, "hw-a")).decision, "ask");
    assert.equal(done.get(journalKey(2, "hw-a")).workspaceId, "ws_1");
    assert.equal(done.has(journalKey(2, "hw-b")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a line cut short by a crash is left out, the rest is kept", () => {
  const dir = scratch();
  try {
    const file = resolve(dir, "rows.jsonl");
    appendRow(file, 1, { id: "hw-a", decision: "ask" });
    appendFileSync(file, '{"repeat":1,"row":{"id":"hw-b","dec');
    const done = readJournal(file);
    assert.deepEqual([...done.keys()], [journalKey(1, "hw-a")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a damaged line before the end is an error, not a silent gap", () => {
  const dir = scratch();
  try {
    const file = resolve(dir, "rows.jsonl");
    writeFileSync(
      file,
      '{"repeat":1,"row":{"id":"hw-a"}}\nnot json\n{"repeat":1,"row":{"id":"hw-c"}}\n',
    );
    assert.throws(() => readJournal(file), /line 2 is not a row/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing journal is empty; the runner rejects a missing --resume file itself", () => {
  assert.equal(readJournal(resolve(scratch(), "absent.jsonl")).size, 0);
});
