import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendLine, flushLines } from "../dist/platform/line-log.js";

test("lines are appended in order after what the file held", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fdy-line-log-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "messages.jsonl");
  appendLine(path, "first\n");
  await flushLines(path);
  for (let i = 0; i < 500; i++) appendLine(path, `${i}\n`);
  await flushLines(path);
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines[0], "first");
  assert.deepEqual(
    lines.slice(1),
    Array.from({ length: 500 }, (_, i) => `${i}`),
  );
});

test("a log that cannot be written never throws to its caller", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fdy-line-log-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "missing", "messages.jsonl");
  const errors = [];
  const original = console.error;
  console.error = (line) => errors.push(line);
  t.after(() => (console.error = original));
  appendLine(path, "a\n");
  await new Promise((done) => setTimeout(done, 100));
  appendLine(path, "b\n");
  await flushLines(path);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Could not append to .*messages\.jsonl/);
});
