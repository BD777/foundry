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
const { calls, held, refused } = await import("./fixtures/fake-native-sdk.mjs");
const {
  closeAllActiveRuntimes,
  runClaudeWorkspaceSession,
  runCodexWorkspaceSession,
} = await import("../dist/runner.js");
const { activeClaudeRuntimes } = await import("../dist/session-state.js");
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

/** Lets a closed fake query's stream, and its runtime's pump, run out. */
async function settle() {
  for (let tick = 0; tick < 20; tick++)
    await new Promise((done) => setImmediate(done));
}

/** The fake Claude processes still running (their input still open). */
const openProcesses = () =>
  calls.filter((call) => call.sdk === "claude" && !call.closed);

test("a runtime reaped as its replacement starts never unregisters the replacement", async () => {
  const cwd = workspace();
  const nativeId = randomUUID();
  claudeTranscript(nativeId);
  calls.length = 0;
  const session = chatSession({ nativeSessionId: nativeId });
  const turn = (prompt) =>
    run(cwd, { ...session, input: { id: randomUUID(), prompt } });
  await turn("first");
  const reaped = [...activeClaudeRuntimes.values()].find(
    (runtime) => runtime.foundrySessionId === session.id,
  );
  // Idle past its TTL: the next turn reaps it and registers its replacement
  // under the same key before the reaped process's stream has ended.
  reaped.lastUsed = 0;
  const second = await turn("second");
  assert.ok(
    second.events.some((event) => event.label === "Started Claude Agent SDK"),
  );
  await settle();
  assert.equal(calls[0].closed, true, "the reaped process's input closed");
  const replacement = activeClaudeRuntimes.get(reaped.key);
  assert.ok(replacement, "the replacement is still registered under the key");
  assert.notEqual(replacement, reaped);
  assert.equal(replacement.closed, false);

  const third = await turn("third");
  assert.ok(
    third.events.some(
      (event) => event.label === "Reused active Claude Agent SDK",
    ),
    "the third turn reuses the replacement",
  );
  assert.equal(calls.length, 2, "two processes in all");
  await settle();
  assert.equal(openProcesses().length, 1, "one process writes the session");
});

test("a busy native owner survives a configuration change; explicit stop allows a new single writer", async () => {
  const cwd = workspace();
  const nativeId = randomUUID();
  claudeTranscript(nativeId);
  calls.length = 0;
  held.add("stays open");
  try {
    const session = chatSession({ nativeSessionId: nativeId });
    const open = run(cwd, {
      ...session,
      input: { id: randomUUID(), prompt: "stays open" },
    }).then(
      () => undefined,
      (error) => error,
    );
    for (let waited = 0; !calls[0]?.prompts.length; waited += 10) {
      if (waited > 5000) throw new Error("the first turn never started");
      await new Promise((done) => setTimeout(done, 10));
    }
    // A different key must not silently preempt a live native owner.
    await assert.rejects(
      run(cwd, {
        ...session,
        model: "claude-other",
        input: { id: randomUUID(), prompt: "changed configuration" },
      }),
      /still working/,
    );
    assert.equal(calls.length, 1);
    assert.notEqual(calls[0].closed, true);
    const { cancelActiveSession } = await import("../dist/session-control.js");
    await cancelActiveSession(session.id);
    assert.match(String((await open)?.message), /canceled/);
    // After an explicit stop, a new process resumes the same native thread.
    const next = await run(cwd, {
      ...session,
      model: "claude-other",
      input: { id: randomUUID(), prompt: "next" },
    });
    assert.equal(next.result.nativeSessionId, nativeId);
    await settle();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.resume, nativeId);
    assert.equal(calls[0].closed, true, "the earlier process was closed");
    assert.equal(openProcesses().length, 1, "one process writes the session");
    // And across a skill-set change, a reap, and the turns after them.
    await run(
      cwd,
      { ...session, input: { id: randomUUID(), prompt: "skills" } },
      { managed: managed("other") },
    );
    for (const runtime of activeClaudeRuntimes.values())
      if (runtime.foundrySessionId === session.id) runtime.lastUsed = 0;
    await run(cwd, { ...session, input: { id: randomUUID(), prompt: "late" } });
    await settle();
    assert.equal(openProcesses().length, 1, "one process writes the session");
    assert.equal(
      [...activeClaudeRuntimes.values()].filter(
        (runtime) => !runtime.closed && runtime.nativeSessionId === nativeId,
      ).length,
      1,
    );
  } finally {
    held.delete("stays open");
  }
});

