import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";
import {
  connectionEnvironment,
  prepareExternalConnection,
} from "../dist/external-connection.js";
import { redactTranscriptText } from "../dist/secret-redaction.js";
import { needsProviderCheck } from "../dist/provider-check-state.js";
import {
  profileRuntimeEnvironment,
  profileFingerprint,
} from "../dist/profiles.js";

const root = mkdtempSync(join(tmpdir(), "foundry-external-test-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
function helper(mode = "ready") {
  const script = join(root, `${mode}.mjs`);
  const receipt = join(root, `${mode}.released`);
  writeFileSync(
    script,
    `
    import { createInterface } from 'node:readline';
    import { writeFileSync } from 'node:fs';
    const reader = createInterface({input:process.stdin});
    reader.once('line', line => {
      const req=JSON.parse(line);
      if (${JSON.stringify(mode)} === 'wait') return;
      const identity=${JSON.stringify(mode)} === 'wrong' ? 'another-person' : req.identity;
      console.log(JSON.stringify({protocol:req.protocol, identity, environment:{
        unset:['ANTHROPIC_API_KEY'],set:{CLAUDE_CODE_OAUTH_TOKEN:'test-secret-external-connection-123456789', HTTPS_PROXY:'http://127.0.0.1:12345'}
      }}));
      if (${JSON.stringify(mode)} === 'lost') setTimeout(()=>process.exit(1), 100);
    });
    reader.on('close',()=>{writeFileSync(${JSON.stringify(receipt)},'released');process.exit(0)});
  `,
  );
  return {
    config: {
      executable: process.execPath,
      args: [script],
      identity: "person-a",
    },
    receipt,
  };
}

test("private preparation returns only connection changes and releases on EOF", async () => {
  const { config, receipt } = helper();
  const env = {
    CLAUDE_CONFIG_DIR: root,
    FOUNDRY_SESSION_TOKEN: "orchestration-secret",
    ANTHROPIC_API_KEY: "old",
  };
  const prepared = await prepareExternalConnection(config, { env, cwd: root });
  assert.equal(prepared.env.CLAUDE_CONFIG_DIR, root);
  assert.equal(prepared.env.FOUNDRY_SESSION_TOKEN, "orchestration-secret");
  assert.equal(prepared.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, "old");
  assert.equal(
    redactTranscriptText(prepared.env.CLAUDE_CODE_OAUTH_TOKEN),
    "[REDACTED]",
  );
  assert.equal(JSON.stringify(prepared).includes("test-secret"), false);
  await prepared.release();
  await prepared.release();
  assert.equal(existsSync(receipt), true);
  assert.equal(prepared.signal.aborted, false);
});

test("identity changes refuse the connection and clean up the helper", async () => {
  const { config, receipt } = helper("wrong");
  await assert.rejects(
    prepareExternalConnection(config, { env: {}, cwd: root }),
    /identity changed/,
  );
  assert.equal(existsSync(receipt), true);
});

test("lost helper invalidates the native connection", async () => {
  const { config } = helper("lost");
  const prepared = await prepareExternalConnection(config, {
    env: {},
    cwd: root,
  });
  if (!prepared.signal.aborted) await once(prepared.signal, "abort");
  assert.equal(prepared.signal.aborted, true);
  await prepared.release();
});

test("hung preparation is bounded and released", async () => {
  const { config } = helper("wait");
  await assert.rejects(
    prepareExternalConnection(config, { env: {}, cwd: root, timeoutMs: 150 }),
    /timed out/,
  );
});

test("helper cannot replace execution config, executable loader or tool credentials", () => {
  for (const name of [
    "CLAUDE_CONFIG_DIR",
    "FOUNDRY_SESSION_TOKEN",
    "PATH",
    "HOME",
    "NODE_OPTIONS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
  ])
    assert.throws(
      () =>
        connectionEnvironment({}, { set: { [name]: "override" }, unset: [] }),
      /invalid environment/,
    );
  assert.throws(
    () =>
      connectionEnvironment({}, { set: {}, unset: ["FOUNDRY_SESSION_TOKEN"] }),
    /protected/,
  );
});

test("external connections need inference checks and retain native model aliases", () => {
  const profile = {
    id: "external",
    runtime: "claude",
    connectionType: "external",
    model: "sonnet",
    externalConnection: helper().config,
  };
  assert.equal(needsProviderCheck(profile), true);
  const env = profileRuntimeEnvironment(profile);
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.notEqual(
    profileFingerprint(profile),
    profileFingerprint({
      ...profile,
      externalConnection: { ...profile.externalConnection, identity: "b" },
    }),
  );
});

test("a new daemon refuses external dispatch to an old execution host", async () => {
  const { ExecutionHostClient } =
    await import("../dist/execution-host/client.js");
  const client = new ExecutionHostClient("/unused-test-socket", "test");
  client.refresh = async () => {};
  client.supportsCapability = () => false;
  let dispatched = false;
  client.command = async () => {
    dispatched = true;
  };
  const {
    deviceAgentProfilesPath,
    readAgentProfilesFile,
    writeAgentProfilesFile,
  } = await import("../dist/profiles.js");
  const previous = readAgentProfilesFile(deviceAgentProfilesPath);
  writeAgentProfilesFile(deviceAgentProfilesPath, {
    profiles: [
      {
        id: "external_gate",
        runtime: "claude",
        connectionType: "external",
        externalConnection: helper().config,
      },
    ],
  });
  try {
    for (const fingerprint of [undefined, "claude:local_login"])
      await assert.rejects(
        client.run(root, {
          session: {
            provider: "claude",
            profileId: "external_gate",
            profileFingerprint: fingerprint,
          },
        }),
        /updated execution host/,
      );
  } finally {
    writeAgentProfilesFile(deviceAgentProfilesPath, previous);
  }
  assert.equal(dispatched, false);
  client.close();
});

test("a connection can remove inherited TLS bypass without replacing host settings", () => {
  const env = connectionEnvironment(
    {
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      NODE_OPTIONS: "--require unrelated",
      CLAUDE_CONFIG_DIR: root,
    },
    { set: {}, unset: ["NODE_TLS_REJECT_UNAUTHORIZED", "NODE_OPTIONS"] },
  );
  assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, root);
});

test("explicit check results invalidate the next device registration", async () => {
  const { deviceProfileRevision } = await import("../dist/profiles.js");
  const { providerChecksPath } =
    await import("../dist/provider-check-state.js");
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const before = deviceProfileRevision();
  mkdirSync(dirname(providerChecksPath()), { recursive: true });
  writeFileSync(
    providerChecksPath(),
    JSON.stringify({ external: { status: "passed" } }),
  );
  assert.notEqual(deviceProfileRevision(), before);
});

function scriptedHelper(name, body) {
  const script = join(root, `${name}.mjs`);
  writeFileSync(
    script,
    `import{createInterface}from'node:readline';import{writeFileSync}from'node:fs';const r=createInterface({input:process.stdin});r.once('line',line=>{const request=JSON.parse(line);${body}});r.once('close',()=>process.exit(0));`,
  );
  return { executable: process.execPath, args: [script], identity: "person-a" };
}

test("helper process and request exclude inherited provider credentials and workspace cwd", async () => {
  const receipt = join(root, "helper-input.json");
  const config = scriptedHelper(
    "capture",
    `writeFileSync(${JSON.stringify(receipt)},JSON.stringify({env:process.env,cwd:process.cwd(),request}));console.log(JSON.stringify({protocol:request.protocol,identity:request.identity,environment:{set:{},unset:[]}}));`,
  );
  const keys = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_BASE_URL",
  ];
  const old = new Map(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) process.env[k] = "HOST_SECRET_" + k;
  const input = {
    ...Object.fromEntries(keys.map((k) => [k, "INPUT_SECRET_" + k])),
    ANTHROPIC_MODEL: "sonnet",
    FOUNDRY_SERVER_URL: "https://foundry.example.invalid",
    CLAUDE_CONFIG_DIR: root,
  };
  let p;
  try {
    p = await prepareExternalConnection(config, { env: input, cwd: root });
    const { readFileSync } = await import("node:fs");
    const seen = JSON.parse(readFileSync(receipt, "utf8"));
    for (const k of keys) {
      assert.equal(seen.env[k], undefined);
      assert.equal(seen.request.environment[k], undefined);
      assert.equal(p.env[k], undefined);
    }
    assert.notEqual(seen.cwd, root);
    assert.equal(seen.request.cwd, root);
    assert.equal(seen.request.environment.ANTHROPIC_MODEL, "sonnet");
    assert.equal(p.env.NO_PROXY, "foundry.example.invalid");
    assert.equal(p.env.no_proxy, p.env.NO_PROXY);
    // Foundry hosts the session: host mode is set back after the helper.
    assert.deepEqual(Object.keys(p.set).sort(), [
      "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
      "NO_PROXY",
      "no_proxy",
    ]);
  } finally {
    await p?.release();
    for (const [k, v] of old)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});

for (const [name, body, pattern] of [
  ["invalid", 'console.log("not-json")', /invalid JSON/],
  ["null", 'console.log("null")', /invalid JSON/],
  ["array", 'console.log("[]")', /invalid JSON/],
  ["oversized", 'process.stdout.write("x".repeat(262145))', /exceeded/],
])
  test(`reject ${name} helper response`, async () => {
    await assert.rejects(
      prepareExternalConnection(scriptedHelper(name, body), {
        env: {},
        cwd: root,
      }),
      pattern,
    );
  });

test("credential-bearing headers and URLs are redacted", () => {
  const values = {
    ANTHROPIC_CUSTOM_HEADERS: "X-Key: synthetic-private-header-value",
    ANTHROPIC_BASE_URL:
      "https://private:synthetic-password@example.invalid/?key=secret",
    OTEL_EXPORTER_OTLP_HEADERS: "authorization=synthetic-private-otel-key",
  };
  connectionEnvironment({}, { set: values, unset: [] });
  for (const value of Object.values(values))
    assert.equal(redactTranscriptText(value), "[REDACTED]");
});

test("only selected external profiles enable an adapter", async () => {
  const { selectedExternalConnection } =
    await import("../dist/external-connection.js");
  const config = helper().config;
  for (const type of ["local_login", "anthropic_compatible", "env"])
    assert.equal(
      selectedExternalConnection({
        connectionType: type,
        externalConnection: config,
      }),
      undefined,
    );
  assert.equal(
    selectedExternalConnection({
      connectionType: "external",
      externalConnection: config,
    }),
    config,
  );
  assert.throws(
    () => selectedExternalConnection({ connectionType: "external" }),
    /unavailable/,
  );
});

test("external upsert refuses remote conversion and missing executables invalidate passed checks", async () => {
  const {
    deviceAgentProfilesPath,
    writeAgentProfilesFile,
    readAgentProfilesFile,
    upsertAgentProfileConfig,
    agentProfilesForWorkspace,
  } = await import("../dist/profiles.js");
  const { providerChecksPath, providerCheckFingerprint } =
    await import("../dist/provider-check-state.js");
  const executable = join(root, "checkable-helper");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const profile = {
    id: "external_review",
    runtime: "claude",
    label: "External",
    connectionType: "external",
    model: "sonnet",
    externalConnection: { executable, identity: "a" },
  };
  const previous = readAgentProfilesFile(deviceAgentProfilesPath);
  writeAgentProfilesFile(deviceAgentProfilesPath, { profiles: [profile] });
  try {
    assert.throws(
      () =>
        upsertAgentProfileConfig(
          {
            id: profile.id,
            label: "Converted",
            runtime: "claude",
            connectionType: "anthropic_compatible",
            baseUrl: "https://example.invalid",
          },
          root,
        ),
      /configured on the device/,
    );
    assert.deepEqual(readAgentProfilesFile(deviceAgentProfilesPath).profiles, [
      profile,
    ]);
    writeFileSync(
      providerChecksPath(),
      JSON.stringify({
        [profile.id]: {
          status: "passed",
          checkedAt: new Date().toISOString(),
          fingerprint: providerCheckFingerprint(profile, []),
        },
      }),
    );
    const rows = () =>
      agentProfilesForWorkspace(
        { id: "test", lastSeenLabel: "now" },
        root,
        [],
      ).find((p) => p.id === profile.id);
    assert.equal(rows().status, "healthy");
    rmSync(executable);
    assert.equal(rows().status, "unavailable");
    assert.match(rows().statusDetail, /helper is unavailable/);
  } finally {
    writeAgentProfilesFile(deviceAgentProfilesPath, previous);
  }
});

test("sandbox preparation shares the final config home and carries only explicit helper credentials", async () => {
  const { prepareSandboxConnection } =
    await import("../dist/session/workspace.js");
  const { isolatedClaudeEnvironment } =
    await import("../dist/runtime-isolation.js");
  const { foundryClaudeSettings } = await import("../dist/session-policy.js");
  const { readFileSync, mkdirSync } = await import("node:fs");
  const receipt = join(root, "sandbox-request.json");
  const config = scriptedHelper(
    "sandbox",
    `writeFileSync(${JSON.stringify(receipt)},JSON.stringify(request));console.log(JSON.stringify({protocol:request.protocol,identity:request.identity,environment:{set:{CLAUDE_CODE_OAUTH_TOKEN:'invocation-only-sandbox-token'},unset:[]}}));`,
  );
  const scratch = join(root, "sandbox");
  mkdirSync(scratch, { recursive: true });
  const run = {
    cwd: root,
    session: { id: "sess_sandbox_review", provider: "claude", model: "sonnet" },
    profile: {
      id: "external_sandbox",
      runtime: "claude",
      connectionType: "external",
      externalConnection: config,
      env: {
        ANTHROPIC_API_KEY: "profile-host-key",
        ANTHROPIC_BASE_URL: "https://wrong.invalid",
      },
    },
    emit: async () => {},
    emitSetup: async () => {},
    reportNativeSessionId: () => {},
  };
  const sandbox = {
    env: {
      HOME: scratch,
      FOUNDRY_EXECUTION_SESSION_ROOT: join(scratch, "sessions"),
      CLAUDE_CONFIG_DIR: join(scratch, "claude"),
      ANTHROPIC_API_KEY: "inherited-host-key",
      ANTHROPIC_BASE_URL: "https://wrong.invalid",
    },
    profile: {},
    stderrFile: join(scratch, "stderr"),
  };
  const p = await prepareSandboxConnection(run, sandbox);
  try {
    const request = JSON.parse(readFileSync(receipt, "utf8"));
    assert.equal(request.configHome, p.childEnv.CLAUDE_CONFIG_DIR);
    assert.match(request.configHome, /native-runtime/);
    assert.equal(request.environment.ANTHROPIC_API_KEY, undefined);
    assert.equal(p.childEnv.ANTHROPIC_API_KEY, undefined);
    assert.equal(p.childEnv.ANTHROPIC_BASE_URL, undefined);
    assert.deepEqual(p.run.profile.preparedExternalEnvironment, {
      CLAUDE_CODE_OAUTH_TOKEN: "invocation-only-sandbox-token",
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    });
    assert.equal(p.run.profile.env.ANTHROPIC_API_KEY, undefined);
    const native = isolatedClaudeEnvironment(
      p.run.profile,
      p.childEnv,
      root,
      run.session.id,
    );
    assert.equal(native.CLAUDE_CONFIG_DIR, request.configHome);
    assert.deepEqual(
      foundryClaudeSettings(p.run.profile, run.session),
      request.settings,
    );
    assert.throws(
      () =>
        isolatedClaudeEnvironment(
          p.run.profile,
          p.childEnv,
          root,
          "another-owner",
        ),
      /does not belong/,
    );
  } finally {
    await p.release();
  }
});

test(
  "release is bounded when an escaped descendant retains stdout",
  { skip: process.platform === "win32" },
  async () => {
    const script = join(root, "retained-pipes.mjs");
    writeFileSync(
      script,
      `import{createInterface}from'node:readline';import{spawn}from'node:child_process';const r=createInterface({input:process.stdin});r.once('line',line=>{const q=JSON.parse(line);console.log(JSON.stringify({protocol:q.protocol,identity:q.identity,environment:{set:{},unset:[]}}));const c=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),4000)'],{detached:true,stdio:['ignore',process.stdout,process.stderr]});c.unref();});r.once('close',()=>process.exit(0));`,
    );
    const p = await prepareExternalConnection(
      { executable: process.execPath, args: [script], identity: "pipes" },
      { env: {}, cwd: root },
    );
    const start = Date.now();
    await p.release();
    assert.ok(Date.now() - start < 3500);
  },
);

test("external runWorkspaceSession preserves its prepared config inside the real OS sandbox", async (t) => {
  const { sandboxReady } = await import("../dist/sandbox/index.js");
  if (!sandboxReady("writable_tree")) return t.skip("OS sandbox unavailable");
  const { runWorkspaceSession } = await import("../dist/session/workspace.js");
  const { activateRuntime } = await import("../dist/agent-runtime/state.js");
  const { mkdirSync, readFileSync } = await import("node:fs");
  const scratch = join(root, "execution-scratch");
  const tree = join(root, "candidate");
  mkdirSync(scratch);
  mkdirSync(tree);
  const reqFile = join(scratch, "request.json");
  const sdkFile = join(scratch, "sdk-options.json");
  const adapter = scriptedHelper(
    "full-sandbox",
    `writeFileSync(${JSON.stringify(reqFile)},JSON.stringify(request));console.log(JSON.stringify({protocol:request.protocol,identity:request.identity,environment:{set:{CLAUDE_CODE_OAUTH_TOKEN:'test-sandbox-invocation-only'},unset:[]}}));`,
  );
  const cli = join(root, "native-cli");
  writeFileSync(cli, "#!/bin/sh\necho 2.1.308\n", { mode: 0o700 });
  const sdk = join(root, "sdk.mjs");
  const source = readFileSync(
    new URL("./fixtures/fake-native-sdk.mjs", import.meta.url),
    "utf8",
  ).replace(
    "export function query({ prompt, options }) {",
    `export function query({ prompt, options }) { writeFileSync(${JSON.stringify(sdkFile)}, JSON.stringify({env:options.env,settings:JSON.parse(readFileSync(options.settings,'utf8'))}));`,
  );
  writeFileSync(
    sdk,
    "import {writeFileSync,readFileSync} from 'node:fs';\n" + source,
  );
  const keys = ["FOUNDRY_TOOLS_ROOT", "FOUNDRY_CLAUDE_BIN"];
  const old = new Map(keys.map((k) => [k, process.env[k]]));
  process.env.FOUNDRY_TOOLS_ROOT = join(root, "runtime-tools");
  process.env.FOUNDRY_CLAUDE_BIN = cli;
  activateRuntime("claude", {
    executable: cli,
    version: "2.1.308",
    sdkEntry: sdk,
    generation: "sandbox-test",
  });
  try {
    const result = await runWorkspaceSession({
      cwd: tree,
      session: {
        id: "sess_external_full",
        threadId: "sess_external_full",
        provider: "claude",
        workspaceId: "ws_test",
        agentId: "test",
        deviceId: "test",
        status: "running",
        title: "test",
        prompt: "Reply answer",
        createdLabel: "now",
        updatedLabel: "now",
      },
      profile: {
        id: "sandbox-full",
        runtime: "claude",
        connectionType: "external",
        externalConnection: adapter,
        model: "sonnet",
      },
      emit: async () => {},
      emitSetup: async () => {},
      reportNativeSessionId: () => {},
      sandbox: {
        profile: {
          kind: "writable_tree",
          policyFile: join(scratch, "sandbox.sb"),
          workdir: tree,
          readRoots: [root],
          writeRoots: [tree, scratch],
          protectedReadRoots: [],
          readOnlyDirectories: [],
          readOnlyPaths: [],
          connectSockets: [],
          executables: [],
          userFiles: "hidden",
        },
        env: {
          PATH: process.env.PATH,
          HOME: scratch,
          TMPDIR: scratch,
          CLAUDE_CONFIG_DIR: join(scratch, "claude"),
          FOUNDRY_EXECUTION_SESSION_ROOT: join(scratch, "sessions"),
          FOUNDRY_TOOLS_ROOT: process.env.FOUNDRY_TOOLS_ROOT,
          ANTHROPIC_API_KEY: "must-not-reach-child",
          ANTHROPIC_BASE_URL: "https://wrong.invalid",
        },
        stderrFile: join(scratch, "stderr"),
        timeoutMs: 20000,
      },
    });
    assert.ok(result);
    const request = JSON.parse(readFileSync(reqFile, "utf8"));
    const received = JSON.parse(readFileSync(sdkFile, "utf8"));
    assert.equal(received.env.CLAUDE_CONFIG_DIR, request.configHome);
    assert.equal(received.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(received.env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(
      received.env.CLAUDE_CODE_OAUTH_TOKEN,
      "test-sandbox-invocation-only",
    );
    assert.deepEqual(received.settings, request.settings);
  } finally {
    for (const [k, v] of old)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});

test("settings snapshots cannot expose a host credential through a separate channel", async () => {
  const file = join(root, "credential-settings.json");
  writeFileSync(
    file,
    JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: "host-secret-in-settings" },
    }),
  );
  await assert.rejects(
    prepareExternalConnection(helper().config, {
      env: {},
      cwd: root,
      settings: file,
    }),
    /another provider/,
  );
});
