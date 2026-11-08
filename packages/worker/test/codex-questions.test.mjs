import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { agentQuestionReplyText } from "@bd777/foundry-protocol";
import { CodexAppServerThread } from "../dist/session/runner/codex-app-server.js";

// A fake Codex app-server: no model is called. Each turn/start sends the
// server request in REQUEST ({method, params}) and ends the turn once
// Foundry answers it (or, with RESOLVE, resolves it itself). It records
// Foundry's responses and the notes steered into the turn.
const fakeCodex = `#!${process.execPath}
const fs=require('node:fs');
const path=require('node:path');
const dir=process.env.FAKE_DIR;
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const notify=(method,params)=>send({method,params:{threadId:'native',...params}});
const request=JSON.parse(process.env.REQUEST);
let turns=0, turn='';
const finish=()=>setTimeout(()=>{
  notify('item/completed',{turnId:turn,item:{id:'answer-'+turns,type:'agentMessage',text:'done',phase:'final_answer'}});
  notify('turn/completed',{turn:{id:turn,status:'completed'}});
},150);
require('node:readline').createInterface({input:process.stdin}).on('line',l=>{
  const r=JSON.parse(l);
  if(r.id!==undefined&&!r.method){
    fs.appendFileSync(path.join(dir,'responses'),JSON.stringify(r)+'\\n');
    return finish();
  }
  if(r.id===undefined)return;
  const reply=result=>send({id:r.id,result});
  if(r.method==='initialize')return reply({});
  if(r.method==='thread/start'||r.method==='thread/resume')return reply({thread:{id:'native'}});
  if(r.method==='turn/steer'){
    fs.appendFileSync(path.join(dir,'steers'),r.params.input.map(p=>p.text).join('')+'\\n');
    return reply({turnId:r.params.expectedTurnId});
  }
  if(r.method==='turn/start'){
    turns++;turn='turn-'+turns;
    notify('turn/started',{turn:{id:turn}});
    reply({turn:{id:turn}});
    const id='srv-'+turns;
    send({id,method:request.method,params:{threadId:'native',turnId:turn,...request.params}});
    if(process.env.RESOLVE){setTimeout(()=>{notify('serverRequest/resolved',{requestId:id});finish();},100);}
    return;
  }
  reply({data:[]});
});`;

function fixture(t, request, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "codex-questions-"));
  const bin = join(dir, "codex");
  writeFileSync(bin, fakeCodex, { mode: 0o700 });
  writeFileSync(join(dir, "responses"), "");
  writeFileSync(join(dir, "steers"), "");
  const sessionId = `sess_${randomUUID()}`;
  const env = {
    ...process.env,
    REQUEST: JSON.stringify(request),
    FAKE_DIR: dir,
    FOUNDRY_SESSION_ID: sessionId,
    ...(options.resolve ? { RESOLVE: "1" } : {}),
  };
  delete env.FOUNDRY_CODEX_AUTH_SOURCE;
  const thread = new CodexAppServerThread(
    bin,
    env,
    {},
    {
      workingDirectory: dir,
      approvalPolicy: "untrusted",
      sandboxMode: "read-only",
      questionWaitMs: options.waitMs ?? 60_000,
      ...(options.to ? { questionsTo: options.to } : {}),
    },
  );
  t.after(async () => {
    await thread.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const lines = (name) =>
    readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean);
  return {
    thread,
    responses: () => lines("responses").map((line) => JSON.parse(line)),
    steers: () => lines("steers"),
  };
}

/** Runs one turn; `onQuestion` sees each question card as it is shown. */
async function runTurn(thread, onQuestion = () => {}) {
  const { events } = await thread.runStreamed("go");
  const seen = [];
  for await (const event of events) {
    seen.push(event);
    if (event.type === "foundry.question") onQuestion(event.message);
  }
  return seen;
}

async function until(check, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((done) => setTimeout(done, 20));
  }
}

const command = {
  method: "item/commandExecution/requestApproval",
  params: {
    itemId: "cmd-1",
    command: "touch done.txt",
    cwd: "/work",
    reason: "Needs to write outside the sandbox",
    startedAtMs: 1,
  },
};

