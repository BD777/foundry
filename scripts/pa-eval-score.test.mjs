#!/usr/bin/env node
// Synthetic checks of the Personal Agent eval's scoring (scripts/pa-eval-score.mjs).
// Run: node scripts/pa-eval-score.test.mjs   (exit 0: all pass)

import { strict as assert } from "node:assert";
import {
  blockingAsksOf,
  cardAsksIn,
  classifyOutcome,
  mentionedProjects,
  parseJudgeAnswer,
  parseToolEvent,
  projectByComputer,
  questionsIn,
} from "./pa-eval-score.mjs";

const assistant = "ws_assistant";
const project = (id, name, device) => ({
  id,
  name,
  device,
  ref: device ? `${name}@${device}` : "",
});
const tool = (name, args = {}) => ({ name, args, failed: false });

const offline = [
  project("ws_cotton", "cottoncpp", "cottoncpp"),
  project("ws_cpa", "cpa-stack", "work-dev-sg"),
  project("ws_ccm", "ccm", "work-dev"),
  project("ws_ccmh", "ccm-harness", "work-dev"),
  project("ws_ws1", "workspace", "work-dev"),
  project("ws_ws2", "workspace", "macbook"),
  project("ws_ai", "ai", "macbook"),
  project("ws_home", "家庭记账", "mac-mini"),
  project("ws_foundry", "foundry", "sg-chaos"),
  project("ws_jobs", "job-hunting", "macbook"),
];

const mentionCases = [
  ["unquoted name", "我在你的 cottoncpp 项目里没找到", ["ws_cotton"]],
  ["quoted name", "在『cottoncpp』里没有", ["ws_cotton"]],
  ["name next to its computer", "dev-sg 上的 cpa-stack 还没上线", ["ws_cpa"]],
  ["ref form name@computer", "ccm-harness@work-dev 没在线", ["ws_ccmh"]],
  ["hyphen is part of the name", "ccm-harness 的 hub 我查不到", ["ws_ccmh"]],
  ["unquoted CJK name", "家庭记账的网页我没法看", ["ws_home"]],
  ["shared name, computer named", "workspace on work-dev 离线", ["ws_ws1"]],
  ["shared name, no computer: not decided", "那个 workspace 离线了", []],
  ["ASCII name under three characters", "ai 相关的我没法看", []],
  ["no project named", "我查不到，电脑都离线", []],
  [
    "product word Foundry is not a project mention",
    "Foundry 的安全性我没法查",
    [],
  ],
  [
    "quoted project name foundry names it",
    "『foundry』那台电脑离线",
    ["ws_foundry"],
  ],
  [
    "two projects: product word and a real one",
    "cottoncpp 和 Foundry 都在",
    ["ws_cotton"],
  ],
];

const outcomeCases = [
  [
    "dispatch_item to a project",
    [tool("dispatch_item", { workspaceId: "ws_proj" })],
    "ok",
    { decision: "project", workspaceId: "ws_proj" },
  ],
  [
    "needs_you ask card, no question in reply",
    [tool("needs_you", { op: "ask", question: "哪个？" })],
    "好的",
    { decision: "ask" },
  ],
  ["plain answer", [], "这是答案。", { decision: "answer" }],
  [
    "create_session with no workspace is the assistant's own",
    [tool("create_session", {})],
    "ok",
    { decision: "answer" },
  ],
  [
    "offline project named in reply",
    [],
    "我在你的 cottoncpp 项目里没找到，电脑离线",
    { decision: "answer", mentionedProject: "ws_cotton" },
  ],
  [
    "two offline projects named: not decided",
    [],
    "cottoncpp 和 cpa-stack 都离线",
    { decision: "answer" },
  ],
];

