import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  withCodexControl,
  inspectNativeAccount,
  readOfficialCodexCatalog,
} from "../dist/native-inspection.js";

test("Codex inspection uses only native account control reads, handles quota failure and never copies credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-account-test-"));
  const command = join(directory, "codex");
  const calls = join(directory, "calls");
  writeFileSync(
    command,
    `#!${process.execPath}
const fs=require("node:fs");
if(process.argv.includes("--version")) { console.log("test"); process.exit(0); }
if(process.argv.includes("models")) {
  fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+"\\n");
  console.log(JSON.stringify({models:[{slug:"official",visibility:"list"},{slug:"hidden",visibility:"hide"}]})); process.exit(0);
}
require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
 const m=JSON.parse(line); if(m.id===undefined)return;
 fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(m)+"\\n");
 let result={};
 if(m.method==="account/read")result={account:{type:"chatgpt",email:"test@example.test",planType:"pro"}};
 if(m.method==="account/rateLimits/read"){
  if(process.env.FOUNDRY_TEST_USAGE_FAIL) {console.log(JSON.stringify({id:m.id,error:{message:"SECRET-MUST-NOT-LEAK"}}));return;}
  result={rateLimits:{primary:{usedPercent:100,windowDurationMins:10080,resetsAt:1900000000}}};
 }
 console.log(JSON.stringify({id:m.id,result}));
});`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(directory, "auth.json"),
    JSON.stringify({
      tokens: {
        account_id: "test-account",
        access_token: "test-access",
        id_token: "test-id",
        refresh_token: "never-copy",
      },
    }),
  );
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
  const previous = {
    bin: process.env.FOUNDRY_CODEX_BIN,
    home: process.env.CODEX_HOME,
  };
  process.env.FOUNDRY_CODEX_BIN = command;
  process.env.CODEX_HOME = directory;
  try {
    const result = await inspectNativeAccount("codex");
    assert.equal(result.status, "verified");
    assert.equal(result.accountLabel, "test@example.test");
    assert.equal(result.usage[0].usedPercent, 100);
    assert.equal(result.executionSource, directory);
    assert.equal(result.source, directory);
    process.env.FOUNDRY_TEST_USAGE_FAIL = "1";
    const failed = await inspectNativeAccount("codex");
    assert.equal(failed.status, "local_login");
    assert.equal(failed.usage.length, 0);
    assert.doesNotMatch(JSON.stringify(failed), /SECRET-MUST/);
    writeFileSync(
      join(directory, "config.toml"),
      'model_catalog_json = "/gateway/catalog.json"\n',
    );
    assert.deepEqual(await readOfficialCodexCatalog(), [
      { id: "official", label: undefined },
    ]);
    const reads = readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      reads.filter((x) => x.method).map((x) => x.method),
      [
        "initialize",
        "account/login/start",
        "account/read",
        "account/rateLimits/read",
        "initialize",
        "account/login/start",
        "account/read",
        "account/rateLimits/read",
        "initialize",
        "account/login/start",
        "model/list",
      ],
    );
    assert(!JSON.stringify(reads).includes("never-copy"));
    assert.ok(
      reads.at(-1).includes("--bundled"),
      "official catalog cannot inherit a gateway catalog",
    );
    const missing = await inspectNativeAccount("codex", "/unapproved/path");
    assert.equal(missing.status, "unavailable");
    assert.equal(missing.source, "/unapproved/path");
    assert.equal(missing.executionSource, directory);
    assert.equal(missing.sources[0], directory);
    assert.ok(!missing.sources.includes("/unapproved/path"));
    assert.match(missing.message, /no longer present/);
    assert.doesNotMatch(JSON.stringify(missing), /SECRET-MUST/);
  } finally {
    globalThis.fetch = previousFetch;
    delete process.env.FOUNDRY_TEST_USAGE_FAIL;
    if (previous.bin === undefined) delete process.env.FOUNDRY_CODEX_BIN;
    else process.env.FOUNDRY_CODEX_BIN = previous.bin;
    if (previous.home === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous.home;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed Codex inspection setup releases its runtime lease", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-inspection-lease-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "not-a-directory");
  writeFileSync(source, "not a native home");
  const { foundryToolsRoot } = await import("../dist/state-root.js");
  const leases = join(foundryToolsRoot(), "agent-runtime-locks", "codex");
  const ownReaders = () =>
    (existsSync(leases) ? readdirSync(leases) : []).filter((name) => {
      if (!name.startsWith("reader-")) return false;
      try {
        return (
          JSON.parse(readFileSync(join(leases, name), "utf8")).pid ===
          process.pid
        );
      } catch {
        return false;
      }
    });
  const before = ownReaders();
  const marker = process.env.FOUNDRY_RUNTIME_CONFIG_ISOLATED;
  delete process.env.FOUNDRY_RUNTIME_CONFIG_ISOLATED;
  try {
    await assert.rejects(withCodexControl(source, async () => {}));
    assert.deepEqual(
      ownReaders(),
      before,
      "failed setup must not block future updates",
    );
  } finally {
    if (marker !== undefined)
      process.env.FOUNDRY_RUNTIME_CONFIG_ISOLATED = marker;
  }
});
