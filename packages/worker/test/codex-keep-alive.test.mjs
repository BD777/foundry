import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexAppServerThread,
  codexNativeActivityBusy,
} from "../dist/session/runner/codex-app-server.js";
import {
  activeCodexThreads,
  setOutOfBandSessionEventSink,
  setSessionTurnSink,
} from "../dist/session/session-state.js";
import {
  busyCodexWriter,
  cleanupActiveCodexThreads,
  closeAllActiveRuntimes,
} from "../dist/session/runner/active-runtimes.js";

// A fake app-server: no model is called. MODE picks what Codex still runs
// after the Foundry turn: an active goal that continues once, a background
// terminal listed until `stop` exists, a queued input, or nothing.
const fakeCodex = `#!${process.execPath}
const fs=require('node:fs');
const path=require('node:path');
const dir=process.env.FAKE_DIR;
fs.appendFileSync(path.join(dir,'spawns'),process.pid+'\\n');
const rl=require('node:readline').createInterface({input:process.stdin});
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const notify=(method,params)=>send({method,params:{threadId:'native',...params}});
const mode=process.env.MODE;
let turns=0;
// terminal-exit: like Codex 0.163, the command's item/completed (with its
// exit code) arrives when it ends, before any inventory stops listing it.
let exited=false;
if(mode==='terminal-exit'){const poll=setInterval(()=>{if(!fs.existsSync(path.join(dir,'stop')))return;clearInterval(poll);
notify('item/completed',{turnId:'turn-1',item:{id:'cmd-1',type:'commandExecution',command:'sleep 100',cwd:dir,status:'completed',exitCode:0}});exited=true;},20);}
let queued=mode==='queue'?1:0;
rl.on('line',l=>{const r=JSON.parse(l);if(!r.id)return;
fs.appendFileSync(path.join(dir,'methods'),r.method+'\\n');
const reply=result=>send({id:r.id,result});
if(r.method==='initialize')return reply({});
if(r.method==='thread/start'||r.method==='thread/resume')return reply({thread:{id:'native'}});
if(r.method==='thread/goal/get')return reply({goal:mode==='goal'||mode==='handover'||mode==='paused'?{threadId:'native',objective:'Ship it',status:mode==='paused'?'paused':'active',createdAt:1,updatedAt:1,timeUsedSeconds:0,tokensUsed:0}:null});
if(r.method==='thread/goal/set'){fs.appendFileSync(path.join(dir,'goal-controls'),JSON.stringify(r.params)+'\\n');const goal={threadId:'native',objective:'Ship it',status:r.params.status,createdAt:1,updatedAt:3,timeUsedSeconds:3,tokensUsed:7};reply({goal});return notify('thread/goal/updated',{goal});}
if(r.method==='thread/goal/clear'){fs.appendFileSync(path.join(dir,'goal-controls'),JSON.stringify(r.params)+'\\n');reply({cleared:true});return notify('thread/goal/cleared',{});}
if(r.method==='thread/backgroundTerminals/list'){const live=(mode==='terminal'&&!fs.existsSync(path.join(dir,'stop')))||(mode==='terminal-exit'&&!exited);return reply({data:live?[{processId:'p1',itemId:'cmd-1',command:'sleep 100',cwd:dir}]:[]});}
if(r.method==='thread/queue/list')return reply({data:queued?[{id:'q1',clientUserMessageId:'c1',input:[]}]:[]});
if(r.method==='turn/start'&&mode==='handover'&&turns===1){turns++;reply({turn:{id:'own-1'}});
notify('item/completed',{turnId:'own-1',item:{id:'h',type:'agentMessage',text:'Took your message in',phase:'final_answer'}});
return notify('turn/completed',{turn:{id:'own-1',status:'completed'}});}
if(r.method==='turn/start'){turns++;const id='turn-'+turns;notify('turn/started',{turn:{id}});reply({turn:{id}});
if((mode==='terminal'||mode==='terminal-exit')&&turns===1)notify('item/started',{turnId:id,item:{id:'cmd-1',type:'commandExecution',command:'sleep 100',cwd:dir}});
if(mode==='handover'&&turns===1)setTimeout(()=>notify('turn/started',{turn:{id:'own-1'}}),20);
if(mode==='queue'&&turns===1){notify('thread/queue/changed',{});setTimeout(()=>{queued=0;notify('thread/queue/changed',{});},300);}
notify('item/completed',{turnId:id,item:{id:'answer-'+turns,type:'agentMessage',text:'done '+turns,phase:'final_answer'}});
notify('turn/completed',{turn:{id,status:'completed'}});
if(mode==='goal'&&turns===1)setTimeout(()=>{notify('turn/started',{turn:{id:'own-1'}});
notify('item/completed',{turnId:'own-1',item:{id:'c',type:'agentMessage',text:'Checking the build',phase:'commentary'}});
notify('item/completed',{turnId:'own-1',item:{id:'a',type:'agentMessage',text:'Goal reached',phase:'final_answer'}});
notify('thread/tokenUsage/updated',{turnId:'own-1',tokenUsage:{last:{inputTokens:5,cachedInputTokens:0,outputTokens:2}}});
notify('turn/completed',{turn:{id:'own-1',status:'completed'}});
notify('thread/goal/updated',{goal:{threadId:'native',objective:'Ship it',status:'complete',createdAt:1,updatedAt:2,timeUsedSeconds:3,tokensUsed:7}});},150);
return;}
});`;

