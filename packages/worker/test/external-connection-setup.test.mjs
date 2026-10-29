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
} from "../dist/external-connection-registry.js";
import {
  cancelSetupRun,
  currentSetupProgress,
  readSetupRun,
  reportSetupProgress,
  setupEnvironment,
  setupWorkerCommand,
  startSetupRun,
} from "../dist/external-connection-setup.js";
import {
  agentProfilesForWorkspace,
  deviceAgentProfilesPath,
  profileFingerprint,
} from "../dist/profiles.js";
import { resourceSettings } from "../dist/resources/compute-settings.js";
import { workerShimPath } from "../dist/worker-identity.js";
import { foundryStatePath } from "../dist/state-root.js";
import { DaemonDispatch } from "../dist/daemon/dispatch.js";
import { registerAgentHandlers } from "../dist/daemon/handlers/agents.js";
import { availableDaemonCapabilities } from "../dist/workspace-ops.js";

const cliPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "cli.js",
);
const root = mkdtempSync(join(tmpdir(), "foundry-external-setup-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

const helper = join(root, "helper");
writeFileSync(helper, "#!/bin/sh\nexit 0\n");
chmodSync(helper, 0o755);

const command =
  "curl -fsSL https://gateway.example/install.sh | sh -s -- --profile default";
const input = {
  id: "company",
  label: "Company",
  executable: helper,
  identity: "acct-1",
  model: "sonnet",
  setupCommand: command,
  setupUrl: "https://gateway.example/foundry",
  signIn: "device_code",
};

function reset() {
  writeFileSync(deviceAgentProfilesPath, JSON.stringify({ profiles: [] }));
  rmSync(foundryStatePath("external-connection-setup.json"), { force: true });
  resourceSettings.set({ allowRemoteCommands: true });
}

const storedSetup = () =>
  JSON.parse(readFileSync(deviceAgentProfilesPath, "utf8")).profiles.find(
    (profile) => profile.id === "company",
  )?.externalSetup;

const worker = setupWorkerCommand(workerShimPath());
const run = (id, line, extra = {}) =>
  startSetupRun(id, line, {
    remoteCommands: true,
    env: setupEnvironment(id, worker),
    ...extra,
  });

const cli = (...args) =>
  spawnSync(process.execPath, [cliPath, "connection", ...args], {
    encoding: "utf8",
    env: process.env,
    timeout: 10_000,
  });

async function until(read, done, ms = 10_000) {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (done(value)) return value;
    if (Date.now() - started > ms) return value;
    await new Promise((settle) => setTimeout(settle, 50));
  }
}

test("setup metadata is registered, reported and kept out of the connection's fingerprint", () => {
  reset();
  const created = addExternalConnection(input);
  assert.equal(created.action, "created");
  assert.equal(created.connection.setup.command, command);
  const first = storedSetup();
  assert.equal(first.signIn, "device_code");
  assert.ok(Date.parse(first.registeredAt));

  // The same input changes nothing, including when it was registered.
  assert.equal(addExternalConnection(input).action, "unchanged");
  assert.equal(storedSetup().registeredAt, first.registeredAt);

  const [projection] = agentProfilesForWorkspace(
    { id: "dev", label: "Dev", lastSeenLabel: "now" },
    root,
  ).filter((profile) => profile.id === "company");
  assert.equal(projection.externalSetup.command, command);

  // Setup metadata is not part of the connection: changing it keeps the
  // check fingerprint, so a passed check stays valid.
  const profile = JSON.parse(readFileSync(deviceAgentProfilesPath, "utf8"))
    .profiles[0];
  const before = profileFingerprint(profile);
  assert.equal(
    addExternalConnection({ ...input, setupCommand: "install --v2" }).action,
    "updated",
  );
  const after = JSON.parse(readFileSync(deviceAgentProfilesPath, "utf8"))
    .profiles[0];
  assert.equal(profileFingerprint(after), before);
  assert.equal(after.externalSetup.command, "install --v2");

  // Registering without metadata drops it.
  const { setupCommand, setupUrl, signIn, ...plain } = input;
  addExternalConnection(plain);
  assert.equal(storedSetup(), undefined);
  assert.equal(listExternalConnections()[0].setup, undefined);
});

test("setup metadata is validated", () => {
  reset();
  for (const bad of [
    { setupCommand: "one\ntwo" },
    { setupCommand: "x".repeat(2001) },
    { setupUrl: "http://gateway.example/" },
    { setupCommand: "", setupUrl: "https://gateway.example/" },
    { signIn: "password" },
  ])
    assert.throws(
      () => addExternalConnection({ ...input, ...bad }),
      (error) => error.code === "invalid_input",
      JSON.stringify(bad),
    );
});

test("installers report progress with the CLI; it expires and goes with the connection", () => {
  reset();
  const ok = cli(
    "progress",
    "company",
    "--state",
    "waiting_sign_in",
    "--sign-in-url",
    "https://gateway.example/device",
    "--user-code",
    "ABCD-1234",
  );
  assert.equal(ok.status, 0, ok.stderr);
  const line = JSON.parse(ok.stdout);
  assert.equal(line.ok, true);
  assert.equal(line.progress.state, "waiting_sign_in");
  assert.equal(currentSetupProgress("company").userCode, "ABCD-1234");
  const file = foundryStatePath("external-connection-setup.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);

  for (const args of [
    ["--state", "done"],
    ["--state", "installed", "--sign-in-url", "http://plain.example/"],
    ["--state", "installed", "--user-code", "a;b"],
  ]) {
    const refused = cli("progress", "company", ...args);
    assert.equal(refused.status, 2, args.join(" "));
    assert.equal(JSON.parse(refused.stdout).code, "invalid_input");
  }

  // An hour-old step is no longer current.
  const stale = JSON.parse(readFileSync(file, "utf8"));
  stale.company.updatedAt = new Date(Date.now() - 61 * 60_000).toISOString();
  writeFileSync(file, JSON.stringify(stale));
  assert.equal(currentSetupProgress("company"), undefined);

  reportSetupProgress({ id: "company", state: "installed" });
  addExternalConnection(input);
  removeExternalConnection("company");
  assert.equal(currentSetupProgress("company"), undefined);
});

test("a remote setup run needs remote commands and gets a plain environment", async () => {
  reset();
  assert.throws(
    () => startSetupRun("company", "true", { remoteCommands: false, env: {} }),
    (error) => error.code === "remote_commands_off",
  );

  const env = setupEnvironment("company", worker, {
    ...process.env,
    FOUNDRY_SESSION_TOKEN: "session-secret",
    ANTHROPIC_API_KEY: "provider-secret",
  });
  assert.equal(env.FOUNDRY_SESSION_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.FOUNDRY_CONNECTION_SETUP, "remote");
  assert.equal(env.FOUNDRY_CONNECTION_ID, "company");
  assert.equal(env.FOUNDRY_STATE_ROOT, process.env.FOUNDRY_STATE_ROOT);

  // The installer calls this worker's CLI, which reaches its state.
  const started = run(
    "company",
    `echo "mode=$FOUNDRY_CONNECTION_SETUP"; "$FOUNDRY_WORKER" connection progress company --state installed >/dev/null; echo done >&2`,
  );
  assert.equal(started.state, "running");
  assert.throws(
    () => run("company", "true"),
    (error) => error.code === "busy",
  );
  const finished = await until(
    () => readSetupRun("company", started.runId),
    (value) => value.state !== "running",
  );
  assert.equal(finished.state, "succeeded", finished.output);
  assert.equal(finished.exitCode, 0);
  assert.match(finished.output, /mode=remote/);
  assert.match(finished.output, /done/);
  assert.equal(currentSetupProgress("company").state, "installed");

  // Output is read on from an offset.
  const rest = readSetupRun("company", started.runId, finished.nextOffset - 5);
  assert.equal(rest.output, finished.output.slice(-5));
  assert.equal(readSetupRun("company").runId, started.runId);
  assert.equal(readSetupRun("other", started.runId), undefined);
});

test("a remote setup run can be cancelled or time out, and a failure keeps its code", async () => {
  reset();
  const long = run("company", "echo started; sleep 30");
  await until(
    () => readSetupRun("company", long.runId),
    (value) => value.output.includes("started"),
  );
  cancelSetupRun("company", long.runId);
  const cancelled = await until(
    () => readSetupRun("company", long.runId),
    (value) => value.state !== "running",
  );
  assert.equal(cancelled.state, "cancelled");

  const slow = run("company", "sleep 30", { timeoutMs: 200 });
  const timedOut = await until(
    () => readSetupRun("company", slow.runId),
    (value) => value.state !== "running",
  );
  assert.equal(timedOut.state, "timed_out");

  const failing = run("company", "echo nope >&2; exit 3");
  const failed = await until(
    () => readSetupRun("company", failing.runId),
    (value) => value.state !== "running",
  );
  assert.equal(failed.state, "failed");
  assert.equal(failed.exitCode, 3);
});

test("the daemon reads, starts and cancels setup on the server's request", async () => {
  assert.ok(
    availableDaemonCapabilities(undefined).includes(
      "external_connection_setup_v1",
    ),
  );
  reset();
  const dispatch = new DaemonDispatch();
  registerAgentHandlers(dispatch);
  const sent = [];
  let reports = 0;
  const ctx = {
    socket: { readyState: 1, send: (data) => sent.push(JSON.parse(data)) },
    roster: {
      currentRegistration: () => ({ device: { id: "dev" } }),
      reportDevice: () => (reports += 1),
    },
  };
  const ask = (id, type, payload) =>
    dispatch.dispatch({ id, type, payload }, ctx);

  await ask("r1", "read_external_connection_setup", { profileId: "company" });
  const nothing = sent.at(-1).payload;
  assert.equal(nothing.remoteCommands, true);
  assert.equal(nothing.connection, undefined);
  assert.equal(nothing.progress, undefined);

  reportSetupProgress({ id: "company", state: "installed" });
  addExternalConnection(input);
  await ask("r2", "read_external_connection_setup", { profileId: "company" });
  const read = sent.at(-1).payload;
  assert.equal(read.progress.state, "installed");
  assert.deepEqual(read.connection, {
    helperAvailable: true,
    check: { status: "unchecked" },
  });
  // The connection appeared since the last read: the device reports at once.
  assert.equal(reports, 1);
  await ask("r3", "read_external_connection_setup", { profileId: "company" });
  assert.equal(reports, 1);

  await ask("r4", "start_external_connection_setup", {
    profileId: "company",
    command: "sleep 30",
  });
  const started = sent.at(-1);
  assert.equal(started.type, "external_connection_setup_started");
  assert.equal(started.payload.run.state, "running");
  await ask("r5", "cancel_external_connection_setup", {
    profileId: "company",
    runId: started.payload.run.runId,
  });
  assert.equal(sent.at(-1).type, "external_connection_setup_cancelled");
  await ask("r6", "cancel_external_connection_setup", {
    profileId: "company",
    runId: "setup_unknown",
  });
  assert.equal(sent.at(-1).payload.errorCode, "not_found");

  resourceSettings.set({ allowRemoteCommands: false });
  await ask("r7", "start_external_connection_setup", {
    profileId: "company",
    command: "true",
  });
  assert.equal(sent.at(-1).payload.errorCode, "remote_commands_off");
});
