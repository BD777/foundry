import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  claudeSettingsProfiles,
  codexConfigProfiles,
  environmentProfiles,
  nativeAgentProfiles,
} from "../dist/native-agent-config.js";

const scratch = mkdtempSync(join(tmpdir(), "foundry-native-"));

test("a Claude Code relay configured through settings env is discovered", () => {
  const path = join(scratch, "settings.json");
  writeFileSync(
    path,
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: "relay-token",
        ANTHROPIC_BASE_URL: "https://team-relay.internal",
        ANTHROPIC_MODEL: "model_hub/es1",
      },
    }),
  );

  assert.deepEqual(
    claudeSettingsProfiles([path]).map((profile) => ({
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      connectionType: profile.connectionType,
      model: profile.model,
      runtime: profile.runtime,
    })),
    [
      {
        apiKey: "relay-token",
        baseUrl: "https://team-relay.internal",
        connectionType: "anthropic_compatible",
        model: "model_hub/es1",
        runtime: "claude",
      },
    ],
  );
});

test("settings without a custom endpoint contribute nothing", () => {
  const path = join(scratch, "plain.json");
  writeFileSync(path, JSON.stringify({ env: {}, permissions: {} }));

  assert.deepEqual(claudeSettingsProfiles([path]), []);
  assert.deepEqual(claudeSettingsProfiles([join(scratch, "absent.json")]), []);
});

test("Codex model providers are discovered with their env-held key", () => {
  const path = join(scratch, "config.toml");
  writeFileSync(
    path,
    [
      'model = "gpt-6-astra"',
      'model_provider = "relay"',
      "",
      "[model_providers.relay]",
      'name = "Internal relay"',
      'base_url = "https://relay.internal/v1"',
      'env_key = "RELAY_KEY"',
      "",
      "[model_providers.broken]",
      'name = "No endpoint"',
      "",
      '[projects."/tmp"]',
      'trust_level = "trusted"',
      "",
    ].join("\n"),
  );

  const discovered = codexConfigProfiles(path, { RELAY_KEY: "relay-secret" });
  assert.deepEqual(
    discovered.map((profile) => ({
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      codexModelProvider: profile.codexModelProvider,
      configSection: profile.configSection,
      keySource: profile.keySource,
      label: profile.label,
      model: profile.model,
      runtime: profile.runtime,
    })),
    [
      {
        apiKey: "relay-secret",
        baseUrl: "https://relay.internal/v1",
        codexModelProvider: "relay",
        configSection: "model_providers.relay",
        keySource: "$RELAY_KEY",
        label: "Internal relay",
        model: "gpt-6-astra",
        runtime: "codex",
      },
    ],
  );
});

test("each Codex credential option is named, and only real keys are checked", () => {
  const path = join(scratch, "credentials.toml");
  writeFileSync(
    path,
    [
      'model_provider = "token"',
      "[profiles.a]",
      'model_provider = "login"',
      "[profiles.b]",
      'model_provider = "header"',
      "[profiles.c]",
      'model_provider = "gateway"',
      "[model_providers.token]",
      'base_url = "https://a.example/v1"',
      'experimental_bearer_token = "file-token"',
      "[model_providers.login]",
      'base_url = "https://b.example/v1"',
      "requires_openai_auth = true",
      "[model_providers.header]",
      'base_url = "https://c.example/v1"',
      'env_http_headers = { Authorization = "GW_TOKEN" }',
      "[model_providers.gateway]",
      'base_url = "http://127.0.0.1:8787/v1"',
      "",
    ].join("\n"),
  );
  const discovered = codexConfigProfiles(path, { GW_TOKEN: "gw" });
  assert.deepEqual(
    discovered.map(({ apiKey, keySource, keyCheckable }) => ({
      apiKey,
      keySource,
      keyCheckable,
    })),
    [
      {
        apiKey: "file-token",
        keySource: "experimental_bearer_token",
        keyCheckable: undefined,
      },
      {
        apiKey: undefined,
        keySource: "requires_openai_auth",
        keyCheckable: false,
      },
      {
        apiKey: "gw",
        keySource: "env_http_headers.Authorization ($GW_TOKEN)",
        keyCheckable: undefined,
      },
      { apiKey: undefined, keySource: "none", keyCheckable: false },
    ],
  );
});

