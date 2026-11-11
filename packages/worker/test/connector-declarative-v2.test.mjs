// Declarative extension v2: envelope, two-step guided sign-in, continuation
// authorizations, fallback, minVersion, error rules and localized copy. The
// synthetic acmecli answers from a state file; nothing here names a real tool.
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
import { dirname, join } from "node:path";
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
hideHostTools(["acmecli"]);

const root = mkdtempSync(join(tmpdir(), "fdy-acme-"));
const bin = join(root, "bin");
mkdirSync(bin);
writeFileSync(
  join(bin, "acmecli"),
  `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(here, "fixtures", "fake-acmecli.mjs"))} "$@"\n`,
);
chmodSync(join(bin, "acmecli"), 0o755);
const statePath = join(root, "state.json");
const callsPath = join(root, "calls.jsonl");
const scratch = join(root, "scratch");
mkdirSync(scratch);

function resetState(change = {}) {
  writeFileSync(
    statePath,
    JSON.stringify({
      version: "2.1.0",
      signedIn: false,
      challenge: "none",
      auth: "ready",
      terminal: "ready",
      authChallenge: "pending",
      authFallback: "none",
      ...change,
    }),
  );
}
writeFileSync(callsPath, "");

const manifest = {
  manifestVersion: 1,
  id: "acme",
  name: "Acme tools",
  version: "2.0.0",
  protocol: 1,
  connectors: [
    {
      kind: "acmecli",
      label: "acmecli",
      tool: { command: "acmecli", source: "device" },
      signIn: {
        methods: [{ id: "device", kind: "guided", label: "Scan" }],
      },
      authorizationGroups: [
        {
          id: "web",
          revision: 1,
          label: "Web session",
          capabilities: ["web"],
          credential: "native_web_session",
        },
        {
          id: "terminal",
          revision: 1,
          label: "Terminal CLI",
          capabilities: ["terminal"],
          credential: "native_login",
        },
      ],
      cli: {
        envelope: {
          ok: "/ok",
          code: "/error/code",
          error: "/error/message",
          hint: "/error/hint",
          data: "/data",
        },
        env: {
          ACME_NO_AUTO_UPGRADE: "1",
          FAKE_ACMECLI_DIR: root,
        },
        version: {
          args: ["--version"],
          pattern: "(\\d+\\.\\d+\\.\\d+)",
        },
        status: {
          args: ["status", "--json"],
          signedIn: [
            { pointer: "/authenticated", equals: true },
            {
              pointer: "/account/status",
              equals: "ready",
              allowMissing: true,
            },
          ],
          identity: {
            pointer: "/account/name",
            stripAfter: "@",
          },
          sites: { pointer: "/account/region" },
          expiresAt: {
            pointer: "/account/expires",
            asTimestamp: true,
          },
        },
        signIn: {
          device: {
            begin: {
              args: ["login", "--begin", "--qr-image", "{scratch}/sign-in.png"],
              timeoutSeconds: 30,
            },
            poll: { args: ["login", "--poll"], timeoutSeconds: 30 },
            state: {
              pointer: "/login_status",
              map: {
                pending: { status: "pending" },
                success: { status: "complete" },
                expired: { status: "expired" },
              },
              otherwise: {
                status: "failed",
                error: "Unknown login status.",
              },
              verificationUrl: "/verification_uri_complete",
              requireChallenge: true,
              missingChallenge:
                "The tool started a sign-in without a page to approve it on.",
            },
            errors: [
              {
                code: "ACME_LOGIN_DENIED",
                step: {
                  status: "denied",
                  error: "The sign-in was denied.",
                },
              },
            ],
          },
        },
        signOut: { args: ["logout", "--json"] },
        authorizations: [
          {
            group: "web",
            revision: 1,
            minVersion: "2.0.0",
            minVersionState: {
              status: "unavailable",
              reason: "cli_upgrade",
            },
            upgradeMessage: {
              en: "Update acmecli for this authorization.",
              "zh-CN": "请更新 acmecli 以获得这项授权。",
            },
            read: {
              args: ["auth", "status", "--json"],
              rules: [
                {
                  when: [
                    { pointer: "/providers/goapi/state", equals: "ready" },
                  ],
                  state: { status: "ready" },
                },
                {
                  when: [
                    { pointer: "/providers/goapi/state", equals: "missing" },
                  ],
                  state: { status: "needs_auth" },
                },
                {
                  when: [
                    {
                      pointer: "/providers/goapi/state",
                      equals: "bootstrap_available",
                    },
                  ],
                  state: {
                    status: "unknown",
                    reason: "bootstrap_available",
                  },
                },
              ],
              otherwise: {
                status: "unknown",
                verification: "not_checked",
                reason: "check_failed",
              },
              onError: {
                status: "unknown",
                verification: "not_checked",
                reason: "check_failed",
              },
            },
            authorize: {
              begin: {
                args: [
                  "auth",
                  "begin",
                  "--json",
                  "--qr-image",
                  "{scratch}/sign-in.png",
                ],
                timeoutSeconds: 30,
                fallbackWhen: ["ACME_AUTH_PARSE_FAILED"],
                fallback: {
                  args: [
                    "auth",
                    "begin",
                    "--json",
                    "--fresh",
                    "--qr-image",
                    "{scratch}/sign-in.png",
                  ],
                  timeoutSeconds: 25,
                },
              },
              poll: {
                args: ["auth", "complete", "{continuation}", "--json"],
                timeoutSeconds: 30,
              },
              state: {
                pointer: "/login_status",
                map: {
                  pending: { status: "pending" },
                  success: {
                    status: "failed",
                    error:
                      "The web session was not confirmed ready for this capability.",
                  },
                  expired: { status: "expired" },
                },
                rules: [
                  {
                    when: [
                      {
                        pointer: "/feishu_web_session_ready",
                        equals: true,
                      },
                      {
                        pointer: "/meego_goapi_session_ready",
                        equals: true,
                      },
                    ],
                    step: { status: "complete" },
                  },
                ],
                otherwise: {
                  status: "failed",
                  error: "Unknown authorization status.",
                },
                qrImage: "/qr_image_path",
                continuation: "/complete_token",
                continuationPattern: "^[a-zA-Z0-9._-]{16,128}$",
                missingContinuation:
                  "The device returned no usable authorization continuation.",
              },
              errors: [
                {
                  code: "ACME_AUTH_PARSE_FAILED",
                  step: {
                    status: "failed",
                    error: {
                      en: "Acme's authorization page is incompatible.",
                      "zh-CN": "Acme 的授权页不兼容。",
                    },
                  },
                },
                {
                  contains: "DENIED",
                  step: {
                    status: "denied",
                    error: "The provider denied it.",
                  },
                },
                {
                  contains: ["EXPIRED", "NOT_FOUND"],
                  step: {
                    status: "expired",
                    error: "The challenge expired.",
                  },
                },
              ],
              noJsonMessage: "Acme returned no JSON.",
              defaultErrorMessage: "Acme authorization failed.",
            },
          },
          {
            group: "terminal",
            revision: 1,
            read: {
              args: ["terminal", "status", "--json"],
              envelope: false,
              source: "stdoutThenStderr",
              firstObject: true,
              upgradeWhen: "CLI_PARSE_ERROR",
              rules: [
                {
                  when: [
                    { pointer: "/ok", equals: false },
                    { pointer: "/error/type", equals: "config" },
                  ],
                  state: { status: "needs_auth" },
                },
                {
                  when: [
                    {
                      pointer: "/identities",
                      anyItem: {
                        pointer: "/available",
                        equals: true,
                      },
                    },
                  ],
                  state: { status: "ready" },
                },
                {
                  when: [{ pointer: "/identities", nonEmpty: true }],
                  state: { status: "needs_auth" },
                },
              ],
              otherwise: {
                status: "unknown",
                verification: "not_checked",
                reason: "check_failed",
              },
              onError: {
                status: "unknown",
                verification: "not_checked",
                reason: "check_failed",
              },
            },
            authorize: {
              terminalMessage: {
                en: "Authorize terminal in a terminal.",
                "zh-CN": "请在终端授权。",
              },
            },
          },
        ],
      },
    },
  ],
};

