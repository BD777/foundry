import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSubagentRecords } from "../dist/subagent-records.js";

test("subagent index follows append, partial UTF-8 records, truncation and rotation", async () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-subagent-index-"));
  const path = join(root, "messages.jsonl");
  const first = { type: "system", subtype: "task_started", task_id: "one" };
  const second = { type: "assistant", parent_tool_use_id: "one", text: "你好" };
  const initial = JSON.stringify(first) + "\n";
  try {
    writeFileSync(
      path,
      initial +
        JSON.stringify({ type: "stream_event", data: "ignored" }) +
        "\n",
    );
    const a = readSubagentRecords(path),
      b = readSubagentRecords(path);
    assert.equal(a, b);
    assert.deepEqual(await a, [first]);
    const bytes = Buffer.from(JSON.stringify(second) + "\n");
    const split = bytes.indexOf(Buffer.from("你好")) + 1;
    appendFileSync(path, bytes.subarray(0, split));
    assert.deepEqual(await readSubagentRecords(path), [first]);
    appendFileSync(path, bytes.subarray(split));
    assert.deepEqual(await readSubagentRecords(path), [first, second]);
    assert.deepEqual(await readSubagentRecords(path), [first, second]);
    writeFileSync(path, JSON.stringify(second));
    assert.deepEqual(await readSubagentRecords(path), [second]);
    appendFileSync(path, "\n");
    assert.deepEqual(await readSubagentRecords(path), [second]);
    renameSync(path, path + ".old");
    writeFileSync(path, initial);
    assert.deepEqual(await readSubagentRecords(path), [first]);
    writeFileSync(
      path,
      JSON.stringify({ ...first, task_id: "replacement" }) +
        "\n" +
        JSON.stringify(second) +
        "\n",
    );
    assert.deepEqual(await readSubagentRecords(path), [
      { ...first, task_id: "replacement" },
      second,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