test("only providers Codex uses are offered, each endpoint and credential once", () => {
  const path = join(scratch, "referenced.toml");
  writeFileSync(
    path,
    [
      'model = "gpt-6"',
      'model_provider = "aiden"',
      "[profiles.fast]",
      'model_provider = "mira"',
      'model = "mira-fast"',
      "[profiles.alias]",
      'model_provider = "aiden_alias"',
      "[model_providers.aiden]",
      'base_url = "http://127.0.0.1:8787/aiden/v1"',
      "requires_openai_auth = true",
      "[model_providers.aiden_alias]",
      'base_url = "http://127.0.0.1:8787/aiden/v1/"',
      "requires_openai_auth = true",
      "[model_providers.mira]",
      'base_url = "http://127.0.0.1:8787/mira/v1"',
      "requires_openai_auth = true",
      "[model_providers.legacy]",
      'base_url = "http://127.0.0.1:8787/v1"',
      "requires_openai_auth = true",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    codexConfigProfiles(path, {}).map(({ id, model }) => ({ id, model })),
    [
      { id: "codex_provider_aiden", model: "gpt-6" },
      { id: "codex_provider_mira", model: "mira-fast" },
    ],
  );
});

test("a malformed Codex config is ignored instead of breaking discovery", () => {
  const path = join(scratch, "broken.toml");
  writeFileSync(path, "model = \nthis is not toml [[[");

  assert.deepEqual(codexConfigProfiles(path, {}), []);
});

test("endpoints inherited only through the environment are discovered", () => {
  const discovered = environmentProfiles({
    ANTHROPIC_AUTH_TOKEN: "env-token",
    ANTHROPIC_BASE_URL: "https://team-relay.example.org",
    OPENAI_API_KEY: "openai-token",
    OPENAI_BASE_URL: "https://relay.internal/v1",
  });

  assert.deepEqual(
    discovered.map((profile) => `${profile.runtime}:${profile.baseUrl}`),
    [
      "claude:https://team-relay.example.org",
      "codex:https://relay.internal/v1",
    ],
  );
  assert.equal(discovered[0].apiKey, "env-token");
});

test("an empty environment discovers nothing", () => {
  assert.deepEqual(environmentProfiles({}), []);
});

test("the configuration is read where CLAUDE_CONFIG_DIR and CODEX_HOME put it, as the CLIs do", () => {
  const home = join(scratch, "moved-home");
  const claudeDir = join(scratch, "claude-elsewhere");
  const codexDir = join(scratch, "codex-elsewhere");
  for (const dir of [
    join(home, ".claude"),
    join(home, ".codex"),
    claudeDir,
    codexDir,
  ])
    mkdirSync(dir, { recursive: true });
  const claudeRelay = (host) =>
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: `https://${host}` } });
  const codexRelay = (host) =>
    [
      'model_provider = "relay"',
      "[model_providers.relay]",
      `base_url = "https://${host}/v1"`,
      "requires_openai_auth = true",
      "",
    ].join("\n");
  writeFileSync(
    join(home, ".claude", "settings.json"),
    claudeRelay("home-claude"),
  );
  writeFileSync(join(home, ".codex", "config.toml"), codexRelay("home-codex"));
  writeFileSync(
    join(claudeDir, "settings.local.json"),
    claudeRelay("moved-claude"),
  );
  writeFileSync(join(codexDir, "config.toml"), codexRelay("moved-codex"));
  const endpoints = (env) =>
    nativeAgentProfiles(env).map((profile) => profile.baseUrl);

  assert.deepEqual(endpoints({ HOME: home }), [
    "https://home-claude",
    "https://home-codex/v1",
  ]);
  assert.deepEqual(
    endpoints({
      HOME: home,
      CLAUDE_CONFIG_DIR: claudeDir,
      CODEX_HOME: codexDir,
    }),
    ["https://moved-claude", "https://moved-codex/v1"],
  );
});
