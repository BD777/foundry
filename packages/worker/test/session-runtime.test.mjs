import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Profiles are read from ~/.foundry, resolved when the modules load, so the
// scratch home must be in place before importing them.
const home = realpathSync(mkdtempSync(join(tmpdir(), "foundry-session-home-")));
process.env.HOME = home;
mkdirSync(join(home, ".foundry"));
writeFileSync(
  join(home, ".foundry/agent-profiles.local.json"),
  JSON.stringify({
    profiles: [
      { id: "claude_p", runtime: "claude", label: "C", model: "sonnet" },
      { id: "codex_p", runtime: "codex", label: "X", model: "gpt" },
      { id: "command_p", runtime: "claude", label: "K", command: "run" },
    ],
  }),
);
test.after(() => rmSync(home, { recursive: true, force: true }));

register("./fixtures/fake-agent-sdk-hooks.mjs", import.meta.url);
const { calls } = await import("./fixtures/fake-agent-sdk.mjs");
const { startSession } = await import("../dist/session/index.js");
const { sandboxAvailable } = await import("../dist/sandbox/index.js");

const supported = { skip: !sandboxAvailable("readonly_agent") };

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "foundry-session-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "workspace"));
  calls.length = 0;
  return root;
}

function spec(root, overrides) {
  return {
    role: "verification",
    harness: "claude",
    profileId: "claude_p",
    directory: join(root, "stage"),
    workspace: { path: join(root, "workspace"), readRoots: [] },
    systemPrompt: "system",
    prompt: { text: "prompt", images: [] },
    title: "Foundry test",
    ...overrides,
  };
}

test(
  "the role decides tools, instructions and turn limits",
  supported,
  async (t) => {
    const root = fixture(t);
    await startSession(spec(root, {})).result;
    await startSession(
      spec(root, { role: "clarification", directory: join(root, "c") }),
    ).result;
    await startSession(
      spec(root, { workspace: undefined, directory: join(root, "d") }),
    ).result;
    const [verify, clarify, detached] = calls.map((call) => call.options);
    assert.deepEqual(verify.allowedTools, ["Read", "Grep", "Glob", "Bash"]);
    assert.deepEqual(verify.settingSources, []);
    assert.equal(verify.maxTurns, 30);
    assert.deepEqual(clarify.allowedTools, ["Read", "Grep", "Glob"]);
    assert.ok(clarify.disallowedTools.includes("Bash"));
    assert.deepEqual(clarify.settingSources, ["project"]);
    assert.deepEqual(detached.allowedTools, []);
    assert.deepEqual(detached.tools, []);
    assert.equal(detached.maxTurns, 1);
    for (const options of [verify, clarify, detached]) {
      assert.deepEqual(options.mcpServers, {});
      assert.equal(options.persistSession, false);
      const write = await options.canUseTool("Write", {});
      assert.equal(write.behavior, "deny");
    }
  },
);

test(
  "results carry the closing answer, the provider identity and the activity",
  supported,
  async (t) => {
    const root = fixture(t);
    const claude = await startSession(spec(root, {})).result;
    assert.equal(claude.text, "answer");
    assert.equal(claude.reportedModel, "claude-reported");
    assert.equal(claude.sessionId, "claude-session");
    assert.deepEqual(claude.activity, ['Read: {"file_path":"a.md"}']);
    const codex = await startSession(
      spec(root, {
        harness: "codex",
        profileId: "codex_p",
        directory: join(root, "x"),
      }),
    ).result;
    assert.equal(codex.text, "codex answer");
    assert.equal(codex.sessionId, "codex-thread");
    assert.deepEqual(codex.activity, ["shell: ls"]);
    const call = calls.find((c) => c.sdk === "codex");
    assert.equal(call.thread.sandboxMode, "read-only");
    assert.equal(call.thread.networkAccessEnabled, false);
    assert.deepEqual(call.options.config.mcp_servers, {});
  },
);

test("sessions only use native profiles without a custom command", async (t) => {
  const root = fixture(t);
  for (const profileId of ["missing", "command_p"])
    await assert.rejects(
      startSession(spec(root, { profileId })).result,
      /isolated_verifier_profile_unavailable/,
    );
  assert.equal(calls.length, 0);
});

test("cancel aborts a running session", supported, async (t) => {
  const root = fixture(t);
  const handle = startSession(spec(root, { model: "wait-for-abort" }));
  for (let wait = 0; !calls.length && wait < 400; wait++)
    await new Promise((done) => setTimeout(done, 5));
  assert.equal(calls.length, 1, "the session reached the SDK");
  handle.cancel();
  await assert.rejects(handle.result, /agent_sdk_error: Error: aborted/);
});
