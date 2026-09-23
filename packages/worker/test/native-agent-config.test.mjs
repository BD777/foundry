import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  claudeSettingsProfiles,
  codexConfigProfiles,
  environmentProfiles,
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
      label: profile.label,
      model: profile.model,
      runtime: profile.runtime,
    })),
    [
      {
        apiKey: "relay-secret",
        baseUrl: "https://relay.internal/v1",
        label: "Internal relay",
        model: "gpt-6-astra",
        runtime: "codex",
      },
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
