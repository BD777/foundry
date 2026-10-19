import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  claudeRenewalPending,
  claudeStoredLogin,
  clearNativeLoginHealth,
  isNativeAccountStatus,
  nativeLoginHealth,
} from "../dist/native-login.js";
import {
  inspectNativeAccount,
  readClaudeCatalog,
} from "../dist/native-inspection.js";
import {
  configuredAgentProfiles,
  profileRuntimeEnvironment,
} from "../dist/profiles.js";

test("native status accepts official login, not a working gateway or API key", () => {
  assert.equal(
    isNativeAccountStatus("claude", {
      status: 0,
      stdout: '{"loggedIn":true,"authMethod":"oauth_token"}',
    }),
    true,
  );
  assert.equal(
    isNativeAccountStatus("claude", {
      status: 0,
      stdout:
        '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}',
    }),
    true,
  );
  assert.equal(
    isNativeAccountStatus("claude", {
      status: 0,
      stdout: '{"loggedIn":true,"authMethod":"api_key"}',
    }),
    false,
  );
  for (const authMethod of ["api_key_helper", "third_party", "none"])
    assert.equal(
      isNativeAccountStatus("claude", {
        status: 0,
        stdout: JSON.stringify({ loggedIn: true, authMethod }),
      }),
      false,
    );
  assert.equal(
    isNativeAccountStatus("claude", {
      status: 1,
      stdout: '{"loggedIn":true,"authMethod":"oauth_token"}',
    }),
    false,
  );
  assert.equal(
    isNativeAccountStatus("claude", { status: 0, stdout: "malformed" }),
    false,
  );
  assert.equal(
    isNativeAccountStatus("codex", {
      status: 0,
      stderr: "Logged in using ChatGPT",
    }),
    true,
  );
  assert.equal(
    isNativeAccountStatus("codex", {
      status: 0,
      stderr: "Logged in using an API key",
    }),
    false,
  );
  assert.equal(
    isNativeAccountStatus("codex", { status: 1, stderr: "Not logged in" }),
    false,
  );
});

test("a gateway using an old built-in ID never hides the independent device account", () => {
  const profiles = configuredAgentProfiles("/unused", {
    device: [
      {
        id: "claude_local",
        label: "Old relay",
        runtime: "claude",
        connectionType: "anthropic_compatible",
        baseUrl: "https://relay.example.test",
      },
    ],
    native: [],
  });
  assert.equal(
    profiles.find((row) => row.id === "claude_local").label,
    "Old relay",
  );
  assert.equal(
    profiles.find((row) => row.id === "foundry_official_claude").connectionType,
    "local_login",
  );
  assert.equal(
    profiles.filter(
      (row) => row.runtime === "claude" && row.connectionType === "local_login",
    ).length,
    1,
  );
});

test("official runtime ignores stale keys/endpoints while keeping unrelated project environment", () => {
  const env = profileRuntimeEnvironment({
    runtime: "claude",
    connectionType: "local_login",
    apiKey: "stale-key",
    baseUrl: "https://relay.example.test",
    env: {
      ANTHROPIC_AUTH_TOKEN: "stale",
      ANTHROPIC_MODEL: "gateway-model",
      PROJECT_SETTING: "retained",
    },
  });
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "");
  assert.equal(env.ANTHROPIC_API_KEY, "");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
  assert.equal(env.ANTHROPIC_MODEL, "");
  assert.equal(env.PROJECT_SETTING, "retained");
  assert.equal(
    profileRuntimeEnvironment({
      runtime: "claude",
      connectionType: "local_login",
      model: "explicit-model",
    }).ANTHROPIC_MODEL,
    "explicit-model",
  );
  assert.equal(
    profileRuntimeEnvironment({
      runtime: "codex",
      connectionType: "local_login",
    }).CODEX_MODEL,
    "",
  );
});

test("a native login passes an alias model without pinning the CLI defaults to it", () => {
  const env = profileRuntimeEnvironment({
    runtime: "claude",
    connectionType: "local_login",
    model: "default",
  });
  assert.equal(env.ANTHROPIC_MODEL, "default");
  for (const name of [
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
  ])
    assert.equal(env[name], "", name);
  const compatible = profileRuntimeEnvironment({
    runtime: "claude",
    connectionType: "anthropic_compatible",
    model: "relay-sonnet",
    env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: "stale" },
  });
  assert.equal(compatible.ANTHROPIC_DEFAULT_HAIKU_MODEL, "relay-sonnet");
});

test("an existing custom official-looking ID is preserved instead of overwritten", () => {
  const profiles = configuredAgentProfiles("/unused", {
    device: ["claude_local", "foundry_official_claude"].map((id) => ({
      id,
      label: id,
      runtime: "claude",
      connectionType: "anthropic_compatible",
      baseUrl: "https://relay.example.test",
    })),
    native: [],
  });
  assert.equal(
    profiles.find((row) => row.id === "foundry_official_claude").connectionType,
    "anthropic_compatible",
  );
  assert.equal(
    profiles.find((row) => row.id === "foundry_official_claude_2")
      .connectionType,
    "local_login",
  );
});