function fixture(t, mode, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "codex-keep-alive-"));
  const bin = join(dir, "codex");
  writeFileSync(bin, fakeCodex, { mode: 0o700 });
  writeFileSync(join(dir, "spawns"), "");
  writeFileSync(join(dir, "methods"), "");
  const thread = new CodexAppServerThread(
    bin,
    {
      ...process.env,
      MODE: mode,
      FAKE_DIR: dir,
      FOUNDRY_SESSION_ID: "sess_keep",
    },
    {},
    {
      workingDirectory: dir,
      approvalPolicy: "never",
      sandboxMode: "read-only",
      workSessionId: "sess_keep",
      persistent: true,
      ...options,
    },
  );
  t.after(async () => {
    await thread.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const pids = () =>
    readFileSync(join(dir, "spawns"), "utf8").split("\n").filter(Boolean);
  const methods = () =>
    readFileSync(join(dir, "methods"), "utf8").split("\n").filter(Boolean);
  const alive = (pid) => {
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch {
      return false;
    }
  };
  return { dir, thread, pids, methods, alive };
}

async function runTurn(thread, input = "go") {
  const { events } = await thread.runStreamed(input);
  const seen = [];
  for await (const event of events) seen.push(event);
  return seen;
}

async function until(check, ms = 6000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((done) => setTimeout(done, 25));
  }
}

function sinks(t) {
  const events = [];
  const turns = [];
  const eventSink = (sessionId, event) => events.push({ sessionId, ...event });
  setOutOfBandSessionEventSink(eventSink);
  setSessionTurnSink((sessionId, running) => turns.push([sessionId, running]));
  t.after(() => {
    setOutOfBandSessionEventSink(undefined);
    setSessionTurnSink(undefined);
  });
  return { events, turns };
}

test("busy means a goal is active, terminals live, inputs are queued or Codex runs its own turn", () => {
  const idle = { liveTerminals: 0, queued: 0, ownTurn: false };
  assert.equal(codexNativeActivityBusy(idle), false);
  assert.equal(
    codexNativeActivityBusy({ ...idle, goalStatus: "active" }),
    true,
  );
  for (const status of [
    "paused",
    "blocked",
    "usageLimited",
    "budgetLimited",
    "complete",
  ])
    assert.equal(
      codexNativeActivityBusy({ ...idle, goalStatus: status }),
      false,
    );
  assert.equal(codexNativeActivityBusy({ ...idle, liveTerminals: 1 }), true);
  assert.equal(codexNativeActivityBusy({ ...idle, queued: 1 }), true);
  assert.equal(codexNativeActivityBusy({ ...idle, ownTurn: true }), true);
  assert.equal(
    codexNativeActivityBusy({ ...idle, ownTurn: true, closed: true }),
    false,
  );
});

