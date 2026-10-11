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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A verifier checks another session's work: it reads and runs commands that
// only read, in a sandbox that keeps the workspace read-only, with tools
// that cannot edit files. The runtimes' homes are scratch folders, set
// before any module reads them.
const root = realpathSync(mkdtempSync(join(tmpdir(), "foundry-verifier-")));
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
process.env.CODEX_HOME = join(root, "codex");
const cli = join(root, "agent-cli");
writeFileSync(cli, "#!/bin/sh\necho 0.0.0-test\n", { mode: 0o755 });
process.env.FOUNDRY_CLAUDE_BIN = cli;
process.env.FOUNDRY_CODEX_BIN = cli;
test.after(() => rmSync(root, { recursive: true, force: true }));

register("./fixtures/fake-native-sdk-hooks.mjs", import.meta.url);
const { calls } = await import("./fixtures/fake-native-sdk.mjs");
const {
  closeAllActiveRuntimes,
  runClaudeWorkspaceSession,
  runCodexWorkspaceSession,
} = await import("../dist/runner.js");
const { registerSessionAmbientEnv } =
  await import("../dist/session-ambient.js");
const { verificationDirectory, verificationExecution } =
  await import("../dist/verification-session.js");
const { runWorkspaceSession } = await import("../dist/session/index.js");
const { sandboxAvailable } = await import("../dist/sandbox/index.js");
test.after(() => closeAllActiveRuntimes());

const ambient = {
  serverURL: "http://127.0.0.1:1",
  sessionToken: "token-of-the-verifier",
  workspaceID: "ws_verify",
};

function verifier(provider) {
  const id = `sess_${randomUUID().replaceAll("-", "")}`;
  return {
    id,
    threadId: id,
    workspaceId: "ws_verify",
    agentId: "agent",
    deviceId: "dev",
    provider,
    source: "verification",
    parentSessionId: "sess_parent",
    status: "queued",
    title: "Check",
    prompt: "Run the tests and report",
    createdLabel: "now",
    updatedLabel: "queued",
    input: { id: randomUUID(), prompt: "Run the tests and report" },
  };
}

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

test("a verifier's Claude runs reading tools and a shell only, for at most 20 turns", async () => {
  calls.length = 0;
  await run(verifier("claude"), {
    id: "claude_local",
    runtime: "claude",
    label: "Claude",
    connectionType: "local_login",
  });
  const { options } = calls.find((call) => call.sdk === "claude");
  assert.equal(options.permissionMode, "dontAsk");
  assert.equal(options.allowDangerouslySkipPermissions, undefined);
  assert.deepEqual(options.allowedTools, [
    "Read",
    "Grep",
    "Glob",
    "Bash",
    "Skill",
    "mcp__foundry",
  ]);
  for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Task"])
    assert.ok(options.disallowedTools.includes(tool), tool);
  assert.equal(options.maxTurns, 20);
  assert.deepEqual(options.settingSources, ["project"]);
  assert.equal(options.strictMcpConfig, true);
  // Its Foundry tools: the server lists a verifier only those that read.
  assert.ok(options.mcpServers.foundry);
  const notes = options.systemPrompt.append;
  assert.match(notes, /an independent verifier/);
  assert.match(notes, /read-only at the operating-system level/);
  assert.match(notes, /20 turns per message/);
  assert.doesNotMatch(notes, /\.foundry\/attachments/);
});

test("a verifier's Codex lets commands write only where its sandbox allows", async () => {
  calls.length = 0;
  await run(verifier("codex"), {
    id: "codex_local",
    runtime: "codex",
    label: "Codex",
    connectionType: "local_login",
  });
  const call = calls.find((item) => item.sdk === "codex");
  assert.equal(call.thread.sandboxMode, "workspace-write");
  assert.equal(call.thread.approvalPolicy, "never");
  assert.equal(call.thread.webSearchMode, "disabled");
  assert.ok(call.options.config.mcp_servers.foundry);
  assert.match(
    call.options.config.developer_instructions,
    /read-only at the operating-system level/,
  );
  assert.doesNotMatch(
    call.options.config.developer_instructions,
    /turns per message/,
  );
});

test("a verifier runs in the workspace read-only, with a scratch directory emptied each turn", () => {
  const path = workspace();
  const session = verifier("claude");
  const execution = verificationExecution(session, path, ambient);
  const { profile, env } = execution.sandbox;
  assert.equal(execution.cwd, path);
  assert.equal(
    execution.stateRoot,
    verificationDirectory("ws_verify", session.id),
  );
  assert.deepEqual(profile.readRoots, [path]);
  assert.equal(profile.writeRoots.length, 1);
  const [scratch] = profile.writeRoots;
  assert.ok(!scratch.startsWith(path) && !path.startsWith(scratch));
  assert.equal(profile.userFiles, "readable");
  assert.equal(env.HOME, scratch);
  assert.equal(env.TMPDIR, join(scratch, "tmp"));
  assert.deepEqual(execution.sandbox.ambient, ambient);

  writeFileSync(join(env.TMPDIR, "build.out"), "x");
  writeFileSync(join(scratch, "claude", "session.jsonl"), "{}");
  // A verifier unused for a week is removed with what it cached.
  const stale = verificationDirectory("ws_verify", "sess_stale");
  mkdirSync(stale, { recursive: true });
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(stale, old, old);

  verificationExecution(session, path, ambient);
  assert.deepEqual(readdirSync(env.TMPDIR), []);
  assert.ok(existsSync(join(scratch, "claude", "session.jsonl")));
  assert.equal(existsSync(stale), false);
});

test(
  "the verifier's sandbox refuses writes to the workspace and allows its temporary directory",
  { skip: !sandboxAvailable("writable_tree") },
  async () => {
    const path = workspace();
    writeFileSync(join(path, "greeting.txt"), "hello\n");
    const session = verifier("claude");
    const execution = verificationExecution(session, path, ambient);
    const result = await runWorkspaceSession({
      cwd: execution.cwd,
      session,
      // A stand-in agent: the commands a verifier's tools would run.
      profile: {
        id: "stand_in",
        runtime: "claude",
        label: "Stand-in",
        command: [
          "printf 'read: %s; ' \"$(cat greeting.txt)\"",
          "if (echo changed > greeting.txt) 2>/dev/null; then printf 'workspace written; '; else printf 'workspace refused; '; fi",
          "if (echo new > created.txt) 2>/dev/null; then printf 'file created; '; else printf 'create refused; '; fi",
          'echo built > "$TMPDIR/out.txt" && printf "tmp: %s" "$(cat "$TMPDIR/out.txt")"',
        ].join("; "),
      },
      emit: async () => {},
      emitSetup: async () => {},
      reportNativeSessionId: () => {},
      sandbox: execution.sandbox,
    });
    assert.equal(
      result.response,
      "read: hello; workspace refused; create refused; tmp: built",
    );
    assert.equal(readFileSync(join(path, "greeting.txt"), "utf8"), "hello\n");
    assert.equal(existsSync(join(path, "created.txt")), false);
  },
);
