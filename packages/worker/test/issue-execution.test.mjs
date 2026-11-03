import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ExecutionStore } from "../dist/candidate-store/execution-storage.js";
import { git, gitCommit } from "../dist/candidate-store/execution-git.js";
import { executeAgentSession } from "../dist/daemon/session-execution.js";
import { executeIssue } from "../dist/issue/issue-execution.js";
import {
  recordedIssueCompletion,
  recoveredIssueCompletion,
} from "../dist/issue/issue-recovery.js";
import { writeJSON } from "../dist/platform/storage.js";
import { sandboxAvailable } from "../dist/sandbox/index.js";
import {
  cancelActiveSession,
  steerActiveSessionOnce,
} from "../dist/session/session-control.js";

// An Issue's execution is an ordinary session: it reports through the
// session's messages and is steered and canceled by its session id.

const sandboxed = { skip: !sandboxAvailable("writable_tree"), timeout: 30_000 };

test("mock runs reuse one Issue environment and archive each attempt outside source", async (t) => {
  const workspace = await fixture(t);
  const issue = confirmedIssue("mock");
  const first = await execute(workspace, issue);
  const second = await execute(workspace, {
    ...issue,
    checks: ["Changes requested"],
  });
  const completions = [first, second].map((run) => run.completed().issueResult);
  for (const completion of completions)
    assert.equal(completion.error, undefined, completion.error);
  assert.notEqual(completions[0].runId, completions[1].runId);
  assert.equal(completions[0].environmentId, completions[1].environmentId);
  assert.equal(
    existsSync(resolve(workspace.source, `foundry-result-${issue.id}.md`)),
    false,
  );
});

test("an Issue execution reports through its session and its result can be recovered", async (t) => {
  const workspace = await fixture(t);
  const { store } = workspace;
  const issue = confirmedIssue("mock");
  const run = await execute(workspace, issue);
  const { session, sent } = run;
  assert.deepEqual(sent[0], {
    type: "session_started",
    payload: { sessionId: session.id, inputId: session.input.id },
  });
  const events = sent.filter((message) => message.type === "session_event");
  assert.ok(events.length > 0);
  assert.ok(
    events.every((message) => message.payload.event.sessionId === session.id),
  );
  const completed = sent.at(-1);
  assert.equal(completed.type, "session_completed");
  assert.equal(completed.payload.sessionId, session.id);
  assert.equal(completed.payload.inputId, session.input.id);
  assert.equal(completed.payload.error, undefined);
  assert.equal(completed.payload.issueResult.runId, session.id);
  assert.ok(completed.payload.issueResult.environmentId);

  // A lost report is replayed from the attempt's record, not run again.
  assert.deepEqual(
    recordedIssueCompletion("ws_test", issue.id, session.id, store),
    JSON.parse(JSON.stringify(completed.payload.issueResult)),
  );
  assert.equal(
    recoveredIssueCompletion("ws_test", issue.id, "sess_other", store),
    undefined,
  );
  // An attempt that stopped mid-run is reported as interrupted, keeping
  // its candidate for a retry.
  const environment = store.environment("ws_test", issue.id);
  const interrupted = store.runDirectory(environment, "sess_crashed");
  mkdirSync(interrupted, { recursive: true });
  writeJSON(resolve(interrupted, "run.json"), { id: "sess_crashed" });
  const recovered = recoveredIssueCompletion(
    "ws_test",
    issue.id,
    "sess_crashed",
    store,
  );
  assert.match(recovered.error, /Worker process stopped/);
  assert.equal(recovered.environmentId, environment.id);
  assert.equal(store.environment("ws_test", issue.id).status, "failed");
});

test("a cancel that reaches an execution before it starts reports a canceled result", async (t) => {
  const workspace = await fixture(t);
  const session = executionSession(confirmedIssue("mock"));
  await cancelActiveSession(session.id, session.input.id);
  const run = await execute(workspace, confirmedIssue("mock"), { session });
  assert.equal(run.sent[0].type, "session_started");
  const completed = run.completed();
  assert.equal(completed.issueResult.canceled, true);
  assert.match(completed.issueResult.error, /canceled/);
  assert.equal(
    existsSync(
      resolve(
        workspace.store.environment("ws_test", "iss_exec")?.cwd ?? "/none",
        "foundry-result-iss_exec.md",
      ),
    ),
    false,
    "a canceled execution never runs",
  );
});