test("with nothing left to run, the app-server closes at turn end as before", async (t) => {
  const { thread, pids, alive } = fixture(t, "idle");
  const seen = await runTurn(thread);
  assert.equal(seen.at(-1).type, "turn.completed");
  assert.equal(pids().length, 1);
  assert.equal(alive(pids()[0]), false);
  assert.equal(thread.isBusy(), false);
  assert.equal(thread.nativeActivity(), undefined);
});

test("a thread that is not persistent never stays open", async (t) => {
  const { thread, pids, alive } = fixture(t, "goal", { persistent: false });
  await runTurn(thread);
  assert.equal(alive(pids()[0]), false);
});

test("an active goal keeps the app-server; its own turn is published, then it closes", async (t) => {
  const { events, turns } = sinks(t);
  const { thread, pids, alive } = fixture(t, "goal");
  await runTurn(thread);
  const [pid] = pids();
  assert.equal(alive(pid), true, "kept for the goal");
  assert.equal(thread.isBusy(), true);
  assert.equal(thread.nativeActivity()?.goal?.status, "active");
  await until(() => !alive(pid));
  assert.deepEqual(turns, [
    ["sess_keep", true],
    ["sess_keep", false],
  ]);
  const commentary = events.find((e) => e.label === "Commentary");
  assert.equal(commentary?.detail, "Checking the build");
  assert.equal(commentary?.message?.kind, "commentary");
  const own = events.find((e) => e.label === "Background task continued");
  assert.equal(own?.sessionId, "sess_keep");
  assert.equal(own?.detail, "Codex continued toward its goal: Ship it");
  assert.equal(own?.metadata?.timerFire?.origin, "background");
  assert.equal(own?.metadata?.timerFire?.response, "Goal reached");
  assert.equal(own?.metadata?.turnUsage?.inputTokens, 5);
  assert.equal(thread.isBusy(), false);
});

test("a live background terminal keeps the process: the next turn reuses it without resuming", async (t) => {
  const { dir, thread, pids, methods, alive } = fixture(t, "terminal");
  await runTurn(thread);
  // The inventory poll lists the terminal; the next turn end keeps it.
  await until(() => methods().includes("thread/backgroundTerminals/list"));
  await runTurn(thread, "again");
  assert.equal(pids().length, 1, "one process for both turns");
  const [pid] = pids();
  assert.equal(alive(pid), true);
  assert.equal(methods().filter((m) => m === "thread/start").length, 1);
  assert.equal(methods().filter((m) => m === "turn/start").length, 2);
  assert.equal(thread.nativeActivity()?.liveTerminals, 1);
  // The registry keeps a busy thread past its idle time and routes the
  // session's next writer to it.
  activeCodexThreads.set("old-key", {
    key: "old-key",
    lastUsed: 0,
    nativeSessionId: "native",
    thread,
  });
  t.after(() => activeCodexThreads.delete("old-key"));
  cleanupActiveCodexThreads();
  assert.ok(activeCodexThreads.has("old-key"));
  assert.equal(busyCodexWriter("native")?.thread, thread);
  // The terminal ends: the next inventory sees it gone and the process closes.
  writeFileSync(join(dir, "stop"), "");
  await until(() => !alive(pid));
  assert.equal(busyCodexWriter("native"), undefined);
});

test("a background terminal whose exit Codex reports closes the kept process", async (t) => {
  const { dir, thread, pids, methods, alive } = fixture(t, "terminal-exit");
  await runTurn(thread);
  await until(() => methods().includes("thread/backgroundTerminals/list"));
  const [pid] = pids();
  assert.equal(alive(pid), true, "kept while the terminal runs");
  writeFileSync(join(dir, "stop"), "");
  await until(() => !alive(pid));
  assert.equal(thread.isBusy(), false);
});

