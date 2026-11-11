// The pure-data bytedcli extension, compared with the behavior documented in
// foundry-private-connectors/bytedcli/reference/connectors-device-held.test.mjs.
// The fake is the same state-file design, extended with Meego, lark and the
// web-session begin/poll the additional authorization uses.
import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionHost } from "../dist/connectors/extensions/host.js";
import {
  addExtension,
  removeExtension,
} from "../dist/connectors/extensions/registry.js";
import { parseExtensionManifest } from "../dist/connectors/extensions/manifest.js";
import { extensionConnectorDescriptors } from "../dist/connectors/index.js";
import { hideHostTools } from "./fixtures/host-tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
hideHostTools(["bytedcli"]);

const root = mkdtempSync(join(tmpdir(), "fdy-byted-"));
const bin = join(root, "bin");
mkdirSync(bin);
writeFileSync(
  join(bin, "bytedcli"),
  `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(here, "fixtures", "fake-bytedcli.mjs"))} "$@"\n`,
);
chmodSync(join(bin, "bytedcli"), 0o755);
const statePath = join(root, "state.json");
const callsPath = join(root, "calls.jsonl");
const scratch = join(root, "scratch");
mkdirSync(scratch);

function resetState(change = {}) {
  writeFileSync(
    statePath,
    JSON.stringify({
      version: "0.174.0",
      signedIn: false,
      challenge: "none",
      meego: "ready",
      lark: "ready",
      web: "pending",
      webFallback: "none",
      ...change,
    }),
  );
}
resetState();
writeFileSync(callsPath, "");

const extensionDir = resolve(here, "../../../extensions/bytedcli");
const fixtureExtensionDir = mkdtempSync(join(tmpdir(), "fdy-byted-ext-"));
{
  const manifest = JSON.parse(
    readFileSync(join(extensionDir, "foundry-extension.json"), "utf8"),
  );
  manifest.connectors[0].cli.env.FAKE_BYTEDCLI_DIR = root;
  writeFileSync(
    join(fixtureExtensionDir, "foundry-extension.json"),
    JSON.stringify(manifest),
  );
}

