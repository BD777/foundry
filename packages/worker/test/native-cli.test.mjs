import assert from "node:assert/strict";
import test from "node:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearNativeCliCache,
  isOlderVersion,
  minimumCliVersion,
  nativeCli,
  nativeCliInstallCommands,
  nativeCliUpdateCommand,
  parseCliVersion,
} from "../dist/harness/native/native-cli.js";
import { installNativeCli } from "../dist/harness/native/native-cli-install.js";
import {
  runtimeCompanions,
  runtimeInstallArgs,
} from "../dist/install/worker-install.js";

import {
  saveRuntimeUpdate,
  runtimeUpdateState,
} from "../dist/harness/agent-runtime/state.js";
import { foundryStatePath } from "../dist/platform/state-root.js";

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

test("the worker does not ship the agents' own Claude Code and Codex programs", () => {
  assert.equal(manifest.dependencies["@openai/codex"], undefined);
  for (const sdk of ["@anthropic-ai/claude-agent-sdk"]) {
    assert.equal(
      manifest.dependencies[sdk],
      undefined,
      `${sdk} is not a dependency`,
    );
    assert.ok(manifest.peerDependencies[sdk], `${sdk} is a peer`);
    assert.equal(manifest.peerDependenciesMeta[sdk].optional, true);
  }
  assert.ok(runtimeInstallArgs("/x").includes("--omit=optional"));
  assert.ok(runtimeInstallArgs("/x").includes("--prefer-offline"));
  const { required } = runtimeCompanions(manifest);
  assert.deepEqual(required.sort(), [
    `@anthropic-ai/claude-agent-sdk@${manifest.peerDependencies["@anthropic-ai/claude-agent-sdk"]}`,
  ]);
  // Nothing native: no optional dependencies to build or download.
  assert.equal(manifest.optionalDependencies, undefined);
});

test("program versions are read and compared with what Foundry needs", () => {
  assert.equal(parseCliVersion("2.1.288 (Claude Code)"), "2.1.288");
  assert.equal(parseCliVersion("codex-cli 0.153.4"), "0.153.4");
  assert.equal(
    parseCliVersion("codex-cli 0.162.0-alpha.17.2"),
    "0.162.0-alpha.17.2",
  );
  assert.equal(isOlderVersion("0.162.0-alpha.17.2", "0.162.0"), true);
  assert.equal(isOlderVersion("2.1.9", "2.1.201"), true);
  assert.equal(isOlderVersion("2.1.288", "2.1.201"), false);
  assert.equal(isOlderVersion("0.142.0", "0.142.0"), false);
  assert.match(minimumCliVersion("claude"), /^\d+\.\d+\.\d+$/);
  assert.equal(minimumCliVersion("codex"), "0.159.1");
  // Session timers need the Claude Code that brings them back as fired on
  // resume: 2.1.289 fired a resumed timer at once (a real run, 2026-10-12).
  assert.equal(isOlderVersion(minimumCliVersion("claude"), "2.1.291"), false);
  assert.equal(isOlderVersion("2.1.289", minimumCliVersion("claude")), true);
});

