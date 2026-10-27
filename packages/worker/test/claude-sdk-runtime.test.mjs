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

test("external preparation stays outside SDK options and concurrent close waits for helper cleanup", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fdy-sdk-external-"));
  const previous = process.env.FOUNDRY_TOOLS_ROOT;
  process.env.FOUNDRY_TOOLS_ROOT = join(root, "tools");
  t.after(() => {
    if (previous === undefined) delete process.env.FOUNDRY_TOOLS_ROOT;
    else process.env.FOUNDRY_TOOLS_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const { existsSync } = await import("node:fs");
  const receipt = join(root, "released");
  const helper = join(root, "helper.mjs");
  writeFileSync(
    helper,
    `import {createInterface} from 'node:readline';import{writeFileSync}from'node:fs';
    const r=createInterface({input:process.stdin});r.once('line',line=>{const p=JSON.parse(line);console.log(JSON.stringify({protocol:p.protocol,identity:p.identity,environment:{set:{},unset:[]}}));});
    r.once('close',()=>setTimeout(()=>{writeFileSync(${JSON.stringify(receipt)},'done');process.exit(0)},200));`,
  );
  const sdkEntry = join(root, "sdk.mjs");
  writeFileSync(
    sdkEntry,
    `export function query(input){if('connectionAdapter' in input.options)throw Error('host-only option leaked');const q=(async function*(){yield {ok:true};})();q.control=async()=>true;q.close=()=>{};return q;}`,
  );
  activateRuntime("claude", {
    executable: "/test/claude",
    version: "test",
    sdkVersion: "test",
    sdkEntry,
    generation: "external-test",
  });
  const sdk = await loadClaudeSdk();
  const q = sdk.query({
    options: {
      env: { CLAUDE_CONFIG_DIR: root },
      cwd: root,
      connectionAdapter: {
        executable: process.execPath,
        args: [helper],
        identity: "test",
      },
    },
  });
  const consumed = (async () => {
    for await (const _ of q) {
    }
  })();
  await q.control();
  await q.dispose();
  assert.equal(existsSync(receipt), true);
  await consumed;
  const release = await tryMaintainRuntime("claude");
  assert.ok(release);
  release();
});