test("custom connections keep their requested endpoint and credential", () => {
  const env = profileRuntimeEnvironment({
    runtime: "codex",
    connectionType: "openai_compatible",
    apiKey: "synthetic",
    baseUrl: "https://relay.example.test/v1",
  });
  assert.equal(env.OPENAI_API_KEY, "synthetic");
  assert.equal(env.OPENAI_BASE_URL, "https://relay.example.test/v1");
});

function writeClaudeLogin(directory, oauth) {
  writeFileSync(
    join(directory, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: oauth }),
  );
}

test("a stored Claude login is due for renewal only inside the CLI's window", () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-claude-login-"));
  try {
    const now = 1_800_000_000_000;
    assert.equal(claudeStoredLogin(directory), undefined);
    writeClaudeLogin(directory, {
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      expiresAt: now + 2 * 60 * 1000,
      subscriptionType: "max",
    });
    const login = claudeStoredLogin(directory);
    assert.deepEqual(login, {
      expiresAt: now + 2 * 60 * 1000,
      renewable: true,
      subscriptionType: "max",
    });
    assert.doesNotMatch(JSON.stringify(login), /synthetic-/);
    assert.equal(claudeRenewalPending(now, login), login);
    // Already expired: the CLI renews it on start-up too.
    assert.ok(claudeRenewalPending(now, { ...login, expiresAt: now - 1 }));
    // Starting up takes a moment, so the edge of the window counts.
    assert.ok(
      claudeRenewalPending(now, { ...login, expiresAt: now + 5.5 * 60 * 1000 }),
    );
    assert.equal(
      claudeRenewalPending(now, { ...login, expiresAt: now + 60 * 60 * 1000 }),
      undefined,
    );
    // Nothing to renew with, nothing to lose.
    assert.equal(
      claudeRenewalPending(now, { ...login, renewable: false }),
      undefined,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Claude's status commands are not run while its login is due for renewal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-claude-status-"));
  const command = join(directory, "claude");
  const calls = join(directory, "calls");
  writeFileSync(
    command,
    `#!${process.execPath}
const fs=require("node:fs");
if(process.argv.includes("--version")) { console.log("2.1.0 (Claude Code)"); process.exit(0); }
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+"\\n");
console.log(JSON.stringify({loggedIn:true,authMethod:"claude.ai",email:"cli@example.test",subscriptionType:"pro"}));`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(directory, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "stored@example.test" } }),
  );
  const previous = {
    bin: process.env.FOUNDRY_CLAUDE_BIN,
    config: process.env.CLAUDE_CONFIG_DIR,
    namespace: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
  };
  process.env.FOUNDRY_CLAUDE_BIN = command;
  process.env.CLAUDE_CONFIG_DIR = directory;
  process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = directory;
  const ran = () =>
    existsSync(calls)
      ? readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse)
      : [];
  try {
    writeClaudeLogin(directory, {
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      expiresAt: Date.now() + 60 * 1000,
      subscriptionType: "max",
    });
    clearNativeLoginHealth();
    const health = nativeLoginHealth("claude");
    assert.equal(health.status, "healthy");
    assert.equal(health.authMode, "local_config");
    assert.equal(health.accountLabel, "stored@example.test");
    assert.match(health.statusDetail, /due for renewal/);
    const inspection = await inspectNativeAccount("claude");
    assert.equal(inspection.status, "local_login");
    assert.equal(inspection.accountLabel, "stored@example.test");
    assert.equal(inspection.plan, "max");
    await assert.rejects(readClaudeCatalog(), /due for renewal/);
    assert.deepEqual(ran(), [], "no CLI command may race the renewal");

    // Outside the window everything runs exactly as before.
    writeClaudeLogin(directory, {
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      expiresAt: Date.now() + 2 * 60 * 60 * 1000,
    });
    clearNativeLoginHealth();
    assert.equal(nativeLoginHealth("claude").status, "healthy");
    assert.equal(nativeLoginHealth("claude").accountLabel, "cli@example.test");
    const live = await inspectNativeAccount("claude");
    assert.equal(live.status, "local_login");
    assert.equal(live.accountLabel, "cli@example.test");
    assert.equal(live.plan, "pro");
    assert.deepEqual(ran(), [
      ["auth", "status", "--json"],
      ["auth", "status", "--json"],
    ]);
  } finally {
    clearNativeLoginHealth();
    for (const [key, value] of [
      ["FOUNDRY_CLAUDE_BIN", previous.bin],
      ["CLAUDE_CONFIG_DIR", previous.config],
      ["CLAUDE_SECURESTORAGE_CONFIG_DIR", previous.namespace],
    ])
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(directory, { recursive: true, force: true });
  }
});
