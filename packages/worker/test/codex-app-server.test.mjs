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
} from "../dist/runner/codex-app-server.js";
function fixture(t, mode = "normal", options = {}) {
  const root = mkdtempSync(join(tmpdir(), "foundry-app-server-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "codex");
  writeFileSync(
    bin,
    `#!${process.execPath}
const rl=require('node:readline').createInterface({input:process.stdin});
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const notify=(method,params)=>send({method,params:{threadId:'native',...params}});
rl.on('line',l=>{const r=JSON.parse(l);if(!r.id)return;const reply=result=>send({id:r.id,result});
if(r.method==='initialize')return reply({});
if(r.method==='thread/start'||r.method==='thread/resume'){if(process.env.MODE==='hang-start')return;if(process.env.MODE==='slow-start')return setTimeout(()=>reply({thread:{id:'native'}}),80);return reply({thread:{id:'native'}});}
if(r.method==='turn/start'){if(process.env.MODE.startsWith('compact')){notify('turn/started',{turn:{id:'turn-1'}});reply({turn:{id:'turn-1'}});notify('thread/compacted',{});return;}notify('item/started',{item:{id:'user',type:'userMessage',content:[{text:'internal execution prompt'}]}});notify('turn/started',{turn:{id:'turn-1'}});reply({turn:{id:'turn-1'}});notify('item/started',{turnId:'turn-1',item:{id:'msg',type:'agentMessage',text:'',phase:'commentary'}});notify('item/agentMessage/delta',{turnId:'turn-1',itemId:'msg',delta:'Working'});return;}
if(r.method==='turn/steer'){if(process.env.MODE==='compact-pending'){notify('turn/completed',{turn:{id:'turn-1',status:'completed'}});return;}if(r.params.input[0].text==='no acknowledgement')return;if(r.params.expectedTurnId!=='turn-1')return send({id:r.id,error:{message:'wrong turn'}});if(process.env.MODE==='crash')return process.exit(1);reply({turnId:'turn-1'});notify('item/completed',{turnId:'turn-1',item:{id:'answer',type:'agentMessage',text:r.params.input[0].text,phase:'final_answer'}});notify('thread/tokenUsage/updated',{tokenUsage:{last:{inputTokens:42,cachedInputTokens:2,outputTokens:8}}});notify('turn/completed',{turn:{id:'turn-1',status:'completed'}});return;}
if(r.method==='turn/interrupt'){reply({});notify('turn/completed',{turn:{id:'turn-1',status:'interrupted'}});}
});`,
    { mode: 0o700 },
  );
  return new CodexAppServerThread(
    bin,
    { ...process.env, MODE: mode, FOUNDRY_SESSION_ID: options.sessionId || "" },
    {},
    {
      workingDirectory: root,
      approvalPolicy: "never",
      sandboxMode: "read-only",
      ...options,
    },
  );
}
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
  assert.deepEqual(seen.at(-1), {
    type: "turn.completed",
    usage: { input_tokens: 42, cached_input_tokens: 2, output_tokens: 8 },
  });
  await assert.rejects(thread.steer("late"), /not accepting/);
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
  const { foundryToolsRoot } = await import("../dist/state-root.js");
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

test("native compaction notification refreshes work context through turn/steer", async (t) => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        items: [],
        operations: [],
        barrier: false,
        coverage: { hostSchedules: "not_observed", processes: "not_observed" },
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const { sessionWork } = await import("../dist/session-work/supervisor.js");
  const supervisor = sessionWork();
  await supervisor.start(`http://127.0.0.1:${server.address().port}`);
  supervisor.stop();
  for (const mode of ["compact", "compact-pending"]) {
    const thread = fixture(t, mode, { sessionId: "session_compact" });
    const { events } = await thread.runStreamed("start");
    const seen = [];
    for await (const event of events) seen.push(event);
    assert.equal(seen.at(-1).type, "turn.completed");
    if (mode === "compact") {
      assert.ok(
        seen.some((event) =>
          event.item?.text?.includes("Foundry persistent work state"),
        ),
        "compact did not refresh native turn context",
      );
    } else {
      assert.ok(
        !seen.some((event) => event.item?.id === "work_context_recovery"),
        "late compact diagnostic must not enter a terminal turn",
      );
    }
  }
});
