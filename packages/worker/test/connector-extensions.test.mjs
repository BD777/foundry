// Connector extensions (docs/connector-extensions.md) and the device-held
// runtime they plug into: installing one, talking to its process, signing
// in through it, sessions kept from a login, and the model access it gives.
// The extension is a fixture (fixtures/fake-extension) answering from a
// state file; nothing here names a real private tool.
import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DeviceHeldConnectors } from "../dist/connectors/device-held.js";
import { extensionAdapter } from "../dist/connectors/extensions/adapter.js";
import { ExtensionHost } from "../dist/connectors/extensions/host.js";
import { refreshExtensionModelProviders } from "../dist/connectors/extensions/model-access.js";
import { connectorModelProviders as extensionModelProviders } from "../dist/harness/connector-model-providers.js";
import {
  addExtension,
  extensionDataDir,
  extensionDir,
  listExtensions,
  loadedExtensions,
  removeExtension,
} from "../dist/connectors/extensions/registry.js";
import {
  configuredAgentProfiles,
  profileFingerprint,
} from "../dist/harness/profiles.js";
import {
  extensionConnectorDescriptors,
  prepareSessionConnectors,
  sessionConnectorEnvironment,
} from "../dist/connectors/index.js";
import {
  auditSealedServerPackages,
  auditWorker,
  workerModules,
} from "../../../scripts/audit-module-boundaries.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "fake-extension");

