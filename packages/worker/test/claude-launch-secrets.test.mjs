import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "foundry-claude-launch-"));
process.env.FOUNDRY_STATE_ROOT = root;
test.after(() => rmSync(root, { recursive: true, force: true }));

const settingsModule =
  await import("../dist/session/session-launch-options.js");
const { claudeSettingsFile, clearClaudeSettingsFiles } = settingsModule;
const { reconnectFailedClaudeFoundryTools, startClaudeFoundryTools } =
  await import("../dist/session/runner/foundry-tools.js");
const { claudeFoundryToolsConnection, FoundryToolsSupervisor } =
  await import("../dist/session/runner/foundry-tools-supervisor.js");
const { withoutSessionToken } =
  await import("../dist/session/session-ambient.js");

test("Claude's settings go to an owner-only file without the connection's key", () => {
  const path = claudeSettingsFile("sess_1", {
    env: {
      ANTHROPIC_AUTH_TOKEN: "sk-secret-tokenhub-0001",
      ANTHROPIC_MODEL: "deepseek-v4.1-flash-1017",
    },
    autoCompactEnabled: true,
  });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const text = readFileSync(path, "utf8");
  assert.doesNotMatch(text, /sk-secret-tokenhub-0001|ANTHROPIC_AUTH_TOKEN/);
  assert.deepEqual(JSON.parse(text), {
    env: { ANTHROPIC_MODEL: "deepseek-v4.1-flash-1017" },
    autoCompactEnabled: true,
  });
  assert.doesNotMatch(path, /sess_1/);
  clearClaudeSettingsFiles();
  assert.equal(existsSync(path), false);
});

test("a settings file holds no credential, by name or inside another value; counts and models stay", () => {
  const { claudeSettingsEnvironment } = settingsModule;
  assert.deepEqual(
    claudeSettingsEnvironment({
      ANTHROPIC_AUTH_TOKEN: "tok-0123456789abcdef",
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-0123456789",
      ANTHROPIC_CUSTOM_HEADERS: "X-Route: r1",
      OPENAI_API_KEY: "sk-openai-0123456789",
      GATEWAY_PASSWORD: "hunter2hunter2",
      ANTHROPIC_BASE_URL: "https://gateway.example/tok-0123456789abcdef",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
      MAX_THINKING_TOKENS: "32000",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "800000",
      ANTHROPIC_MODEL: "claude-opus-5-5",
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      DISABLE_AUTOUPDATER: "1",
      UNSET: undefined,
    }),
    {
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
      MAX_THINKING_TOKENS: "32000",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "800000",
      ANTHROPIC_MODEL: "claude-opus-5-5",
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      DISABLE_AUTOUPDATER: "1",
    },
  );
});

test("two sessions' settings files hold neither session's key", () => {
  const { acquireClaudeSettings } = settingsModule;
  const a = acquireClaudeSettings("sess_a", {
    env: {
      ANTHROPIC_AUTH_TOKEN: "key-of-session-a-0001",
      ANTHROPIC_MODEL: "a",
    },
  });
  const b = acquireClaudeSettings("sess_b", {
    env: {
      ANTHROPIC_AUTH_TOKEN: "key-of-session-b-0002",
      ANTHROPIC_MODEL: "b",
    },
  });
  for (const lease of [a, b])
    assert.doesNotMatch(
      readFileSync(lease.path, "utf8"),
      /key-of-session-[ab]/,
    );
  a.release();
  b.release();
});

