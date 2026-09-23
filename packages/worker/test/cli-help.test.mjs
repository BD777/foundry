import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseCliInvocation } from "../dist/cli-contract.js";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(packageDir, "dist", "cli.js");

function withCliSandbox(run) {
  const root = mkdtempSync(join(tmpdir(), "foundry-cli-"));
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  mkdirSync(home);
  mkdirSync(cwd);
  try {
    return run({ cwd, home, root });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function runCli(args, options) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: options.home,
      USERPROFILE: options.home,
      XDG_CONFIG_HOME: join(options.home, ".config"),
    },
    timeout: 5_000,
  });
}

test("init --help has no filesystem side effects", () => {
  withCliSandbox(({ cwd, home }) => {
    const result = runCli(["init", "--help"], { cwd, home });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^@HELP foundry-worker init/m);
    assert.equal(existsSync(join(cwd, "--help")), false);
    assert.equal(existsSync(join(home, ".foundry")), false);
  });
});

test("connect --help does not read pairing state or connect", () => {
  withCliSandbox(({ cwd, home }) => {
    const result = runCli(
      [
        "connect",
        "--server",
        "http://127.0.0.1:9",
        "--workspace",
        cwd,
        "--help",
      ],
      { cwd, home },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^@HELP foundry-worker connect/m);
    assert.equal(existsSync(join(home, ".foundry")), false);
  });
});

test("doctor --help does not treat --help as a workspace path", () => {
  withCliSandbox(({ cwd, home }) => {
    const result = runCli(["doctor", "--help"], { cwd, home });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^@HELP foundry-worker doctor/m);
    assert.doesNotMatch(result.stdout, /Workspace: --help/);
    assert.equal(existsSync(join(home, ".foundry")), false);
  });
});

test("required commands show usage before validation", () => {
  withCliSandbox(({ cwd, home }) => {
    const result = runCli(["init"], { cwd, home });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^@USAGE foundry-worker init/m);
    assert.equal(existsSync(join(home, ".foundry")), false);
  });
});

test("--commands and --schema are machine-readable", () => {
  withCliSandbox(({ cwd, home }) => {
    const commandsResult = runCli(["--commands"], { cwd, home });
    assert.equal(commandsResult.status, 0, commandsResult.stderr);
    const commands = JSON.parse(commandsResult.stdout);
    assert.ok(
      commands.some((command) => command.path === "foundry-worker connect"),
    );

    const schemaResult = runCli(["connect", "--schema"], { cwd, home });
    assert.equal(schemaResult.status, 0, schemaResult.stderr);
    const schema = JSON.parse(schemaResult.stdout);
    assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
    assert.equal(schema.title, "foundry-worker connect");
  });
});

test("argument errors use structured codes and exit status 2", () => {
  withCliSandbox(({ cwd, home }) => {
    const result = runCli(["logs", "--lines", "0"], { cwd, home });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /^ERROR \[E1004\] INVALID_VALUE:/m);
    assert.match(result.stderr, /Fix:/);
    assert.match(result.stderr, /Example:/);
  });
});

test("parser accepts long option assignment syntax", () => {
  const invocation = parseCliInvocation([
    "connect",
    "--server=http://127.0.0.1:31982",
    "--workspace=/tmp/project",
    "--once",
  ]);

  assert.equal(invocation.command.id, "connect");
  assert.deepEqual(invocation.positionals, []);
});
