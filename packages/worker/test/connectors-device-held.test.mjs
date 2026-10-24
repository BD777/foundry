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
import {
  bytedcliAdapter,
  parseAuthStatus,
  parseLoginStep,
} from "../dist/connectors/bytedcli.js";
import { DeviceHeldConnectors } from "../dist/connectors/device-held.js";
import {
  prepareSessionConnectors,
  sessionConnectorEnvironment,
  sessionConnectorNote,
} from "../dist/connectors/index.js";
import {
  auditSealedServerPackages,
  auditWorker,
  workerModules,
} from "../../../scripts/audit-module-boundaries.mjs";
import { hideHostTools } from "./fixtures/host-tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
hideHostTools(["bytedcli"]);
const outputs = JSON.parse(
  readFileSync(join(here, "fixtures", "bytedcli-outputs.json"), "utf8"),
);

const bytedcli = {
  kind: "bytedcli",
  label: "bytedcli",
  holding: "device_held",
  adapter: "bytedcli",
  tool: {
    command: "bytedcli",
    source: "npm",
    package: "@bytedance-dev/bytedcli",
    registry: "device",
  },
  requires: [
    {
      kind: "tcp_reachable",
      host: "cloud.bytedance.net",
      port: 443,
      label: "ByteDance network",
    },
  ],
  expiryReminderDays: 3,
  isolationEnv: { BYTEDCLI_PROFILE: "foundry-no-login" },
};

