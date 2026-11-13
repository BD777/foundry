import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const proxyModule = resolve(
  import.meta.dirname,
  "../dist/platform/server-link/server-proxy.js",
);

/** A plain `node` running Worker code from this checkout, as a repro script would. */
function runFromCheckout(home, extra = {}) {
  const env = { ...process.env, HOME: home, ...extra };
  for (const name of [
    "NODE_TEST_CONTEXT",
    "FOUNDRY_STATE_ROOT",
    "FOUNDRY_STACK",
    "FOUNDRY_TOOLS_ROOT",
  ])
    if (!(name in extra)) delete env[name];
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(proxyModule)}); m.setWorkerProxy("http://127.0.0.1:9"); console.log(m.workerProxyPath());`,
    ],
    { env, encoding: "utf8" },
  );
}

// DEV-217: a benchmark's proxy repro, plain node against this checkout's
// dist, wrote a device's real ~/.foundry/worker-proxy.json.
test("Worker code from a checkout keeps its state out of the real ~/.foundry", (t) => {
  const home = mkdtempSync(join(tmpdir(), "checkout-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const run = runFromCheckout(home);
  assert.equal(run.status, 0, run.stderr);
  const written = run.stdout.trim();
  assert.match(written, /foundry-checkout-state-[^/]+\/worker-proxy\.json$/);
  assert.ok(existsSync(written));
  assert.equal(existsSync(join(home, ".foundry", "worker-proxy.json")), false);
  assert.match(run.stderr, /keeps its state in .*foundry-checkout-state-/);
  rmSync(resolve(written, ".."), { recursive: true, force: true });

  // Opting in, or naming a root, is taken as said.
  const real = runFromCheckout(home, { FOUNDRY_USE_REAL_STATE: "1" });
  assert.equal(real.status, 0, real.stderr);
  assert.equal(real.stdout.trim(), join(home, ".foundry", "worker-proxy.json"));
  assert.doesNotMatch(real.stderr, /keeps its state/);
  const named = runFromCheckout(home, {
    FOUNDRY_STATE_ROOT: join(home, "named"),
  });
  assert.equal(named.stdout.trim(), join(home, "named", "worker-proxy.json"));
});