function fakeClaude(t, version) {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\necho "${version} (Claude Code)"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function withEnv(t, values) {
  const previous = Object.fromEntries(
    Object.keys(values).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, values);
  t.after(() => {
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    clearNativeCliCache();
  });
  clearNativeCliCache();
}

test("an older device program is still used, and flagged with how to update it", (t) => {
  withEnv(t, { FOUNDRY_CLAUDE_BIN: fakeClaude(t, "1.0.0") });
  const cli = nativeCli("claude");
  assert.equal(cli.installed, true);
  assert.equal(cli.version, "1.0.0");
  assert.equal(cli.outdated, true);
  assert.equal(cli.updateCommand, "claude update");
});

test("installing runs the official command on request and reads the program again", async (t) => {
  withEnv(t, {
    FOUNDRY_CLAUDE_BIN: fakeClaude(t, "9.9.9"),
    FOUNDRY_NATIVE_CLI_INSTALL_COMMAND: "echo installing Claude Code",
  });
  const result = await installNativeCli("claude");
  assert.equal(result.ok, true);
  assert.match(result.log, /installing Claude Code/);
  assert.equal(result.cli.installed, true);
  assert.equal(result.cli.outdated, false);

  process.env.FOUNDRY_NATIVE_CLI_INSTALL_COMMAND =
    "echo no network >&2; exit 7";
  const failed = await installNativeCli("claude");
  assert.equal(failed.ok, false);
  assert.match(failed.log, /no network/);
});

test("programs install per user with the official scripts, and update the way they were installed", (t) => {
  assert.equal(
    nativeCliInstallCommands.claude,
    "curl -fsSL https://claude.ai/install.sh | bash -s stable",
  );
  assert.equal(
    nativeCliInstallCommands.codex,
    "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  );

  const root = mkdtempSync(join(tmpdir(), "foundry-codex-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const place = (relative) => {
    const target = join(root, relative);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "#!/bin/sh\n");
    const link = join(root, "bin", relative.replaceAll("/", "_"));
    mkdirSync(join(root, "bin"), { recursive: true });
    symlinkSync(target, link);
    return link;
  };
  assert.equal(
    nativeCliUpdateCommand(
      "codex",
      place("lib/node_modules/@openai/codex/bin/codex.js"),
    ),
    "npm install -g @openai/codex@latest",
  );
  assert.equal(
    nativeCliUpdateCommand("codex", place("Caskroom/codex/0.150.0/codex")),
    "brew upgrade --cask codex",
  );
  assert.equal(
    nativeCliUpdateCommand(
      "codex",
      place(".codex/packages/standalone/current/codex"),
    ),
    nativeCliInstallCommands.codex,
  );
  assert.equal(
    nativeCliUpdateCommand("claude", "/anywhere/claude"),
    "claude update",
  );
});

test("every lookup shares one probe of the device program", async (t) => {
  const { resolveClaudeCommand } =
    await import("../dist/harness/native/native-cli.js");
  const dir = mkdtempSync(join(tmpdir(), "counted-claude-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "claude");
  const log = join(dir, "runs");
  writeFileSync(
    bin,
    `#!/bin/sh\necho run >> "${log}"\necho "2.1.300 (Claude Code)"\n`,
  );
  chmodSync(bin, 0o755);
  withEnv(t, { FOUNDRY_CLAUDE_BIN: bin });
  clearNativeCliCache();

  assert.equal(resolveClaudeCommand(), bin);
  assert.equal(nativeCli("claude").version, "2.1.300");
  assert.equal(resolveClaudeCommand(), bin);
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);

  clearNativeCliCache();
  resolveClaudeCommand();
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2);
});

test("native CLI registration excludes private updater fields on fresh and cached reads", (t) => {
  withEnv(t, { FOUNDRY_CLAUDE_BIN: fakeClaude(t, "2.1.292") });
  const path = foundryStatePath("agent-updates", "claude.json");
  const previous = runtimeUpdateState("claude");
  t.after(() => {
    if (previous) saveRuntimeUpdate("claude", previous);
    else rmSync(path, { force: true });
  });
  const publicState = {
    state: "current",
    checkedAt: "2026-10-16T08:01:10.416Z",
    current: "2.1.292",
    target: "2.1.292",
    sdkTarget: "0.3.301",
    nextCheckAt: 1792159430990,
  };
  saveRuntimeUpdate("claude", {
    ...publicState,
    failureCount: 0,
    futurePrivateField: "local",
  });
  const fresh = JSON.parse(JSON.stringify(nativeCli("claude")));
  assert.deepEqual(fresh.update, publicState);
  saveRuntimeUpdate("claude", {
    ...publicState,
    state: "failed",
    failureCount: 3,
    futurePrivateField: "local",
  });
  const cached = JSON.parse(JSON.stringify(nativeCli("claude")));
  assert.deepEqual(cached.update, { ...publicState, state: "failed" });
  assert.equal(runtimeUpdateState("claude").failureCount, 3);
});

// A busy Mac took 8.5 s for Claude Code's first `--version` (a 276 MB
// binary), and the 10 s probe made the device report it as not installed.
test("a program slow to answer is there, and its version follows", async (t) => {
  const { resolveDeviceCommand } =
    await import("../dist/harness/native/native-cli.js");
  const dir = mkdtempSync(join(tmpdir(), "slow-claude-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\nsleep 1\necho "2.1.311 (Claude Code)"\n`);
  chmodSync(bin, 0o755);
  withEnv(t, { FOUNDRY_CLAUDE_BIN: bin, FOUNDRY_CLI_PROBE_TIMEOUT_MS: "300" });

  assert.equal(nativeCli("claude").installed, true);
  // The background probe waits longer and reads the version.
  let found = resolveDeviceCommand([bin]);
  for (let i = 0; i < 50 && !found?.versionOutput; i++) {
    await new Promise((done) => setTimeout(done, 100));
    found = resolveDeviceCommand([bin]);
  }
  assert.equal(found?.command, bin);
  assert.match(found?.versionOutput ?? "", /2\.1\.311/);
});

test("a program that is not there still reads as not installed", (t) => {
  withEnv(t, {
    FOUNDRY_CLAUDE_BIN: join(tmpdir(), "no-such-claude-binary"),
    FOUNDRY_CLI_PROBE_TIMEOUT_MS: "300",
  });
  assert.equal(nativeCli("claude").installed, false);
});

// After the version fix, the same Mac mini still reported Claude Code as
// unavailable: `claude auth status` took 18 s cold (6 s after two idle
// minutes), and its 5 s check counted as "did not complete".
test("a login status slow to answer keeps the last answer and is read again in the background", async (t) => {
  const {
    clearNativeLoginHealth,
    nativeLoginHealth,
    nativeLoginRevision,
    readNativeLoginHealth,
  } = await import("../dist/harness/native/native-login.js");
  const dir = mkdtempSync(join(tmpdir(), "slow-status-claude-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.311 (Claude Code)"; exit 0; fi
answer=$(cat "${dir}/answer"); code=$(cat "${dir}/code")
if [ -f "${dir}/slow" ]; then exec "${process.execPath}" -e 'setTimeout(() => { process.stdout.write(process.argv[1]); process.exit(Number(process.argv[2])) }, 1500)' "$answer" "$code"; fi
printf '%s' "$answer"; exit "$code"
`,
  );
  chmodSync(bin, 0o755);
  const answer = (value, code) => {
    writeFileSync(join(dir, "answer"), JSON.stringify(value));
    writeFileSync(join(dir, "code"), String(code));
  };
  const slow = (on) =>
    on
      ? writeFileSync(join(dir, "slow"), "")
      : rmSync(join(dir, "slow"), { force: true });
  withEnv(t, {
    FOUNDRY_CLAUDE_BIN: bin,
    CLAUDE_CONFIG_DIR: dir,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: dir,
    FOUNDRY_CLI_PROBE_TIMEOUT_MS: "500",
  });
  t.after(() => clearNativeLoginHealth());
  const settles = async (check) => {
    for (let i = 0; i < 100; i++) {
      const health = nativeLoginHealth("claude");
      if (check(health)) return health;
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.fail("the background status read did not settle");
  };

  // Never answered yet: still being read, not "did not complete".
  answer(
    { loggedIn: true, authMethod: "claude.ai", email: "slow@example.test" },
    0,
  );
  slow(true);
  clearNativeLoginHealth();
  const first = readNativeLoginHealth("claude");
  assert.equal(first.status, "unavailable");
  assert.match(first.statusDetail, /still reading/);
  assert.doesNotMatch(first.statusDetail, /did not complete/);
  const revision = nativeLoginRevision();
  const answered = await settles((health) => health.status === "healthy");
  assert.equal(answered.accountLabel, "slow@example.test");
  assert.ok(nativeLoginRevision() > revision, "the device reports the answer");

  // Answered before: a slow check keeps that answer until the new one.
  answer({ loggedIn: false, authMethod: "none" }, 1);
  clearNativeLoginHealth();
  const kept = readNativeLoginHealth("claude");
  assert.equal(kept.status, "healthy");
  assert.equal(kept.accountLabel, "slow@example.test");
  await settles((health) => health.status === "missing_auth");

  // A prompt explicit answer changes the status at once.
  slow(false);
  answer(
    { loggedIn: true, authMethod: "claude.ai", email: "fast@example.test" },
    0,
  );
  clearNativeLoginHealth();
  assert.equal(readNativeLoginHealth("claude").status, "healthy");
  answer({ loggedIn: false, authMethod: "none" }, 1);
  clearNativeLoginHealth();
  assert.equal(readNativeLoginHealth("claude").status, "missing_auth");
});

test("a login status command that cannot start still reports why", async (t) => {
  const { clearNativeLoginHealth, readNativeLoginHealth } =
    await import("../dist/harness/native/native-login.js");
  const dir = mkdtempSync(join(tmpdir(), "broken-status-claude-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "claude");
  // Answers --version, then is replaced by a file it cannot run.
  writeFileSync(bin, `#!/bin/sh\necho "2.1.311 (Claude Code)"\n`);
  chmodSync(bin, 0o755);
  withEnv(t, {
    FOUNDRY_CLAUDE_BIN: bin,
    CLAUDE_CONFIG_DIR: dir,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: dir,
    FOUNDRY_CLI_PROBE_TIMEOUT_MS: "500",
  });
  t.after(() => clearNativeLoginHealth());
  clearNativeLoginHealth();
  const { resolveClaudeCommand } =
    await import("../dist/harness/native/native-cli.js");
  assert.equal(resolveClaudeCommand(), bin);
  chmodSync(bin, 0o644);
  const health = readNativeLoginHealth("claude");
  assert.equal(health.status, "unavailable");
  assert.match(health.statusDetail, /did not complete/);
});
