import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The runtimes' config homes are scratch folders holding the transcripts a
// test says the device has; they are set before any module reads them.
const root = realpathSync(mkdtempSync(join(tmpdir(), "foundry-native-")));
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
process.env.CODEX_HOME = join(root, "codex");
const cli = join(root, "agent-cli");
writeFileSync(cli, "#!/bin/sh\necho 0.0.0-test\n", { mode: 0o755 });
process.env.FOUNDRY_CLAUDE_BIN = cli;
process.env.FOUNDRY_CODEX_BIN = cli;
test.after(() => rmSync(root, { recursive: true, force: true }));

register("./fixtures/fake-native-sdk-hooks.mjs", import.meta.url);
const { calls, refused } = await import("./fixtures/fake-native-sdk.mjs");
const {
  closeAllActiveRuntimes,
  runClaudeWorkspaceSession,
  runCodexWorkspaceSession,
} = await import("../dist/runner.js");
const { decideNativeSession } = await import("../dist/native-session.js");
const { registerSessionAmbientEnv } =
  await import("../dist/session-ambient.js");
const { foundryStatePath } = await import("../dist/state-root.js");
test.after(() => closeAllActiveRuntimes());

const profile = {
  id: "claude_local",
  runtime: "claude",
  label: "Claude",
  connectionType: "local_login",
};
const managed = (set) => ({
  pluginDir: join(root, "skill-sets", set),
  skills: [],
  officialSkills: [],
});

function workspace() {
  const path = join(root, `ws-${randomUUID()}`);
  mkdirSync(path, { recursive: true });
  return path;
}

/** The device has this Claude transcript. */
function claudeTranscript(id) {
  const dir = join(process.env.CLAUDE_CONFIG_DIR, "projects", "p");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), "{}\n");
}

function chatSession(overrides) {
  const id = `sess_${randomUUID()}`;
  return {
    id,
    threadId: id,
    workspaceId: "ws",
    agentId: "agent",
    deviceId: "dev",
    provider: "claude",
    source: "chat",
    status: "queued",
    title: "t",
    prompt: "first",
    createdLabel: "now",
    updatedLabel: "queued",
    input: { id: randomUUID(), prompt: "hello" },
    ...overrides,
  };
}

async function run(cwd, session, options = {}) {
  const events = [];
  const reported = [];
  const run =
    session.provider === "codex"
      ? runCodexWorkspaceSession
      : runClaudeWorkspaceSession;
  const result = await run(
    cwd,
    session,
    options.profile ?? profile,
    async (label, detail) => events.push({ label, detail }),
    async () => {},
    (id) => reported.push(id),
    options.managed,
  );
  return { result, events, reported };
}

test("the decision: resume what the device has, otherwise start over told the conversation", () => {
  const base = {
    nativeSessionId: "n",
    canFork: true,
    transcriptPresent: true,
    forkSourcePresent: false,
    receiptConflicts: false,
  };
  assert.deepEqual(decideNativeSession(base), {
    kind: "resume",
    nativeSessionId: "n",
  });
  assert.deepEqual(decideNativeSession({ ...base, nativeSessionId: "" }), {
    kind: "new",
  });
  assert.deepEqual(decideNativeSession({ ...base, transcriptPresent: false }), {
    kind: "new",
    reason: "transcript_missing",
  });
  assert.deepEqual(decideNativeSession({ ...base, receiptConflicts: true }), {
    kind: "new",
    reason: "other_workspace",
  });
  assert.deepEqual(decideNativeSession({ ...base, resumeRefused: true }), {
    kind: "new",
    reason: "resume_refused",
  });
  const fork = {
    ...base,
    forkFrom: "source",
    transcriptPresent: false,
    forkSourcePresent: true,
  };
  assert.deepEqual(decideNativeSession(fork), {
    kind: "fork",
    from: "source",
    nativeSessionId: "n",
  });
  // A fork that already answered is resumed like any other session.
  assert.deepEqual(decideNativeSession({ ...fork, transcriptPresent: true }), {
    kind: "resume",
    nativeSessionId: "n",
  });
  assert.deepEqual(decideNativeSession({ ...fork, canFork: false }), {
    kind: "new",
    reason: "transcript_missing",
  });
});

test("a changed skill set resumes the same native session", async () => {
  const cwd = workspace();
  const nativeId = randomUUID();
  claudeTranscript(nativeId);
  calls.length = 0;
  const session = chatSession({ nativeSessionId: nativeId });
  const first = await run(cwd, session, { managed: managed("a") });
  assert.equal(first.result.nativeSessionId, nativeId);
  // Next turn: a skill was added, so the catalog (and the runtime) differ.
  const second = await run(
    cwd,
    {
      ...session,
      input: { id: randomUUID(), prompt: "again" },
    },
    {
      managed: {
        ...managed("b"),
        skills: [{ name: "qa", dir: join(root, "skill-sets/b/skills/qa") }],
      },
    },
  );
  assert.equal(second.result.nativeSessionId, nativeId);
  assert.deepEqual(
    calls.map((call) => call.options.resume),
    [nativeId, nativeId],
  );
  assert.ok(
    !second.events.some((event) => /new native session/i.test(event.label)),
  );
});

