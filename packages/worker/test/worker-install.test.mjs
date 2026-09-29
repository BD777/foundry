import assert from "node:assert/strict";
import test from "node:test";
import { workerPackageName } from "@foundry/protocol";
import { installDecision, ownPackage } from "../dist/worker-install.js";
import { workerLauncherScript } from "../dist/mac-worker-app.js";

test("install leaves a machine that already runs a worker for that server alone", () => {
  const server = "https://foundry.example.com";
  assert.equal(
    installDecision(
      { paired: true, serviceInstalled: true, serverURL: server },
      server,
    ),
    "already-installed",
  );
  assert.equal(
    installDecision(
      { paired: true, serviceInstalled: true, serverURL: "https://other" },
      server,
    ),
    "other-server",
  );
  // Paired without a service (an interrupted install) is finished, not refused.
  assert.equal(
    installDecision(
      { paired: true, serviceInstalled: false, serverURL: "https://other" },
      server,
    ),
    "install",
  );
  assert.equal(
    installDecision({ paired: false, serviceInstalled: false }, server),
    "install",
  );
});

test("the web's install command names this package", () => {
  assert.equal(ownPackage().name, workerPackageName);
});

test("the app's launcher exports the service environment, logs, and runs the worker", () => {
  const script = workerLauncherScript({
    command: [
      "/usr/bin/node",
      "/rt/current/cli.js",
      "daemon",
      "--server",
      "https://s",
    ],
    env: { HOME: "/Users/a b", ODD: "it's" },
    logs: { out: "/logs/out.log", err: "/logs/err.log" },
  });
  const lines = script.split("\n");
  assert.equal(lines[0], "#!/bin/sh");
  assert.ok(lines.includes("export HOME='/Users/a b'"));
  assert.ok(lines.includes("export ODD='it'\\''s'"));
  assert.ok(
    lines.some((line) =>
      /^export FOUNDRY_WORKER_APP='Foundry Worker/.test(line),
    ),
  );
  assert.ok(lines.includes("exec >>'/logs/out.log' 2>>'/logs/err.log'"));
  assert.ok(
    lines.includes(
      "exec '/usr/bin/node' '/rt/current/cli.js' 'daemon' '--server' 'https://s'",
    ),
  );
});
