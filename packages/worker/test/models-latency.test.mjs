import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listCodexLocalModels } from "../dist/models.js";

test("model discovery does not block other requests and coalesces concurrent callers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-models-"));
  const executable = join(directory, "codex");
  const calls = join(directory, "calls");
  writeFileSync(
    executable,
    `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},process.argv.slice(2).join(' ')+'\\n');if(process.argv[2]==='--version'){console.log('test');}else{setTimeout(()=>console.log(JSON.stringify({models:[{slug:'test-model',visibility:'list'}]})),300);}`,
    { mode: 0o700 },
  );
  const previous = process.env.FOUNDRY_CODEX_BIN;
  process.env.FOUNDRY_CODEX_BIN = executable;
  try {
    let finished = false;
    const first = listCodexLocalModels();
    const second = listCodexLocalModels();
    assert.equal(first, second);
    void first.then(() => {
      finished = true;
    });
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(
      finished,
      false,
      "main event loop must respond while CLI is running",
    );
    assert.deepEqual(await first, [{ id: "test-model", label: undefined }]);
    await listCodexLocalModels();
    // One spawn total: concurrent callers share it, the result is cached, and no
    // separate `--version` probe runs.
    assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
      "debug models",
    ]);
  } finally {
    if (previous === undefined) delete process.env.FOUNDRY_CODEX_BIN;
    else process.env.FOUNDRY_CODEX_BIN = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
