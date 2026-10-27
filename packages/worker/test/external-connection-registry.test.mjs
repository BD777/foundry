import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  addExternalConnection,
  listExternalConnections,
  removeExternalConnection,
  withExternalCheck,
} from "../dist/external-connection-registry.js";
import {
  deviceAgentProfilesPath,
  deviceProfileRevision,
} from "../dist/profiles.js";
import {
  providerCheckFingerprint,
  providerChecksPath,
} from "../dist/provider-check-state.js";
import { checkExternalConnection } from "../dist/provider-check.js";
import { DaemonDispatch } from "../dist/daemon/dispatch.js";
import { registerAgentHandlers } from "../dist/daemon/handlers/agents.js";
import { availableDaemonCapabilities } from "../dist/workspace-ops.js";

const cliPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "cli.js",
);
const root = mkdtempSync(join(tmpdir(), "foundry-external-registry-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

const helper = join(root, "helper");
writeFileSync(helper, "#!/bin/sh\nexit 0\n");
chmodSync(helper, 0o755);

const others = {
  profiles: [
    {
      id: "gateway",
      label: "Gateway",
      runtime: "claude",
      connectionType: "anthropic_compatible",
      baseUrl: "http://127.0.0.1:9",
      apiKey: "kept-as-is",
    },
    {
      id: "disabled",
      label: "Disabled",
      runtime: "codex",
      connectionType: "openai_compatible",
      enabled: false,
    },
  ],
  note: "top-level keys survive",
};

const input = {
  id: "company",
  label: "Company",
  executable: helper,
  args: ["work", "--port"],
  identity: "acct-1",
  model: "sonnet",
  models: ["opus", "sonnet"],
};

function reset() {
  writeFileSync(deviceAgentProfilesPath, JSON.stringify(others));
  rmSync(providerChecksPath(), { force: true });
}

const fileProfiles = () =>
  JSON.parse(readFileSync(deviceAgentProfilesPath, "utf8"));

test("registration is idempotent, keeps other profiles and resets the check on change", () => {
  reset();
  const created = addExternalConnection(input);
  assert.equal(created.action, "created");
  assert.deepEqual(created.connection.models, ["sonnet", "opus"]);
  assert.equal(created.connection.check.status, "unchecked");
  assert.equal(statSync(deviceAgentProfilesPath).mode & 0o777, 0o600);
  const file = fileProfiles();
  assert.equal(file.note, others.note);
  assert.deepEqual(file.profiles.slice(0, 2), others.profiles);
  assert.deepEqual(file.profiles[2].externalConnection, {
    executable: helper,
    args: ["work", "--port"],
    identity: "acct-1",
  });

  // A passed check of exactly this configuration.
  const profile = file.profiles[2];
  writeFileSync(
    providerChecksPath(),
    JSON.stringify({
      company: {
        status: "passed",
        checkedAt: "2026-10-26T00:00:00.000Z",
        fingerprint: providerCheckFingerprint(profile, []),
      },
    }),
  );
  const before = deviceProfileRevision();
  const again = addExternalConnection(input);
  assert.equal(again.action, "unchanged");
  assert.equal(again.connection.check.status, "passed");
  assert.equal(deviceProfileRevision(), before, "a no-op does not rewrite");

  const changed = addExternalConnection({ ...input, identity: "acct-2" });
  assert.equal(changed.action, "updated");
  assert.equal(changed.connection.check.status, "unchecked");
  assert.notEqual(deviceProfileRevision(), before, "the heartbeat sees it");
  assert.equal(fileProfiles().profiles.length, 3);
  assert.deepEqual(
    listExternalConnections().map((item) => [item.id, item.identity]),
    [["company", "acct-2"]],
  );
});

test("registration refuses other profile kinds and invalid helpers", () => {
  reset();
  const refused = (value, code) =>
    assert.throws(
      () => addExternalConnection(value),
      (error) => error.code === code,
    );
  refused({ ...input, id: "gateway" }, "id_conflict");
  refused({ ...input, id: "claude_local" }, "id_conflict");
  refused({ ...input, id: "Not Safe" }, "invalid_input");
  refused({ ...input, executable: "relative/helper" }, "invalid_input");
  refused({ ...input, executable: join(root, "missing") }, "invalid_input");
  refused({ ...input, identity: "" }, "invalid_input");
  refused({ ...input, model: "" }, "invalid_input");
  refused({ ...input, models: ["sonnet; rm -rf /"] }, "invalid_input");
  assert.deepEqual(fileProfiles(), others);
});

test("removal deletes only that external connection and its check", () => {
  reset();
  addExternalConnection(input);
  writeFileSync(
    providerChecksPath(),
    JSON.stringify({
      company: { status: "failed", checkedAt: "x", fingerprint: "y" },
      gateway: { status: "passed", checkedAt: "x", fingerprint: "z" },
    }),
  );
  assert.throws(
    () => removeExternalConnection("gateway"),
    (error) => error.code === "id_conflict",
  );
  assert.throws(
    () => removeExternalConnection("nope"),
    (error) => error.code === "not_found",
  );
  assert.equal(removeExternalConnection("company").action, "removed");
  assert.deepEqual(fileProfiles(), others);
  assert.deepEqual(
    Object.keys(JSON.parse(readFileSync(providerChecksPath(), "utf8"))),
    ["gateway"],
  );
});

test("registering again keeps a connection a person turned off", () => {
  reset();
  addExternalConnection(input);
  const file = fileProfiles();
  file.profiles[2].enabled = false;
  writeFileSync(deviceAgentProfilesPath, JSON.stringify(file));
  assert.equal(addExternalConnection(input).action, "unchanged");
  assert.equal(fileProfiles().profiles[2].enabled, false);
  addExternalConnection({ ...input, identity: "acct-2" });
  assert.equal(fileProfiles().profiles[2].enabled, false);
});

test("a check in progress refuses removal and its result does not outlive one", async () => {
  reset();
  addExternalConnection(input);
  await withExternalCheck("company", "Company", async () => {
    assert.throws(
      () => removeExternalConnection("company"),
      (error) => error.code === "busy",
    );
    // Another process (the CLI) removes it while the check writes a result.
    writeFileSync(deviceAgentProfilesPath, JSON.stringify(others));
    writeFileSync(
      providerChecksPath(),
      JSON.stringify({
        company: { status: "passed", checkedAt: "x", fingerprint: "y" },
      }),
    );
  });
  assert.deepEqual(JSON.parse(readFileSync(providerChecksPath(), "utf8")), {});
  await assert.rejects(
    withExternalCheck("company", "Company", async () => {
      await withExternalCheck("company", "Company", async () => {});
    }),
    (error) => error.code === "busy",
  );
});

test("the CLI prints one JSON line and follows the exit code contract", () => {
  reset();
  const run = (...args) =>
    spawnSync(process.execPath, [cliPath, "connection", ...args], {
      encoding: "utf8",
      env: process.env,
      timeout: 10_000,
    });
  const add = [
    "add",
    "company",
    "--label",
    "Company",
    "--executable",
    helper,
    "--arg",
    "work",
    "--arg=--port",
    "--identity",
    "acct-1",
    "--model",
    "sonnet",
    "--models",
    "sonnet,opus",
  ];
  const first = run(...add);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(
    [JSON.parse(first.stdout).action, JSON.parse(first.stdout).connection.args],
    ["created", ["work", "--port"]],
  );
  assert.equal(JSON.parse(run(...add).stdout).action, "unchanged");

  const conflict = run(
    ...add.map((arg) => (arg === "company" ? "gateway" : arg)),
  );
  assert.equal(conflict.status, 3);
  assert.equal(JSON.parse(conflict.stdout).code, "id_conflict");

  const invalid = run(
    "add",
    "x",
    "--label",
    "X",
    "--executable",
    "rel",
    "--identity",
    "i",
    "--model",
    "m",
  );
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stdout).ok, false);

  const listed = run("list", "--json");
  assert.equal(listed.status, 0);
  assert.equal(JSON.parse(listed.stdout)[0].check.status, "unchecked");

  assert.equal(run("remove", "missing").status, 4);
  const removed = run("remove", "company");
  assert.equal(removed.status, 0);
  assert.equal(JSON.parse(removed.stdout).action, "removed");
  assert.deepEqual(fileProfiles(), others);
});

