import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeAccount, codexAccount } from "../dist/native-account.js";

const scratch = mkdtempSync(join(tmpdir(), "foundry-account-"));

function codexHome(name, contents) {
  const home = join(scratch, name);
  mkdirSync(home, { recursive: true });
  if (contents !== undefined) {
    writeFileSync(join(home, "auth.json"), contents);
  }
  return home;
}

// A JWT the CLI would have written: header.payload.signature, payload base64url.
function idToken(claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${payload}.signature`;
}

test("a ChatGPT login reports the account it belongs to", () => {
  const home = codexHome(
    "login",
    JSON.stringify({
      tokens: {
        account_id: "acct_123",
        id_token: idToken({ email: "person@example.com" }),
      },
    }),
  );

  assert.deepEqual(codexAccount({ CODEX_HOME: home }), {
    label: "person@example.com",
    mode: "login",
  });
});

test("a login without an email claim falls back to the account id", () => {
  const home = codexHome(
    "no-email",
    JSON.stringify({
      tokens: { account_id: "acct_456", id_token: idToken({ sub: "user" }) },
    }),
  );

  assert.deepEqual(codexAccount({ CODEX_HOME: home }), {
    label: "acct_456",
    mode: "login",
  });
});

test("an api key login is reported without inventing an identity", () => {
  const home = codexHome(
    "api-key",
    JSON.stringify({ OPENAI_API_KEY: "sk-not-a-real-key" }),
  );

  assert.deepEqual(codexAccount({ CODEX_HOME: home }), {
    label: "API key",
    mode: "api_key",
  });
});

test("no auth file means not signed in, matching the CLI", () => {
  assert.equal(codexAccount({ CODEX_HOME: codexHome("empty") }), undefined);
});

test("a corrupt auth file is treated as not signed in", () => {
  assert.equal(
    codexAccount({ CODEX_HOME: codexHome("broken", "{not json") }),
    undefined,
  );
});

test("the Claude account comes from the profile beside its keychain entry", () => {
  const home = join(scratch, "claude");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "person@example.com" } }),
  );

  assert.deepEqual(claudeAccount(home), {
    label: "person@example.com",
    mode: "login",
  });
  assert.equal(claudeAccount(join(scratch, "absent")), undefined);
});
