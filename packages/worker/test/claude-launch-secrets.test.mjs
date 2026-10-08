import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "foundry-claude-launch-"));
process.env.FOUNDRY_STATE_ROOT = root;
test.after(() => rmSync(root, { recursive: true, force: true }));

const { claudeLaunchMcpServers, claudeSettingsFile, clearClaudeSettingsFiles } =
  await import("../dist/session-policy.js");

test("Claude's settings, key included, go to an owner-only file, not an argument", () => {
  const path = claudeSettingsFile("sess_1", {
    env: { ANTHROPIC_AUTH_TOKEN: "sk-secret" },
  });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(
    JSON.parse(readFileSync(path, "utf8")).env.ANTHROPIC_AUTH_TOKEN,
    "sk-secret",
  );
  assert.doesNotMatch(path, /sess_1/);
  clearClaudeSettingsFiles();
  assert.equal(existsSync(path), false);
});

test("a new Claude process reads the Foundry tools token from its environment", () => {
  const servers = {
    foundry: {
      type: "http",
      url: "https://server/api/mcp",
      headers: { Authorization: "Bearer tok-secret" },
    },
  };
  const launched = claudeLaunchMcpServers(servers);
  assert.equal(
    launched.foundry.headers.Authorization,
    "Bearer ${FOUNDRY_SESSION_TOKEN}",
  );
  assert.doesNotMatch(JSON.stringify(launched), /tok-secret/);
  // The live update path keeps the literal token.
  assert.equal(servers.foundry.headers.Authorization, "Bearer tok-secret");
});