test("startup takes the key out of settings files an earlier Worker wrote, leaving the file in place", () => {
  const { removeCredentialsFromSettingsFiles } = settingsModule;
  const owner = join(root, "claude-settings", "999999-legacy");
  mkdirSync(owner, { recursive: true, mode: 0o700 });
  const legacy = join(owner, `${"a".repeat(64)}.json`);
  writeFileSync(
    legacy,
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: "legacy-key-0123456789",
        ANTHROPIC_MODEL: "m",
      },
      autoCompactEnabled: true,
    }),
    { mode: 0o600 },
  );
  const clean = join(owner, `${"b".repeat(64)}.json`);
  writeFileSync(clean, JSON.stringify({ env: { ANTHROPIC_MODEL: "m" } }), {
    mode: 0o600,
  });
  const other = join(owner, "notes.json");
  writeFileSync(
    other,
    JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "x".repeat(20) } }),
  );
  assert.equal(
    removeCredentialsFromSettingsFiles(join(root, "claude-settings")),
    1,
  );
  assert.deepEqual(JSON.parse(readFileSync(legacy, "utf8")), {
    env: { ANTHROPIC_MODEL: "m" },
    autoCompactEnabled: true,
  });
  assert.equal(statSync(legacy).mode & 0o777, 0o600);
  // Only Foundry's own settings files are touched.
  assert.match(readFileSync(other, "utf8"), /ANTHROPIC_AUTH_TOKEN/);
  rmSync(owner, { recursive: true, force: true });
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

test("a reused process reconnects Foundry tools that failed to connect", async () => {
  const reconnected = [];
  const events = [];
  const query = (statuses) => ({
    mcpServerStatus: async () => statuses,
    reconnectMcpServer: async (name) => reconnected.push(name),
  });
  const supervisor = new FoundryToolsSupervisor(
    claudeFoundryToolsConnection(
      query([
        { name: "foundry", status: "failed" },
        { name: "other", status: "failed" },
      ]),
    ),
    (...event) => events.push(event),
    () => 0.5,
    () => 60_000,
  );
  await reconnectFailedClaudeFoundryTools(supervisor);
  const connected = new FoundryToolsSupervisor(
    claudeFoundryToolsConnection(
      query([{ name: "foundry", status: "connected" }]),
    ),
    (...event) => events.push(event),
    () => 0.5,
    () => 60_000,
  );
  await reconnectFailedClaudeFoundryTools(connected);
  assert.deepEqual(reconnected, ["foundry"]);
  assert.deepEqual(events, [
    [
      "Foundry tools unavailable",
      "The Foundry MCP server reports a failed connection.",
      "warning",
    ],
    [
      "Foundry tools reconnected",
      "The Foundry MCP connection recovered.",
      undefined,
    ],
  ]);

  const failing = new FoundryToolsSupervisor(
    claudeFoundryToolsConnection({
      mcpServerStatus: async () => [{ name: "foundry", status: "failed" }],
      reconnectMcpServer: async () => {
        throw new Error("connect timed out");
      },
    }),
    (...event) => events.push(event),
    () => 0.5,
    () => 60_000,
  );
  await reconnectFailedClaudeFoundryTools(failing);
  assert.deepEqual(events.at(-1), [
    "Foundry tools unavailable",
    "The Foundry MCP server reports a failed connection.",
    "warning",
  ]);
  supervisor.close();
  connected.close();
  failing.close();
  await reconnectFailedClaudeFoundryTools(undefined);
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
  const { refreshClaudeFoundryTools } =
    await import("../dist/session/runner/foundry-tools.js");
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
  const { acquireClaudeSettings } =
    await import("../dist/session/session-launch-options.js");
  const first = acquireClaudeSettings("same-session", {
    env: { ANTHROPIC_MODEL: "first" },
  });
  const held = acquireClaudeSettings("same-session", {
    env: { ANTHROPIC_MODEL: "first" },
  });
  const changed = acquireClaudeSettings("same-session", {
    env: { ANTHROPIC_MODEL: "second" },
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
  const { activeClaudeRuntimes } =
    await import("../dist/session/session-state.js");
  const { closeOtherClaudeWriters } =
    await import("../dist/session/runner/active-runtimes.js");
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
      /still working/,
    );
    assert.equal(runtime.closed, false);
    assert.equal(activeClaudeRuntimes.get(runtime.key), runtime);
  } finally {
    activeClaudeRuntimes.delete(runtime.key);
  }
});
