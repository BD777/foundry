import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  hostConnectorProfile,
  startConnectionRelay,
} from "./pa-eval-connection-relay.mjs";

const helperSource = `
const lines = require("node:readline").createInterface({ input: process.stdin });
lines.once("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({
    protocol: request.protocol,
    identity: request.identity,
    home: process.env.HOME,
    arg: process.argv[2],
  }) + "\\n");
});
lines.on("close", () => {
  require("node:fs").writeFileSync(process.argv[3], "released");
  process.exit(0);
});
`;

test("the shim relays one request and the helper ends with its stdin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-test-"));
  let relay;
  try {
    const helper = join(dir, "helper.cjs");
    const released = join(dir, "released");
    writeFileSync(helper, helperSource);
    relay = startConnectionRelay(
      {
        id: "limen_default",
        label: "Limen · default",
        runtime: "claude",
        model: "sonnet",
        models: ["sonnet", "opus"],
        externalConnection: {
          executable: process.execPath,
          args: [helper, "default", released],
          identity: "ns-1",
        },
      },
      dir,
    );
    assert.equal(relay.profile.connectionType, "external");
    assert.equal(relay.profile.externalConnection.identity, "ns-1");
    assert.deepEqual(relay.profile.externalConnection.args, []);
    await new Promise((r) => setTimeout(r, 100));
    const shim = spawn(
      process.execPath,
      [relay.profile.externalConnection.executable],
      {
        env: { ...process.env, HOME: "/home/eval-worker" },
        stdio: ["pipe", "pipe", "inherit"],
      },
    );
    const reply = await new Promise((resolve) => {
      let out = "";
      shim.stdout.on("data", (c) => {
        out += c;
        if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0]));
      });
      shim.stdin.write(
        JSON.stringify({
          protocol: "foundry.connection.v1",
          identity: "ns-1",
        }) + "\n",
      );
    });
    assert.deepEqual(reply, {
      protocol: "foundry.connection.v1",
      identity: "ns-1",
      home: "/home/eval-worker",
      arg: "default",
    });
    shim.stdin.end();
    const code = await new Promise((r) => shim.once("close", r));
    assert.equal(code, 0);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(relay.served(), 1);
    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(released, "utf8"), "released");
  } finally {
    relay?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only a usable connector profile on this computer is relayed", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-test-"));
  try {
    const path = join(dir, "providers.json");
    writeFileSync(
      path,
      JSON.stringify({
        providers: [
          { id: "ok", externalConnection: { executable: "/bin/true" } },
          {
            id: "broken",
            problem: "x",
            externalConnection: { executable: "/bin/true" },
          },
        ],
      }),
    );
    process.env.PA_EVAL_HOST_MODEL_PROVIDERS = path;
    assert.equal(hostConnectorProfile("ok").id, "ok");
    assert.equal(hostConnectorProfile("broken"), undefined);
    assert.equal(hostConnectorProfile("prof_server"), undefined);
    assert.equal(hostConnectorProfile(""), undefined);
  } finally {
    delete process.env.PA_EVAL_HOST_MODEL_PROVIDERS;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the reply's loopback ports are the ones bridged", async () => {
  const { replyPorts } = await import("./pa-eval-connection-relay.mjs");
  const line = JSON.stringify({
    environment: {
      set: {
        HTTPS_PROXY: "http://127.0.0.1:41234",
        HTTP_PROXY: "http://user:secret@127.0.0.1:41234/",
        ANTHROPIC_BASE_URL: "http://localhost:5555",
        NODE_EXTRA_CA_CERTS: "/x/ca.pem",
        OTHER: "https://example.com:443",
      },
    },
  });
  assert.deepEqual(replyPorts(line), [41234, 5555]);
  assert.deepEqual(replyPorts("not json"), []);
});
