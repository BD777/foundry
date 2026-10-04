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
} from "../dist/native-cli.js";
import { installNativeCli } from "../dist/native-cli-install.js";
import {
  runtimeCompanions,
  runtimeInstallArgs,
} from "../dist/worker-install.js";

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

test("the worker does not ship the agents' own Claude Code and Codex programs", () => {
  assert.equal(manifest.dependencies["@openai/codex"], undefined);
  for (const sdk of ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk"]) {
    assert.equal(
      manifest.dependencies[sdk],
      undefined,
      `${sdk} is not a dependency`,
    );
    assert.ok(manifest.peerDependencies[sdk], `${sdk} is a peer`);
    assert.equal(manifest.peerDependenciesMeta[sdk].optional, true);
  }
  assert.ok(runtimeInstallArgs("/x").includes("--omit=optional"));
  const { required, bestEffort } = runtimeCompanions(manifest);
  assert.deepEqual(required.sort(), [
    `@anthropic-ai/claude-agent-sdk@${manifest.peerDependencies["@anthropic-ai/claude-agent-sdk"]}`,
    `@openai/codex-sdk@${manifest.peerDependencies["@openai/codex-sdk"]}`,
  ]);
  assert.deepEqual(bestEffort, [
    `node-pty@${manifest.optionalDependencies["node-pty"]}`,
  ]);
});

test("program versions are read and compared with what Foundry needs", () => {
  assert.equal(parseCliVersion("2.1.288 (Claude Code)"), "2.1.288");
  assert.equal(parseCliVersion("codex-cli 0.153.4"), "0.153.4");
  assert.equal(isOlderVersion("2.1.9", "2.1.201"), true);
  assert.equal(isOlderVersion("2.1.288", "2.1.201"), false);
  assert.equal(isOlderVersion("0.142.0", "0.142.0"), false);
  assert.match(minimumCliVersion("claude"), /^\d+\.\d+\.\d+$/);
  assert.match(minimumCliVersion("codex"), /^\d+\.\d+\.0$/);
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
    "curl -fsSL https://claude.ai/install.sh | bash",
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
