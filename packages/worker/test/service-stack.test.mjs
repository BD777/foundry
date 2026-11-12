import assert from "node:assert/strict";
import test from "node:test";

// Stack selection is read when the modules load, as in a real service.
process.env.FOUNDRY_STACK = "dev";
// These tests stand for a person's shell, even when run inside a Foundry session.
const sessionId = process.env.FOUNDRY_SESSION_ID;
for (const marker of [
  "FOUNDRY_SESSION_ID",
  "FOUNDRY_SESSION_TOKEN",
  "FOUNDRY_WORKSPACE",
  "FOUNDRY_WORKSPACE_ID",
  "FOUNDRY_AGENT_PROFILE",
  "FOUNDRY_SESSION_SOURCE",
  "FOUNDRY_RUNTIME_CONFIG_ISOLATED",
  "FOUNDRY_NATIVE_CLAUDE_SOURCE_HOME",
  "FOUNDRY_NATIVE_CODEX_SOURCE_HOME",
])
  delete process.env[marker];
const { serviceEnvironment, serviceLabel, watchdogLabel } =
  await import("../dist/install/service.js");

test("a named stack's service runs as that stack and names itself after it", () => {
  assert.equal(serviceEnvironment().FOUNDRY_STACK, "dev");
  assert.equal(serviceLabel(), "dev.foundry.dev.worker");
  assert.equal(watchdogLabel(), "dev.foundry.dev.worker-watchdog");
});

const { parseSystemdEnvironment, systemdEnvironmentLines } =
  await import("../dist/install/service.js");

test("a reinstall keeps settings given to the installed service", () => {
  const saved = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  try {
    const env = serviceEnvironment({ CODEX_HOME: "/Users/me/.codex-personal" });
    assert.equal(env.CODEX_HOME, "/Users/me/.codex-personal");
    process.env.CODEX_HOME = "/elsewhere";
    assert.equal(
      serviceEnvironment({ CODEX_HOME: "/Users/me/.codex-personal" })
        .CODEX_HOME,
      "/elsewhere",
    );
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
  }
});

