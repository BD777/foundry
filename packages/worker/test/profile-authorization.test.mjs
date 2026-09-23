import assert from "node:assert/strict";
import { accessSync, constants } from "node:fs";
import test from "node:test";
import {
  authorizationCodeFromInput,
  authorizationPromptFromOutput,
  ensurePtySpawnHelperExecutable,
} from "../dist/profile-authorization.js";

test("Claude authorization accepts either a code or a callback URL", () => {
  assert.equal(authorizationCodeFromInput("plain-code"), "plain-code");
  assert.equal(
    authorizationCodeFromInput(
      "http://127.0.0.1/callback?code=oauth-code&state=s1",
    ),
    "oauth-code",
  );
});

test("native CLI prompts expose only the URL and Codex device code", () => {
  const claude = authorizationPromptFromOutput(
    "Browser did not open\r\nhttps://claude.com/cai/oauth/authorize?code=true&state=s1\r\nPaste code here",
    "claude",
  );
  assert.equal(
    claude.url,
    "https://claude.com/cai/oauth/authorize?code=true&state=s1",
  );
  assert.equal(claude.code, undefined);

  const codex = authorizationPromptFromOutput(
    "Open https://auth.openai.com/codex/device and enter ABCD-EFGHJ",
    "codex",
  );
  assert.equal(codex.url, "https://auth.openai.com/codex/device");
  assert.equal(codex.code, "ABCD-EFGHJ");
});

test("the node-pty spawn helper is executable before a PTY is spawned", () => {
  const helper = ensurePtySpawnHelperExecutable();
  if (process.platform !== "darwin") {
    // node-pty builds spawn-helper only for macOS; Linux forks directly.
    assert.equal(helper, undefined);
    return;
  }
  assert.ok(helper, "macOS must resolve a spawn helper");
  accessSync(helper, constants.X_OK);
});