/** The session's runtime reports background work still running. */
function keepBackgroundRunning(sessionId) {
  const runtime = [...activeClaudeRuntimes.values()].find(
    (candidate) =>
      candidate.foundrySessionId === sessionId && !candidate.closed,
  );
  const hasRunning = runtime.background.hasRunning;
  runtime.background.hasRunning = () => true;
  return () => {
    runtime.background.hasRunning = hasRunning;
  };
}

/** A catalog with one skill: its set is part of the runtime key. */
const withSkill = (set) => ({
  ...managed(set),
  skills: [{ name: "qa", dir: join(root, "skill-sets", set, "skills/qa") }],
});

const notices = (events) =>
  events.filter((event) => event.label === "Notice").map((e) => e.detail);

test("a changed key while background work runs continues on that process and says what waits (DEV-072)", async () => {
  const cwd = workspace();
  const nativeId = randomUUID();
  claudeTranscript(nativeId);
  calls.length = 0;
  const session = chatSession({ nativeSessionId: nativeId });
  await run(cwd, session, { managed: withSkill("catalog-a") });
  const stopBackground = keepBackgroundRunning(session.id);
  try {
    // Only Foundry's setup changed (here the skill catalog).
    const setup = await run(
      cwd,
      { ...session, input: { id: randomUUID(), prompt: "setup changed" } },
      { managed: withSkill("catalog-b") },
    );
    assert.ok(
      setup.events.some((e) => e.label === "Reused active Claude Agent SDK"),
    );
    assert.match(notices(setup.events).join("\n"), /updated setup applies/);
    // The person's own choice changed: named, and not applied yet.
    const model = await run(
      cwd,
      {
        ...session,
        model: "claude-other",
        input: { id: randomUUID(), prompt: "model changed" },
      },
      { managed: withSkill("catalog-b") },
    );
    assert.match(
      notices(model.events).join("\n"),
      /Not applied yet: model default → claude-other/,
    );
    assert.equal(calls.length, 1, "the busy process served every turn");
    assert.notEqual(calls[0].closed, true, "its background work kept running");
    // Another account cannot use that process: refused, work untouched.
    await assert.rejects(
      run(
        cwd,
        { ...session, input: { id: randomUUID(), prompt: "other account" } },
        {
          managed: withSkill("catalog-b"),
          profile: { ...profile, id: "claude_other" },
        },
      ),
      /cannot switch accounts yet/,
    );
    assert.equal(calls.length, 1);
    assert.notEqual(calls[0].closed, true);
  } finally {
    stopBackground();
  }
  // Once that work ended, the next turn starts with the new configuration.
  const after = await run(
    cwd,
    {
      ...session,
      model: "claude-other",
      input: { id: randomUUID(), prompt: "after" },
    },
    { managed: withSkill("catalog-b") },
  );
  assert.ok(after.events.some((e) => e.label === "Started Claude Agent SDK"));
  assert.deepEqual(notices(after.events), []);
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.model, "claude-other");
  assert.equal(calls[0].closed, true);
  assert.equal(openProcesses().length, 1, "one process writes the session");
});

test("a Codex turn that fails mid-stream stops its process", async () => {
  const cwd = workspace();
  calls.length = 0;
  await assert.rejects(
    run(cwd, chatSession({ provider: "codex", model: "fails-midway" }), {
      profile: {
        id: "codex_local",
        runtime: "codex",
        label: "Codex",
        connectionType: "local_login",
      },
    }),
    /midway/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, true, "its process was stopped");
});

