import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexAppServerThread,
  appServerItem,
} from "../dist/runner/codex-app-server.js";
function fixture(t, mode = "normal") {
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
if(r.method==='thread/start'||r.method==='thread/resume')return reply({thread:{id:'native'}});
if(r.method==='turn/start'){notify('item/started',{item:{id:'user',type:'userMessage',content:[{text:'internal execution prompt'}]}});notify('turn/started',{turn:{id:'turn-1'}});reply({turn:{id:'turn-1'}});notify('item/started',{turnId:'turn-1',item:{id:'msg',type:'agentMessage',text:'',phase:'commentary'}});notify('item/agentMessage/delta',{turnId:'turn-1',itemId:'msg',delta:'Working'});return;}
if(r.method==='turn/steer'){if(r.params.expectedTurnId!=='turn-1')return send({id:r.id,error:{message:'wrong turn'}});if(process.env.MODE==='crash')return process.exit(1);reply({turnId:'turn-1'});notify('item/completed',{turnId:'turn-1',item:{id:'answer',type:'agentMessage',text:r.params.input[0].text,phase:'final_answer'}});notify('thread/tokenUsage/updated',{tokenUsage:{last:{inputTokens:42,cachedInputTokens:2,outputTokens:8}}});notify('turn/completed',{turn:{id:'turn-1',status:'completed'}});return;}
if(r.method==='turn/interrupt'){reply({});notify('turn/completed',{turn:{id:'turn-1',status:'interrupted'}});}
});`,
    { mode: 0o700 },
  );
  return new CodexAppServerThread(
    bin,
    { ...process.env, MODE: mode },
    {},
    {
      workingDirectory: root,
      approvalPolicy: "never",
      sandboxMode: "read-only",
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
