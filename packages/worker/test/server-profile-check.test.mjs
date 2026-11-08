import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { providerChecksPath } from "../dist/harness/provider-check-state.js";
import { DaemonDispatch } from "../dist/daemon/dispatch.js";
import { registerAgentHandlers } from "../dist/daemon/handlers/agents.js";

// The server checks a provider it stores by handing the device the
// definition and its key, as run_session does: the device runs one turn
// through Claude Code with them and answers the result, keeping neither.

const root = mkdtempSync(join(tmpdir(), "foundry-server-profile-check-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
const key = "tk-server-held-key-5d1e0c9a7b";
// A home of its own: a device without a ~/.claude yet (CI) gets one made
// for the check, which the test runner forbids in the real home.
const home = join(root, "home");
const realHome = process.env.HOME;
process.env.HOME = home;
test.after(() => {
  process.env.HOME = realHome;
});

/** A Claude Code speaking stream-json that records what it ran with. */
function fakeClaude(t, ok) {
  const seen = join(root, `seen-${ok}.json`);
  const native = join(root, `fake-claude-${ok}`);
  writeFileSync(
    native,
    `#!${process.execPath}
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('2.1.300 (Claude Code)'); process.exit(0); }
const out = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const session_id = 'check-session';
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    return;
  }
  if (message.type !== 'user') return;
  writeFileSync(${JSON.stringify(seen)}, JSON.stringify({
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    token: process.env.ANTHROPIC_AUTH_TOKEN,
    model: process.argv.includes('claude-opus-5-5') || process.env.ANTHROPIC_MODEL === 'claude-opus-5-5' || line.includes('claude-opus-5-5'),
  }));
  out({ type: 'system', subtype: 'init', session_id, cwd: process.cwd(), tools: [], mcp_servers: [], model: 'fixture', permissionMode: 'default', slash_commands: [], apiKeySource: 'none', output_style: 'default', uuid: '00000000-0000-4000-8000-000000000001' });
  const text = ${ok} ? 'OK' : 'invalid x-api-key';
  out({ type: 'assistant', session_id, parent_tool_use_id: null, uuid: '00000000-0000-4000-8000-000000000002', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  out({ type: 'result', subtype: ${ok} ? 'success' : 'error_during_execution', is_error: !${ok}, result: text, errors: ${ok} ? [] : [text], session_id, duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [], uuid: '00000000-0000-4000-8000-000000000003' });
});
`,
  );
  chmodSync(native, 0o755);
  const previous = process.env.FOUNDRY_CLAUDE_BIN;
  process.env.FOUNDRY_CLAUDE_BIN = native;
  t.after(() => {
    if (previous === undefined) delete process.env.FOUNDRY_CLAUDE_BIN;
    else process.env.FOUNDRY_CLAUDE_BIN = previous;
  });
  return () => JSON.parse(readFileSync(seen, "utf8"));
}

async function check(payload) {
  const dispatch = new DaemonDispatch();
  registerAgentHandlers(dispatch);
  let resolveReply;
  const replied = new Promise((resolve) => (resolveReply = resolve));
  const ctx = {
    socket: {
      readyState: 1,
      send: (data) => resolveReply(JSON.parse(data)),
    },
    roster: { currentRegistration: () => ({ device: { id: "dev" } }) },
  };
  await dispatch.dispatch(
    { id: "c1", type: "check_agent_profile", payload },
    ctx,
  );
  return replied;
}

const definition = {
  id: "prof_relay",
  runtime: "claude",
  label: "Relay",
  authMode: "custom",
  connectionType: "anthropic_compatible",
  baseUrl: "https://relay.example",
  model: "claude-opus-5-5",
  hasCredential: true,
  updatedAtLabel: "now",
};

test("a server profile is checked through Claude Code with its endpoint and key", async (t) => {
  const seen = fakeClaude(t, true);
  const before = existsSync(providerChecksPath())
    ? readFileSync(providerChecksPath(), "utf8")
    : undefined;
  const reply = await check({ profile: definition, credential: key });
  assert.equal(reply.type, "agent_profile_checked");
  assert.equal(reply.id, "c1");
  assert.equal(reply.payload.result.status, "passed", JSON.stringify(reply));
  assert.ok(reply.payload.result.checkedAt);
  assert.deepEqual(seen(), {
    baseUrl: "https://relay.example",
    token: key,
    model: true,
  });
  assert.ok(!JSON.stringify(reply).includes(key));
  // The server records the result; the device keeps none of it.
  const after = existsSync(providerChecksPath())
    ? readFileSync(providerChecksPath(), "utf8")
    : undefined;
  assert.equal(after, before);
});

test("a failed check answers the agent's words, never the key", async (t) => {
  fakeClaude(t, false);
  const reply = await check({ profile: definition, credential: key });
  assert.equal(reply.payload.result.status, "failed");
  assert.match(reply.payload.result.message, /invalid x-api-key/);
  assert.ok(!JSON.stringify(reply).includes(key));
});

test("a check without a profile is refused", async () => {
  const reply = await check({});
  assert.match(reply.payload.error, /requires profile/);
});
