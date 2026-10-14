import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Config paths are resolved from HOME and the state root when the modules
// load, so the fake home has to exist before the import.
const home = mkdtempSync(join(tmpdir(), "foundry-provider-key-"));
mkdirSync(join(home, ".foundry"));
mkdirSync(join(home, ".codex"));
writeFileSync(
  join(home, ".foundry", "agent-profiles.local.json"),
  JSON.stringify({
    profiles: [
      {
        baseUrl: "https://relay.internal/v1",
        connectionType: "anthropic_compatible",
        id: "relay_none",
        label: "Relay with no key",
        runtime: "claude",
      },
      {
        apiKey: "file-key-0123456789",
        baseUrl: "https://file.internal/v1",
        connectionType: "anthropic_compatible",
        id: "relay_file",
        label: "Relay via file",
        runtime: "claude",
      },
      {
        baseUrl: "https://block.internal/v1",
        connectionType: "openai_compatible",
        env: { OPENAI_API_KEY: "block-key-0123456789" },
        id: "relay_block",
        label: "Relay via env block",
        runtime: "codex",
      },
    ],
  }),
);
writeFileSync(
  join(home, ".codex", "config.toml"),
  `model = "gpt-5"
model_provider = "gateway"

[model_providers.gateway]
name = "LLM Gateway"
base_url = "http://127.0.0.1:8787/v1"
env_key = "GATEWAY_KEY"

[profiles.chatgpt]
model_provider = "relay"

[model_providers.relay]
name = "ChatGPT relay"
base_url = "http://127.0.0.1:9999/backend-api/codex"
requires_openai_auth = true
`,
);
process.env.HOME = home;
process.env.FOUNDRY_STATE_ROOT = join(home, ".foundry");
process.env.GATEWAY_KEY = "gateway-key-0123456789";
// Keys the daemon happens to inherit must never stand in for a provider's own.
process.env.ANTHROPIC_AUTH_TOKEN = "daemon-anthropic-0123456789";
process.env.OPENAI_API_KEY = "daemon-openai-0123456789";

const { agentProfilesForWorkspace, configuredProviderKey } =
  await import("../dist/profiles.js");

test("a Codex provider yields the value of the env_key it names", () => {
  assert.deepEqual(configuredProviderKey("codex_provider_gateway"), {
    keySource: "$GATEWAY_KEY",
    credential: "gateway-key-0123456789",
  });
});

test("a provider that authenticates with a login has no key to copy", () => {
  assert.deepEqual(configuredProviderKey("codex_provider_relay"), {});
});

test("a key in Foundry's profiles file or the profile's env block is named", () => {
  assert.deepEqual(configuredProviderKey("relay_file"), {
    keySource: "apiKey",
    credential: "file-key-0123456789",
  });
  assert.deepEqual(configuredProviderKey("relay_block"), {
    keySource: "env.OPENAI_API_KEY",
    credential: "block-key-0123456789",
  });
});

test("the daemon's own environment never stands in for a missing key", () => {
  assert.deepEqual(configuredProviderKey("relay_none"), {});
});

test("an unknown provider is an error, not an empty key", () => {
  assert.throws(() => configuredProviderKey("missing"), /not configured/);
});

test("the device's provider list names key sources, never values", () => {
  const rows = agentProfilesForWorkspace(
    { id: "dev_1", label: "Studio", lastSeenLabel: "now", status: "connected" },
    "",
    [],
  );
  const byID = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(byID.codex_provider_gateway.keySource, "$GATEWAY_KEY");
  assert.equal(byID.codex_provider_relay.keySource, undefined);
  assert.equal(byID.relay_none.keySource, undefined);
  const listed = JSON.stringify(rows);
  for (const value of [
    "gateway-key-0123456789",
    "file-key-0123456789",
    "block-key-0123456789",
  ])
    assert.ok(!listed.includes(value), `the list leaked ${value}`);
});