for (const runtime of ["claude", "codex"]) {
  test(
    `a running ${runtime} execution is steered and canceled through its session`,
    sandboxed,
    async (t) => {
      const workspace = await fixture(t);
      useFakeRuntime(t, workspace, runtime);
      const issue = confirmedIssue(runtime);
      const profile = { runtime, id: "fixture" };

      const steered = start(workspace, issue, { profile });
      await steerWhenRunning(steered.session, "Focus on the mobile layout");
      await steered.done;
      const answer = steered.completed();
      assert.equal(answer.error, undefined, answer.error);
      assert.match(answer.response, /Steered: Focus on the mobile layout/);
      assert.equal(answer.issueResult.canceled, false);
      assert.equal(answer.issueResult.runId, steered.session.id);

      const canceled = start(workspace, { ...issue, checks: [] }, { profile });
      await untilRunning(canceled);
      const outcome = await cancelActiveSession(
        canceled.session.id,
        canceled.session.input.id,
      );
      assert.equal(outcome.pending, true);
      await canceled.done;
      const stopped = canceled.completed();
      assert.equal(stopped.issueResult.canceled, true);
      assert.ok(
        canceled.sent.some(
          (message) => message.payload.event?.label === "Session canceled",
        ),
      );
      // Its candidate stays for the next execution.
      assert.equal(
        stopped.issueResult.environmentId,
        answer.issueResult.environmentId,
      );
    },
  );
}

test(
  "real executor boundary prepares a repository between turns",
  sandboxed,
  async (t) => {
    const workspace = await fixture(t);
    const { source, store } = workspace;
    const toolPath = resolve(
      import.meta.dirname,
      "../dist/issue/repository-tool.js",
    );
    const script = resolve(source, ".foundry/probe.mjs");
    writeFileSync(
      script,
      `import { existsSync, writeFileSync } from 'node:fs';\nimport { execFileSync } from 'node:child_process';\nimport { resolve } from 'node:path';\nprocess.stdin.resume();\nprocess.stdin.on('end', () => {\nconst tool = ${JSON.stringify(toolPath)};\nconst repos = JSON.parse(execFileSync(process.execPath, [tool, 'list'], {encoding:'utf8'}));\nconst repo = repos.find(r => r.relativePath === 'repos/backend');\nif (!existsSync(resolve('repos/backend/.git'))) {\n console.log(execFileSync(process.execPath, [tool, 'prepare', repo.id], {encoding:'utf8'}));\n} else {\n writeFileSync(resolve('repos/backend/code.txt'), 'executor candidate\\n');\n let denied = false; try { writeFileSync(resolve(process.env.FOUNDRY_ROOT_WORKSPACE, 'AGENTS.md'), 'bad'); } catch { denied = true; }\n if (!denied) process.exit(3);\n console.log('Changed backend and verified original is read-only.');\n}\n});\n`,
    );
    // A fake Claude Code that speaks the Agent SDK's stream-json protocol,
    // so the executor's real launch path and sandbox are exercised.
    useFakeClaude(
      t,
      workspace,
      `const child = spawnSync(process.execPath, [${JSON.stringify(script)}], { encoding: 'utf8', input: '' });
  answer((child.stdout || child.stderr || '').trim(), child.status === 0);`,
    );
    const run = await execute(workspace, confirmedIssue("claude"), {
      profile: { runtime: "claude", id: "fixture" },
    });
    const completed = run.completed();
    assert.equal(completed.error, undefined, completed.error);
    assert.match(completed.response, /Changed backend/);
    assert.ok(
      run.sent.some(
        (message) => message.payload.event?.label === "Repository prepared",
      ),
    );
    assert.equal(
      readFileSync(resolve(source, "repos/backend/code.txt"), "utf8"),
      "baseline\n",
    );
    const environment = store.environment("ws_test", "iss_exec");
    assert.equal(environment.repositories.length, 2);
    assert.equal(
      readFileSync(resolve(environment.cwd, "repos/backend/code.txt"), "utf8"),
      "executor candidate\n",
    );
  },
);

