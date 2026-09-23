import assert from "node:assert/strict";
import test from "node:test";
import { isNativeAccountStatus } from "../dist/native-login.js";
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
