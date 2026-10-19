import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeKeychainLocation,
  readClaudeCredentialSource,
} from "../dist/native-credential-source.js";
import {
  nativeSourcePaths,
  withNativeSourceOverrides,
} from "../dist/native-runtime-paths.js";
import { isolatedClaudeEnvironment } from "../dist/runtime-isolation.js";
import { sandboxClaudeCredentials } from "../dist/session/provider-credentials.js";
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "credential-source-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".claude"));
  return { HOME: home, USER: "fixture-user" };
}
test("default Keychain identity survives isolated execution, including an explicit empty secure-store override", (t) => {
  const env = fixture(t);
  for (const source of [
    env,
    {
      ...env,
      CLAUDE_CONFIG_DIR: join(env.HOME, "settings"),
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
    },
  ]) {
    const isolated = isolatedClaudeEnvironment(
      { id: "local", runtime: "claude", connectionType: "local_login" },
      source,
      env.HOME,
    );
    assert.equal(isolated.CLAUDE_SECURESTORAGE_CONFIG_DIR, "");
    assert.deepEqual(claudeKeychainLocation(isolated), {
      service: "Claude Code-credentials",
      account: "fixture-user",
    });
    assert.equal(
      nativeSourcePaths("claude", isolated).credentialHome,
      join(env.HOME, ".claude"),
    );
  }
});
test("a profile switch separates credential namespace from configuration and history", (t) => {
  const env = fixture(t);
  const settings = join(env.HOME, "settings"),
    vault = join(env.HOME, "e\u0301-vault");
  const selected = withNativeSourceOverrides(
    { ...env, FOUNDRY_NATIVE_CLAUDE_CREDENTIAL_NAMESPACE: "old" },
    { CLAUDE_CONFIG_DIR: settings, CLAUDE_SECURESTORAGE_CONFIG_DIR: vault },
  );
  const source = nativeSourcePaths("claude", selected);
  assert.equal(source.credentialHome, vault);
  assert.equal(source.configurationSourceHome, settings);
  assert.equal(source.dataHome, settings);
  assert.equal(
    claudeKeychainLocation(selected).service,
    "Claude Code-credentials-" +
      createHash("sha256")
        .update(vault.normalize("NFC"))
        .digest("hex")
        .slice(0, 8),
  );
  assert.equal(
    claudeKeychainLocation({ ...selected, USER: "bad account" }).account,
    "claude-code-user",
  );
  const other = withNativeSourceOverrides(selected, {
    CLAUDE_CONFIG_DIR: join(env.HOME, "other"),
  });
  assert.equal(
    nativeSourcePaths("claude", other).credentialNamespace,
    join(env.HOME, "other"),
  );
});
test("selected Keychain credentials take priority; sandbox projection never carries refresh or connector secrets", (t) => {
  const env = fixture(t);
  writeFileSync(
    join(env.HOME, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "wrong-file" } }),
  );
  const text = JSON.stringify({
    claudeAiOauth: {
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      expiresAt: 1234,
    },
    mcpOAuth: { secret: "synthetic-connector" },
  });
  const selected = readClaudeCredentialSource(env, {
    platform: "darwin",
    keychain: (service, account) => {
      assert.equal(service, "Claude Code-credentials");
      assert.equal(account, "fixture-user");
      return text;
    },
  });
  assert.equal(selected.kind, "keychain");
  const projected = JSON.parse(sandboxClaudeCredentials(selected.text));
  assert.equal(projected.claudeAiOauth.accessToken, "synthetic-access");
  assert.equal(projected.claudeAiOauth.refreshToken, undefined);
  assert.equal(projected.mcpOAuth, undefined);
  assert.throws(
    () =>
      readClaudeCredentialSource(env, {
        platform: "darwin",
        keychain: () => {
          throw new Error("denied");
        },
      }),
    /denied/,
  );
  assert.equal(
    readClaudeCredentialSource(env, {
      platform: "darwin",
      keychain: () => undefined,
    }).kind,
    "file",
  );
});
