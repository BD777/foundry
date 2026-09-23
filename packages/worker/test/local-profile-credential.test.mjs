import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The profiles file location is resolved from the home directory when the
// module loads, so the fake home has to exist before the import.
const home = mkdtempSync(join(tmpdir(), "foundry-credential-"));
mkdirSync(join(home, ".foundry"));
writeFileSync(
  join(home, ".foundry", "agent-profiles.local.json"),
  JSON.stringify({
    profiles: [
      {
        apiKey: "",
        baseUrl: "https://relay.internal/v1",
        connectionType: "anthropic_compatible",
        id: "relay_env",
        label: "Relay via env",
        runtime: "claude",
      },
      {
        apiKey: "file-key-0123456789",
        baseUrl: "https://relay.internal/v1",
        connectionType: "anthropic_compatible",
        id: "relay_file",
        label: "Relay via file",
        runtime: "claude",
      },
    ],
  }),
);
process.env.HOME = home;

const { localProfileCredential } = await import("../dist/profiles.js");

test("a profile that relies on the daemon environment still yields its key", () => {
  process.env.ANTHROPIC_AUTH_TOKEN = "env-key-0123456789";
  try {
    assert.equal(localProfileCredential("relay_env"), "env-key-0123456789");
  } finally {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }
});

test("a key stored in the profiles file wins over the environment", () => {
  process.env.ANTHROPIC_AUTH_TOKEN = "env-key-0123456789";
  try {
    assert.equal(localProfileCredential("relay_file"), "file-key-0123456789");
  } finally {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }
});

test("a profile with no key anywhere reports an empty credential", () => {
  assert.equal(localProfileCredential("relay_env"), "");
});

test("an unknown profile id is an error, not an empty credential", () => {
  assert.throws(
    () => localProfileCredential("missing_profile"),
    /not configured/,
  );
});
