import assert from "node:assert/strict";
import test from "node:test";

// Stack selection is read when the modules load, as in a real service.
process.env.FOUNDRY_STACK = "dev";
const { serviceEnvironment, serviceLabel, watchdogLabel } =
  await import("../dist/service.js");

test("a named stack's service runs as that stack and names itself after it", () => {
  assert.equal(serviceEnvironment().FOUNDRY_STACK, "dev");
  assert.equal(serviceLabel(), "dev.foundry.dev.worker");
  assert.equal(watchdogLabel(), "dev.foundry.dev.worker-watchdog");
});

const { parseSystemdEnvironment, systemdEnvironmentLines } =
  await import("../dist/service.js");

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
  const saved = process.env.CODEX_HOME;
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
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
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
