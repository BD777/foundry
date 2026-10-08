import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "foundry-provider-check-"));
process.env.FOUNDRY_STATE_ROOT = root;
test.after(() => rmSync(root, { recursive: true, force: true }));

const {
  currentProviderCheck,
  needsProviderCheck,
  providerCheckDue,
  providerCheckFingerprint,
  providerChecksPath,
  readProviderChecks,
} = await import("../dist/provider-check-state.js");

const provider = {
  id: "codex_provider_aiden",
  runtime: "codex",
  connectionType: "openai_compatible",
  discovered: true,
  codexModelProvider: "aiden",
  baseUrl: "http://127.0.0.1:8787/aiden/v1",
  keySource: "requires_openai_auth",
};
const health = [
  { provider: "codex", status: "healthy", authMode: "local_login" },
];

test("only providers found in the device's configuration need a check", () => {
  assert.equal(needsProviderCheck(provider), true);
  assert.equal(
    needsProviderCheck({ ...provider, discovered: undefined }),
    false,
  );
  assert.equal(
    needsProviderCheck({ ...provider, connectionType: "local_login" }),
    false,
  );
});

test("a passed check holds until the provider or its login changes", () => {
  writeFileSync(
    providerChecksPath(),
    JSON.stringify({
      [provider.id]: {
        status: "passed",
        checkedAt: new Date().toISOString(),
        fingerprint: providerCheckFingerprint(provider, health),
      },
    }),
  );
  const checks = readProviderChecks();
  assert.equal(
    currentProviderCheck(provider.id, provider, health, checks)?.status,
    "passed",
  );
  assert.equal(providerCheckDue(provider.id, provider, health, checks), false);
  // Another endpoint, or signing out, makes the result stale.
  const moved = { ...provider, baseUrl: "http://127.0.0.1:8787/mira/v1" };
  assert.equal(
    currentProviderCheck(provider.id, moved, health, checks),
    undefined,
  );
  const signedOut = [
    { provider: "codex", status: "missing_auth", authMode: "missing" },
  ];
  assert.equal(
    providerCheckDue(provider.id, provider, signedOut, checks),
    true,
  );
});

test("a failed check is retried after an hour", () => {
  const fingerprint = providerCheckFingerprint(provider, health);
  const recent = {
    [provider.id]: {
      status: "failed",
      checkedAt: new Date().toISOString(),
      fingerprint,
    },
  };
  const old = {
    [provider.id]: {
      status: "failed",
      checkedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      fingerprint,
    },
  };
  assert.equal(providerCheckDue(provider.id, provider, health, recent), false);
  assert.equal(providerCheckDue(provider.id, provider, health, old), true);
});
