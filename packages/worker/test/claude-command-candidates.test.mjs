import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  claudeCommandCandidates,
  resolveClaudeCommand,
} from "../dist/utils.js";

function fakeClaudeInstall(root, name = "claude") {
  const binDir = resolve(root, ".local/bin");
  mkdirSync(binDir, { recursive: true });
  const bin = resolve(binDir, name);
  writeFileSync(
    bin,
    ["#!/bin/sh", 'echo "1.0.0 (fake)"', "exit 0"].join("\n"),
    { mode: 0o755 },
  );
  return bin;
}

test("candidate order prefers env override, then PATH, then install locations", () => {
  const home = "/tmp/fake-home";
  assert.deepEqual(claudeCommandCandidates({}, home), [
    "claude",
    resolve(home, ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
  ]);
  assert.deepEqual(
    claudeCommandCandidates({ FOUNDRY_CLAUDE_BIN: "/custom/claude" }, home),
    [
      "/custom/claude",
      "claude",
      resolve(home, ".local/bin/claude"),
      "/opt/homebrew/bin/claude",
    ],
  );
});

test("claude installed by the native installer resolves without a login-shell PATH", (t) => {
  const home = mkdtempSync(resolve(tmpdir(), "foundry-claude-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = fakeClaudeInstall(home);
  const original = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    FOUNDRY_CLAUDE_BIN: process.env.FOUNDRY_CLAUDE_BIN,
  };
  delete process.env.FOUNDRY_CLAUDE_BIN;
  process.env.HOME = home;
  process.env.PATH = "/usr/bin:/bin";
  try {
    assert.equal(resolveClaudeCommand(), bin);
  } finally {
    process.env.HOME = original.HOME;
    process.env.PATH = original.PATH;
    if (original.FOUNDRY_CLAUDE_BIN === undefined)
      delete process.env.FOUNDRY_CLAUDE_BIN;
    else process.env.FOUNDRY_CLAUDE_BIN = original.FOUNDRY_CLAUDE_BIN;
  }
});

test("FOUNDRY_CLAUDE_BIN wins over discovered install locations", (t) => {
  const home = mkdtempSync(resolve(tmpdir(), "foundry-claude-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const native = fakeClaudeInstall(home);
  const overrideDir = resolve(home, "override");
  mkdirSync(overrideDir);
  const override = resolve(overrideDir, "claude-override");
  writeFileSync(
    override,
    ["#!/bin/sh", 'echo "9.9.9 (override)"', "exit 0"].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(override, 0o755);
  const original = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    FOUNDRY_CLAUDE_BIN: process.env.FOUNDRY_CLAUDE_BIN,
  };
  process.env.FOUNDRY_CLAUDE_BIN = override;
  process.env.HOME = home;
  process.env.PATH = "/usr/bin:/bin";
  try {
    assert.equal(resolveClaudeCommand(), override);
    assert.notEqual(resolveClaudeCommand(), native);
  } finally {
    process.env.HOME = original.HOME;
    process.env.PATH = original.PATH;
    if (original.FOUNDRY_CLAUDE_BIN === undefined)
      delete process.env.FOUNDRY_CLAUDE_BIN;
    else process.env.FOUNDRY_CLAUDE_BIN = original.FOUNDRY_CLAUDE_BIN;
  }
});
