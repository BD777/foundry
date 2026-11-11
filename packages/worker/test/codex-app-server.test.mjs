import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexAppServerThread,
  appServerItem,
  codexCompactionContinuation,
  codexCompactionNotice,
  codexProviderArguments,
  codexProviderForkNotice,
} from "../dist/session/runner/codex-app-server.js";
function fixture(t, mode = "normal", options = {}) {
  const root = mkdtempSync(join(tmpdir(), "foundry-app-server-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "codex");
  writeFileSync(
    bin,
    `#!${process.execPath}
const rl=require('node:readline').createInterface({input:process.stdin});
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const notify=(method,params)=>send({method,params:{threadId:process.env.MODE==='provider-moved'?'forked':'native',...params}});
let refreshed=false;
let foundryMcp='failed';
rl.on('line',l=>{const r=JSON.parse(l);if(!r.id)return;const reply=result=>send({id:r.id,result});
if(r.method==='initialize')return reply({});
if(r.method==='mcpServerStatus/list')return reply({data:[{name:'foundry',runtimeStatus:foundryMcp,authStatus:'bearerToken'}]});
if(r.method==='config/mcpServer/reload'){foundryMcp='connected';reply({});return notify('mcpServer/startupStatus/updated',{name:'foundry',status:'ready'});}
if(r.method==='thread/resume'&&process.env.MODE==='provider-moved')return send({id:r.id,error:{code:-32600,message:'This chat uses foundry_a, but your current provider is foundry_b.',data:{type:'modelProviderMismatch'}}});
if(r.method==='thread/fork')return reply({thread:{id:r.params.threadId==='native'&&r.params.config.model_provider==='foundry_b'?'forked':'wrong'}});
if(r.method==='thread/start'||r.method==='thread/resume'){if(process.env.MODE==='hang-start')return;if(process.env.MODE==='slow-start')return setTimeout(()=>reply({thread:{id:'native'}}),80);const result=reply({thread:{id:'native'}});if(r.params.config?.mcp_servers?.foundry)setTimeout(()=>notify('mcpServer/startupStatus/updated',{name:'foundry',status:'failed',error:'connect refused'}),25);return result;}
if(r.method==='thread/inject_items'){if(process.env.MODE==='refresh-rejected')return send({id:r.id,error:{message:'refresh rejected'}});const item=r.params.items[0];refreshed=r.params.threadId==='native'&&item.role==='developer'&&item.content[0].text==='CURRENT_CATALOG';return reply({});}
if(process.env.MODE.startsWith('overflow')){globalThis.calls=(globalThis.calls||[]);globalThis.calls.push(r.method);const full={message:"Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",codexErrorInfo:'contextWindowExceeded'};const starts=globalThis.calls.filter(m=>m==='turn/start').length;
if(r.method==='turn/start'){const id='turn-'+starts;notify('turn/started',{turn:{id}});reply({turn:{id}});if(starts===1||process.env.MODE==='overflow-twice')return notify('turn/completed',{turn:{id,status:'failed',error:full}});notify('item/completed',{turnId:id,item:{id:'answer',type:'agentMessage',text:'CONTINUED:'+r.params.input[0].text,phase:'final_answer'}});return notify('turn/completed',{turn:{id,status:'completed'}});}
if(r.method==='thread/compact/start'){if(process.env.MODE==='overflow-compact-rejected')return send({id:r.id,error:{message:'compact refused'}});reply({});notify('turn/started',{turn:{id:'compact-1'}});notify('item/started',{turnId:'compact-1',item:{id:'c',type:'contextCompaction'}});notify('item/completed',{turnId:'compact-1',item:{id:'c',type:'contextCompaction'}});return notify('turn/completed',{turn:{id:'compact-1',status:process.env.MODE==='overflow-compact-fails'?'failed':'completed',...(process.env.MODE==='overflow-compact-fails'?{error:full}:{})}});}}
if(r.method==='turn/start'&&process.env.MODE==='schema'){notify('turn/started',{turn:{id:'turn-1'}});reply({turn:{id:'turn-1'}});notify('item/completed',{turnId:'turn-1',item:{id:'answer',type:'agentMessage',text:JSON.stringify(r.params.outputSchema??null),phase:'final_answer'}});return notify('turn/completed',{turn:{id:'turn-1',status:'completed'}});}
if(r.method==='turn/start'&&process.env.MODE==='provider-check'&&!process.argv.includes('model_provider="foundry_x"'))return send({id:r.id,error:{message:'This chat uses foundry_x, but your current provider is openai.'}});
if(r.method==='turn/start'&&process.env.MODE==='usage-multi'){notify('turn/started',{turn:{id:'turn-usage'}});reply({turn:{id:'turn-usage'}});const at=(ms,fn)=>setTimeout(fn,ms);
at(40,()=>notify('thread/tokenUsage/updated',{tokenUsage:{last:{inputTokens:10,cachedInputTokens:3,cacheWriteInputTokens:1,outputTokens:4,reasoningOutputTokens:1,totalTokens:14},total:{inputTokens:10,cachedInputTokens:3,cacheWriteInputTokens:1,outputTokens:4,reasoningOutputTokens:1,totalTokens:14}}}));
at(90,()=>notify('item/completed',{turnId:'turn-usage',item:{id:'tool-1',type:'commandExecution',command:'one'}}));
at(140,()=>notify('thread/tokenUsage/updated',{tokenUsage:{last:{inputTokens:20,cachedInputTokens:6,cacheWriteInputTokens:1,outputTokens:6,reasoningOutputTokens:2,totalTokens:26},total:{inputTokens:30,cachedInputTokens:9,cacheWriteInputTokens:2,outputTokens:10,reasoningOutputTokens:3,totalTokens:40}}}));
at(190,()=>notify('item/completed',{turnId:'turn-usage',item:{id:'tool-2',type:'commandExecution',command:'two'}}));
at(240,()=>notify('thread/tokenUsage/updated',{tokenUsage:{last:{inputTokens:30,cachedInputTokens:9,cacheWriteInputTokens:1,outputTokens:9,reasoningOutputTokens:3,totalTokens:39},total:{inputTokens:60,cachedInputTokens:18,cacheWriteInputTokens:3,outputTokens:19,reasoningOutputTokens:6,totalTokens:79}}}));
at(280,()=>{notify('item/completed',{turnId:'turn-usage',item:{id:'answer',type:'agentMessage',text:'finished',phase:'final_answer'}});notify('turn/completed',{turn:{id:'turn-usage',status:'completed'}});});return;}
if(r.method==='turn/start'&&process.env.MODE==='usage-late'){notify('turn/started',{turn:{id:'turn-late'}});reply({turn:{id:'turn-late'}});const at=(ms,fn)=>setTimeout(fn,ms);
at(60,()=>notify('item/completed',{turnId:'turn-late',item:{id:'tool-late',type:'commandExecution',command:'slow'}}));
at(150,()=>notify('thread/tokenUsage/updated',{tokenUsage:{last:{inputTokens:10,cachedInputTokens:3,outputTokens:4,totalTokens:14},total:{inputTokens:10,cachedInputTokens:3,outputTokens:4,totalTokens:14}}}));
at(220,()=>notify('thread/tokenUsage/updated',{tokenUsage:{last:{inputTokens:20,cachedInputTokens:6,outputTokens:6,totalTokens:26},total:{inputTokens:30,cachedInputTokens:9,outputTokens:10,totalTokens:40}}}));
at(260,()=>{notify('item/completed',{turnId:'turn-late',item:{id:'answer',type:'agentMessage',text:'finished',phase:'final_answer'}});notify('turn/completed',{turn:{id:'turn-late',status:'completed'}});});return;}
if(r.method==='turn/start'&&process.env.MODE==='terminal-ws-405'){notify('turn/started',{turn:{id:'turn-1'}});reply({turn:{id:'turn-1'}});return notify('turn/completed',{turn:{id:'turn-1',status:'failed',error:{message:'unexpected status 405 Method Not Allowed: Method Not Allowed, url: wss://tokenhub.example/v1/responses',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:405}}}}});}
if(r.method==='turn/start'&&process.env.MODE==='usage-timeline'){const base=Date.now();notify('turn/started',{turn:{id:'turn-timeline',startedAtMs:base}});reply({turn:{id:'turn-timeline'}});
notify('item/started',{turnId:'turn-timeline',item:{id:'reasoning-1',type:'reasoning',startedAtMs:base+2000}});
notify('item/completed',{turnId:'turn-timeline',item:{id:'reasoning-1',type:'reasoning',completedAtMs:base+4000}});
notify('item/completed',{turnId:'turn-timeline',item:{id:'commentary-1',type:'agentMessage',phase:'commentary',text:'working',completedAtMs:base+4500}});
notify('item/started',{turnId:'turn-timeline',item:{id:'tool-1',type:'commandExecution',startedAtMs:base+5000}});
notify('item/started',{turnId:'turn-timeline',item:{id:'tool-2',type:'commandExecution',startedAtMs:base+5200}});
notify('item/completed',{turnId:'turn-timeline',item:{id:'tool-1',type:'commandExecution',completedAtMs:base+12000}});
notify('item/completed',{turnId:'turn-timeline',item:{id:'tool-2',type:'commandExecution',completedAtMs:base+15000}});
notify('thread/tokenUsage/updated',{tokenUsage:{last:{inputTokens:100,cachedInputTokens:80,outputTokens:1500,totalTokens:1600},total:{inputTokens:100,cachedInputTokens:80,outputTokens:1500,totalTokens:1600}}});
notify('item/started',{turnId:'turn-timeline',item:{id:'reasoning-2',type:'reasoning',startedAtMs:base+16000}});
notify('item/completed',{turnId:'turn-timeline',item:{id:'reasoning-2',type:'reasoning',completedAtMs:base+18000}});
notify('item/completed',{turnId:'turn-timeline',item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'finished',completedAtMs:base+19000}});
notify('thread/tokenUsage/updated',{tokenUsage:{last:{inputTokens:200,cachedInputTokens:180,outputTokens:800,totalTokens:1000},total:{inputTokens:300,cachedInputTokens:260,outputTokens:2300,totalTokens:2600}}});
notify('turn/completed',{turn:{id:'turn-timeline',status:'completed'}});return;}
if(r.method==='turn/start'){if(process.env.MODE==='refresh-required'&&!refreshed)return send({id:r.id,error:{message:'stale catalog reached execution'}});if(process.env.MODE.startsWith('compact')){notify('turn/started',{turn:{id:'turn-1'}});reply({turn:{id:'turn-1'}});notify('thread/compacted',{});setTimeout(()=>notify('turn/completed',{turn:{id:'turn-1',status:'completed'}}),50);return;}notify('item/started',{item:{id:'user',type:'userMessage',content:[{text:'internal execution prompt'}]}});notify('turn/started',{turn:{id:'turn-1'}});reply({turn:{id:'turn-1'}});notify('item/started',{turnId:'turn-1',item:{id:'msg',type:'agentMessage',text:'',phase:'commentary'}});notify('item/agentMessage/delta',{turnId:'turn-1',itemId:'msg',delta:'Working'});return;}
if(r.method==='turn/steer'){if(process.env.MODE==='compact-pending'){notify('turn/completed',{turn:{id:'turn-1',status:'completed'}});return;}if(r.params.input[0].text==='no acknowledgement')return;if(r.params.expectedTurnId!=='turn-1')return send({id:r.id,error:{message:'wrong turn'}});if(process.env.MODE==='crash')return process.exit(1);reply({turnId:'turn-1'});notify('item/completed',{turnId:'turn-1',item:{id:'answer',type:'agentMessage',text:r.params.input[0].text,phase:'final_answer'}});notify('thread/tokenUsage/updated',{tokenUsage:{last:{inputTokens:42,cachedInputTokens:2,outputTokens:8}}});notify('turn/completed',{turn:{id:'turn-1',status:'completed'}});return;}
if(r.method==='turn/interrupt'){reply({});notify('turn/completed',{turn:{id:'turn-1',status:'interrupted'}});}
});`,
    { mode: 0o700 },
  );
  return new CodexAppServerThread(
    bin,
    { ...process.env, MODE: mode, FOUNDRY_SESSION_ID: options.sessionId || "" },
    options.config ?? {},
    {
      workingDirectory: root,
      approvalPolicy: "never",
      sandboxMode: "read-only",
      ...options,
    },
    options.nativeSessionId,
  );
}

test("a Codex MCP failure reconnects through the app-server protocol", async (t) => {
  const { clearOutOfBandSessionEventSink, setOutOfBandSessionEventSink } =
    await import("../dist/session/session-state.js");
  const { reconnectRegisteredFoundryTools } =
    await import("../dist/session/runner/foundry-tools-supervisor.js");
  const events = [];
  const sink = (sessionId, event) => events.push({ sessionId, ...event });
  setOutOfBandSessionEventSink(sink);
  t.after(() => clearOutOfBandSessionEventSink(sink));

  const thread = fixture(t, "normal", {
    workSessionId: "sess_codex_mcp",
    config: {
      mcp_servers: {
        foundry: { url: "http://127.0.0.1/api/mcp" },
      },
    },
  });
  t.after(() => thread.close());
  const { events: turnEvents } = await thread.runStreamed("start");
  const waitForLabel = async (label) => {
    const deadline = Date.now() + 1_000;
    while (!events.some((event) => event.label === label)) {
      if (Date.now() >= deadline) throw new Error(`${label} did not arrive`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  await waitForLabel("Foundry tools unavailable");
  await reconnectRegisteredFoundryTools();
  await waitForLabel("Foundry tools reconnected");
  await thread.steer("finish");
  for await (const _event of turnEvents) {
    // Drain the turn so its process closes before the test ends.
  }
  assert.deepEqual(
    events.map((event) => [event.label, event.sessionId]),
    [
      ["Foundry tools unavailable", "sess_codex_mcp"],
      ["Foundry tools reconnected", "sess_codex_mcp"],
    ],
  );
});

test("same native owner steers the exact turn, retaining phases and usage", async (t) => {
  const thread = fixture(t);
  const { events } = await thread.runStreamed("start");
  await thread.steer("changed", "input-2");
  const seen = [];
  for await (const e of events) seen.push(e);
  assert.equal(thread.id, "native");
  assert.ok(!seen.some((e) => e.item?.type === "userMessage"));
  assert.ok(
    seen.some(
      (e) => e.item?.phase === "commentary" && e.item.text === "Working",
    ),
  );
  assert.ok(seen.some((e) => e.item?.text === "changed"));
  assert.equal(seen.at(-1).type, "turn.completed");
  assert.deepEqual(seen.at(-1).usage, {
    input_tokens: 42,
    cached_input_tokens: 2,
    cache_write_input_tokens: 0,
    output_tokens: 8,
    reasoning_output_tokens: 0,
  });
  assert.equal(seen.at(-1).timing.timingEstimated, true);
  await assert.rejects(thread.steer("late"), /not accepting/);
});

test("a turn sums every token usage update and emits three request records", async (t) => {
  const thread = fixture(t, "usage-multi");
  const { events } = await thread.runStreamed("start");
  const seen = [];
  for await (const event of events) seen.push(event);

  const requests = seen
    .filter((event) => event.type === "foundry.model_request_usage")
    .map((event) => event.requestUsage);
  assert.equal(requests.length, 3);
  assert.deepEqual(
    requests.map((request) => request.requestId),
    ["turn-usage:1", "turn-usage:2", "turn-usage:3"],
  );
  assert.deepEqual(
    requests.map((request) => [
      request.inputTokens,
      request.cacheReadTokens,
      request.cacheWriteTokens,
      request.outputTokens,
    ]),
    [
      [10, 3, 1, 4],
      [20, 6, 1, 6],
      [30, 9, 1, 9],
    ],
  );
  for (const request of requests) {
    assert.equal(request.timingEstimated, true);
    assert.equal(request.firstTokenMs, undefined);
    assert.equal(request.generationMs, undefined);
    assert.equal(request.requestMs, undefined);
  }
  assert.equal(seen.at(-1).type, "turn.completed");
  assert.deepEqual(seen.at(-1).usage, {
    input_tokens: 60,
    cached_input_tokens: 18,
    cache_write_input_tokens: 3,
    output_tokens: 19,
    reasoning_output_tokens: 6,
  });
});

test("a delayed token usage update keeps tokens without inventing timing", async (t) => {
  const thread = fixture(t, "usage-late");
  const { events } = await thread.runStreamed("start");
  const seen = [];
  for await (const event of events) seen.push(event);

  const requests = seen
    .filter((event) => event.type === "foundry.model_request_usage")
    .map((event) => event.requestUsage);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].requestMs, undefined);
  assert.equal(requests[1].requestMs, undefined);
  assert.equal(requests[0].inputTokens, 10);
  assert.equal(requests[1].inputTokens, 20);
  assert.deepEqual(seen.at(-1).usage, {
    input_tokens: 30,
    cached_input_tokens: 9,
    cache_write_input_tokens: 0,
    output_tokens: 10,
    reasoning_output_tokens: 0,
  });
});

test("a replayed item timeline gives usage updates their response time", async (t) => {
  const thread = fixture(t, "usage-timeline");
  const { events } = await thread.runStreamed("start");
  const seen = [];
  for await (const event of events) seen.push(event);

  const requests = seen
    .filter((event) => event.type === "foundry.model_request_usage")
    .map((event) => event.requestUsage);
  assert.deepEqual(
    requests.map((request) => request.requestMs),
    [5200, 4000],
  );
  assert.deepEqual(
    requests.map((request) => request.outputTokens),
    [1500, 800],
  );
  for (const request of requests) {
    const speed = request.outputTokens / (request.requestMs / 1000);
    assert.ok(speed >= 50 && speed <= 300, `speed was ${speed} tok/s`);
  }
  assert.deepEqual(seen.at(-1).usage, {
    input_tokens: 300,
    cached_input_tokens: 260,
    cache_write_input_tokens: 0,
    output_tokens: 2300,
    reasoning_output_tokens: 0,
  });
});
test("an output schema reaches Codex's turn/start as its native structured output", async (t) => {
  const schema = { type: "object", required: ["verdict"] };
  const answers = [];
  for (const outputSchema of [schema, undefined]) {
    const { events } = await fixture(t, "schema").runStreamed("judge", {
      outputSchema,
    });
    for await (const e of events)
      if (e.item?.type === "agent_message")
        answers.push(JSON.parse(e.item.text));
  }
  assert.deepEqual(answers, [schema, null]);
});
test("lost native acknowledgement remains unknown", async (t) => {
  const thread = fixture(t, "crash");
  const { events } = await thread.runStreamed("start");
  await assert.rejects(
    thread.steer("maybe applied"),
    (e) => e.name === "ControlOutcomeUnknownError",
  );
  await assert.rejects(async () => {
    for await (const e of events) {
    }
  }, /exited/);
});
test("cancellation ends a quiet turn", async (t) => {
  const thread = fixture(t);
  const controller = new AbortController();
  const { events } = await thread.runStreamed("start", {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(async () => {
    for await (const e of events) {
    }
  }, /interrupted/);
});
test("tool mapping retains outcomes", () => {
  assert.equal(
    appServerItem({ type: "commandExecution", exitCode: 3 }).exit_code,
    3,
  );
  assert.deepEqual(
    appServerItem({
      type: "fileChange",
      changes: [{ path: "a", kind: { type: "add" } }],
    }).changes,
    [{ path: "a", kind: "add" }],
  );
});

test("a terminal turn preserves Codex's structured HTTP failure", async (t) => {
  const thread = fixture(t, "terminal-ws-405");
  const { events } = await thread.runStreamed("start");
  const seen = [];
  for await (const event of events) seen.push(event);
  assert.equal(seen.at(-1).type, "turn.failed");
  assert.deepEqual(seen.at(-1).error, {
    message:
      "unexpected status 405 Method Not Allowed: Method Not Allowed, url: wss://tokenhub.example/v1/responses",
    codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 405 } },
  });
});

test("native startup can exceed the control deadline without replaying a turn", async (t) => {
  const thread = fixture(t, "slow-start", {
    rpcTimeouts: { initializeMs: 1000, startupMs: 1000, controlMs: 20 },
  });
  const controller = new AbortController();
  const { events } = await thread.runStreamed("start", {
    signal: controller.signal,
  });
  await assert.rejects(
    thread.steer("no acknowledgement"),
    (e) => e.name === "ControlOutcomeUnknownError",
  );
  controller.abort();
  await assert.rejects(async () => {
    for await (const event of events) {
    }
  }, /interrupted/);
});

test("cancel interrupts native startup without waiting for its deadline", async (t) => {
  const thread = fixture(t, "hang-start", {
    rpcTimeouts: { initializeMs: 5000, startupMs: 5000, controlMs: 5000 },
  });
  const controller = new AbortController();
  const started = Date.now();
  const running = thread.runStreamed("start", { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(running, /interrupted/);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  assert.ok(
    Date.now() - started < 2000,
    "cancellation must not wait for the 5s startup deadline",
  );
});

test("synchronous native spawn failure releases its runtime lease", async () => {
  const { foundryToolsRoot } = await import("../dist/platform/state-root.js");
  const leases = join(foundryToolsRoot(), "agent-runtime-locks", "codex");
  const ownReaders = () =>
    (existsSync(leases) ? readdirSync(leases) : []).filter((name) => {
      if (!name.startsWith("reader-")) return false;
      try {
        return (
          JSON.parse(readFileSync(join(leases, name), "utf8")).pid ===
          process.pid
        );
      } catch {
        return false;
      }
    });
  const before = ownReaders();
  const thread = new CodexAppServerThread(
    "",
    {},
    {},
    { workingDirectory: tmpdir() },
  );
  await assert.rejects(thread.runStreamed("unused"));
  assert.deepEqual(
    ownReaders(),
    before,
    "failed spawn must not block future updates",
  );
});

test("a native compaction adds nothing to the turn: Foundry injects no work context", async (t) => {
  for (const mode of ["compact", "compact-pending"]) {
    const thread = fixture(t, mode, { sessionId: "session_compact" });
    const { events } = await thread.runStreamed("start");
    const seen = [];
    for await (const event of events) seen.push(event);
    assert.equal(seen.at(-1).type, "turn.completed");
    assert.ok(
      !seen.some(
        (event) =>
          event.item?.text?.includes("Foundry persistent work state") ||
          event.item?.id === "work_context_recovery",
      ),
      mode,
    );
  }
});

test("resume restores only the native-indexed history alias after execution-home collection", async (t) => {
  const { mkdirSync, existsSync } = await import("node:fs");
  const { resumeCodexThread } =
    await import("../dist/session/runner/codex-app-server.js");
  const home = mkdtempSync(join(tmpdir(), "foundry-resume-source-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = join(home, "sessions", "2026", "10", "21");
  const parent = join(home, "managed", "codex");
  mkdirSync(dir, { recursive: true });
  mkdirSync(parent, { recursive: true });
  const id = "synthetic-native-thread";
  const path = join(dir, `rollout-test-${id}.jsonl`);
  const indexed = join(
    parent,
    "a".repeat(24),
    "sessions",
    "2026",
    "10",
    "21",
    `rollout-test-${id}.jsonl`,
  );
  const env = {
    CODEX_HOME: join(parent, "b".repeat(24)),
    FOUNDRY_NATIVE_CODEX_DATA_HOME: home,
    FOUNDRY_RUNTIME_CONFIG_ISOLATED: "1",
  };
  writeFileSync(
    path,
    JSON.stringify({ type: "session_meta", payload: { id } }) + "\n",
  );
  const calls = [];
  const client = {
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/read") return { thread: { id, path: indexed } };
      if (!existsSync(indexed))
        throw new Error(`no rollout found for thread id ${id}`);
      return { thread: { id } };
    },
  };
  const result = await resumeCodexThread(
    client,
    { threadId: id, cwd: home },
    env,
  );
  assert.equal(result.thread.id, id);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["thread/resume", "thread/read", "thread/resume"],
  );
  assert.equal(
    calls[2].params.path,
    undefined,
    "paginated native identity is retained",
  );
  assert.equal(readFileSync(indexed, "utf8"), readFileSync(path, "utf8"));
  assert.equal(existsSync(join(parent, "a".repeat(24), "config.toml")), false);
  rmSync(join(parent, "a".repeat(24)), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      type: "session_meta",
      payload: { id: "another-thread" },
    }) + "\n",
  );
  calls.length = 0;
  await assert.rejects(
    resumeCodexThread(client, { threadId: id }, env),
    /no rollout found/,
  );
  assert.equal(calls.length, 1);
  calls.length = 0;
  await assert.rejects(
    resumeCodexThread(
      {
        request: async () => {
          calls.push(1);
          throw new Error("permission denied");
        },
      },
      { threadId: id },
      env,
    ),
    /permission denied/,
  );
  assert.equal(calls.length, 1);
});

test("resuming the same native owner refreshes its managed catalog before execution", async (t) => {
  const thread = fixture(t, "refresh-required", {
    nativeSessionId: "native",
    config: { developer_instructions: "CURRENT_CATALOG" },
  });
  const { events } = await thread.runStreamed("use the current catalog");
  await thread.steer("refreshed");
  const seen = [];
  for await (const event of events) seen.push(event);
  assert.equal(thread.id, "native");
  assert.equal(seen.at(-1).type, "turn.completed");
});

test("a rejected managed-catalog refresh fails before a resumed user turn", async (t) => {
  const thread = fixture(t, "refresh-rejected", {
    nativeSessionId: "native",
    config: { developer_instructions: "CURRENT_CATALOG" },
  });
  await assert.rejects(
    thread.runStreamed("must not execute"),
    /refresh rejected/,
  );
  assert.equal(thread.id, "native");
});

test("a context-window refusal compacts natively and continues once", async (t) => {
  const thread = fixture(t, "overflow");
  const { events } = await thread.runStreamed("ORIGINAL REQUEST");
  const seen = [];
  for await (const event of events) seen.push(event);
  assert.ok(
    seen.some(
      (event) =>
        event.item?.phase === "commentary" &&
        event.item.text === codexCompactionNotice,
    ),
  );
  const answer = seen.find((event) => event.item?.id === "answer");
  assert.ok(
    answer.item.text.startsWith(`CONTINUED:${codexCompactionContinuation}`),
  );
  assert.ok(!answer.item.text.includes("ORIGINAL REQUEST"));
  assert.equal(seen.at(-1).type, "turn.completed");
});

for (const [mode, reason] of [
  ["overflow-twice", /ran out of room/],
  ["overflow-compact-fails", /compacting the thread did not complete/],
  [
    "overflow-compact-rejected",
    /Compaction could not start: .*compact refused/,
  ],
]) {
  test(`context-window recovery fails visibly without looping (${mode})`, async (t) => {
    const thread = fixture(t, mode);
    const { events } = await thread.runStreamed("start");
    const seen = [];
    for await (const event of events) seen.push(event);
    assert.equal(seen.at(-1).type, "turn.failed");
    assert.match(seen.at(-1).error.message, reason);
    assert.equal(
      seen.filter((event) => event.item?.text === codexCompactionNotice).length,
      1,
    );
  });
}

test(
  "native Codex compacts after a context-length refusal and continues",
  { skip: !process.env.TEST_CODEX_CONTEXT_BIN },
  async (t) => {
    const { createServer } = await import("node:http");
    const root = mkdtempSync(join(tmpdir(), "codex-overflow-native-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bodies = [];
    const sse = (text) =>
      [
        { type: "response.created", response: { id: `r${bodies.length}` } },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "message",
            role: "assistant",
            id: `m${bodies.length}`,
            content: [{ type: "output_text", text }],
          },
        },
        {
          type: "response.completed",
          response: {
            id: `r${bodies.length}`,
            usage: {
              input_tokens: 10,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: 5,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 15,
            },
          },
        },
      ]
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join("");
    // A local stand-in for an endpoint; no provider is contacted.
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        if (request.method !== "POST" || !request.url.endsWith("/responses")) {
          response.writeHead(404).end();
          return;
        }
        bodies.push(body);
        if (bodies.length === 1) {
          const failed = {
            type: "response.failed",
            response: {
              id: "r1",
              error: {
                code: "context_length_exceeded",
                message: "Your input exceeds the context window of this model.",
              },
            },
          };
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            `event: ${failed.type}\ndata: ${JSON.stringify(failed)}\n\n`,
          );
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          sse(bodies.length === 2 ? "SUMMARY OF EARLIER WORK" : "CONTINUED"),
        );
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const env = {
      PATH: process.env.PATH,
      CODEX_HOME: join(root, "native"),
      TMPDIR: tmpdir(),
    };
    const { mkdirSync } = await import("node:fs");
    mkdirSync(env.CODEX_HOME);
    const thread = new CodexAppServerThread(
      process.env.TEST_CODEX_CONTEXT_BIN,
      env,
      {
        model_provider: "local_test",
        model_context_window: 200000,
        model_auto_compact_token_limit: 160000,
        model_providers: {
          local_test: {
            name: "local test",
            base_url: `http://127.0.0.1:${server.address().port}/v1`,
            wire_api: "responses",
            supports_websockets: false,
            request_max_retries: 0,
            stream_max_retries: 0,
          },
        },
      },
      {
        workingDirectory: root,
        model: "private/overflow-test",
        approvalPolicy: "never",
        sandboxMode: "read-only",
      },
    );
    const { events } = await thread.runStreamed("ORIGINAL REQUEST");
    const seen = [];
    for await (const event of events) seen.push(event);
    assert.equal(
      seen.at(-1).type,
      "turn.completed",
      JSON.stringify(seen.at(-1)),
    );
    assert.ok(seen.some((event) => event.item?.text === codexCompactionNotice));
    assert.ok(seen.some((event) => event.item?.text === "CONTINUED"));
    assert.equal(bodies.length, 3);
    // The continuation carries the compacted history, not the original twice.
    assert.ok(bodies[2].includes(codexCompactionContinuation));
    assert.ok(bodies[2].includes("SUMMARY OF EARLIER WORK"));
    assert.equal(bodies[2].split("ORIGINAL REQUEST").length - 1, 1);
  },
);

test("a compatible endpoint is the app-server's own provider, so Codex 0.166 accepts the turn", async (t) => {
  const config = {
    model_provider: "foundry_x",
    model_providers: {
      foundry_x: {
        name: 'LLM Gateway "dev"',
        base_url: "http://user:pw@127.0.0.1:8787/v1?key=q",
        wire_api: "responses",
        env_key: "CODEX_API_KEY",
        supports_websockets: false,
        http_headers: { Authorization: "Bearer header-secret" },
        query_params: { key: "query-secret" },
        experimental_bearer_token: "token-secret",
      },
    },
  };
  const args = codexProviderArguments(config);
  assert.deepEqual(args, [
    "-c",
    'model_provider="foundry_x"',
    "-c",
    'model_providers.foundry_x={name = "LLM Gateway \\"dev\\"", base_url = "http://127.0.0.1:8787/v1", wire_api = "responses", env_key = "CODEX_API_KEY", supports_websockets = false}',
  ]);
  // The command line is visible to other local users; credentials are not.
  assert.doesNotMatch(args.join(" "), /secret|pw@|key=q/);
  assert.deepEqual(codexProviderArguments({}), []);
  const thread = fixture(t, "provider-check", { config });
  const { events } = await thread.runStreamed("start");
  await thread.steer("done", "input-2");
  for await (const event of events)
    if (event.type === "turn.failed") assert.fail(JSON.stringify(event));
});

test("a chat whose provider changed continues, with its history, in a fork on the new provider", async (t) => {
  const thread = fixture(t, "provider-moved", {
    nativeSessionId: "native",
    config: {
      model_provider: "foundry_b",
      model_providers: { foundry_b: { name: "b", base_url: "http://b/v1" } },
    },
  });
  const { events } = await thread.runStreamed("start");
  await thread.steer("done", "input-2");
  const seen = [];
  for await (const event of events) seen.push(event);
  assert.equal(thread.id, "forked");
  assert.ok(seen.some((event) => event.item?.text === codexProviderForkNotice));
  assert.ok(
    seen.some(
      (event) =>
        event.type === "thread.started" && event.thread_id === "forked",
    ),
  );
  assert.equal(seen.at(-1).type, "turn.completed");
});
