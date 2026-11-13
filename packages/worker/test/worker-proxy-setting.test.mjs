import test from "node:test";
import assert from "node:assert/strict";
import {
  clearWorkerProxy,
  readWorkerProxy,
  setWorkerProxy,
} from "../dist/platform/server-link/server-proxy.js";
import { applyWorkerProxySetting } from "../dist/daemon/handlers/device.js";
import { availableDaemonCapabilities } from "../dist/daemon/workspace-ops.js";

// DEV-217: the device page's "Stop using this proxy" / "Use another proxy…".
test("the owner's proxy choice is saved by the Worker, validated and credential-free in its answer", (t) => {
  t.after(() => clearWorkerProxy());
  assert.ok(availableDaemonCapabilities().includes("worker_proxy_settings"));
  setWorkerProxy("http://127.0.0.1:1", "localhost");

  const answer = applyWorkerProxySetting({
    url: " http://user:pw@proxy:3128 ",
  });
  assert.deepEqual(answer, { proxy: "http://proxy:3128" });
  assert.deepEqual(readWorkerProxy(), {
    url: "http://user:pw@proxy:3128/",
    noProxy: "localhost",
  });

  assert.throws(
    () => applyWorkerProxySetting({ url: "ftp://proxy:21" }),
    /Invalid worker proxy/,
  );
  assert.throws(
    () => applyWorkerProxySetting({ url: "http://proxy:3128", clear: true }),
    /Name a proxy address/,
  );
  assert.equal(readWorkerProxy().url, "http://user:pw@proxy:3128/");

  assert.deepEqual(applyWorkerProxySetting({ clear: true }), {});
  assert.equal(readWorkerProxy(), undefined);
});