test("queued native input keeps the process until the queue empties", async (t) => {
  const { thread, pids, methods, alive } = fixture(t, "queue");
  await runTurn(thread);
  const [pid] = pids();
  assert.equal(alive(pid), true, "kept for the queued input");
  assert.equal(thread.nativeActivity()?.queued, 1);
  await until(() => !alive(pid));
  assert.ok(methods().filter((m) => m === "thread/queue/list").length >= 2);
});

test("closing all runtimes ends a kept app-server", async (t) => {
  const { thread, pids, methods, alive } = fixture(t, "terminal");
  await runTurn(thread);
  await until(() => methods().includes("thread/backgroundTerminals/list"));
  await runTurn(thread, "again");
  const [pid] = pids();
  assert.equal(alive(pid), true);
  activeCodexThreads.set("shutdown-key", {
    key: "shutdown-key",
    lastUsed: Date.now(),
    nativeSessionId: "native",
    thread,
  });
  closeAllActiveRuntimes();
  assert.equal(activeCodexThreads.has("shutdown-key"), false);
  await until(() => !alive(pid));
});

test("a Foundry turn sent while Codex runs its own turn continues that turn", async (t) => {
  const { events, turns } = sinks(t);
  const { thread, pids, alive } = fixture(t, "handover");
  await runTurn(thread);
  await until(() => turns.length === 1);
  assert.equal(thread.nativeActivity()?.ownTurnId, "own-1");
  const seen = await runTurn(thread, "steer in");
  assert.equal(pids().length, 1);
  assert.ok(seen.some((e) => e.item?.text === "Took your message in"));
  assert.equal(seen.at(-1).type, "turn.completed");
  // The handed-over turn had no answer of its own yet: nothing is published.
  assert.equal(
    events.some((e) => e.label === "Background task continued"),
    false,
  );
  assert.deepEqual(turns, [
    ["sess_keep", true],
    ["sess_keep", false],
  ]);
  // Its goal is still active, so the process stays for its continuation.
  assert.equal(alive(pids()[0]), true);
});

test("the goal is published as it is read and as it changes", async (t) => {
  const { events } = sinks(t);
  const { thread, pids, alive } = fixture(t, "goal");
  await runTurn(thread);
  await until(() => !alive(pids()[0]));
  const goals = events
    .filter((event) => event.label === "Goal updated")
    .map((event) => event.metadata.goalSnapshot.goal?.status ?? "none");
  assert.deepEqual(goals, ["active", "complete"]);
  const complete = events.findLast((event) => event.label === "Goal updated");
  assert.equal(complete.sessionId, "sess_keep");
  assert.deepEqual(complete.metadata.goalSnapshot.goal, {
    runtime: "codex",
    objective: "Ship it",
    status: "complete",
    tokensUsed: 7,
    timeUsedSeconds: 3,
    setAt: new Date(1000).toISOString(),
  });
});

test("the person resumes a paused goal on a closed thread and clears it, as the user", async (t) => {
  const { events } = sinks(t);
  const { dir, thread, pids, alive } = fixture(t, "paused");
  await runTurn(thread);
  assert.equal(alive(pids()[0]), false, "a paused goal keeps nothing open");
  await thread.controlGoal("resume");
  assert.equal(pids().length, 2, "the thread is opened for the control");
  assert.equal(alive(pids()[1]), true, "kept while the goal is active");
  await thread.controlGoal("clear");
  await until(() => !alive(pids()[1]));
  const controls = readFileSync(join(dir, "goal-controls"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(controls, [
    { threadId: "native", status: "active", origin: "user" },
    { threadId: "native", origin: "user" },
  ]);
  assert.deepEqual(
    events
      .filter((event) => event.label === "Goal updated")
      .map((event) => event.metadata.goalSnapshot.goal?.status ?? "none"),
    ["paused", "active", "none"],
  );
});
