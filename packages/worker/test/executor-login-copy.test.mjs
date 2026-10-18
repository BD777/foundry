import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedAgentEnvironment } from "../dist/execution-sandbox.js";
import {
  ensureFreshClaudeLogin,
  keepSandboxCredentialsCurrent,
  sandboxClaudeCredentials,
  sandboxCodexAuth,
  sandboxCredentialCopies,
  writeSandboxCredentials,
} from "../dist/session/provider-credentials.js";

// Real-looking, never real.
const claudeLogin = (accessToken, expiresAt) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken: "sk-ant-ort01-device-refresh-token",
      expiresAt,
      refreshTokenExpiresAt: expiresAt + 86_400_000,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "max",
    },
    mcpOAuth: { server: { refreshToken: "mcp-refresh" } },
  });
const codexLogin = (access) =>
  JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "eyJ.id.token",
      access_token: access,
      refresh_token: "rt_device_refresh_token",
      account_id: "acct_1",
    },
    last_refresh: "2026-10-07T12:49:45Z",
  });

function deviceHomes(t) {
  const root = mkdtempSync(join(tmpdir(), "executor-login-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const claude = join(root, "device-claude");
  const codex = join(root, "device-codex");
  mkdirSync(claude);
  mkdirSync(codex);
  for (const [name, value] of [
    ["CLAUDE_CONFIG_DIR", claude],
    ["CODEX_HOME", codex],
  ]) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  return { root, claude, codex };
}

test("a sandbox gets the device's access tokens, never a refresh token", () => {
  const claude = JSON.parse(
    sandboxClaudeCredentials(claudeLogin("sk-ant-oat01-access", 1_000)),
  );
  assert.deepEqual(claude, {
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-access",
      expiresAt: 1_000,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "max",
    },
  });
  const codex = JSON.parse(sandboxCodexAuth(codexLogin("at-access")));
  assert.equal(codex.tokens.refresh_token, "");
  assert.equal(codex.tokens.access_token, "at-access");
  assert.equal(codex.tokens.account_id, "acct_1");
  const apiKey = JSON.stringify({ OPENAI_API_KEY: "sk-key", tokens: null });
  assert.deepEqual(JSON.parse(sandboxCodexAuth(apiKey)), JSON.parse(apiKey));
  assert.equal(sandboxClaudeCredentials("not json"), undefined);
  assert.equal(sandboxClaudeCredentials("{}"), undefined);
});

test("an executor's login copy follows the device's login, one way", (t) => {
  const device = deviceHomes(t);
  writeFileSync(
    join(device.claude, ".credentials.json"),
    claudeLogin("sk-ant-oat01-first", 1_000),
  );
  writeFileSync(join(device.codex, "auth.json"), codexLogin("at-first"));
  const scratch = join(device.root, "scratch");
  const env = isolatedAgentEnvironment(scratch);
  const claudeCopy = join(env.CLAUDE_CONFIG_DIR, ".credentials.json");
  const codexCopy = join(env.CODEX_HOME, "auth.json");
  assert.doesNotMatch(readFileSync(claudeCopy, "utf8"), /refresh/i);
  assert.doesNotMatch(readFileSync(codexCopy, "utf8"), /rt_device/);
  assert.equal(statSync(claudeCopy).mode & 0o777, 0o600);

  // The device renewed its login: the copy follows.
  writeFileSync(
    join(device.claude, ".credentials.json"),
    claudeLogin("sk-ant-oat01-renewed", 2_000),
  );
  const copies = sandboxCredentialCopies(env);
  writeSandboxCredentials(copies);
  assert.match(readFileSync(claudeCopy, "utf8"), /oat01-renewed/);

  // What the agent writes to its copy never reaches the device, and the
  // next sync puts the device's login back.
  writeFileSync(claudeCopy, '{"claudeAiOauth":{"accessToken":"attacker"}}');
  writeSandboxCredentials(copies);
  assert.match(
    readFileSync(join(device.claude, ".credentials.json"), "utf8"),
    /oat01-renewed/,
  );
  assert.match(readFileSync(claudeCopy, "utf8"), /oat01-renewed/);

  // Signed out on the device: the sandbox has no login either.
  rmSync(join(device.codex, "auth.json"));
  writeSandboxCredentials(copies);
  assert.equal(existsSync(codexCopy), false);
});

test("a running sandbox's copy follows the device while it runs", async (t) => {
  const device = deviceHomes(t);
  const source = join(device.claude, ".credentials.json");
  writeFileSync(source, claudeLogin("sk-ant-oat01-first", 1_000));
  const env = isolatedAgentEnvironment(join(device.root, "scratch"));
  let renewals = 0;
  const stop = keepSandboxCredentialsCurrent(sandboxCredentialCopies(env), {
    intervalMs: 10,
    renewClaude: async () => {
      renewals += 1;
    },
  });
  t.after(stop);
  writeFileSync(source, claudeLogin("sk-ant-oat01-renewed", 2_000));
  const copy = join(env.CLAUDE_CONFIG_DIR, ".credentials.json");
  const deadline = Date.now() + 2_000;
  while (
    !readFileSync(copy, "utf8").includes("renewed") &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(readFileSync(copy, "utf8"), /oat01-renewed/);
  assert.ok(renewals > 0, "the device's login is checked while it runs");
});

test("the device's Claude renews its own login only near expiry, where it can keep it", async () => {
  const now = () => 10_000_000;
  const runs = [];
  const run = async (args) => runs.push(args);
  let expiry = now() + 60 * 60 * 1000;
  const options = {
    now,
    run,
    writable: () => true,
    expiry: () => expiry,
  };
  assert.equal(await ensureFreshClaudeLogin(options), "fresh");
  assert.equal(runs.length, 0, "Claude Code renews nothing this early");

  expiry = now() + 60 * 1000;
  const renewing = {
    ...options,
    run: async (args) => {
      runs.push(args);
      expiry = now() + 8 * 60 * 60 * 1000;
    },
  };
  assert.equal(await ensureFreshClaudeLogin(renewing), "renewed");
  assert.equal(runs.length, 1);
  const args = runs[0];
  assert.ok(
    args.includes("native-account-metadata") && !args.includes("--print"),
  );
  assert.deepEqual(
    args,
    ["native-account-metadata"],
    "credential maintenance never submits a prompt",
  );

  // A renewal that changed nothing is not repeated at every check.
  expiry = now() + 30 * 1000;
  assert.equal(await ensureFreshClaudeLogin(options), "not_renewed");
  assert.equal(await ensureFreshClaudeLogin(options), "not_renewed");
  assert.equal(runs.length, 2);

  // A login file this worker cannot write is never renewed: the device
  // could not keep the rotated refresh token.
  expiry = now() + 20 * 1000;
  assert.equal(
    await ensureFreshClaudeLogin({ ...options, writable: () => false }),
    "not_renewed",
  );
  assert.equal(runs.length, 2);
  assert.equal(
    await ensureFreshClaudeLogin({ ...options, expiry: () => undefined }),
    "no_login",
  );
});
