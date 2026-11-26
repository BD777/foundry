import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  antigravityHome,
  antigravityInvocation,
  antigravityBinDir,
  requireAntigravityLogin,
} from "../dist/harness/native/antigravity.js";
import { nativeSignIn } from "../dist/harness/native/native-sign-in.js";
import {
  inspectAntigravity,
  readAntigravityCatalog,
} from "../dist/harness/native/antigravity-inspection.js";
import { installNativeCli } from "../dist/harness/native/native-cli-install.js";
import { nativeCliInstallCommands } from "../dist/harness/native/native-cli.js";
import { agentUpdateAdapters } from "../dist/harness/agent-runtime/registry.js";
import { acquireRuntime } from "../dist/harness/agent-runtime/maintenance.js";

test("the official installer targets Foundry's tools directory, and agy owns updates", () => {
  assert.match(
    nativeCliInstallCommands.antigravity,
    /https:\/\/antigravity\.google\/cli\/install\.sh \| bash -s -- --dir /,
  );
  assert.ok(nativeCliInstallCommands.antigravity.includes(antigravityBinDir()));
  assert.ok(
    agentUpdateAdapters.every((adapter) => adapter.id !== "antigravity"),
  );
});

test("Antigravity uses profile-scoped ACP argv and a personal Google terminal login", async () => {
  const root = mkdtempSync(join(tmpdir(), "agy-login-test-"));
  const trap = join(root, "secret-read");
  // Assert all Linux service checks are nonsecret Ping requests. A call to
  // secret-tool (or macOS security) would leave a trace even if it failed.
  writeFileSync(
    join(root, "dbus-send"),
    '#!/bin/sh\ncase "$*" in *org.freedesktop.DBus.Peer.Ping) exit 0;; *) exit 1;; esac\n',
    { mode: 0o755 },
  );
  for (const tool of ["secret-tool", "security"])
    writeFileSync(join(root, tool), `#!/bin/sh\ntouch "${trap}"\nexit 1\n`, {
      mode: 0o755,
    });
  const oldPath = process.env.PATH;
  process.env.PATH = root + ":" + oldPath;
  const id = "agy_profile1";
  const home = antigravityHome(id);
  const launch = antigravityInvocation(id);
  assert.deepEqual(launch.args, [
    "acp",
    "--gemini-dir",
    join(home, ".gemini"),
    "--app-data-dir",
    "antigravity-cli",
  ]);
  assert.throws(() => antigravityInvocation("../other"), /Invalid/);
  assert.notEqual(home, antigravityHome("agy_profile2"));
  assert.equal(launch.env.GEMINI_API_KEY, undefined);
  assert.equal(launch.env.AGY_ADC_AUTH, undefined);
  const log = join(root, "protocol.jsonl");
  mkdirSync(antigravityBinDir(), { recursive: true });
  writeFileSync(
    launch.command,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("1.5.15");
else if (args[0] === "models") console.log("available");
else if (args.at(-1) === "--login") {
  console.log("  https://accounts.google.com/o/oauth2/auth?state=fixture");
  process.stdin.once("data", data => process.exit(data.toString().trim() === "fixture-code" ? 0 : 1));
} else {
  const lines = require("node:readline").createInterface({ input: process.stdin });
  lines.on("line", line => {
    require("node:fs").appendFileSync(${JSON.stringify(log)}, line+"\\n");
    const m = JSON.parse(line);
    const result = m.method === "initialize" ? {protocolVersion:1,agentCapabilities:{auth:{logout:{}}}}
      : m.method === "session/new" ? {sessionId:"s",configOptions:[
        {category:"model",id:"model",currentValue:"m1",options:[{value:"m1",name:"Main"}]},
        {category:"thought_level",id:"effort",options:[{value:"high"}]}
      ]} : {};
    console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result}));
  });
}
`,
    { mode: 0o755 },
  );
  const step = (action, input) =>
    nativeSignIn({
      runtime: "antigravity",
      profileId: id,
      operationId: "operation-1234567890",
      action,
      input,
    });
  try {
    const install = await installNativeCli("antigravity");
    assert.equal(install.ok, true);
    assert.match(install.log, /manages its own updates/);
    const busy = await acquireRuntime("antigravity");
    try {
      await assert.rejects(step("begin"), /active/);
    } finally {
      busy();
    }
    const pending = await step("begin");
    assert.equal(pending.codeEntry, true);
    assert.equal(
      new URL(pending.verificationUrl).hostname,
      "accounts.google.com",
    );
    await step("input", "fixture-code");
    let end;
    for (let i = 0; i < 100; i++) {
      end = await step("poll");
      if (end.status !== "pending") break;
      await new Promise((done) => setTimeout(done, 25));
    }
    assert.equal(end.status, "complete");
    requireAntigravityLogin(id);
    assert.throws(() => requireAntigravityLogin("agy_profile2"), /Sign in/);
    assert.deepEqual(await readAntigravityCatalog(id), [
      { id: "m1", label: "Main", reasoningEfforts: ["high"] },
    ]);
    assert.equal((await inspectAntigravity(id)).status, "verified");
    await step("sign_out");
    assert.throws(() => requireAntigravityLogin(id), /Sign in/);
    assert.ok(!readFileSync(log, "utf8").includes("fixture-code"));
    assert.equal(existsSync(trap), false);
  } finally {
    await step("dismiss");
    process.env.PATH = oldPath;
  }
});