function extensionFolder(value = manifest) {
  const dir = mkdtempSync(join(tmpdir(), "fdy-acme-ext-"));
  writeFileSync(join(dir, "foundry-extension.json"), JSON.stringify(value));
  return dir;
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

test("a declarative extension reads status through an envelope, two-step sign-in and sign-out", async (t) => {
  resetState();
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_ACMECLI_DIR = root;
  addExtension(extensionFolder(), []);
  t.after(() => removeExtension("acme"));
  const host = new ExtensionHost({ log: () => {} });

  const reported = extensionConnectorDescriptors().find(
    (c) => c.kind === "acmecli",
  );
  assert.equal(reported.cli, undefined);
  assert.equal(reported.adapter, "extension:acme");

  let status = await host.call(
    "acme",
    "connector.status",
    { kind: "acmecli" },
    30000,
  );
  assert.equal(status.installed, true);
  assert.equal(status.installSource, "device");
  assert.equal(status.version, "2.1.0");
  assert.equal(status.signedIn, false);
  assert.deepEqual(status.authorizations, [
    { id: "web", revision: 1, status: "ready" },
    { id: "terminal", revision: 1, status: "ready" },
  ]);

  let begin = await host.call(
    "acme",
    "connector.signIn.begin",
    { kind: "acmecli", scratch, options: { method: "device" } },
    30000,
  );
  assert.equal(begin.status, "pending");
  assert.equal(begin.verificationUrl, "https://acme.example/approve");
  assert.equal(existsSync(join(scratch, "sign-in.png")), true);

  assert.deepEqual(
    await host.call(
      "acme",
      "connector.signIn.poll",
      { kind: "acmecli" },
      30000,
    ),
    { status: "pending" },
  );
  patch({ challenge: "approved" });
  assert.equal(
    (
      await host.call(
        "acme",
        "connector.signIn.poll",
        { kind: "acmecli" },
        30000,
      )
    ).status,
    "complete",
  );

  status = await host.call(
    "acme",
    "connector.status",
    { kind: "acmecli" },
    30000,
  );
  assert.equal(status.signedIn, true);
  assert.equal(status.identity, "alice");
  assert.deepEqual(status.sites, ["eu"]);
  assert.equal(status.expiresAt, "2027-01-02T03:04:05.000Z");
  assert.doesNotMatch(JSON.stringify(status), /example\.com/);

  await host.call("acme", "connector.signOut", { kind: "acmecli" }, 30000);
  assert.equal(
    (await host.call("acme", "connector.status", { kind: "acmecli" }, 30000))
      .signedIn,
    false,
  );

  const all = calls();
  assert.ok(all.every((call) => call.noAutoUpgrade === "1"));
  assert.ok(all.every((call) => call.profile === null));
  assert.ok(
    all
      .filter((call) => call.args.includes("--poll"))
      .every((call) => !call.args.includes("fixture-continuation-123456")),
    "base sign-in polls carry no continuation",
  );
});

test("a no-challenge begin fails, denied and expired are mapped, and allowMissing works", async (t) => {
  resetState({ noChallenge: true });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_ACMECLI_DIR = root;
  addExtension(extensionFolder(), []);
  t.after(() => removeExtension("acme"));
  const host = new ExtensionHost({ log: () => {} });

  const missing = await host.call(
    "acme",
    "connector.signIn.begin",
    { kind: "acmecli", scratch, options: { method: "device" } },
    30000,
  );
  assert.equal(missing.status, "failed");
  assert.match(missing.error, /without a page to approve it on/);

  resetState({ challenge: "pending" });
  await host.call(
    "acme",
    "connector.signIn.begin",
    { kind: "acmecli", scratch, options: { method: "device" } },
    30000,
  );
  patch({ challenge: "denied" });
  assert.equal(
    (
      await host.call(
        "acme",
        "connector.signIn.poll",
        { kind: "acmecli" },
        30000,
      )
    ).status,
    "denied",
  );

  resetState({ challenge: "pending" });
  await host.call(
    "acme",
    "connector.signIn.begin",
    { kind: "acmecli", scratch, options: { method: "device" } },
    30000,
  );
  patch({ challenge: "expired" });
  assert.equal(
    (
      await host.call(
        "acme",
        "connector.signIn.poll",
        { kind: "acmecli" },
        30000,
      )
    ).status,
    "expired",
  );

  patch({ signedIn: true, noAccountStatus: true, challenge: "none" });
  const status = await host.call(
    "acme",
    "connector.status",
    { kind: "acmecli" },
    30000,
  );
  assert.equal(status.signedIn, true);
});

test("authorization status, minVersion and localized errors are data", async (t) => {
  resetState({ signedIn: true, auth: "missing", terminal: "needs_auth" });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_ACMECLI_DIR = root;
  addExtension(extensionFolder(), []);
  t.after(() => removeExtension("acme"));
  const host = new ExtensionHost({ log: () => {} });

  let status = await host.call(
    "acme",
    "connector.status",
    { kind: "acmecli" },
    30000,
  );
  assert.deepEqual(status.authorizations, [
    { id: "web", revision: 1, status: "needs_auth" },
    { id: "terminal", revision: 1, status: "needs_auth" },
  ]);

  patch({ auth: "bootstrap" });
  status = await host.call(
    "acme",
    "connector.status",
    { kind: "acmecli" },
    30000,
  );
  assert.deepEqual(status.authorizations[0], {
    id: "web",
    revision: 1,
    status: "unknown",
    reason: "bootstrap_available",
  });

  patch({ auth: "error" });
  status = await host.call(
    "acme",
    "connector.status",
    { kind: "acmecli" },
    30000,
  );
  assert.deepEqual(status.authorizations[0], {
    id: "web",
    revision: 1,
    status: "unknown",
    reason: "check_failed",
  });

  patch({ terminal: "upgrade" });
  status = await host.call(
    "acme",
    "connector.status",
    { kind: "acmecli" },
    30000,
  );
  assert.deepEqual(status.authorizations[1], {
    id: "terminal",
    revision: 1,
    status: "unavailable",
    reason: "cli_upgrade",
  });

  patch({ version: "1.9.9", auth: "ready" });
  const old = process.env.LANG;
  const oldLanguage = process.env.LANGUAGE;
  process.env.LANG = "zh_CN.UTF-8";
  process.env.LANGUAGE = "zh_CN.UTF-8";
  try {
    status = await host.call(
      "acme",
      "connector.status",
      { kind: "acmecli" },
      30000,
    );
    assert.deepEqual(status.authorizations[0], {
      id: "web",
      revision: 1,
      status: "unavailable",
      reason: "cli_upgrade",
    });
    await assert.rejects(
      host.call(
        "acme",
        "connector.authorization.begin",
        { kind: "acmecli", scratch, group: "web", revision: 1 },
        30000,
      ),
      /请更新 acmecli/,
    );
  } finally {
    if (old === undefined) delete process.env.LANG;
    else process.env.LANG = old;
    if (oldLanguage === undefined) delete process.env.LANGUAGE;
    else process.env.LANGUAGE = oldLanguage;
  }
});

test("authorization begin returns a QR challenge and a device-only continuation, with one fallback", async (t) => {
  resetState({
    signedIn: true,
    authFallback: "once",
    authChallenge: "pending",
  });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_ACMECLI_DIR = root;
  addExtension(extensionFolder(), []);
  t.after(() => removeExtension("acme"));
  const host = new ExtensionHost({ log: () => {} });
  writeFileSync(callsPath, "");

  const started = await host.call(
    "acme",
    "connector.authorization.begin",
    { kind: "acmecli", scratch, group: "web", revision: 1 },
    30000,
  );
  assert.equal(started.step.status, "pending");
  assert.deepEqual(started.step.challenge, { kind: "qr_image" });
  assert.equal(started.continuation, "fixture-continuation-123456");
  assert.equal(
    JSON.stringify(started.step).includes("fixture-continuation-123456"),
    false,
  );
  assert.equal(existsSync(join(scratch, "sign-in.png")), true);
  const begins = calls().filter((call) => call.args.includes("begin"));
  assert.equal(begins.length, 2);
  assert.equal(begins.at(-1).args.includes("--fresh"), true);

  patch({ authChallenge: "approved" });
  assert.equal(
    (
      await host.call(
        "acme",
        "connector.authorization.poll",
        {
          kind: "acmecli",
          group: "web",
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
      "acme",
      "connector.authorization.poll",
      {
        kind: "acmecli",
        group: "web",
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

test("not-ready, denied and always-failing authorizations map to the declared copy", async (t) => {
  resetState({ signedIn: true, authChallenge: "not_ready" });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_ACMECLI_DIR = root;
  addExtension(extensionFolder(), []);
  t.after(() => removeExtension("acme"));
  const host = new ExtensionHost({ log: () => {} });

  const started = await host.call(
    "acme",
    "connector.authorization.begin",
    { kind: "acmecli", scratch, group: "web", revision: 1 },
    30000,
  );
  assert.equal(started.step.status, "failed");
  assert.match(started.step.error, /not confirmed ready/);

  resetState({ signedIn: true, authChallenge: "pending" });
  const pending = await host.call(
    "acme",
    "connector.authorization.begin",
    { kind: "acmecli", scratch, group: "web", revision: 1 },
    30000,
  );
  patch({ authChallenge: "denied" });
  assert.equal(
    (
      await host.call(
        "acme",
        "connector.authorization.poll",
        {
          kind: "acmecli",
          group: "web",
          revision: 1,
          continuation: pending.continuation,
        },
        30000,
      )
    ).status,
    "denied",
  );

  resetState({
    signedIn: true,
    authFallback: "always",
    authChallenge: "pending",
  });
  const old = process.env.LANG;
  const oldLanguage = process.env.LANGUAGE;
  process.env.LANG = "zh_CN.UTF-8";
  process.env.LANGUAGE = "zh_CN.UTF-8";
  try {
    const failed = await host.call(
      "acme",
      "connector.authorization.begin",
      { kind: "acmecli", scratch, group: "web", revision: 1 },
      30000,
    );
    assert.equal(failed.step.status, "failed");
    assert.match(
      failed.step.error,
      /\[ACME_AUTH_PARSE_FAILED; begin; exit 1\]/,
    );
    assert.match(failed.step.error, /Acme 的授权页不兼容/);
    assert.doesNotMatch(failed.step.error, /secret|endpoint/i);
    await assert.rejects(
      host.call(
        "acme",
        "connector.authorization.begin",
        { kind: "acmecli", scratch, group: "terminal", revision: 1 },
        30000,
      ),
      /请在终端授权/,
    );
  } finally {
    if (old === undefined) delete process.env.LANG;
    else process.env.LANG = old;
    if (oldLanguage === undefined) delete process.env.LANGUAGE;
    else process.env.LANGUAGE = oldLanguage;
  }
});

test("isolation environment reaches the tool, and manifests are checked", async (t) => {
  resetState({ signedIn: true });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_ACMECLI_DIR = root;
  addExtension(extensionFolder(), []);
  t.after(() => removeExtension("acme"));
  const host = new ExtensionHost({ log: () => {} });
  writeFileSync(callsPath, "");
  await host.call(
    "acme",
    "connector.status",
    { kind: "acmecli" },
    30000,
    undefined,
    { ACME_PROFILE: "foundry-no-login" },
  );
  assert.ok(
    calls().every((call) => call.profile === "foundry-no-login"),
    "the isolation environment is applied to every tool run",
  );

  const variant = (change) => {
    const copy = structuredClone(manifest);
    change(copy, copy.connectors[0]);
    return copy;
  };
  assert.throws(
    () =>
      parseExtensionManifest(
        variant((_, c) => (c.cli.envelope.okValue = ["bad"])),
      ),
    /okValue/,
  );
  assert.throws(
    () =>
      parseExtensionManifest(
        variant(
          (_, c) => (c.cli.signIn.device.state.map.pending.status = "nope"),
        ),
      ),
    /status is a known step status/,
  );
  assert.throws(
    () =>
      parseExtensionManifest(
        variant((_, c) => (c.cli.authorizations[0].group = "missing")),
      ),
    /names no authorization group/,
  );
  assert.throws(
    () =>
      parseExtensionManifest(
        variant((_, c) => (c.cli.authorizations[0].minVersion = "2")),
      ),
    /version such as/,
  );
  assert.throws(
    () =>
      parseExtensionManifest(
        variant((_, c) => (c.cli.signIn.device.begin.args[1] = "{nope}")),
      ),
    /{nope} is not something it can name here/,
  );
});