/** A workspace with a nested repository the execution may prepare. */
async function fixture(t) {
  const directory = mkdtempSync(resolve(tmpdir(), "foundry-execution-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = resolve(directory, "source");
  mkdirSync(resolve(source, "repos/backend"), { recursive: true });
  await repository(source, {
    "AGENTS.md": "Shared workspace guidance",
    ".gitignore": ".foundry/\nrepos/\n",
  });
  await repository(resolve(source, "repos/backend"), {
    "code.txt": "baseline\n",
  });
  mkdirSync(resolve(source, ".foundry"));
  writeJSON(resolve(source, ".foundry/workspace.json"), {
    id: "ws_test",
    path: source,
    name: "Test",
    baseline: "main",
    schemaVersion: 1,
  });
  return {
    directory,
    source,
    store: new ExecutionStore(resolve(directory, "state")),
  };
}

async function repository(path, files) {
  await git(path, ["init", "-b", "main"]);
  for (const [name, text] of Object.entries(files))
    writeFileSync(resolve(path, name), text);
  await git(path, ["add", "."]);
  await gitCommit(path, "Baseline");
}

function confirmedIssue(runtime) {
  const actor = { kind: "local_owner", id: "owner", displayName: "Owner" };
  const digest = `sha256:${"a".repeat(64)}`;
  const content = JSON.parse(
    readFileSync(
      new URL("../../protocol/test/evidence-fixtures.json", import.meta.url),
      "utf8",
    ),
  ).find((item) => item.name === "observable agent criterion").value;
  return {
    id: "iss_exec",
    contractState: "confirmed",
    currentContractRevision: 1,
    workspaceId: "ws_test",
    shortId: "ISS-exec",
    title: "Write",
    sourceInput: "Write report",
    runtime,
    skills: [],
    acceptanceCriteria: [],
    checks: [],
    executionContract: {
      ...content,
      schemaVersion: 1,
      id: "contract_exec",
      workspaceId: "ws_test",
      issueId: "iss_exec",
      revision: 1,
      origin: "user",
      createdAt: "2026-09-10T00:00:00Z",
      createdBy: actor,
      contentDigest: digest,
      status: "confirmed",
      confirmation: {
        actor,
        at: "2026-09-10T00:00:00Z",
        contentDigest: digest,
      },
    },
  };
}

/** The issue_execution session the server dispatches for the Issue. */
function executionSession(issue) {
  const id = `sess_${randomUUID()}`;
  return {
    id,
    threadId: id,
    workspaceId: issue.workspaceId,
    issueId: issue.id,
    role: "issue_execution",
    source: "issue",
    agentId: "",
    deviceId: "dev_test",
    provider: issue.runtime,
    status: "queued",
    title: issue.title,
    prompt: `Implement ${issue.shortId}`,
    input: {
      id: `input_${randomUUID()}`,
      prompt: `Implement ${issue.shortId}`,
    },
    skillRefs: [],
    createdLabel: "now",
    updatedLabel: "now",
  };
}

/** Runs the execution as the daemon does, recording what it reports. */
function start(
  workspace,
  issue,
  { session = executionSession(issue), profile } = {},
) {
  const sent = [];
  const transport = { send: (type, payload) => sent.push({ type, payload }) };
  const ambient = {
    serverURL: "",
    sessionToken: "",
    workspaceID: issue.workspaceId,
  };
  const done = executeIssue(
    "",
    workspace.source,
    { session, issue },
    ambient,
    (role) =>
      executeAgentSession(
        transport,
        session,
        role,
        undefined,
        profile,
        ambient,
      ),
    workspace.store,
  );
  return {
    session,
    sent,
    done,
    completed: () =>
      sent.findLast((message) => message.type === "session_completed")?.payload,
  };
}

async function execute(workspace, issue, options) {
  const run = start(workspace, issue, options);
  await run.done;
  return run;
}

/** Steers as the server does, once the running session takes input. */
async function steerWhenRunning(session, message) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      return await steerActiveSessionOnce(
        session.id,
        `steer_${randomUUID()}`,
        message,
      );
    } catch (error) {
      if (!/not accepting/i.test(String(error)) || Date.now() > deadline)
        throw error;
      await new Promise((done) => setTimeout(done, 50));
    }
  }
}