// The judge's reading of whether a reply asks (--judge) replaces the
// question mark; card asks always ask.
const judgedCases = [
  [
    "judge: no ask although the reply ends with a question; names a project",
    [],
    "简化版我先列在下面。cottoncpp 那台电脑开机后我再去找完整版，好吗？",
    { asks: false },
    { decision: "answer", mentionedProject: "ws_cotton" },
  ],
  [
    "judge: asks without a question mark (numbered options)",
    [],
    "我找到两个，不确定要改哪一个：\n1. 第一个\n2. 第二个",
    { asks: true },
    { decision: "ask" },
  ],
  [
    "judge: asks for a missing link without a question mark",
    [],
    "你可以把订阅地址重新发给我。",
    { asks: true },
    { decision: "ask" },
  ],
  [
    "judge says no ask, but a question card was put on the list",
    [tool("needs_you", { op: "ask" })],
    "好的",
    { asks: false },
    { decision: "ask" },
  ],
  [
    "judge says asks, but the assistant dispatched: dispatch decides",
    [tool("dispatch_item", { workspaceId: "ws_proj" })],
    "开始了，要我顺便看看别的吗",
    { asks: true },
    { decision: "project", workspaceId: "ws_proj" },
  ],
  ["no judge: a question mark asks", [], "要我做吗？", {}, { decision: "ask" }],
  [
    "judge: an offer after a finished answer is not an ask",
    [],
    "报告整理好了，要点都列在上面。要我顺便再查一下别的群吗？",
    { asks: false },
    { decision: "answer" },
  ],
  [
    "judge: a saved change with an optional yes/no is not an ask",
    [tool("remember", { op: "add" })],
    "好的，已记下：周末不给您发工作上的事。您要关掉吗？",
    { asks: false },
    { decision: "answer" },
  ],
  [
    "judge: a side-term question after a full answer is not an ask",
    [],
    "abase 是「贬低」的意思。RU 我不确定你指什么，是俄罗斯吗？",
    { asks: false },
    { decision: "answer" },
  ],
  [
    "judge: a Feishu permission card (needs_you op list) is not an ask",
    [tool("needs_you", { op: "list" })],
    "我还不能读飞书对话：系统要你先确认，确认卡同意后我再去看。",
    { asks: false },
    { decision: "answer" },
  ],
  [
    "judge: a blocking choice with a question card is an ask",
    [tool("needs_you", { op: "ask" })],
    "两个都可以，你选哪个？",
    { asks: true },
    { decision: "ask" },
  ],
  [
    "judge: a missing name is an ask",
    [],
    "“某人”是哪位？告诉我名字，我就去对。",
    { asks: true },
    { decision: "ask" },
  ],
];

// A reply naming only a computer names the one project the assistant looked
// into there.
const computerCases = [
  [
    "computer named, one project looked into there",
    [tool("get_workspace", { workspaceId: "ws_jobs" })],
    "JD 文件夹在你的 MacBook 上，这台电脑现在不在线",
    "ws_jobs",
  ],
  [
    "computer named, two projects looked into there",
    [
      tool("get_workspace", { workspaceId: "ws_jobs" }),
      tool("read_context", { workspaceId: "ws_ai" }),
    ],
    "在你的 MacBook 上，电脑不在线",
    "",
  ],
  [
    "computer named, no project looked into",
    [tool("list_workspaces")],
    "在你的 MacBook 上，电脑不在线",
    "",
  ],
  [
    "project looked into on another computer",
    [tool("get_workspace", { workspaceId: "ws_ccm" })],
    "在你的 MacBook 上，电脑不在线",
    "",
  ],
  [
    "two computers named",
    [tool("get_workspace", { workspaceId: "ws_jobs" })],
    "MacBook 和 work-dev 都不在线",
    "",
  ],
  [
    "computer name inside a longer name is not the computer",
    [tool("get_workspace", { workspaceId: "ws_ccm" })],
    "work-dev-sg 不在线",
    "",
  ],
];

// Tool events as the worker writes them: two-space JSON cut at 1600
// characters.
const toolEvent = (detail, label = "Used tool") => ({
  label,
  detail,
  message: { kind: "tool" },
});
const parseCases = [
  [
    "whole JSON block",
    toolEvent(
      'mcp__foundry__needs_you\n\n```json\n{\n  "op": "ask",\n  "question": "哪个？"\n}\n```',
    ),
    { name: "needs_you", op: "ask", failed: false },
  ],
  [
    "cut block, op before the cut",
    toolEvent(
      'mcp__foundry__needs_you\n\n```json\n{\n  "op": "ask",\n  "question": "很长\n\n... truncated ...\n```',
    ),
    { name: "needs_you", op: "ask", failed: false },
  ],
  [
    "cut block, op after the cut is missing",
    toolEvent(
      'mcp__foundry__needs_you\n\n```json\n{\n  "question": "很长\n\n... truncated ...\n```',
    ),
    { name: "needs_you", op: undefined, failed: false },
  ],
  [
    "failed dispatch keeps its workspace",
    toolEvent(
      'mcp__foundry__dispatch_item\n\n```json\n{\n  "workspaceId": "ws_x"\n}\n```\n\nError\n\n```\noffline\n```',
      "Tool failed",
    ),
    { name: "dispatch_item", workspaceId: "ws_x", failed: true },
  ],
];

let failures = 0;
const run = (name, fn) => {
  try {
    fn();
    console.log("PASS", name);
  } catch (error) {
    failures++;
    console.log("FAIL", name, "-", error.message);
  }
};