function calls() {
  return readFileSync(callsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function patch(change) {
  const current = JSON.parse(readFileSync(statePath, "utf8"));
  writeFileSync(statePath, JSON.stringify({ ...current, ...change }));
}

function setup(t) {
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_BYTEDCLI_DIR = root;
  addExtension(fixtureExtensionDir, []);
  t.after(() => removeExtension("bytedance"));
  return new ExtensionHost({ log: () => {} });
}

test("the shipped bytedcli extension is pure data with the same kind", () => {
  const manifest = JSON.parse(
    readFileSync(join(extensionDir, "foundry-extension.json"), "utf8"),
  );
  const parsed = parseExtensionManifest(manifest);
  assert.equal(parsed.entry, undefined);
  assert.equal(parsed.id, "bytedance");
  assert.equal(parsed.connectors[0].kind, "bytedcli");
  assert.equal(parsed.connectors[0].tool.source, "npm");
  assert.equal(parsed.connectors[0].tool.package, "@bytedance-dev/bytedcli");
  assert.deepEqual(parsed.connectors[0].requires, [
    {
      kind: "tcp_reachable",
      host: "cloud.bytedance.net",
      port: 443,
      label: "ByteDance network",
    },
  ]);
  assert.equal(parsed.connectors[0].cli, undefined);
  assert.equal(parsed.cli.bytedcli.envelope.okValue, "success");
  assert.equal(
    parsed.cli.bytedcli.signIn.device.begin.args.at(-1),
    "{scratch}/sign-in.png",
  );
  assert.equal(parsed.cli.bytedcli.authorizations.length, 2);
  assert.equal(
    parsed.cli.bytedcli.authorizations[0].authorize.begin.fallback.args.at(-1),
    "qr",
  );
  extensionConnectorDescriptors();
});

test("status, two-step sign-in and sign-out keep the adapter's shapes", async (t) => {
  resetState({
    signedIn: false,
    version: "0.170.0",
    meego: "ready",
    lark: "ready",
  });
  const host = setup(t);

  let status = await host.call(
    "bytedance",
    "connector.status",
    { kind: "bytedcli" },
    30000,
  );
  assert.equal(status.installed, true);
  assert.equal(status.installSource, "device");
  assert.equal(status.version, "0.170.0");
  assert.equal(status.signedIn, false);
  assert.deepEqual(status.authorizations, [
    {
      id: "feishu_web_session",
      revision: 1,
      status: "unavailable",
      reason: "cli_upgrade",
    },
    { id: "lark_cli", revision: 1, status: "ready" },
  ]);

  patch({ version: "0.174.0" });
  status = await host.call(
    "bytedance",
    "connector.status",
    { kind: "bytedcli" },
    30000,
  );
  assert.deepEqual(status.authorizations, [
    { id: "feishu_web_session", revision: 1, status: "ready" },
    { id: "lark_cli", revision: 1, status: "ready" },
  ]);

  let begin = await host.call(
    "bytedance",
    "connector.signIn.begin",
    { kind: "bytedcli", scratch, options: { method: "device" } },
    30000,
  );
  assert.equal(begin.status, "pending");
  assert.match(begin.verificationUrl, /^https:\/\/cloud\.bytedance\.net\//);
  assert.equal(JSON.stringify(begin).includes("complete_token"), false);
  assert.equal(existsSync(join(scratch, "sign-in.png")), true);

  assert.deepEqual(
    await host.call(
      "bytedance",
      "connector.signIn.poll",
      { kind: "bytedcli" },
      30000,
    ),
    { status: "pending" },
  );
  patch({ challenge: "approved" });
  assert.equal(
    (
      await host.call(
        "bytedance",
        "connector.signIn.poll",
        { kind: "bytedcli" },
        30000,
      )
    ).status,
    "complete",
  );

  status = await host.call(
    "bytedance",
    "connector.status",
    { kind: "bytedcli" },
    30000,
  );
  assert.equal(status.signedIn, true);
  assert.equal(status.identity, "someone");
  assert.deepEqual(status.sites, ["cn"]);
  assert.equal(status.expiresAt, "2026-11-13T16:39:56.146Z");
  assert.doesNotMatch(JSON.stringify(status), /example\.com|complete_token/);

  await host.call(
    "bytedance",
    "connector.signOut",
    { kind: "bytedcli" },
    30000,
  );
  assert.equal(
    (
      await host.call(
        "bytedance",
        "connector.status",
        { kind: "bytedcli" },
        30000,
      )
    ).signedIn,
    false,
  );

  const all = calls();
  assert.ok(all.every((call) => call.noAutoUpgrade === "1"));
  assert.ok(all.every((call) => call.openQrImage === "0"));
  assert.ok(all.every((call) => call.profile === null));
  const complete = all.filter((call) => call.args.includes("--complete"));
  assert.ok(
    complete
      .filter((call) => !call.args.includes("--site"))
      .every((call) => call.args.length === 4),
    "the base sign-in poll carries no token",
  );
});

test("denied and expired base sign-ins are reported", async (t) => {
  resetState({ signedIn: false });
  const host = setup(t);
  await host.call(
    "bytedance",
    "connector.signIn.begin",
    { kind: "bytedcli", scratch, options: { method: "device" } },
    30000,
  );
  patch({ challenge: "denied" });
  assert.equal(
    (
      await host.call(
        "bytedance",
        "connector.signIn.poll",
        { kind: "bytedcli" },
        30000,
      )
    ).status,
    "denied",
  );
  resetState({ signedIn: false });
  await host.call(
    "bytedance",
    "connector.signIn.begin",
    { kind: "bytedcli", scratch, options: { method: "device" } },
    30000,
  );
  patch({ challenge: "expired" });
  assert.equal(
    (
      await host.call(
        "bytedance",
        "connector.signIn.poll",
        { kind: "bytedcli" },
        30000,
      )
    ).status,
    "expired",
  );
});

test("Meego and lark status map the adapter's states", async (t) => {
  resetState({ signedIn: true, meego: "missing", lark: "needs_auth" });
  const host = setup(t);
  let status = await host.call(
    "bytedance",
    "connector.status",
    { kind: "bytedcli" },
    30000,
  );
  assert.deepEqual(status.authorizations, [
    { id: "feishu_web_session", revision: 1, status: "needs_auth" },
    { id: "lark_cli", revision: 1, status: "needs_auth" },
  ]);

  patch({ meego: "bootstrap_available", lark: "ready" });
  status = await host.call(
    "bytedance",
    "connector.status",
    { kind: "bytedcli" },
    30000,
  );
  assert.deepEqual(status.authorizations, [
    {
      id: "feishu_web_session",
      revision: 1,
      status: "unknown",
      reason: "bootstrap_available",
    },
    { id: "lark_cli", revision: 1, status: "ready" },
  ]);

  patch({ meego: "other", lark: "unknown" });
  status = await host.call(
    "bytedance",
    "connector.status",
    { kind: "bytedcli" },
    30000,
  );
  assert.deepEqual(status.authorizations, [
    {
      id: "feishu_web_session",
      revision: 1,
      status: "unknown",
      reason: "check_failed",
    },
    {
      id: "lark_cli",
      revision: 1,
      status: "unknown",
      reason: "check_failed",
    },
  ]);

  patch({ meego: "error", lark: "upgrade" });
  status = await host.call(
    "bytedance",
    "connector.status",
    { kind: "bytedcli" },
    30000,
  );
  assert.deepEqual(status.authorizations, [
    {
      id: "feishu_web_session",
      revision: 1,
      status: "unknown",
      reason: "check_failed",
    },
    {
      id: "lark_cli",
      revision: 1,
      status: "unavailable",
      reason: "cli_upgrade",
    },
  ]);
});

test("the web-session authorization keeps continuation on device and falls back once", async (t) => {
  resetState({ signedIn: true, webFallback: "once" });
  const host = setup(t);
  writeFileSync(callsPath, "");

  const started = await host.call(
    "bytedance",
    "connector.authorization.begin",
    {
      kind: "bytedcli",
      scratch,
      group: "feishu_web_session",
      revision: 1,
    },
    30000,
  );
  assert.equal(started.step.status, "pending");
  assert.deepEqual(started.step.challenge, { kind: "qr_image" });
  assert.equal(started.continuation, "fixture-web-continuation-123456");
  assert.equal(
    JSON.stringify(started.step).includes("fixture-web-continuation-123456"),
    false,
  );
  assert.equal(existsSync(join(scratch, "sign-in.png")), true);
  const begins = calls().filter((call) => call.args.includes("--begin"));
  assert.equal(begins.length, 2);
  assert.deepEqual(begins.at(-1).args.slice(-2), ["--session-method", "qr"]);

  patch({ web: "approved" });
  assert.equal(
    (
      await host.call(
        "bytedance",
        "connector.authorization.poll",
        {
          kind: "bytedcli",
          group: "feishu_web_session",
          revision: 1,
          continuation: started.continuation,
        },
        30000,
      )
    ).status,
    "complete",
  );

  const before = calls().length;
  assert.deepEqual(
    await host.call(
      "bytedance",
      "connector.authorization.poll",
      {
        kind: "bytedcli",
        group: "feishu_web_session",
        revision: 1,
        continuation: "short",
      },
      30000,
    ),
    { status: "expired" },
  );
  assert.equal(
    calls().length,
    before,
    "invalid continuation does not run the tool",
  );
});

test("web-session not-ready, denied, expired, version gate and terminal group are data", async (t) => {
  resetState({ signedIn: true, web: "not_ready" });
  const host = setup(t);
  const started = await host.call(
    "bytedance",
    "connector.authorization.begin",
    {
      kind: "bytedcli",
      scratch,
      group: "feishu_web_session",
      revision: 1,
    },
    30000,
  );
  assert.equal(started.step.status, "pending");
  patch({ web: "not_ready" });
  const notReady = await host.call(
    "bytedance",
    "connector.authorization.poll",
    {
      kind: "bytedcli",
      group: "feishu_web_session",
      revision: 1,
      continuation: started.continuation,
    },
    30000,
  );
  assert.equal(notReady.status, "failed");
  assert.match(notReady.error, /not confirmed ready/);

  resetState({ signedIn: true, web: "pending" });
  const deniedStart = await host.call(
    "bytedance",
    "connector.authorization.begin",
    {
      kind: "bytedcli",
      scratch,
      group: "feishu_web_session",
      revision: 1,
    },
    30000,
  );
  patch({ web: "denied" });
  assert.equal(
    (
      await host.call(
        "bytedance",
        "connector.authorization.poll",
        {
          kind: "bytedcli",
          group: "feishu_web_session",
          revision: 1,
          continuation: deniedStart.continuation,
        },
        30000,
      )
    ).status,
    "denied",
  );

  resetState({ signedIn: true, web: "pending" });
  const expiredStart = await host.call(
    "bytedance",
    "connector.authorization.begin",
    {
      kind: "bytedcli",
      scratch,
      group: "feishu_web_session",
      revision: 1,
    },
    30000,
  );
  patch({ web: "expired" });
  assert.equal(
    (
      await host.call(
        "bytedance",
        "connector.authorization.poll",
        {
          kind: "bytedcli",
          group: "feishu_web_session",
          revision: 1,
          continuation: expiredStart.continuation,
        },
        30000,
      )
    ).status,
    "expired",
  );

  resetState({ signedIn: true, webFallback: "always" });
  const failed = await host.call(
    "bytedance",
    "connector.authorization.begin",
    {
      kind: "bytedcli",
      scratch,
      group: "feishu_web_session",
      revision: 1,
    },
    30000,
  );
  assert.equal(failed.step.status, "failed");
  assert.match(
    failed.step.error,
    /\[FEISHU_WEB_SESSION_AUTHORIZE_PARSE_FAILED; begin; exit 1\]/,
  );
  assert.equal(failed.step.error.includes("must-not-escape"), false);

  resetState({ signedIn: true, version: "0.170.0" });
  await assert.rejects(
    host.call(
      "bytedance",
      "connector.authorization.begin",
      {
        kind: "bytedcli",
        scratch,
        group: "feishu_web_session",
        revision: 1,
      },
      30000,
    ),
    /Update bytedcli to 0\.174\.0/,
  );
  await assert.rejects(
    host.call(
      "bytedance",
      "connector.authorization.begin",
      { kind: "bytedcli", scratch, group: "lark_cli", revision: 1 },
      30000,
    ),
    /bytedcli lark auth login/,
  );
});

test("isolation variables reach the tool and managed lookup is deterministic", async (t) => {
  resetState({ signedIn: true });
  const host = setup(t);
  writeFileSync(callsPath, "");
  await host.call(
    "bytedance",
    "connector.status",
    { kind: "bytedcli" },
    30000,
    undefined,
    { BYTEDCLI_PROFILE: "foundry-no-login" },
  );
  const all = calls();
  assert.ok(all.every((call) => call.profile === "foundry-no-login"));
  assert.ok(all.every((call) => call.noAutoUpgrade === "1"));
  assert.ok(all.every((call) => call.openQrImage === "0"));

  const managed = join(root, "managed");
  mkdirSync(managed);
  writeFileSync(
    join(managed, "bytedcli"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(here, "fixtures", "fake-bytedcli.mjs"))} "$@"\n`,
  );
  chmodSync(join(managed, "bytedcli"), 0o755);
  const oldManaged = process.env.FOUNDRY_TOOLS_BIN;
  process.env.FOUNDRY_TOOLS_BIN = managed;
  try {
    const managedStatus = await host.call(
      "bytedance",
      "connector.status",
      { kind: "bytedcli" },
      30000,
    );
    assert.equal(managedStatus.installSource, "foundry");
  } finally {
    if (oldManaged === undefined) delete process.env.FOUNDRY_TOOLS_BIN;
    else process.env.FOUNDRY_TOOLS_BIN = oldManaged;
  }
});
