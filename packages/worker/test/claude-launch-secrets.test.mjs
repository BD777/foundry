import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "foundry-claude-launch-"));
process.env.FOUNDRY_STATE_ROOT = root;
test.after(() => rmSync(root, { recursive: true, force: true }));

const { claudeSettingsFile, clearClaudeSettingsFiles } =
  await import("../dist/session-policy.js");
const { startClaudeFoundryTools } = await import("../dist/runner.js");
const { withoutSessionToken } = await import("../dist/session-ambient.js");

test("Claude's settings, key included, go to an owner-only file, not an argument", () => {
  const path = claudeSettingsFile("sess_1", {
    env: { ANTHROPIC_AUTH_TOKEN: "sk-secret" },
  });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(
    JSON.parse(readFileSync(path, "utf8")).env.ANTHROPIC_AUTH_TOKEN,
    "sk-secret",
  );
  assert.doesNotMatch(path, /sess_1/);
  clearClaudeSettingsFiles();
  assert.equal(existsSync(path), false);
});

test("a new Claude process gets its Foundry tools over its input stream before its first turn", async () => {
  const servers = {
    foundry: {
      type: "http",
      url: "https://server/api/mcp",
      headers: { Authorization: "Bearer tok-secret" },
    },
  };
  const handed = [];
  const events = [];
  await startClaudeFoundryTools(
    { setMcpServers: async (value) => handed.push(value) },
    servers,
    (...event) => events.push(event),
  );
  assert.deepEqual(handed, [servers]);
  assert.deepEqual(events, []);

  await startClaudeFoundryTools(
    {
      setMcpServers: async () => ({ errors: { foundry: "connect refused" } }),
    },
    servers,
    (...event) => events.push(event),
  );
  await startClaudeFoundryTools(
    {
      setMcpServers: async () => {
        throw new Error("process exited");
      },
    },
    servers,
    (...event) => events.push(event),
  );
  assert.deepEqual(
    events.map(([label, detail, level]) => [label, detail, level]),
    [
      ["Foundry tools unavailable", "foundry: connect refused", "warning"],
      ["Foundry tools unavailable", "process exited", "warning"],
    ],
    "a session without its tools still runs",
  );
  await startClaudeFoundryTools({}, undefined, () => assert.fail());
});

test("withoutSessionToken drops only the token", () => {
  assert.deepEqual(
    withoutSessionToken({
      FOUNDRY_SESSION_TOKEN: "tok",
      FOUNDRY_SERVER_URL: "https://server",
      PATH: "/bin",
    }),
    { FOUNDRY_SERVER_URL: "https://server", PATH: "/bin" },
  );
});

test("a timer turn Claude starts on its own gets a fresh Foundry token", async () => {
  const { refreshClaudeFoundryTools } = await import("../dist/runner.js");
  const handed = [];
  const runtime = {
    closed: false,
    foundrySessionId: "sess_timer",
    mcpServers: {
      foundry: {
        type: "http",
        url: "https://server/api/mcp",
        headers: { Authorization: "Bearer old-token-0123456789" },
        timeout: 660000,
      },
    },
    query: { setMcpServers: async (servers) => handed.push(servers) },
  };
  const minted = [];
  await refreshClaudeFoundryTools(runtime, async (id) => {
    minted.push(id);
    return "fresh-token-0123456789abcdef";
  });
  assert.deepEqual(minted, ["sess_timer"]);
  assert.equal(
    handed[0].foundry.headers.Authorization,
    "Bearer fresh-token-0123456789abcdef",
  );
  assert.equal(handed[0].foundry.url, "https://server/api/mcp");
  assert.equal(
    runtime.mcpServers,
    handed[0],
    "the next refresh starts from it",
  );

  // No token from the server: the process keeps the one it has.
  await refreshClaudeFoundryTools(runtime, async () => undefined);
  assert.equal(handed.length, 1);
  // A server that hangs delays the turn only briefly.
  const began = Date.now();
  await refreshClaudeFoundryTools(runtime, () => new Promise(() => {}), 50);
  assert.ok(Date.now() - began < 1000);
  // A process without Foundry tools asks for nothing.
  await refreshClaudeFoundryTools({ ...runtime, mcpServers: {} }, async () =>
    assert.fail("no mint"),
  );
});

test("immutable settings remain until the last owner releases them, and startup cleanup leaves leased files alone", async () => {
  const { acquireClaudeSettings } = await import("../dist/session-policy.js");
  const first = acquireClaudeSettings("same-session", {
    env: { ANTHROPIC_AUTH_TOKEN: "first" },
  });
  const held = acquireClaudeSettings("same-session", {
    env: { ANTHROPIC_AUTH_TOKEN: "first" },
  });
  const changed = acquireClaudeSettings("same-session", {
    env: { ANTHROPIC_AUTH_TOKEN: "second" },
  });
  assert.equal(first.path, held.path);
  assert.notEqual(first.path, changed.path);
  clearClaudeSettingsFiles();
  first.release();
  first.release();
  assert.equal(existsSync(held.path), true);
  assert.match(readFileSync(held.path, "utf8"), /first/);
  assert.match(readFileSync(changed.path, "utf8"), /second/);
  held.release();
  assert.equal(existsSync(held.path), false);
  changed.release();
  assert.equal(existsSync(changed.path), false);
});

test("a configuration refresh refuses to preempt a native owner with live background work", async () => {
  const { activeClaudeRuntimes } = await import("../dist/session-state.js");
  const { closeOtherClaudeWriters } =
    await import("../dist/runner/active-runtimes.js");
  const runtime = {
    key: "busy-config-owner",
    foundrySessionId: "session-busy-config",
    nativeSessionId: "native-busy-config",
    closed: false,
    background: { hasRunning: () => true },
  };
  activeClaudeRuntimes.set(runtime.key, runtime);
  try {
    assert.throws(
      () =>
        closeOtherClaudeWriters(
          runtime.foundrySessionId,
          runtime.nativeSessionId,
          undefined,
          { protectActiveWork: true },
        ),
      /active work/,
    );
    assert.equal(runtime.closed, false);
    assert.equal(activeClaudeRuntimes.get(runtime.key), runtime);
  } finally {
    activeClaudeRuntimes.delete(runtime.key);
  }
});