for (const [name, reply, want] of mentionCases)
  run(`mention: ${name}`, () => {
    assert.deepEqual(mentionedProjects(reply, offline), want);
  });

for (const [name, tools, reply, want] of outcomeCases)
  run(`outcome: ${name}`, () => {
    const got = classifyOutcome(tools, reply, assistant, offline);
    assert.equal(got.decision, want.decision);
    if (want.workspaceId) assert.equal(got.workspaceId, want.workspaceId);
    if (want.mentionedProject !== undefined)
      assert.equal(got.mentionedProject, want.mentionedProject);
  });

for (const [name, tools, reply, judged, want] of judgedCases)
  run(`outcome: ${name}`, () => {
    const got = classifyOutcome(tools, reply, assistant, offline, judged);
    assert.equal(got.decision, want.decision);
    if (want.workspaceId) assert.equal(got.workspaceId, want.workspaceId);
    if (want.mentionedProject !== undefined)
      assert.equal(got.mentionedProject, want.mentionedProject);
  });

for (const [name, tools, reply, want] of computerCases)
  run(`computer: ${name}`, () => {
    assert.equal(projectByComputer(reply, tools, offline), want);
  });

run(
  "outcome: computer named, one project looked into: diagnostic, still an answer",
  () => {
    const got = classifyOutcome(
      [tool("get_workspace", { workspaceId: "ws_jobs" })],
      "JD 文件夹在你的 MacBook 上，这台电脑现在不在线，开机后告诉我。",
      assistant,
      offline,
    );
    assert.deepEqual(got, {
      decision: "answer",
      mentionedProject: "ws_jobs",
    });
  },
);

for (const [name, event, want] of parseCases)
  run(`parse: ${name}`, () => {
    const got = parseToolEvent(event);
    assert.equal(got.name, want.name);
    assert.equal(got.failed, want.failed);
    if ("op" in want) assert.equal(got.args.op, want.op);
    if (want.workspaceId) assert.equal(got.args.workspaceId, want.workspaceId);
  });

// Blocking asks per request: question cards plus the reply's ask when no work
// was started; an offer after started work does not block.
const blockingCases = [
  [
    "offer after dispatched work is not blocking",
    [tool("dispatch_item", { workspaceId: "ws_proj" })],
    "开始了。要我顺便看看别的吗？",
    { asks: true },
    0,
  ],
  [
    "blocking choice with no work started is one",
    [],
    "两个都在，要哪个？",
    { asks: true },
    1,
  ],
  [
    "question card (op ask) is one blocking ask",
    [tool("needs_you", { op: "ask" })],
    "好的",
    { asks: false },
    1,
  ],
  [
    "permission card (op list) is not blocking",
    [tool("needs_you", { op: "list" })],
    "请确认飞书卡片",
    { asks: false },
    0,
  ],
  ["no judge: a question mark is one", [], "要我做吗？", {}, 1],
];

for (const [name, tools, reply, judged, want] of blockingCases)
  run(`blocking asks: ${name}`, () => {
    assert.equal(blockingAsksOf(tools, reply, assistant, judged), want);
  });

run("question cards: op list is not a question card", () => {
  assert.equal(
    cardAsksIn([
      tool("needs_you", { op: "list" }),
      tool("needs_you", { op: "ask" }),
    ]),
    1,
  );
});

run("questions per request: raw question marks are still counted", () => {
  assert.equal(questionsIn("要我顺便看看别的吗？这个呢？"), 2);
});

run("judge answer: well-formed array", () => {
  const got = parseJudgeAnswer(
    'Here:\n[{"id": "a", "plain": true, "multipleQuestions": false, "asks": true, "reason": "x"}]',
  );
  assert.deepEqual(got, [
    { id: "a", plain: true, multipleQuestions: false, asks: true, reason: "x" },
  ]);
});

run(
  "judge answer: one item missing a key keeps the others and its readings",
  () => {
    const got = parseJudgeAnswer(`[
 {"id": "a", "plain": true, "multipleQuestions": false, "asks": false, "reason": "ok"},
 {"id": "b", "plain": true, "multipleQuestions": false, "asks": false, "reports the work started."},
 {"id": "c", "plain": false, "multipleQuestions": false, "asks": true, "reason": "asks"}
]`);
    assert.deepEqual(
      got.map((v) => [v.id, v.asks]),
      [
        ["a", false],
        ["b", false],
        ["c", true],
      ],
    );
    assert.equal(got[1].plain, true);
  },
);

run("judge answer: no array", () => {
  assert.deepEqual(parseJudgeAnswer("I cannot rate these."), []);
});

process.exit(failures ? 1 : 0);
