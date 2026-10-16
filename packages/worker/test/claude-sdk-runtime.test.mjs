import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateRuntime } from "../dist/agent-runtime/state.js";
import { loadClaudeSdk } from "../dist/agent-runtime/claude-sdk.js";
import { tryMaintainRuntime } from "../dist/agent-runtime/maintenance.js";

test("SDK queries pin immutable versions, forward controls and release on stream completion", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fdy-sdk-generation-"));
  const previous = process.env.FOUNDRY_TOOLS_ROOT;
  process.env.FOUNDRY_TOOLS_ROOT = join(root, "tools");
  t.after(() => {
    if (previous === undefined) delete process.env.FOUNDRY_TOOLS_ROOT;
    else process.env.FOUNDRY_TOOLS_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  });
  function install(v) {
    const sdkEntry = join(root, `sdk-${v}.mjs`);
    writeFileSync(
      sdkEntry,
      `export function query(input){const q=(async function*(){yield {version:'${v}',disabled:input.options.env.DISABLE_AUTOUPDATER};})();q.control=async x=>x;q.close=()=>{};return q}`,
    );
    activateRuntime("claude", {
      executable: "/test/claude",
      version: v,
      sdkVersion: v,
      sdkEntry,
      generation: v,
    });
  }
  install("1.0.0");
  const old = await loadClaudeSdk();
  install("1.1.0");
  const newer = await loadClaudeSdk();
  const q = old.query({ options: {} });
  assert.equal(await q.control("ok"), "ok");
  assert.equal(await tryMaintainRuntime("claude"), undefined);
  const rows = [];
  for await (const row of q) rows.push(row);
  assert.deepEqual(rows, [{ version: "1.0.0", disabled: "1" }]);
  const next = [];
  for await (const row of newer.query({ options: {} })) next.push(row);
  assert.equal(next[0].version, "1.1.0");
  const release = await tryMaintainRuntime("claude");
  assert.ok(release);
  release();
});
