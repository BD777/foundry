import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedAgentEnvironment } from "../dist/execution-sandbox.js";

test("an executor's login copy follows the device's newer login", (t) => {
  const root = mkdtempSync(join(tmpdir(), "executor-login-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "claude-config");
  mkdirSync(config);
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  });
  const source = join(config, ".credentials.json");
  const scratch = join(root, "scratch");
  const copy = join(scratch, "claude", ".credentials.json");
  const at = (path, seconds) => utimesSync(path, seconds, seconds);

  writeFileSync(source, "first");
  at(source, 1_000);
  isolatedAgentEnvironment(scratch);
  assert.equal(readFileSync(copy, "utf8"), "first");

  // The device refreshed its login (rotating the refresh token).
  writeFileSync(source, "refreshed");
  at(source, 2_000);
  at(copy, 1_000);
  isolatedAgentEnvironment(scratch);
  assert.equal(readFileSync(copy, "utf8"), "refreshed");

  // A copy newer than the device's login is left as it is.
  writeFileSync(copy, "copy refreshed itself");
  at(copy, 3_000);
  isolatedAgentEnvironment(scratch);
  assert.equal(readFileSync(copy, "utf8"), "copy refreshed itself");
});
