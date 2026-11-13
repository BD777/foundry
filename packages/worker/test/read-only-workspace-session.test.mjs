import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A session with workspaceAccess "read" (a message channel's session) is an
// ordinary chat that runs inside the verifier's sandbox: its workspace is
// read-only for its agent and every command it runs.
const root = realpathSync(mkdtempSync(join(tmpdir(), "foundry-read-only-")));
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
process.env.CODEX_HOME = join(root, "codex");
const cli = join(root, "agent-cli");
writeFileSync(cli, "#!/bin/sh\necho 0.0.0-test\n", { mode: 0o755 });
process.env.FOUNDRY_CLAUDE_BIN = cli;
process.env.FOUNDRY_CODEX_BIN = cli;
test.after(() => rmSync(root, { recursive: true, force: true }));

register("./fixtures/fake-native-sdk-hooks.mjs", import.meta.url);
const { calls } = await import("./fixtures/fake-native-sdk.mjs");
const { closeAllActiveRuntimes } =
  await import("../dist/session/runner/active-runtimes.js");
const { runClaudeWorkspaceSession } =
  await import("../dist/session/runner/claude-turn.js");
const { runCodexWorkspaceSession } =
  await import("../dist/session/runner/codex-turn.js");
const { registerSessionAmbientEnv } =
  await import("../dist/session/session-ambient.js");
const { readOnlySessionDirectory, readOnlySessionExecution } =
  await import("../dist/session/read-only-workspace-session.js");
const { sessionExecution } =
  await import("../dist/daemon/session-execution.js");
const { availableDaemonCapabilities } =
  await import("../dist/daemon/workspace-ops.js");
const { writePersonalAgentFiles } =
  await import("../dist/session/personal-agent-files.js");
const { runWorkspaceSession } = await import("../dist/session/index.js");
const { sandboxAvailable, sandboxReady } =
  await import("../dist/sandbox/index.js");
test.after(() => closeAllActiveRuntimes());

const ambient = {
  serverURL: "http://127.0.0.1:1",
  sessionToken: "token-of-the-channel-session",
  workspaceID: "ws_channel",
};

function chat(provider, extra = {}) {
  const id = `sess_${randomUUID().replaceAll("-", "")}`;
  return {
    id,
    threadId: id,
    workspaceId: "ws_channel",
    agentId: "agent",
    deviceId: "dev",
    provider,
    source: "chat",
    status: "queued",
    title: "Channel",
    prompt: "Hello",
    createdLabel: "now",
    updatedLabel: "queued",
    input: { id: randomUUID(), prompt: "Hello" },
    ...extra,
  };
}

const readOnly = (provider) => chat(provider, { workspaceAccess: "read" });

function workspace() {
  const path = join(root, `ws-${randomUUID()}`);
  mkdirSync(path, { recursive: true });
  return path;
}

async function run(session, profile) {
  const unregister = registerSessionAmbientEnv(session.id, ambient);
  try {
    const start =
      session.provider === "codex"
        ? runCodexWorkspaceSession
        : runClaudeWorkspaceSession;
    return await start(
      workspace(),
      session,
      profile,
      async () => {},
      async () => {},
      () => {},
    );
  } finally {
    unregister();
  }
}

test("a read-only session runs in its workspace, writing only its private scratch, kept across turns", () => {
  const path = workspace();
  const session = readOnly("claude");
  const execution = readOnlySessionExecution(
    session,
    path,
    ambient,
    undefined,
    true,
  );
  const { profile, env } = execution.sandbox;
  const directory = readOnlySessionDirectory("ws_channel", session.id);
  assert.equal(execution.cwd, path);
  assert.equal(execution.stateRoot, directory);
  assert.match(directory, /[/\\]read-only-sessions[/\\]/);
  assert.equal(profile.kind, "writable_tree");
  assert.equal(profile.workdir, path);
  assert.deepEqual(profile.readRoots, [path]);
  assert.deepEqual(profile.writeRoots, [join(directory, "scratch")]);
  const [scratch] = profile.writeRoots;
  assert.ok(!scratch.startsWith(path) && !path.startsWith(scratch));
  assert.equal(env.HOME, scratch);
  assert.equal(env.TMPDIR, join(scratch, "tmp"));
  assert.deepEqual(execution.sandbox.ambient, ambient);

  writeFileSync(join(env.TMPDIR, "build.out"), "x");
  writeFileSync(join(scratch, "claude", "session.jsonl"), "{}");
  const next = readOnlySessionExecution(
    session,
    path,
    ambient,
    undefined,
    true,
  );
  assert.equal(next.stateRoot, directory);
  assert.deepEqual(readdirSync(env.TMPDIR), []);
  assert.ok(existsSync(join(scratch, "claude", "session.jsonl")));
});

test("a read-only session fails instead of running unsandboxed", () => {
  assert.throws(
    () =>
      readOnlySessionExecution(
        readOnly("claude"),
        workspace(),
        ambient,
        undefined,
        false,
      ),
    /read-only.*not run/,
  );
});

test("only read-only sessions get the sandbox; a chat runs as before", () => {
  const path = workspace();
  assert.deepEqual(sessionExecution(path, chat("claude"), ambient), {
    cwd: path,
    stateRoot: path,
  });
  const session = readOnly("codex");
  if (!sandboxReady("readonly_agent")) {
    assert.throws(() => sessionExecution(path, session, ambient));
    return;
  }
  const execution = sessionExecution(path, session, ambient);
  assert.equal(execution.cwd, path);
  assert.equal(
    execution.stateRoot,
    readOnlySessionDirectory("ws_channel", session.id),
  );
  assert.deepEqual(execution.sandbox.profile.readRoots, [path]);
});

test("the worker declares read-only sessions exactly when the verifier's sandbox is ready", () => {
  const capabilities = availableDaemonCapabilities();
  const ready = sandboxReady("readonly_agent");
  assert.equal(capabilities.includes("read_only_workspace_sessions"), ready);
  assert.equal(capabilities.includes("verification_sessions"), ready);
  assert.ok(capabilities.includes("workspace_file_write"));
});

test("a read-only session's Claude runs with a chat's options", async () => {
  const profile = {
    id: "claude_local",
    runtime: "claude",
    label: "Claude",
    connectionType: "local_login",
  };
  calls.length = 0;
  await run(chat("claude"), profile);
  await run(readOnly("claude"), profile);
  const [normal, channel] = calls
    .filter((item) => item.sdk === "claude")
    .map((item) => item.options);
  for (const key of [
    "permissionMode",
    "allowedTools",
    "disallowedTools",
    "settingSources",
    "strictMcpConfig",
    "maxTurns",
    "systemPrompt",
  ])
    assert.deepEqual(channel[key], normal[key], key);
  assert.notEqual(channel.permissionMode, "dontAsk");
});

test("a read-only session's Codex leaves commands to the outer sandbox, otherwise a chat's options", async () => {
  const profile = {
    id: "codex_local",
    runtime: "codex",
    label: "Codex",
    connectionType: "local_login",
    // A profile that would sandbox Codex itself.
    codexSandboxMode: "workspace-write",
  };
  calls.length = 0;
  await run(chat("codex"), profile);
  await run(readOnly("codex"), profile);
  const [normal, channel] = calls.filter((item) => item.sdk === "codex");
  assert.equal(channel.thread.sandboxMode, "danger-full-access");
  assert.equal(normal.thread.sandboxMode, "workspace-write");
  const { sandboxMode: _a, ...normalRest } = normal.thread;
  const { sandboxMode: _b, ...channelRest } = channel.thread;
  // Each run has its own session and workspace.
  for (const rest of [normalRest, channelRest]) {
    delete rest.workSessionId;
    delete rest.workingDirectory;
  }
  assert.deepEqual(channelRest, normalRest);
  assert.deepEqual(
    channel.options.config.features,
    normal.options.config.features,
  );
  assert.equal(
    channel.options.config.developer_instructions,
    normal.options.config.developer_instructions,
  );
});

test("the person's assistant files are never written into a read-only session's workspace", () => {
  const path = workspace();
  writePersonalAgentFiles(
    { ...readOnly("claude"), role: "personal_agent" },
    path,
    [{ path: "AGENTS.md", content: "rules" }],
  );
  assert.equal(existsSync(join(path, "AGENTS.md")), false);
});

test(
  "a read-only session's sandbox refuses writes to the workspace and allows its temporary directory",
  { skip: !sandboxAvailable("writable_tree") },
  async () => {
    const path = workspace();
    writeFileSync(join(path, "AGENTS.md"), "rules\n");
    const session = readOnly("claude");
    const execution = readOnlySessionExecution(
      session,
      path,
      ambient,
      undefined,
      true,
    );
    const result = await runWorkspaceSession({
      cwd: execution.cwd,
      session,
      profile: {
        id: "stand_in",
        runtime: "claude",
        label: "Stand-in",
        command: [
          "if sh -c 'echo x >> AGENTS.md' 2>/dev/null; then printf 'workspace written; '; else printf 'workspace refused; '; fi",
          'echo built > "$TMPDIR/out.txt" && printf "tmp: %s" "$(cat "$TMPDIR/out.txt")"',
        ].join("; "),
      },
      emit: async () => {},
      emitSetup: async () => {},
      reportNativeSessionId: () => {},
      sandbox: execution.sandbox,
    });
    assert.equal(result.response, "workspace refused; tmp: built");
    assert.equal(readFileSync(join(path, "AGENTS.md"), "utf8"), "rules\n");
  },
);
