// One setting governs a device's egress: `foundry-worker proxy` reaches the
// programs the Worker starts to reach the network for the person (connection
// helpers, extension tools, connection setup), not only its own requests.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "foundry-egress-test-"));
process.env.FOUNDRY_STATE_ROOT = join(root, "state");
process.env.HTTPS_PROXY = "http://environment.example:3128";
delete process.env.NO_PROXY;
delete process.env.no_proxy;
test.after(() => rmSync(root, { recursive: true, force: true }));

const { setWorkerProxy, clearWorkerProxy, workerEgressVariables } =
  await import("../dist/platform/server-link/server-proxy.js");
const { extensionBaseEnvironment } =
  await import("../dist/connectors/extensions/process-environment.js");
const { setupEnvironment } =
  await import("../dist/harness/external-connection-setup.js");
const { prepareExternalConnection } =
  await import("../dist/harness/external-connection.js");

const saved = "http://alice:secret@egress.example:17890/";

test("the saved proxy wins over the Worker's environment", () => {
  setWorkerProxy(saved.slice(0, -1), "localhost,127.0.0.1");
  const variables = workerEgressVariables();
  assert.equal(variables.HTTPS_PROXY, saved);
  assert.equal(variables.https_proxy, saved);
  assert.equal(variables.ALL_PROXY, saved);
  assert.equal(variables.NO_PROXY, "localhost,127.0.0.1");
  assert.equal(variables.FOUNDRY_PROXY, undefined);
  assert.equal(extensionBaseEnvironment().HTTPS_PROXY, saved);
  assert.equal(
    setupEnvironment("limen_default", "foundry-worker").HTTPS_PROXY,
    saved,
  );
});

test("without a saved proxy the Worker's environment applies", () => {
  clearWorkerProxy();
  assert.equal(
    workerEgressVariables().HTTPS_PROXY,
    "http://environment.example:3128",
  );
  assert.equal(
    extensionBaseEnvironment().HTTPS_PROXY,
    "http://environment.example:3128",
  );
});

test("a connection helper starts with the Worker's proxy", async () => {
  setWorkerProxy(saved.slice(0, -1), "localhost,127.0.0.1");
  const seen = join(root, "helper-proxy.json");
  const script = join(root, "helper.mjs");
  writeFileSync(
    script,
    `
    import { createInterface } from 'node:readline';
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(seen)}, JSON.stringify({https: process.env.HTTPS_PROXY ?? null, no: process.env.NO_PROXY ?? null}));
    const reader = createInterface({input:process.stdin});
    reader.once('line', line => {
      const req = JSON.parse(line);
      writeFileSync(${JSON.stringify(seen)} + '.request', JSON.stringify(req.environment));
      console.log(JSON.stringify({protocol:req.protocol, identity:req.identity, environment:{unset:[], set:{}}}));
    });
    reader.on('close', () => process.exit(0));
  `,
  );
  const prepared = await prepareExternalConnection(
    { executable: process.execPath, args: [script], identity: "person-a" },
    { env: {}, cwd: root },
  );
  await prepared.release?.();
  // The request names the launch's onward proxy too: a gateway records it
  // for the run (Limen's run note) instead of keeping a proxy of its own.
  const requested = JSON.parse(readFileSync(`${seen}.request`, "utf8"));
  assert.equal(requested.HTTPS_PROXY, saved);
  assert.equal(requested.NO_PROXY, "localhost,127.0.0.1");
  assert.equal(prepared.env.HTTPS_PROXY, undefined);
  assert.deepEqual(JSON.parse(readFileSync(seen, "utf8")), {
    https: saved,
    no: "localhost,127.0.0.1",
  });
});