/** A copy of the fixture extension, to change without touching the repo. */
function extensionSource(change = (manifest) => manifest) {
  const dir = mkdtempSync(join(tmpdir(), "fdy-ext-src-"));
  cpSync(fixture, dir, { recursive: true });
  const manifestPath = join(dir, "foundry-extension.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, JSON.stringify(change(manifest)));
  return dir;
}

function setState(state) {
  mkdirSync(extensionDataDir("corp"), { recursive: true });
  writeFileSync(
    join(extensionDataDir("corp"), "state.json"),
    JSON.stringify(state),
  );
}

function calls() {
  const path = join(extensionDataDir("corp"), "calls.jsonl");
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

function installFixture(state = {}) {
  try {
    removeExtension("corp");
  } catch {
    // Not installed yet.
  }
  const change = addExtension(extensionSource(), ["aws"]);
  setState(state);
  return change;
}

function runtime(host, overrides = {}) {
  const managed = mkdtempSync(join(tmpdir(), "fdy-managed-"));
  return new DeviceHeldConnectors({
    adapters: {},
    extensionAdapter: (connector) =>
      host.extension(connector.adapter.slice("extension:".length))
        ? extensionAdapter(host, connector)
        : undefined,
    managedBin: () => managed,
    toolDirs: [],
    reachable: async () => true,
    latestVersion: async () => "9.9.9",
    ...overrides,
  });
}

const corpcli = () =>
  extensionConnectorDescriptors().find((c) => c.kind === "corpcli");

test("an extension is installed as a checked copy, updated in place and removed", () => {
  assert.equal(installFixture().action, "created");
  const installed = listExtensions();
  assert.equal(installed.length, 1);
  assert.deepEqual(installed[0].connectors, ["corpcli"]);
  assert.match(installed[0].sha256, /^[0-9a-f]{64}$/);
  assert.ok(existsSync(join(extensionDir("corp"), "extension.mjs")));
  // The same folder again changes nothing; a changed one updates in place.
  const source = extensionSource();
  assert.equal(addExtension(source, ["aws"]).action, "unchanged");
  writeFileSync(join(source, "extra.txt"), "new file");
  assert.equal(addExtension(source, ["aws"]).action, "updated");

  // Its connectors are device-held, adapted by the extension, named by it.
  const descriptor = corpcli();
  assert.equal(descriptor.holding, "device_held");
  assert.equal(descriptor.adapter, "extension:corp");
  assert.deepEqual(descriptor.extension, {
    id: "corp",
    name: "Corp tools",
    version: "1.0.0",
  });
  assert.equal(descriptor.setup.command, "npx corp-foundry-extension install");

  assert.equal(removeExtension("corp").action, "removed");
  assert.deepEqual(listExtensions(), []);
  assert.equal(existsSync(join(extensionDir("corp"), "extension.mjs")), false);
  assert.throws(() => removeExtension("corp"), /no extension corp/);
});

test("an extension that is not safe or not compatible is refused", () => {
  const refuse = (change, pattern, builtin = ["aws"]) =>
    assert.throws(
      () => addExtension(extensionSource(change), builtin),
      pattern,
    );
  refuse((m) => ({ ...m, protocol: 2 }), /speaks protocol 2/);
  refuse((m) => ({ ...m, id: "Corp Tools" }), /id must be/);
  refuse((m) => ({ ...m, connectors: [] }), /provides no connectors/);
  refuse((m) => ({ ...m, entry: { command: "../escape" } }), /entry.command/);
  refuse((m) => m, /built in/, ["corpcli"]);
  const linked = extensionSource();
  symlinkSync("/etc/passwd", join(linked, "passwd"));
  assert.throws(() => addExtension(linked, []), /symbolic link/);
  // Another extension may not take a kind one already provides.
  installFixture();
  assert.throws(
    () =>
      addExtension(
        extensionSource((m) => ({ ...m, id: "other" })),
        [],
      ),
    /provided by the extension corp/,
  );
});

test("status, install and sign-in go through the extension's process", async () => {
  installFixture({ installed: false });
  const host = new ExtensionHost();
  const connectors = runtime(host);
  try {
    let reply = await connectors.handle({
      action: "status",
      connector: corpcli(),
    });
    assert.equal(reply.state.status, "not_installed");

    const progress = [];
    reply = await connectors.handle(
      { action: "install", connector: corpcli() },
      { progress: (report) => progress.push(report) },
    );
    assert.equal(reply.state.status, "signed_out");
    assert.equal(reply.state.version, "1.2.3");
    assert.deepEqual(progress, [
      {
        kind: "corpcli",
        phase: "downloading",
        receivedBytes: 10,
        totalBytes: 20,
      },
    ]);

    // A QR sign-in: the image is read from the scratch folder the
    // extension wrote it to, the page gets the link.
    const operationId = "operation-0123456789";
    reply = await connectors.handle({
      action: "sign_in_begin",
      connector: corpcli(),
      operationId,
      signInOptions: { method: "device" },
    });
    assert.equal(reply.signIn.status, "pending");
    assert.equal(reply.signIn.challenge.kind, "qr_image");
    assert.equal(
      reply.signIn.verificationUrl,
      "https://sso.corp.example/device?code=x",
    );
    assert.ok(
      Buffer.from(reply.authorizationImage, "base64")
        .subarray(1, 4)
        .equals(Buffer.from("PNG")),
    );
    reply = await connectors.handle({
      action: "sign_in_poll",
      connector: corpcli(),
      operationId,
    });
    assert.equal(reply.signIn.status, "pending");
    setState({
      ...JSON.parse(
        readFileSync(join(extensionDataDir("corp"), "state.json"), "utf8"),
      ),
      challenge: "approved",
    });
    reply = await connectors.handle({
      action: "sign_in_poll",
      connector: corpcli(),
      operationId,
    });
    assert.equal(reply.signIn.status, "complete");
    reply = await connectors.handle({
      action: "status",
      connector: corpcli(),
      fresh: true,
    });
    assert.equal(reply.state.status, "ready");
    assert.equal(
      reply.state.identity,
      "someone@example.com",
      "the server keeps the name, not the email (deviceheld.go)",
    );
    assert.deepEqual(
      reply.state.authorizations.map((a) => `${a.id}:${a.status}`),
      ["web_session:needs_auth"],
    );

    // The fields the page sent reach the extension as options.
    const begin = calls().find(
      (call) => call.method === "connector.signIn.begin",
    );
    assert.deepEqual(begin.params.options, { method: "device" });
    assert.ok(begin.env.home, "the extension gets an ordinary environment");
    assert.equal(begin.env.token, null, "and none of the worker's credentials");

    // An additional authorization keeps its continuation on the device.
    const groupOperation = "operation-group-0123456789";
    reply = await connectors.handle({
      action: "sign_in_begin",
      connector: corpcli(),
      operationId: groupOperation,
      authorizationId: "web_session",
      authorizationRevision: 1,
    });
    assert.equal(reply.signIn.status, "pending");
    assert.equal(
      JSON.stringify(reply).includes("continuation-0123456789"),
      false,
    );
    reply = await connectors.handle({
      action: "sign_in_poll",
      connector: corpcli(),
      operationId: groupOperation,
      authorizationId: "web_session",
      authorizationRevision: 1,
    });
    assert.equal(reply.signIn.status, "complete");

    reply = await connectors.handle({
      action: "sign_out",
      connector: corpcli(),
    });
    assert.equal(reply.state.status, "signed_out");

    // One process answered all of it.
    assert.equal(new Set(calls().map((call) => call.pid)).size, 1);
  } finally {
    host.stopAll();
  }
});

test("a sign-in that takes a pasted code, and one dismissed", async () => {
  installFixture({ installed: true });
  const host = new ExtensionHost();
  const connectors = runtime(host);
  try {
    const operationId = "operation-code-0123456789";
    let reply = await connectors.handle({
      action: "sign_in_begin",
      connector: corpcli(),
      operationId,
      signInOptions: { method: "code", region: "eu-west-1" },
    });
    assert.equal(reply.signIn.codeEntry, true);
    reply = await connectors.handle({
      action: "sign_in_input",
      connector: corpcli(),
      operationId,
      input: "good-code",
    });
    assert.equal(reply.signIn.status, "pending");
    reply = await connectors.handle({
      action: "sign_in_poll",
      connector: corpcli(),
      operationId,
    });
    assert.equal(reply.signIn.status, "complete");

    const dismissed = "operation-dismiss-0123456789";
    await connectors.handle({
      action: "sign_in_begin",
      connector: corpcli(),
      operationId: dismissed,
      signInOptions: { method: "device" },
    });
    await connectors.handle({
      action: "sign_in_dismiss",
      connector: corpcli(),
      operationId: dismissed,
    });
    assert.ok(
      calls().some((call) => call.method === "connector.signIn.cancel"),
    );
  } finally {
    host.stopAll();
  }
});

test("a device off the connector's network, a missing extension, a failing one", async () => {
  installFixture({ installed: true });
  const host = new ExtensionHost();
  try {
    const required = {
      ...corpcli(),
      requires: [
        {
          kind: "tcp_reachable",
          host: "intranet.example",
          port: 443,
          label: "Corp network",
        },
      ],
    };
    let reply = await runtime(host, { reachable: async () => false }).handle({
      action: "status",
      connector: required,
    });
    assert.equal(reply.state.status, "unavailable");
    assert.equal(reply.state.statusDetail, "Corp network");
    assert.equal(
      calls().length,
      0,
      "the extension is not asked where it cannot work",
    );

    setState({ statusFails: true });
    reply = await runtime(host).handle({
      action: "status",
      connector: corpcli(),
      fresh: true,
    });
    assert.equal(reply.state.status, "error");
    assert.match(reply.state.statusDetail, /status could not be read/);

    // A crash ends the request; the next one starts the extension again.
    setState({ crashOn: "connector.status" });
    reply = await runtime(host).handle({
      action: "status",
      connector: corpcli(),
      fresh: true,
    });
    assert.equal(reply.state.status, "error");
    setState({ signedIn: true });
    reply = await runtime(host).handle({
      action: "status",
      connector: corpcli(),
      fresh: true,
    });
    assert.equal(reply.state.status, "ready");

    removeExtension("corp");
    reply = await runtime(host).handle({
      action: "sign_in_begin",
      connector: corpcli() ?? { ...required, requires: [] },
      operationId: "operation-gone-0123456789",
    });
    assert.match(reply.error, /extension is not installed/);
  } finally {
    host.stopAll();
  }
});

test("an extension whose files changed after install is not started", async () => {
  installFixture({ installed: true });
  writeFileSync(
    join(extensionDir("corp"), "extension.mjs"),
    "process.exit(0)\n",
  );
  const host = new ExtensionHost();
  try {
    const reply = await runtime(host).handle({
      action: "status",
      connector: corpcli(),
      fresh: true,
    });
    assert.equal(reply.state.status, "error");
    assert.match(
      reply.state.statusDetail,
      /files changed since it was installed/,
    );
  } finally {
    host.stopAll();
  }
});

test("an extension that answers another protocol version is not used", async () => {
  installFixture({ installed: true, protocolVersion: 7 });
  const host = new ExtensionHost();
  try {
    const reply = await runtime(host).handle({
      action: "status",
      connector: corpcli(),
      fresh: true,
    });
    assert.match(reply.state.statusDetail, /answered protocol 7/);
  } finally {
    host.stopAll();
  }
});

test("model access an extension gives becomes a device profile", async () => {
  installFixture({ installed: true, signedIn: false });
  const host = new ExtensionHost();
  try {
    assert.equal(
      await refreshExtensionModelProviders(host),
      false,
      "nothing while signed out",
    );
    setState({ installed: true, signedIn: true });
    assert.equal(await refreshExtensionModelProviders(host), true);
    assert.equal(
      await refreshExtensionModelProviders(host),
      false,
      "the same list changes nothing",
    );
    const providers = extensionModelProviders();
    assert.deepEqual(
      providers.map((p) => p.id),
      ["corp_default"],
      "a malformed one is left out",
    );
    const profile = configuredAgentProfiles("", {
      device: [],
      native: [],
    }).find((p) => p.id === "corp_default");
    assert.equal(profile.connectionType, "external");
    assert.equal(profile.label, "Corp · default");
    assert.deepEqual(profile.connector, {
      kind: "corpcli",
      label: "corpcli",
      extensionId: "corp",
    });
    assert.equal(profile.externalConnection.identity, "namespace-1");
    assert.equal(profile.externalConnection.executable, process.execPath);
    assert.deepEqual(profile.externalConnection.args, [
      join(extensionDir("corp"), "session.mjs"),
      "default",
    ]);
    // Its check fingerprint is the same as a hand registration with the same helper.
    assert.equal(
      profileFingerprint(profile),
      profileFingerprint({
        runtime: "claude",
        connectionType: "external",
        externalConnection: { ...profile.externalConnection },
      }),
    );
    // A hand-registered entry of the same id gives way to the connector's.
    const both = configuredAgentProfiles("", {
      device: [
        {
          id: "corp_default",
          label: "Old",
          runtime: "claude",
          connectionType: "external",
          externalConnection: { executable: "/bin/true", identity: "old" },
        },
      ],
      native: [],
    }).filter((p) => p.id === "corp_default");
    assert.equal(both.length, 1);
    assert.equal(both[0].label, "Corp · default");

    removeExtension("corp");
    assert.deepEqual(extensionModelProviders(), [], "gone with its extension");
  } finally {
    host.stopAll();
  }
});

test("sessions get the device's login, or are kept from it", async () => {
  installFixture({ installed: true, signedIn: true });
  const host = new ExtensionHost();
  try {
    const connectors = runtime(host);
    const use = {
      kind: "corpcli",
      adapter: "extension:corp",
      label: "corpcli",
      command: "corpcli",
    };
    assert.deepEqual(
      connectors.sessionSetup([{ ...use, access: "device_login" }]),
      { environment: {} },
    );
    const kept = connectors.sessionSetup([
      {
        ...use,
        access: "none",
        isolationEnv: { CORPCLI_PROFILE: "foundry-no-login", "bad name": "x" },
      },
    ]);
    assert.deepEqual(kept.environment, { CORPCLI_PROFILE: "foundry-no-login" });

    const session = {
      id: "sess_device_held",
      workspaceId: "ws_1",
      source: "chat",
    };
    const prepared = await prepareSessionConnectors(session, {
      deviceConnectors: [
        {
          ...use,
          access: "none",
          isolationEnv: { CORPCLI_PROFILE: "foundry-no-login" },
        },
      ],
    });
    assert.equal(
      sessionConnectorEnvironment(session.id).CORPCLI_PROFILE,
      "foundry-no-login",
    );
    prepared.release();
    assert.deepEqual(sessionConnectorEnvironment(session.id), {});
  } finally {
    host.stopAll();
  }
});

test("the Connectors module is sealed: only its entry file is imported from outside", () => {
  const repoRoot = resolve(here, "../../..");
  assert.deepEqual(
    auditWorker().filter((violation) => violation.includes("connectors")),
    [],
  );
  assert.deepEqual(auditSealedServerPackages(), []);
  const sealed = mkdtempSync(join(tmpdir(), "fdy-sealed-"));
  mkdirSync(join(sealed, "connectors"));
  writeFileSync(
    join(sealed, "connectors", "index.ts"),
    'export * from "./feishu.js";\n',
  );
  writeFileSync(
    join(sealed, "connectors", "feishu.ts"),
    "export const x = 1;\n",
  );
  writeFileSync(
    join(sealed, "session.ts"),
    'import { x } from "./connectors/feishu.js";\nimport { y } from "./connectors/index.js";\n',
  );
  const modules = {
    platform: { dependsOn: [], folders: ["connectors"], entries: ["session"] },
  };
  assert.deepEqual(auditWorker(modules, sealed), [
    "worker: session imports connectors/feishu inside connectors/; use connectors/index",
  ]);
  assert.ok(workerModules.session.folders.includes("connectors"));
  assert.ok(
    existsSync(join(repoRoot, "apps/server/internal/connectors/catalog.json")),
  );
  assert.ok(loadedExtensions);
});

test("an explicit check of a connector's model provider keeps its result", async () => {
  installFixture({ installed: true, signedIn: true });
  const host = new ExtensionHost();
  try {
    await refreshExtensionModelProviders(host);
    const { withExternalCheck } =
      await import("../dist/harness/external-connection-registry.js");
    const { providerChecksPath, readProviderChecks } =
      await import("../dist/harness/provider-check-state.js");
    await withExternalCheck("corp_default", "Corp · default", async () => {
      writeFileSync(
        providerChecksPath(),
        JSON.stringify({
          corp_default: {
            status: "passed",
            checkedAt: new Date().toISOString(),
            fingerprint: "x",
          },
        }),
      );
    });
    assert.equal(readProviderChecks().corp_default?.status, "passed");
    removeExtension("corp");
    await withExternalCheck("corp_default", "Corp · default", async () => {});
    assert.equal(
      readProviderChecks().corp_default,
      undefined,
      "dropped once nothing gives it",
    );
  } finally {
    host.stopAll();
  }
});

test("an extension's id is not taken over by another source", () => {
  installFixture();
  const before = listExtensions().find((item) => item.id === "corp");
  // Different files from a repository under the same manifest id: refused;
  // the installed extension (and its private data folder) stays.
  const fork = extensionSource();
  writeFileSync(join(fork, "extra.txt"), "a fork");
  assert.throws(
    () =>
      addExtension(fork, ["aws"], {
        source: { git: "https://example.com/fork/corp.git" },
        commit: "a".repeat(40),
      }),
    (error) => error.code === "id_conflict",
  );
  assert.deepEqual(
    listExtensions().find((item) => item.id === "corp"),
    before,
  );
});