test("external Claude archive restoration precedes native presence decision and retains its id", async () => {
  const cwd = workspace();
  const nativeId = randomUUID();
  const adapter = join(root, `resume-adapter-${randomUUID()}.mjs`);
  writeFileSync(
    adapter,
    `import {createInterface} from 'node:readline'; const reader=createInterface({input:process.stdin}); reader.once('line', line=>{const request=JSON.parse(line); console.log(JSON.stringify({protocol:request.protocol,identity:request.identity,environment:{set:{},unset:[]}}));}); reader.on('close',()=>process.exit(0));`,
  );
  const externalProfile = {
    id: `external-resume-${randomUUID()}`,
    runtime: "claude",
    connectionType: "external",
    externalConnection: {
      identity: "synthetic-resume-identity",
      executable: process.execPath,
      args: [adapter],
    },
  };
  const { externalConnectionDataHome } =
    await import("../dist/session-ambient.js");
  const { archiveClaudeSession } = await import("../dist/native-archive.js");
  const home = externalConnectionDataHome(externalProfile);
  const path = join(home, "projects", "synthetic", `${nativeId}.jsonl`);
  mkdirSync(join(home, "projects", "synthetic"), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      sessionId: nativeId,
      cwd,
      type: "user",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "synthetic external resume history" },
    }) + "\n",
  );
  await archiveClaudeSession(home, nativeId, "archived", {
    workspacePath: cwd,
    inUse: async () => false,
  });
  calls.length = 0;
  const { result, events, reported } = await run(
    cwd,
    chatSession({ nativeSessionId: nativeId }),
    { profile: externalProfile },
  );
  assert.equal(calls[0].options.resume, nativeId);
  assert.equal(result.nativeSessionId, nativeId);
  assert.ok(reported.includes(nativeId));
  assert.ok(existsSync(path), "restored before presence check");
  assert.ok(
    !events.some((event) => event.label === "Started a new native session"),
  );
});

test("archived Codex history remains resumable at the native decision boundary", async () => {
  const { prepareNativeSession } = await import("../dist/native-session.js");
  const nativeId = randomUUID(),
    cwd = workspace();
  const archived = join(process.env.CODEX_HOME, "archived_sessions");
  mkdirSync(archived, { recursive: true });
  writeFileSync(
    join(archived, `rollout-2026-10-27T00-00-00-${nativeId}.jsonl`),
    JSON.stringify({ type: "session_meta", payload: { id: nativeId, cwd } }) +
      "\n",
  );
  const prepared = await prepareNativeSession({
    provider: "codex",
    session: chatSession({ provider: "codex", nativeSessionId: nativeId }),
    workspacePath: cwd,
    env: { CODEX_HOME: process.env.CODEX_HOME },
    isolated: false,
    emit: async () => {},
    reportNativeSessionId: () => {},
  });
  assert.deepEqual(prepared.start, {
    kind: "resume",
    nativeSessionId: nativeId,
  });
  assert.equal(prepared.session.nativeSessionId, nativeId);
});

test("Claude runner refuses archived fork sources without native restoration or SDK calls", async () => {
  const { archiveClaudeSession } = await import("../dist/native-archive.js");
  const cwd = workspace();
  const sourceId = randomUUID();
  const home = process.env.CLAUDE_CONFIG_DIR;
  const active = join(home, "projects", "p", `${sourceId}.jsonl`);
  mkdirSync(join(home, "projects", "p"), { recursive: true });
  writeFileSync(
    active,
    JSON.stringify({ type: "user", sessionId: sourceId, cwd }) + "\n",
  );
  await archiveClaudeSession(home, sourceId, "archived", {
    inUse: async () => false,
  });
  calls.length = 0;
  await assert.rejects(
    run(
      cwd,
      chatSession({
        nativeSessionId: randomUUID(),
        forkNativeSessionId: sourceId,
      }),
    ),
    /Cannot fork an archived/,
  );
  assert.equal(calls.length, 0);
  assert.equal(existsSync(active), false);
  assert.equal(
    existsSync(
      join(home, "archived_sessions", "projects", "p", `${sourceId}.jsonl`),
    ),
    true,
  );
});

test("an existing Claude fork target resumes independently of its archived source", async () => {
  const { archiveClaudeSession } = await import("../dist/native-archive.js");
  const cwd = workspace();
  const sourceId = randomUUID();
  const targetId = randomUUID();
  const home = process.env.CLAUDE_CONFIG_DIR;
  const active = join(home, "projects", "p", `${sourceId}.jsonl`);
  mkdirSync(join(home, "projects", "p"), { recursive: true });
  writeFileSync(
    active,
    JSON.stringify({ type: "user", sessionId: sourceId, cwd }) + "\n",
  );
  await archiveClaudeSession(home, sourceId, "archived", {
    inUse: async () => false,
  });
  claudeTranscript(targetId);
  calls.length = 0;
  await run(
    cwd,
    chatSession({ nativeSessionId: targetId, forkNativeSessionId: sourceId }),
  );
  assert.equal(calls[0].options.resume, targetId);
  assert.equal(existsSync(active), false);
});