/** A folder with a fake `bytedcli` on it, and the state it answers from. */
function fakeTool(state = { signedIn: false, challenge: "none" }) {
  const root = mkdtempSync(join(tmpdir(), "fdy-bytedcli-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const tool = join(bin, "bytedcli");
  writeFileSync(
    tool,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(here, "fixtures", "fake-bytedcli.mjs"))} "$@"\n`,
  );
  chmodSync(tool, 0o755);
  writeFileSync(join(root, "state.json"), JSON.stringify(state));
  writeFileSync(join(root, "calls.jsonl"), "");
  process.env.FAKE_BYTEDCLI_DIR = root;
  return {
    root,
    bin,
    tool,
    set(change) {
      const current = JSON.parse(
        readFileSync(join(root, "state.json"), "utf8"),
      );
      writeFileSync(
        join(root, "state.json"),
        JSON.stringify({ ...current, ...change }),
      );
    },
    calls() {
      return readFileSync(join(root, "calls.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}

function runtime(fake, overrides = {}) {
  const managed = mkdtempSync(join(tmpdir(), "fdy-managed-"));
  return new DeviceHeldConnectors({
    adapters: { bytedcli: bytedcliAdapter },
    managedBin: () => managed,
    toolDirs: fake ? [fake.bin] : [],
    reachable: async () => true,
    latestVersion: async () => "0.171.0",
    ...overrides,
  });
}

test("auth status is read as the CLI shows it, without the email", () => {
  const reading = parseAuthStatus(outputs.statusSignedIn);
  assert.deepEqual(reading, {
    signedIn: true,
    identity: "someone",
    sites: ["cn"],
    expiresAt: "2026-11-13T16:39:56.146Z",
  });
  assert.doesNotMatch(JSON.stringify(reading), /@|example\.com/);
  assert.deepEqual(parseAuthStatus(outputs.statusSignedOut), {
    signedIn: false,
  });
  assert.throws(
    () => parseAuthStatus(outputs.runtimeError),
    /auth status failed \(BYTECLOUD_AUTH_RUNTIME_ERROR\)/,
  );
  assert.throws(() => parseAuthStatus("not json"), /did not answer in JSON/);
  // A user name that is an email keeps only its name.
  const emailName = JSON.parse(outputs.statusSignedIn);
  emailName.data.bytecloud_auth.identity.username = "someone@example.com";
  assert.equal(parseAuthStatus(JSON.stringify(emailName)).identity, "someone");
});

test("sign-in answers map to pending, complete, expired, denied and failed", () => {
  const begun = parseLoginStep(outputs.loginBegin);
  assert.equal(begun.status, "pending");
  assert.match(begun.verificationUrl, /^https:\/\/cloud\.bytedance\.net\//);
  assert.equal(JSON.stringify(begun).includes("complete_token"), false);
  assert.deepEqual(parseLoginStep(outputs.loginPending), { status: "pending" });
  assert.deepEqual(parseLoginStep(outputs.loginSuccess), {
    status: "complete",
  });
  assert.deepEqual(parseLoginStep(outputs.loginExpired), { status: "expired" });
  assert.equal(parseLoginStep(outputs.loginDenied).status, "denied");
  const failed = parseLoginStep(outputs.runtimeError);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /login challenge not found/);
});

test("a fake bytedcli goes through status, sign-in and sign-out", async () => {
  const fake = fakeTool();
  process.env.BYTEDCLI_PROFILE = "someone-elses";
  try {
    const connectors = runtime(fake);
    let reply = await connectors.handle({
      action: "status",
      connector: bytedcli,
    });
    assert.equal(reply.state.status, "signed_out");
    assert.equal(reply.state.installed, true);
    assert.equal(reply.state.installSource, "device");
    assert.equal(reply.state.version, "0.170.0");

    reply = await connectors.handle({
      action: "sign_in_begin",
      connector: bytedcli,
    });
    assert.equal(reply.signIn.status, "pending");
    assert.match(
      reply.signIn.verificationUrl,
      /^https:\/\/cloud\.bytedance\.net\//,
    );
    const begin = fake.calls().find((call) => call.args.includes("--begin"));
    assert.ok(begin.args.includes("--no-terminal-qr"));
    const qr = begin.args[begin.args.indexOf("--qr-image") + 1];
    assert.equal(
      existsSync(dirname(qr)),
      false,
      "the QR image's folder is removed",
    );

    reply = await connectors.handle({
      action: "sign_in_poll",
      connector: bytedcli,
    });
    assert.deepEqual(reply, { signIn: { status: "pending" } });

    fake.set({ challenge: "approved" });
    reply = await connectors.handle({
      action: "sign_in_poll",
      connector: bytedcli,
    });
    assert.equal(reply.signIn.status, "complete");
    assert.equal(reply.state.status, "ready");
    assert.equal(reply.state.identity, "someone");
    assert.deepEqual(reply.state.sites, ["cn"]);
    assert.equal(reply.state.expiresAt, "2026-11-13T16:39:56.146Z");
    assert.doesNotMatch(JSON.stringify(reply), /example\.com|complete_token/);

    reply = await connectors.handle({
      action: "sign_out",
      connector: bytedcli,
    });
    assert.equal(reply.state.status, "signed_out");

    const calls = fake.calls();
    assert.ok(calls.every((call) => call.noAutoUpgrade === "1"));
    assert.ok(
      calls.every((call) => call.profile === null),
      "Foundry's runs read the default login, not an inherited profile",
    );
    const complete = calls.filter((call) => call.args.includes("--complete"));
    assert.ok(
      complete.every((call) => call.args.length === 4),
      "no token is passed",
    );
  } finally {
    delete process.env.BYTEDCLI_PROFILE;
  }
});

test("a denied or expired sign-in is reported, and the CLI is not left pending", async () => {
  const fake = fakeTool();
  const connectors = runtime(fake);
  await connectors.handle({ action: "sign_in_begin", connector: bytedcli });
  fake.set({ challenge: "denied" });
  let reply = await connectors.handle({
    action: "sign_in_poll",
    connector: bytedcli,
  });
  assert.equal(reply.signIn.status, "denied");
  await connectors.handle({ action: "sign_in_begin", connector: bytedcli });
  fake.set({ challenge: "expired" });
  reply = await connectors.handle({
    action: "sign_in_poll",
    connector: bytedcli,
  });
  assert.equal(reply.signIn.status, "expired");
});

test("a device off the required network is not offered sign-in", async () => {
  const fake = fakeTool();
  const reached = [];
  const connectors = runtime(fake, {
    reachable: async (host, port) => {
      reached.push(`${host}:${port}`);
      return false;
    },
  });
  const reply = await connectors.handle({
    action: "status",
    connector: bytedcli,
  });
  assert.equal(reply.state.status, "unavailable");
  assert.equal(reply.state.statusDetail, "ByteDance network");
  assert.deepEqual(reached, ["cloud.bytedance.net:443"]);
  const begin = await connectors.handle({
    action: "sign_in_begin",
    connector: bytedcli,
  });
  assert.match(begin.error, /needs ByteDance network/);
  assert.equal(
    fake.calls().filter((call) => call.args.includes("login")).length,
    0,
  );
});

test("install goes through the managed-tools path with the device's npm source", async () => {
  const installed = [];
  const connectors = runtime(undefined, {
    install: async (spec) => {
      installed.push(spec);
      return { name: spec.name, version: spec.version, sha256: "" };
    },
  });
  let reply = await connectors.handle({
    action: "status",
    connector: bytedcli,
  });
  assert.equal(reply.state.status, "not_installed");
  reply = await connectors.handle({ action: "install", connector: bytedcli });
  assert.deepEqual(installed, [
    {
      name: "bytedcli",
      version: "0.171.0",
      source: "npm",
      package: "@bytedance-dev/bytedcli",
      registry: "device",
    },
  ]);
  const refused = await runtime(undefined, {
    latestVersion: async () => {
      throw new Error("offline");
    },
  }).handle({ action: "install", connector: bytedcli });
  assert.match(
    refused.error,
    /could not find the newest @bytedance-dev\/bytedcli/,
  );
  const serverHeld = await connectors.handle({
    action: "status",
    connector: { ...bytedcli, holding: "server_held" },
  });
  assert.match(serverHeld.error, /not a device-held connector/);
  const unknown = await runtime(fakeTool()).handle({
    action: "status",
    connector: { ...bytedcli, adapter: "nope" },
  });
  assert.match(unknown.error, /no adapter/);
});

test("sessions get the device's login, or are kept from it", async () => {
  const fake = fakeTool({ signedIn: true, challenge: "none" });
  const connectors = runtime(fake);
  await connectors.handle({ action: "status", connector: bytedcli });
  const allowed = connectors.sessionSetup([
    {
      kind: "bytedcli",
      adapter: "bytedcli",
      label: "bytedcli",
      command: "bytedcli",
      access: "device_login",
    },
  ]);
  assert.deepEqual(allowed.environment, {});
  assert.equal(allowed.notes.length, 1);
  assert.match(
    allowed.notes[0],
    /signed in as someone, site cn, until 2026-11-13/,
  );
  assert.match(allowed.notes[0], /Do not run `bytedcli auth login`/);
  assert.ok(
    allowed.notes[0].includes(fake.tool),
    "a tool off the session PATH is named by its path",
  );
  assert.doesNotMatch(allowed.notes[0], /example\.com/);

  const kept = connectors.sessionSetup([
    {
      kind: "bytedcli",
      adapter: "bytedcli",
      label: "bytedcli",
      command: "bytedcli",
      access: "none",
      isolationEnv: { BYTEDCLI_PROFILE: "foundry-no-login", "bad name": "x" },
    },
  ]);
  assert.deepEqual(kept.environment, { BYTEDCLI_PROFILE: "foundry-no-login" });
  assert.match(kept.notes[0], /may not use/);

  const none = runtime(undefined).sessionSetup([
    {
      kind: "bytedcli",
      adapter: "bytedcli",
      label: "bytedcli",
      command: "bytedcli",
      access: "device_login",
    },
  ]);
  assert.deepEqual(
    none,
    { environment: {}, notes: [] },
    "nothing for a tool the device lacks",
  );
});

test("the connectors facade sets up and releases a session's device-held connectors", async () => {
  const fake = fakeTool({ signedIn: true, challenge: "none" });
  const previousPath = process.env.PATH;
  process.env.PATH = `${fake.bin}:${previousPath}`;
  try {
    const session = {
      id: "sess_device_held",
      workspaceId: "ws_1",
      source: "chat",
    };
    const prepared = await prepareSessionConnectors(session, {
      deviceConnectors: [
        {
          kind: "bytedcli",
          adapter: "bytedcli",
          label: "bytedcli",
          command: "bytedcli",
          access: "none",
          isolationEnv: { BYTEDCLI_PROFILE: "foundry-no-login" },
        },
      ],
    });
    assert.equal(
      sessionConnectorEnvironment(session.id).BYTEDCLI_PROFILE,
      "foundry-no-login",
    );
    assert.match(
      sessionConnectorNote(session.id),
      /bytedcli on this device holds its owner's sign-in/,
    );
    prepared.release();
    assert.deepEqual(sessionConnectorEnvironment(session.id), {});
    assert.equal(sessionConnectorNote(session.id), "");

    const issue = {
      id: "sess_issue",
      workspaceId: "ws_1",
      issueId: "iss_1",
      role: "issue_execution",
    };
    await prepareSessionConnectors(issue, {
      deviceConnectors: [
        {
          kind: "bytedcli",
          adapter: "bytedcli",
          label: "bytedcli",
          command: "bytedcli",
          access: "device_login",
        },
      ],
    });
    assert.equal(
      sessionConnectorNote(issue.id),
      "",
      "sandboxed sessions get nothing",
    );
  } finally {
    process.env.PATH = previousPath;
  }
});

test("the Connectors module is sealed: only its entry file is imported from outside", () => {
  const repoRoot = resolve(here, "../../..");
  assert.deepEqual(
    auditWorker().filter((violation) => violation.includes("connectors")),
    [],
  );
  assert.deepEqual(auditSealedServerPackages(), []);

  const fixture = mkdtempSync(join(tmpdir(), "fdy-sealed-"));
  mkdirSync(join(fixture, "connectors"));
  writeFileSync(
    join(fixture, "connectors", "index.ts"),
    'export * from "./feishu.js";\n',
  );
  writeFileSync(
    join(fixture, "connectors", "feishu.ts"),
    "export const x = 1;\n",
  );
  writeFileSync(
    join(fixture, "session.ts"),
    'import { x } from "./connectors/feishu.js";\nimport { y } from "./connectors/index.js";\n',
  );
  const modules = {
    platform: {
      dependsOn: [],
      files: ["connectors/index", "connectors/feishu", "session"],
    },
  };
  assert.deepEqual(auditWorker(modules, fixture), [
    "worker: session imports connectors/feishu inside connectors/; use connectors/index",
  ]);

  const server = mkdtempSync(join(tmpdir(), "fdy-sealed-go-"));
  mkdirSync(join(server, "httpapi"));
  const importLine = (name) =>
    `import "github.com/foundry-dev/foundry/apps/server/internal/${name}"\n`;
  writeFileSync(
    join(server, "httpapi", "sessions.go"),
    importLine("externalaccounts"),
  );
  writeFileSync(
    join(server, "httpapi", "external_accounts.go"),
    importLine("externalaccounts"),
  );
  writeFileSync(
    join(server, "httpapi", "session_dispatch.go"),
    importLine("connectors"),
  );
  assert.deepEqual(auditSealedServerPackages(undefined, server), [
    "server: httpapi/sessions.go imports externalaccounts, which only the module's own HTTP files use",
  ]);
  assert.ok(
    workerModules["session-runtime"].files.includes("connectors/index"),
  );
  assert.ok(
    existsSync(join(repoRoot, "apps/server/internal/connectors/catalog.json")),
  );
});

test("additional authorization is independent of base and official-provider login", async () => {
  const { parseMeegoAuthorization, parseSessionAuthorization } =
    await import("../dist/connectors/bytedcli.js");
  for (const [state, status] of [
    ["ready", "ready"],
    ["missing", "needs_auth"],
    ["bootstrap_available", "unknown"],
  ]) {
    const reading = parseMeegoAuthorization(
      JSON.stringify({
        status: "success",
        data: {
          authenticated: true,
          providers: {
            official: { state: "ready" },
            goapi: { state, source: "feishu_web_session" },
          },
        },
      }),
      "2026-10-21T00:00:00Z",
    );
    assert.equal(reading.status, status);
    assert.equal(reading.verification, "local_state");
  }
  const token = "fixture-private-continuation-1234";
  const parsed = parseSessionAuthorization(
    JSON.stringify({
      status: "success",
      data: {
        login_status: "pending",
        complete_token: token,
        qr_image_path: "/never/read/provider/path.png",
        qr_payload: "private-qr-payload",
        lark_applink_url: "https://applink.example/does-not-authorize",
      },
    }),
  );
  assert.equal(parsed.continuation, token);
  assert.deepEqual(parsed.step, {
    status: "pending",
    challenge: { kind: "qr_image" },
  });
  assert.equal(JSON.stringify(parsed.step).includes(token), false);
  assert.equal(
    parseSessionAuthorization(
      JSON.stringify({
        status: "success",
        data: {
          login_status: "success",
          feishu_web_session_ready: true,
          meego_goapi_session_ready: false,
        },
      }),
    ).step.status,
    "failed",
  );
});

test("group operations keep continuation on device, reuse begin, reject stale scope and expire", async () => {
  const fake = fakeTool();
  let now = Date.now();
  let begins = 0;
  let polls = 0;
  const group = {
    id: "web_session",
    revision: 1,
    label: "Web session",
    capabilities: ["one", "two"],
    credential: "native_web_session",
  };
  const connector = { ...bytedcli, authorizationGroups: [group] };
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jm1kAAAAASUVORK5CYII=",
    "base64",
  );
  const secret = "fixture-secret-kept-on-device";
  const adapter = {
    ...bytedcliAdapter,
    readVersion: async () => "0.174.0",
    readLogin: async () => ({ signedIn: true }),
    readAuthorizations: async () => [],
    beginAuthorization: async (_run, scratch) => {
      begins++;
      writeFileSync(join(scratch, "sign-in.png"), image);
      return {
        step: { status: "pending", challenge: { kind: "qr_image" } },
        continuation: secret,
      };
    },
    pollAuthorization: async (_run, _group, continuation) => {
      polls++;
      assert.equal(continuation, secret);
      return { status: "pending" };
    },
  };
  const rt = runtime(fake, { adapters: { bytedcli: adapter }, now: () => now });
  const request = {
    connector,
    authorizationId: group.id,
    authorizationRevision: 1,
    operationId: "operation_1234567890123456",
  };
  const [first, again] = await Promise.all([
    rt.handle({ ...request, action: "sign_in_begin" }),
    rt.handle({ ...request, action: "sign_in_begin" }),
  ]);
  assert.equal(begins, 1);
  assert.equal(first.authorizationImage, image.toString("base64"));
  assert.equal(JSON.stringify(first).includes(secret), false);
  assert.deepEqual(first, again);
  assert.equal(
    (
      await rt.handle({
        ...request,
        authorizationRevision: 2,
        action: "sign_in_poll",
      })
    ).error,
    "Invalid authorization operation.",
  );
  assert.equal(
    (
      await rt.handle({
        ...request,
        operationId: "wrong_operation_123456789",
        action: "sign_in_poll",
      })
    ).signIn.status,
    "expired",
  );
  const recovered = await rt.handle({ ...request, action: "sign_in_poll" });
  assert.equal(recovered.authorizationImage, image.toString("base64"));
  assert.equal(recovered.signIn.challenge.kind, "qr_image");
  assert.equal(polls, 1);
  await rt.handle({ ...request, action: "sign_in_dismiss" });
  assert.equal(
    (await rt.handle({ ...request, action: "sign_in_poll" })).signIn.status,
    "expired",
  );
  await rt.handle({ ...request, action: "sign_in_begin" });
  now += 6 * 60_000;
  assert.equal(
    (await rt.handle({ ...request, action: "sign_in_poll" })).signIn.status,
    "expired",
  );
  assert.equal(polls, 1);
  const restarted = runtime(fake, { adapters: { bytedcli: adapter } });
  assert.equal(
    (await restarted.handle({ ...request, action: "sign_in_poll" })).signIn
      .status,
    "expired",
  );
});

test("real Feishu reuse-page error falls back once to documented native QR without logout", async () => {
  const group = {
    id: "feishu_web_session",
    revision: 1,
    label: "Web",
    capabilities: ["meego_goapi.cn"],
    credential: "native_web_session",
  };
  const calls = [];
  const captured = {
    status: "error",
    data: null,
    error: {
      code: "FEISHU_WEB_SESSION_AUTHORIZE_PARSE_FAILED",
      message: "Feishu authorize page missing flow key, user id, or scope.",
      endpoint: "https://provider.invalid/?secret=must-not-escape",
      details: { flowKey: true, userId: false, scope: false },
    },
  };
  const pending = {
    status: "success",
    data: {
      login_status: "pending",
      complete_token: "fixture-private-token-123456",
      qr_image_path: "/fixture/sign-in.png",
      qr_payload: "must-not-escape",
    },
  };
  const run = async (args) => {
    calls.push(args);
    return args.includes("--version")
      ? { code: 0, stdout: "0.174.0", stderr: "" }
      : {
          code: args.includes("--session-method") ? 0 : 1,
          stdout: JSON.stringify(
            args.includes("--session-method") ? pending : captured,
          ),
          stderr: "",
        };
  };
  const result = await bytedcliAdapter.beginAuthorization(
    run,
    "/fixture",
    group,
  );
  assert.equal(result.step.status, "pending");
  assert.deepEqual(result.step.challenge, { kind: "qr_image" });
  assert.equal(calls.filter((a) => a.includes("--begin")).length, 2);
  assert.deepEqual(calls.at(-1).slice(-2), ["--session-method", "qr"]);
  assert.equal(
    calls.some(
      (a) =>
        a.includes("logout") ||
        a.includes("clear") ||
        a.includes("--auto") ||
        a.includes("browser-cookie"),
    ),
    false,
  );
  assert.equal(JSON.stringify(result.step).includes("must-not-escape"), false);
  const failures = [];
  const alwaysFail = async (args) => {
    failures.push(args);
    return args.includes("--version")
      ? { code: 0, stdout: "0.174.0", stderr: "" }
      : { code: 1, stdout: JSON.stringify(captured), stderr: "" };
  };
  const failed = await bytedcliAdapter.beginAuthorization(
    alwaysFail,
    "/fixture",
    group,
  );
  assert.equal(failures.length, 3, "version plus exactly two bounded attempts");
  assert.match(
    failed.step.error,
    /FEISHU_WEB_SESSION_AUTHORIZE_PARSE_FAILED; begin; exit 1/,
  );
  assert.equal(failed.step.error.includes("secret="), false);
  const before = failures.length;
  const polled = await bytedcliAdapter.pollAuthorization(
    alwaysFail,
    group,
    "fixture-private-token-123456",
  );
  assert.equal(
    failures.length,
    before + 1,
    "poll never silently starts another challenge",
  );
  assert.match(polled.error, /; poll; exit 1/);
});

test("bounded FIFO reports busy instead of building an unbounded authorization queue", async () => {
  const fake = fakeTool();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const rt = runtime(fake, {
    adapters: {
      bytedcli: {
        ...bytedcliAdapter,
        readVersion: async () => "0.174.0",
        readAuthorizations: async () => [],
        readLogin: async () => {
          calls++;
          entered();
          await gate;
          return { signedIn: true };
        },
      },
    },
  });
  const first = rt.handle({
    connector: bytedcli,
    action: "status",
    fresh: true,
  });
  await started;
  const second = rt.handle({
    connector: bytedcli,
    action: "status",
    fresh: true,
  });
  assert.deepEqual(
    await rt.handle({ connector: bytedcli, action: "sign_in_begin" }),
    { error: "connector_busy" },
  );
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
});

test("same-operation basic receipt survives lost begin and completion responses", async () => {
  const fake = fakeTool();
  let begins = 0,
    polls = 0;
  const rt = runtime(fake, {
    adapters: {
      bytedcli: {
        ...bytedcliAdapter,
        beginSignIn: async () => {
          begins++;
          return {
            status: "pending",
            verificationUrl: "https://login.example/approve",
          };
        },
        pollSignIn: async () => {
          polls++;
          return { status: "complete" };
        },
        readLogin: async () => {
          throw new Error("completion must be verified separately by server");
        },
      },
    },
  });
  const request = {
    connector: bytedcli,
    operationId: "base_operation_123456789",
  };
  await rt.handle({ ...request, action: "sign_in_begin" });
  assert.equal(
    (await rt.handle({ ...request, action: "sign_in_begin" })).signIn.status,
    "pending",
  );
  assert.equal(begins, 1);
  assert.equal(
    (await rt.handle({ ...request, action: "sign_in_poll" })).signIn.status,
    "complete",
  );
  assert.equal(
    (await rt.handle({ ...request, action: "sign_in_poll" })).signIn.status,
    "complete",
  );
  assert.equal(polls, 1);
});