test("a native session started outside Foundry resumes and gets a receipt", async () => {
  const cwd = workspace();
  const nativeId = randomUUID();
  claudeTranscript(nativeId);
  const receipt = foundryStatePath(
    "skill-isolation",
    `${createHash("sha256").update(nativeId).digest("hex")}.json`,
  );
  assert.equal(existsSync(receipt), false);
  calls.length = 0;
  const { result, reported } = await run(
    cwd,
    chatSession({ nativeSessionId: nativeId }),
    { managed: managed("adopted") },
  );
  assert.equal(calls[0].options.resume, nativeId);
  assert.equal(result.nativeSessionId, nativeId);
  assert.ok(reported.includes(nativeId));
  assert.equal(existsSync(receipt), true);
});

test("a native session that has to start over is told the Foundry conversation", async (t) => {
  const cwd = workspace();
  // The server could not be asked: the turns it passed are kept.
  calls.length = 0;
  const kept = await run(
    cwd,
    chatSession({
      nativeSessionId: randomUUID(),
      input: {
        id: randomUUID(),
        prompt: "go on",
        importedContext: "User: the turn it missed",
      },
    }),
  );
  assert.equal(calls[0].options.resume, undefined);
  assert.match(calls[0].prompts[0], /the turn it missed/);
  assert.match(calls[0].prompts[0], /go on$/);
  assert.ok(
    kept.events.some((event) => event.label === "Started a new native session"),
  );
  // With the session's token it reads the whole conversation.
  const server = createServer((request, response) => {
    assert.match(request.url, /\/api\/agent-sessions\/.+\/conversation$/);
    assert.equal(request.headers.authorization, "Bearer token");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ text: "User: everything so far" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const session = chatSession({ nativeSessionId: randomUUID() });
  const unregister = registerSessionAmbientEnv(session.id, {
    serverURL: `http://127.0.0.1:${server.address().port}`,
    sessionToken: "token",
    workspaceID: "ws",
  });
  t.after(unregister);
  calls.length = 0;
  await run(cwd, session);
  assert.match(calls[0].prompts[0], /everything so far/);
});

test("a refused resume runs once more in a new native session", async () => {
  const cwd = workspace();
  const nativeId = randomUUID();
  claudeTranscript(nativeId);
  refused.add(nativeId);
  calls.length = 0;
  const { result } = await run(
    cwd,
    chatSession({
      nativeSessionId: nativeId,
      input: { id: randomUUID(), prompt: "hi", importedContext: "User: x" },
    }),
  );
  assert.deepEqual(
    calls.map((call) => call.options.resume),
    [nativeId, undefined],
  );
  assert.notEqual(result.nativeSessionId, nativeId);
  assert.match(calls[1].prompts[0], /User: x/);
});

test("a fork copies the source into the native session the server assigned", async () => {
  const cwd = workspace();
  const source = randomUUID();
  const target = randomUUID();
  claudeTranscript(source);
  calls.length = 0;
  const { result, reported } = await run(
    cwd,
    chatSession({ nativeSessionId: target, forkNativeSessionId: source }),
  );
  assert.equal(calls[0].options.resume, source);
  assert.equal(calls[0].options.forkSession, true);
  assert.equal(calls[0].options.sessionId, target);
  assert.equal(result.nativeSessionId, target);
  assert.ok(!reported.includes(source));
});

test("Codex resumes its own thread and starts one told the conversation otherwise", async () => {
  const cwd = workspace();
  const threadId = randomUUID();
  const day = join(process.env.CODEX_HOME, "sessions", "2026", "10", "09");
  mkdirSync(day, { recursive: true });
  writeFileSync(
    join(day, `rollout-2026-10-09T00-00-00-${threadId}.jsonl`),
    "{}\n",
  );
  const codex = {
    id: "codex_local",
    runtime: "codex",
    label: "Codex",
    connectionType: "local_login",
  };
  calls.length = 0;
  await run(
    cwd,
    chatSession({ provider: "codex", nativeSessionId: threadId }),
    { profile: codex },
  );
  await run(
    cwd,
    chatSession({
      provider: "codex",
      nativeSessionId: randomUUID(),
      input: {
        id: randomUUID(),
        prompt: "hi",
        importedContext: "User: earlier",
      },
    }),
    { profile: codex },
  );
  assert.deepEqual(
    calls.map((call) => [call.kind, call.id]),
    [
      ["resume", threadId],
      ["start", undefined],
    ],
  );
  assert.match(JSON.stringify(calls[1].input), /User: earlier/);
});

test("a session's earlier runtime is closed when a new one resumes its native session", async () => {
  const cwd = workspace();
  const nativeId = randomUUID();
  claudeTranscript(nativeId);
  calls.length = 0;
  const session = chatSession({ nativeSessionId: nativeId });
  await run(cwd, session, { managed: managed("before") });
  await run(
    cwd,
    { ...session, input: { id: randomUUID(), prompt: "next" } },
    {
      managed: {
        ...managed("after"),
        skills: [{ name: "qa", dir: join(root, "skill-sets/after/skills/qa") }],
      },
    },
  );
  // The fake's first query ends when its input closes.
  assert.equal(calls.length, 2);
  assert.equal(calls[0].closed, true);
});