test("a check runs once at a time and a missing helper fails without inference", async () => {
  reset();
  addExternalConnection(input);
  rmSync(helper);
  try {
    const first = checkExternalConnection("company");
    await assert.rejects(
      checkExternalConnection("company"),
      (error) => error.code === "busy",
    );
    const result = await first;
    assert.equal(result.status, "failed");
    assert.match(result.message, /helper is unavailable/);
    await assert.rejects(
      checkExternalConnection("gateway"),
      (error) => error.code === "not_found",
    );
  } finally {
    writeFileSync(helper, "#!/bin/sh\nexit 0\n");
    chmodSync(helper, 0o755);
  }
});

test("the daemon declares management and removes on the server's request", async () => {
  assert.ok(
    availableDaemonCapabilities(undefined).includes(
      "external_connection_manage_v1",
    ),
  );
  reset();
  addExternalConnection(input);
  const dispatch = new DaemonDispatch();
  registerAgentHandlers(dispatch);
  const sent = [];
  const ctx = {
    socket: { readyState: 1, send: (data) => sent.push(JSON.parse(data)) },
    roster: { currentRegistration: () => ({ device: { id: "dev" } }) },
  };
  await dispatch.dispatch(
    {
      id: "r1",
      type: "remove_external_connection",
      payload: { profileId: "gateway" },
    },
    ctx,
  );
  await dispatch.dispatch(
    {
      id: "r2",
      type: "remove_external_connection",
      payload: { profileId: "company" },
    },
    ctx,
  );
  assert.deepEqual(
    sent.map((message) => [message.id, message.type]),
    [
      ["r1", "external_connection_removed"],
      ["r2", "external_connection_removed"],
    ],
  );
  assert.equal(sent[0].payload.errorCode, "id_conflict");
  assert.equal(sent[1].payload.registration.device.id, "dev");
  assert.deepEqual(fileProfiles(), others);
});
