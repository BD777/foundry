import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { installNativeCli } from "../dist/native-cli-install.js";
import { checkCodexBuildsWith } from "../dist/agent-runtime/adapters.js";
import { verifyCodexCompatibility } from "../dist/runner/codex-compatibility.js";
import { clearNativeCliCache, nativeCli } from "../dist/native-cli.js";
import { fakeCodexAppServer } from "./fake-codex-app-server.mjs";
import {
  runtimeDescriptor,
  runtimeUpdateState,
} from "../dist/agent-runtime/state.js";

checkCodexBuildsWith(verifyCodexCompatibility);

/**
 * A device without Codex: PATH holds only node and a fake npm that "installs"
 * a Codex answering --version and model/list, and the official release
 * metadata is stubbed. Nothing leaves the machine.
 */
function missingCodexDevice(t, { npmFails = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "foundry-missing-runtime-"));
  const before = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    FOUNDRY_TOOLS_ROOT: process.env.FOUNDRY_TOOLS_ROOT,
    FOUNDRY_CODEX_BIN: process.env.FOUNDRY_CODEX_BIN,
    CODEX_CLI_PATH: process.env.CODEX_CLI_PATH,
    FOUNDRY_NATIVE_CLI_INSTALL_COMMAND:
      process.env.FOUNDRY_NATIVE_CLI_INSTALL_COMMAND,
  };
  const fetchBefore = globalThis.fetch;
  t.after(() => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    globalThis.fetch = fetchBefore;
    clearNativeCliCache();
    rmSync(root, { recursive: true, force: true });
  });
  const bin = join(root, "bin");
  mkdirSync(bin);
  process.env.PATH = `${bin}:${dirname(process.execPath)}`;
  process.env.HOME = join(root, "home");
  process.env.FOUNDRY_TOOLS_ROOT = join(root, "tools");
  for (const key of [
    "FOUNDRY_CODEX_BIN",
    "CODEX_CLI_PATH",
    "FOUNDRY_NATIVE_CLI_INSTALL_COMMAND",
  ])
    delete process.env[key];
  const codex = fakeCodexAppServer({ version: "1.1.0" });
  writeFileSync(
    join(bin, "npm"),
    npmFails
      ? `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('10.0.0');process.exit(0);}console.error('npm error network registry unreachable');process.exit(1);`
      : `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('10.0.0');process.exit(0);}const fs=require('node:fs'),p=require('node:path');const a=process.argv.slice(2);const prefix=a[a.indexOf('--prefix')+1];const dir=p.join(prefix,'node_modules','.bin');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(p.join(dir,'codex'),${JSON.stringify(codex)},{mode:0o755});`,
    { mode: 0o755 },
  );
  globalThis.fetch = async (url) => {
    assert.match(
      String(url),
      /^https:\/\/registry\.npmjs\.org\/@openai\/codex\//,
    );
    return new Response(JSON.stringify({ version: "1.1.0" }), { status: 200 });
  };
  clearNativeCliCache();
  return root;
}

test("a missing runtime installs as a Foundry-managed copy, reporting progress as it goes", async (t) => {
  const root = missingCodexDevice(t);
  assert.equal(nativeCli("codex").installed, false);
  assert.equal(nativeCli("codex").update, undefined);
  const seen = [];
  const result = await installNativeCli("codex", {
    onProgress: () => seen.push(nativeCli("codex").update?.state),
  });
  assert.equal(result.ok, true, result.log);
  assert.equal(result.cli.installed, true);
  assert.equal(result.cli.version, "1.1.0");
  // Started: the still-missing runtime says it is installing. Ended: current.
  assert.deepEqual(seen, ["updating", "current"]);
  const descriptor = runtimeDescriptor("codex");
  assert.equal(descriptor.version, "1.1.0");
  assert.ok(descriptor.executable.startsWith(join(root, "tools")));
  assert.equal(runtimeUpdateState("codex").install, undefined);
});

test("a failed install stays visible on the missing runtime with its reason", async (t) => {
  missingCodexDevice(t, { npmFails: true });
  const result = await installNativeCli("codex");
  assert.equal(result.ok, false);
  assert.match(result.log, /registry unreachable/);
  const cli = nativeCli("codex");
  assert.equal(cli.installed, false);
  assert.equal(cli.update?.state, "failed");
  assert.match(cli.update?.detail ?? "", /registry unreachable/);
});

test("two requests for the same install share one run", async (t) => {
  missingCodexDevice(t);
  const [a, b] = await Promise.all([
    installNativeCli("codex"),
    installNativeCli("codex"),
  ]);
  assert.equal(a, b);
  assert.equal(a.ok, true, a.log);
});

test("a pinned runtime is not replaced; the answer says why", async (t) => {
  const root = missingCodexDevice(t);
  process.env.FOUNDRY_CODEX_BIN = join(root, "nowhere", "codex");
  clearNativeCliCache();
  const result = await installNativeCli("codex");
  assert.equal(result.ok, false);
  assert.match(result.log, /pinned/);
  assert.equal(runtimeDescriptor("codex"), undefined);
});

test("an npm failure reads as npm's own error, not its pointer to a debug log", async () => {
  const { installFailureReason } =
    await import("../dist/native-cli-install.js");
  assert.equal(
    installFailureReason(
      "Error: Command failed: npm install --prefix /x @openai/codex@1.1.0\nnpm error code ECONNREFUSED\nnpm error syscall connect\nnpm error errno ECONNREFUSED\nnpm error FetchError: request to https://registry.npmjs.org/@openai%2fcodex failed, reason: connect ECONNREFUSED 127.0.0.1:9\nnpm error     at ClientRequest.<anonymous> (/usr/lib/x.js:1:1)\nnpm error A complete log of this run can be found in: /home/u/.npm/_logs/x.log",
    ),
    "FetchError: request to https://registry.npmjs.org/@openai%2fcodex failed, reason: connect ECONNREFUSED 127.0.0.1:9",
  );
});

test("a missing Codex makes its profiles unavailable, not merely signed out", async (t) => {
  missingCodexDevice(t);
  const { providerHealthData } = await import("../dist/provider-health.js");
  const codex = providerHealthData().find((row) => row.provider === "codex");
  assert.equal(codex.status, "unavailable");
  assert.match(codex.statusDetail, /Codex is not installed/);
  assert.equal(codex.cli.installed, false);
});
