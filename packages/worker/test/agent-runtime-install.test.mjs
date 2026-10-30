import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkCodexBuildsWith,
  nativeUpdateAdapter,
} from "../dist/agent-runtime/adapters.js";
import { verifyCodexCompatibility } from "../dist/runner/codex-compatibility.js";

checkCodexBuildsWith(verifyCodexCompatibility);
import { runtimeDescriptor } from "../dist/agent-runtime/state.js";
import { clearNativeCliCache } from "../dist/native-cli.js";
import { fakeCodexAppServer } from "./fake-codex-app-server.mjs";

test("a staged official runtime activates only after a native metadata handshake; failed candidate retains old generation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "foundry-update-install-"));
  const before = {
    PATH: process.env.PATH,
    FOUNDRY_TOOLS_ROOT: process.env.FOUNDRY_TOOLS_ROOT,
    FOUNDRY_CODEX_BIN: process.env.FOUNDRY_CODEX_BIN,
  };
  t.after(() => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    clearNativeCliCache();
    rmSync(root, { recursive: true, force: true });
  });
  process.env.FOUNDRY_TOOLS_ROOT = join(root, "tools");
  const bin = join(root, "bin");
  mkdirSync(bin);
  process.env.PATH = bin + ":" + process.env.PATH;
  const original = join(bin, "codex");
  writeFileSync(original, "#!/bin/sh\necho codex-cli 1.0.0\n", { mode: 0o755 });
  process.env.FOUNDRY_CODEX_BIN = original;
  const calls = join(root, "rpc.jsonl");
  const binary = (version) =>
    fakeCodexAppServer({
      version,
      calls,
      rejectModelList: version === "1.2.0",
      refuseTurns: version === "1.3.0",
    });
  writeFileSync(
    join(bin, "npm"),
    `#!${process.execPath}\nconst fs=require('node:fs'),p=require('node:path');const a=process.argv.slice(2);const prefix=a[a.indexOf('--prefix')+1];const version=a.at(-1).split('@').at(-1);const dir=p.join(prefix,'node_modules','.bin');fs.mkdirSync(dir,{recursive:true});const scripts=${JSON.stringify({ "1.1.0": binary("1.1.0"), "1.2.0": binary("1.2.0"), "1.3.0": binary("1.3.0") })};fs.writeFileSync(p.join(dir,'codex'),scripts[version],{mode:0o755});`,
    { mode: 0o755 },
  );
  const adapter = nativeUpdateAdapter("codex");
  await adapter.update({ current: "1.0.0", target: "1.1.0", needed: true });
  const first = runtimeDescriptor("codex");
  assert.equal(first.version, "1.1.0");
  assert.ok(first.executable.startsWith(root));
  await assert.rejects(
    adapter.update({ current: "1.1.0", target: "1.2.0", needed: true }),
    /bad candidate/,
  );
  assert.deepEqual(runtimeDescriptor("codex"), first);
  // A release whose metadata handshake passes but that breaks Foundry's own
  // thread flow (as Codex 0.166 did) is not activated either.
  await assert.rejects(
    adapter.update({ current: "1.1.0", target: "1.3.0", needed: true }),
    /failed Foundry's compatibility check \(new thread: .*current provider/,
  );
  assert.deepEqual(runtimeDescriptor("codex"), first);
  const methods = readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  const names = methods.map((m) => m.method);
  assert.deepEqual(names.slice(0, 2), ["initialize", "model/list"]);
  // Only the activated candidate reached a resumed and a moved thread.
  for (const method of [
    "thread/start",
    "turn/start",
    "thread/resume",
    "thread/fork",
  ])
    assert.ok(names.includes(method), method);
  assert.ok(methods.every((m) => m.home.includes("foundry-agent-validation-")));
});