const userInput = {
  method: "item/tool/requestUserInput",
  params: {
    itemId: "ask-1",
    isBlocking: true,
    questions: [
      {
        id: "color",
        header: "Color",
        question: "Which color?",
        options: [
          { label: "Red", description: "warm" },
          { label: "Blue", description: "cold" },
        ],
      },
    ],
  },
};

const answer = (message, ...values) =>
  agentQuestionReplyText(message.id, message.questions, values);

test("a person approves a command from the card; Codex runs it", async (t) => {
  const { thread, responses, steers } = fixture(t, command, { to: "person" });
  const cards = [];
  const seen = await runTurn(thread, (message) => {
    cards.push(message);
    assert.equal(thread.answerQuestion(answer(message, "Approve")), true);
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, "approval_cmd-1");
  assert.equal(cards[0].delivery, undefined, "it holds the turn");
  assert.equal(cards[0].questions[0].approval, true);
  assert.match(cards[0].questions[0].detail, /touch done\.txt/);
  assert.deepEqual(responses()[0].result, { decision: "accept" });
  assert.equal(steers().length, 0);
  assert.equal(
    seen.some((event) => event.type === "foundry.question_settled"),
    false,
    "an answered card is the person's reply, not a lapse",
  );
  assert.equal(seen.at(-1).type, "turn.completed");
});

test("a person's other reply denies with its reason, which Codex is told", async (t) => {
  const { thread, responses, steers } = fixture(t, command, { to: "person" });
  await runTurn(thread, () =>
    assert.equal(thread.answerQuestion("not on main, use a branch"), true),
  );
  assert.deepEqual(responses()[0].result, { decision: "decline" });
  await until(() => steers().length === 1);
  assert.match(steers()[0], /was not approved: not on main, use a branch/);
  assert.match(steers()[0], /NOT performed/);
});

test("an approval nobody answers in time is declined and settles", async (t) => {
  const { thread, responses, steers } = fixture(t, command, {
    to: "person",
    waitMs: 100,
  });
  const seen = await runTurn(thread);
  assert.deepEqual(responses()[0].result, { decision: "decline" });
  const settled = seen.find((e) => e.type === "foundry.question_settled");
  assert.equal(settled?.itemId, "approval_cmd-1");
  await until(() => steers().length === 1);
  assert.match(
    steers()[0],
    /nobody approved the command `touch done.txt` in time/,
  );
  // An answer after the wait is a message for Codex, not the card's.
  assert.equal(thread.answerQuestion("Approve"), false);
});

test("a person answers requestUserInput by option; unanswered, it gets no answers", async (t) => {
  const { thread, responses } = fixture(t, userInput, { to: "person" });
  const cards = [];
  await runTurn(thread, (message) => {
    cards.push(message);
    thread.answerQuestion(answer(message, "Blue"));
  });
  assert.equal(cards[0].id, "ask-1");
  assert.deepEqual(cards[0].questions[0], {
    title: "Which color?",
    header: "Color",
    options: ["Red", "Blue"],
    descriptions: ["warm", "cold"],
    unranked: true,
  });
  assert.deepEqual(responses()[0].result, {
    answers: { color: { answers: ["Blue"] } },
  });

  const late = fixture(t, userInput, { to: "person", waitMs: 100 });
  const seen = await runTurn(late.thread);
  assert.deepEqual(late.responses()[0].result, { answers: {} });
  assert.equal(
    seen.find((e) => e.type === "foundry.question_settled")?.itemId,
    "ask-1",
  );
  assert.equal(late.steers().length, 0, "no answers says it all");
});

test("a request Codex resolves itself closes its card", async (t) => {
  const { thread, responses } = fixture(t, userInput, {
    to: "person",
    resolve: true,
  });
  const seen = await runTurn(thread);
  assert.equal(
    seen.find((e) => e.type === "foundry.question_settled")?.itemId,
    "ask-1",
  );
  assert.equal(thread.answerQuestion("Blue"), false);
  assert.equal(responses().length, 0);
});

test("a child's approval is relayed for the next turn; once approved, the same command passes once", async (t) => {
  const { thread, responses, steers } = fixture(t, command, { to: "parent" });
  const cards = [];
  await runTurn(thread, (message) => cards.push(message));
  assert.equal(cards[0].delivery, "next_turn");
  assert.equal(cards[0].id, "approval_cmd-1");
  assert.deepEqual(responses()[0].result, { decision: "decline" });
  await until(() => steers().length === 1);
  assert.match(steers()[0], /requested from the session that created you/);
  assert.match(steers()[0], /End your turn now/);

  // The parent's "Approve" comes as the next turn's input.
  thread.observeInput(answer(cards[0], "Approve"));
  const again = [];
  await runTurn(thread, (message) => again.push(message));
  assert.equal(again.length, 0, "approved: not asked again");
  assert.deepEqual(responses()[1].result, { decision: "accept" });
  // Approved once: the next time it asks again.
  await runTurn(thread, (message) => again.push(message));
  assert.equal(again.length, 1);
  assert.deepEqual(responses()[2].result, { decision: "decline" });
});

test("a child's question is relayed and its turn told to end", async (t) => {
  const { thread, responses, steers } = fixture(t, userInput, {
    to: "parent",
  });
  const cards = [];
  await runTurn(thread, (message) => cards.push(message));
  assert.equal(cards[0].delivery, "next_turn");
  assert.deepEqual(responses()[0].result, { answers: {} });
  await until(() => steers().length === 1);
  assert.match(steers()[0], /The answer arrives as your next message/);
});

test("with nobody to answer, prompts are declined at once", async (t) => {
  for (const request of [
    command,
    userInput,
    {
      method: "item/fileChange/requestApproval",
      params: { itemId: "patch-1", startedAtMs: 1 },
    },
    {
      method: "item/permissions/requestApproval",
      params: {
        itemId: "perm-1",
        cwd: "/work",
        permissions: { network: { enabled: true } },
        startedAtMs: 1,
      },
    },
  ]) {
    const { thread, responses, steers } = fixture(t, request);
    const cards = [];
    await runTurn(thread, (message) => cards.push(message));
    assert.equal(cards.length, 0, request.method);
    await until(() => steers().length === 1);
    assert.match(steers()[0], /nobody can answer prompts in this session/);
    assert.match(steers()[0], /do not retry it/);
    const declines = {
      "item/commandExecution/requestApproval": { decision: "decline" },
      "item/tool/requestUserInput": { answers: {} },
      "item/fileChange/requestApproval": { decision: "decline" },
      "item/permissions/requestApproval": { permissions: {} },
    };
    assert.deepEqual(responses()[0].result, declines[request.method]);
  }
});

test("an MCP form elicitation asks its fields; one without fields is an approval", async (t) => {
  const form = {
    method: "mcpServer/elicitation/request",
    params: {
      serverName: "tracker",
      mode: "form",
      message: "Create the ticket?",
      requestedSchema: {
        type: "object",
        properties: {
          title: { type: "string", title: "Ticket title" },
          priority: { type: "integer", title: "Priority" },
          urgent: { type: "boolean", title: "Urgent" },
          team: { type: "string", enum: ["web", "server"] },
        },
        required: ["title"],
      },
    },
  };
  const { thread, responses } = fixture(t, form, { to: "person" });
  const cards = [];
  await runTurn(thread, (message) => {
    cards.push(message);
    thread.answerQuestion(answer(message, "Fix login", "2", "Yes", "server"));
  });
  assert.equal(cards[0].id, "elicitation_srv-1");
  assert.deepEqual(
    cards[0].questions.map((q) => [q.title, q.options]),
    [
      ["Ticket title", undefined],
      ["Priority", undefined],
      ["Urgent", ["Yes", "No"]],
      ["team", ["web", "server"]],
    ],
  );
  assert.deepEqual(responses()[0].result, {
    action: "accept",
    content: { title: "Fix login", priority: 2, urgent: true, team: "server" },
  });

  const consent = fixture(
    t,
    {
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "tracker",
        mode: "form",
        message: 'Allow the tracker MCP server to run tool "delete"?',
        requestedSchema: { type: "object", properties: {} },
      },
    },
    { to: "person" },
  );
  await runTurn(consent.thread, (message) => {
    assert.equal(message.questions[0].approval, true);
    consent.thread.answerQuestion(answer(message, "Deny"));
  });
  assert.deepEqual(consent.responses()[0].result, { action: "decline" });
});

test("a request Foundry does not answer is still refused", async (t) => {
  const { thread, responses } = fixture(
    t,
    { method: "item/tool/call", params: { callId: "c1", tool: "x" } },
    { to: "person" },
  );
  await runTurn(thread);
  assert.equal(responses()[0].error.code, -32601);
});