test("a reinstall never captures an isolated native runtime directory into the service environment", () => {
  // This case has no recorded source home. A Foundry-hosted test runner may
  // carry one for its own native login, which is a different recovery case.
  const keys = [
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    ...Object.keys(process.env).filter(
      (key) =>
        key.startsWith("FOUNDRY_NATIVE_") ||
        key === "FOUNDRY_CODEX_AUTH_SOURCE",
    ),
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    process.env.CODEX_HOME =
      "/home/me/.foundry/native-runtime/codex/abcd1234efgh";
    const env = serviceEnvironment({
      CODEX_HOME: "/home/me/.foundry/native-runtime/codex/old1234",
      CLAUDE_CONFIG_DIR: "/home/me/.foundry/native-runtime/claude/old5678",
    });
    assert.equal(env.CODEX_HOME, undefined);
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
  } finally {
    for (const [key, value] of saved)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test("an update run inside a Foundry session keeps the service's own settings", () => {
  const keys = [
    "FOUNDRY_SESSION_ID",
    "HTTPS_PROXY",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.FOUNDRY_SESSION_ID = sessionId ?? "sess_test";
    process.env.HTTPS_PROXY = "http://user:secret@127.0.0.1:45737";
    process.env.CLAUDE_CONFIG_DIR =
      "/home/me/.foundry/connection-data/" + "a".repeat(64) + "/claude";
    process.env.CODEX_HOME = "/home/me/session-codex";
    const env = serviceEnvironment({
      CODEX_HOME: "/home/me/.codex-personal",
      NO_PROXY: "localhost",
    });
    assert.equal(env.HTTPS_PROXY, undefined);
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(env.CODEX_HOME, "/home/me/.codex-personal");
    assert.equal(env.NO_PROXY, "localhost");
  } finally {
    for (const [key, value] of saved)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test("a model connection's data home is never kept as the service's Claude home", () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR =
    "/home/me/.foundry/connection-data/" + "b".repeat(64) + "/claude";
  try {
    assert.equal(serviceEnvironment({}).CLAUDE_CONFIG_DIR, undefined);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test("an installed service's Claude identity homes under connection-data are dropped on reinstall", () => {
  const keys = [
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "FOUNDRY_NATIVE_CLAUDE_GLOBAL_HOME",
    "FOUNDRY_NATIVE_CLAUDE_CREDENTIAL_NAMESPACE",
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    const home =
      "/home/me/.foundry/connection-data/" + "c".repeat(64) + "/claude";
    const env = serviceEnvironment({
      CLAUDE_SECURESTORAGE_CONFIG_DIR: home,
      FOUNDRY_NATIVE_CLAUDE_GLOBAL_HOME: home,
      FOUNDRY_NATIVE_CLAUDE_CREDENTIAL_NAMESPACE: home,
    });
    assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, "");
    assert.equal(env.FOUNDRY_NATIVE_CLAUDE_GLOBAL_HOME, undefined);
  } finally {
    for (const [key, value] of saved)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test("an update keeps the installed service's settings and reads none from the shell, even one that is not marked as a session", () => {
  const keys = [
    "FOUNDRY_SESSION_ID",
    "HTTPS_PROXY",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    delete process.env.FOUNDRY_SESSION_ID;
    process.env.HTTPS_PROXY = "http://user:secret@127.0.0.1:45737";
    process.env.CODEX_HOME = "/home/me/session-codex";
    process.env.CLAUDE_CONFIG_DIR = "/home/me/session-claude";
    const env = serviceEnvironment(
      { CODEX_HOME: "/home/me/.codex-personal", NO_PROXY: "localhost" },
      { fromShell: false },
    );
    assert.equal(env.HTTPS_PROXY, undefined);
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(env.CODEX_HOME, "/home/me/.codex-personal");
    assert.equal(env.NO_PROXY, "localhost");
    // install, from the person's own shell, still takes them.
    assert.equal(
      serviceEnvironment({}, { fromShell: true }).CODEX_HOME,
      "/home/me/session-codex",
    );
  } finally {
    for (const [key, value] of saved)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test("a session shell is known by any of its markers, and a session's credentialed loopback proxy never reaches the service", () => {
  const keys = [
    "FOUNDRY_SESSION_ID",
    "FOUNDRY_AGENT_PROFILE",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "CODEX_HOME",
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    delete process.env.FOUNDRY_SESSION_ID;
    process.env.FOUNDRY_AGENT_PROFILE = "limen_default";
    process.env.HTTPS_PROXY = "http://user:secret@127.0.0.1:45737";
    process.env.CODEX_HOME = "/home/me/session-codex";
    // install from a session's shell whose id was unset: still nothing of it.
    const env = serviceEnvironment({ CODEX_HOME: "/home/me/.codex" });
    assert.equal(env.HTTPS_PROXY, undefined);
    assert.equal(env.CODEX_HOME, "/home/me/.codex");
    // A unit polluted before: its session proxy is dropped, a real one kept.
    delete process.env.FOUNDRY_AGENT_PROFILE;
    delete process.env.HTTPS_PROXY;
    const healed = serviceEnvironment(
      {
        HTTPS_PROXY: "http://user:secret@127.0.0.1:45737",
        HTTP_PROXY: "http://proxy.corp.example:3128",
      },
      { fromShell: false },
    );
    assert.equal(healed.HTTPS_PROXY, undefined);
    assert.equal(healed.HTTP_PROXY, "http://proxy.corp.example:3128");
  } finally {
    for (const [key, value] of saved)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test("systemd environment lines round-trip values with spaces, quotes and %", () => {
  const env = {
    PATH: "/home/me/.local/bin:/usr/bin",
    CODEX_HOME: '/home/me/My "Codex" 100%',
  };
  const unit = `[Service]\n${systemdEnvironmentLines(env)}Restart=always\n`;
  assert.match(unit, /^Environment="CODEX_HOME=.*%%"$/m);
  assert.deepEqual(parseSystemdEnvironment(unit), env);
  // Units written before quoting was added.
  assert.deepEqual(parseSystemdEnvironment("Environment=FOUNDRY_STACK=dev\n"), {
    FOUNDRY_STACK: "dev",
  });
});

const { executionServiceEnvironment, executionLaunchAgent } =
  await import("../dist/execution-host/service.js");
test("execution service keeps native homes but never captures session credentials", () => {
  const env = executionServiceEnvironment({
    HOME: "/Users/me",
    CODEX_HOME: "/Users/me/personal codex",
    CLAUDE_CONFIG_DIR: "/Users/me/claude",
    FOUNDRY_STACK: "dev",
    FOUNDRY_SESSION_TOKEN: "private-session",
    FOUNDRY_SESSION_ID: "s",
    PATH: "/bin",
  });
  assert.equal(env.CODEX_HOME, "/Users/me/personal codex");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/Users/me/claude");
  assert.equal(env.FOUNDRY_SESSION_TOKEN, undefined);
  assert.equal(env.FOUNDRY_SESSION_ID, undefined);
  const plist = executionLaunchAgent({
    label: "test",
    command: ["/bin/node", "/tmp/a & b/main.js"],
    env,
    root: "/tmp/a & b",
  });
  assert.match(plist, /a &amp; b/);
  assert.ok(!plist.includes("private-session"));
  assert.match(plist, /<key>AbandonProcessGroup<\/key><false\/>/);
});

test("execution service drops isolated native runtime paths", () => {
  const env = executionServiceEnvironment({
    HOME: "/Users/me",
    CODEX_HOME: "/Users/me/.foundry/native-runtime/codex/abcd1234",
    CLAUDE_CONFIG_DIR: "/Users/me/.foundry/native-runtime/claude/efgh5678",
  });
  assert.equal(env.CODEX_HOME, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
});

test("execution services keep Claude's separate identity metadata source when recovering its execution home", () => {
  const env = executionServiceEnvironment({
    HOME: "/Users/me",
    CLAUDE_CONFIG_DIR: "/Users/me/.foundry/native-runtime/claude/run",
    FOUNDRY_NATIVE_CLAUDE_SOURCE_HOME: "/Users/me/.claude",
    FOUNDRY_NATIVE_CLAUDE_GLOBAL_HOME: "/Users/me",
  });
  assert.equal(env.CLAUDE_CONFIG_DIR, "/Users/me/.claude");
  assert.equal(env.FOUNDRY_NATIVE_CLAUDE_GLOBAL_HOME, "/Users/me");
});

test("the service PATH keeps no Foundry session folders", () => {
  const saved = process.env.PATH;
  process.env.PATH =
    "/h/.foundry/session-bin/sess_a:/usr/bin:/h/.foundry-tools/.sessions/sess_a:/usr/bin:/opt/x";
  try {
    assert.equal(serviceEnvironment().PATH, "/usr/bin:/opt/x");
  } finally {
    process.env.PATH = saved;
  }
});