/** Until the agent's own process reported (it runs, and can be stopped). */
async function untilRunning(run) {
  const deadline = Date.now() + 15_000;
  while (
    !run.sent.some(
      (message) => message.payload.event?.label === "Loaded workspace",
    )
  ) {
    if (Date.now() > deadline) throw new Error("the execution never started");
    await new Promise((done) => setTimeout(done, 50));
  }
}

/**
 * A native runtime that answers only what is steered into its turn: an
 * execution waits for its steer, or for its cancel.
 */
function useFakeRuntime(t, workspace, runtime) {
  if (runtime === "claude")
    return useFakeClaude(
      t,
      workspace,
      `if (turns > 1) answer('Steered: ' + text, true);`,
    );
  const native = resolve(workspace.directory, "fake-codex");
  writeFileSync(
    native,
    `#!${process.execPath}
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (x) => process.stdout.write(JSON.stringify(x) + '\\n');
if (process.argv.includes('--version')) { console.log('codex-cli 0.166.0'); process.exit(0); }
rl.on('line', (line) => {
  const r = JSON.parse(line);
  if (r.id === undefined) return;
  const reply = (result) => send({ id: r.id, result });
  if (r.method === 'skills/list') return reply({ data: [{ skills: [], errors: [] }] });
  if (r.method === 'thread/start' || r.method === 'thread/resume') return reply({ thread: { id: 'native-execution' } });
  if (r.method === 'turn/start') { reply({ turn: { id: 'turn' } }); return send({ method: 'turn/started', params: { threadId: 'native-execution', turn: { id: 'turn' } } }); }
  if (r.method === 'turn/steer') {
    reply({});
    const text = r.params.input.map((part) => part.text ?? '').join('');
    send({ method: 'item/completed', params: { threadId: 'native-execution', turnId: 'turn', item: { id: 'answer', type: 'agentMessage', text: 'Steered: ' + text, phase: 'final_answer' } } });
    return send({ method: 'turn/completed', params: { threadId: 'native-execution', turn: { id: 'turn', status: 'completed' } } });
  }
  reply({});
});
`,
    { mode: 0o755 },
  );
  setEnv(t, "FOUNDRY_CODEX_BIN", native);
}

/** A Claude Code speaking stream-json; `onMessage` sees each user `text`. */
function useFakeClaude(t, workspace, onMessage) {
  const native = resolve(workspace.directory, "fake-claude");
  writeFileSync(
    native,
    `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('2.1.300 (Claude Code)'); process.exit(0); }
const out = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const session_id = 'fixture-session';
let turns = 0;
const answer = (text, ok) => {
  out({ type: 'assistant', session_id, parent_tool_use_id: null, uuid: '00000000-0000-4000-8000-000000000002', message: { id: 'msg_' + turns, type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  out({ type: 'result', subtype: ok ? 'success' : 'error_during_execution', is_error: !ok, result: text, errors: ok ? [] : [text || 'probe failed'], session_id, duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [], uuid: '00000000-0000-4000-8000-000000000003' });
};
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    return;
  }
  if (message.type !== 'user') return;
  const content = message.message?.content;
  const text = typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('');
  if (turns++ === 0) out({ type: 'system', subtype: 'init', session_id, cwd: process.cwd(), tools: [], mcp_servers: [], model: 'fixture', permissionMode: 'default', slash_commands: [], apiKeySource: 'none', output_style: 'default', uuid: '00000000-0000-4000-8000-000000000001' });
  ${onMessage}
});
`,
  );
  chmodSync(native, 0o755);
  setEnv(t, "FOUNDRY_CLAUDE_BIN", native);
}

function setEnv(t, key, value) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}
