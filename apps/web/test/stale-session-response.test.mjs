import assert from "node:assert/strict";
import test from "node:test";
import { applyFoundryStreamEvent } from "../src/app/foundry-data-projection.ts";
import {
  chatMessagesForThread,
  chatThreadsFromSessions,
} from "../src/features/chat/chat-model.ts";
import { mergeLoadedAgentSession } from "../src/lib/agent-session-events.ts";

// The shape of a real chat (2026-10-10): one session, one input per turn,
// each turn's answer under `evt_<session>_<input>_response_stream[_N]`.
const sessionId = "sess_1791537694112193282";
const turns = [
  {
    input: "01a1236e-832c-7716-9e57-915cda179e55",
    prompt: "Run failed: Claude Agent SDK …",
    answers: [
      ["_response_stream", "这个报错是 Foundry 自己报出来的"],
      ["_response_stream_2", "这个报错是 Foundry 自己报出来的，不是 Claude"],
      ["_response_stream_3", "查了最近所有这种失败：会话 设备 失败时间"],
    ],
  },
  {
    input: "01a1239d-0f2e-7f97-904c-052ff3b085bf",
    prompt: "图一：你这是干嘛呀？",
    answers: [["_response_stream", "已经开工，两个子 agent 并行"]],
  },
  {
    input: "01a1239e-8d2b-7d02-b93f-460e6be26018",
    prompt: '"10 分钟没有事件" 这个很显然就不应该判死啊',
    answers: [["_response_stream", "明白，从根上改，已经派子 agent 去做"]],
  },
];
const staleResponse = turns[0].answers[2][1];

function eventsFor(list) {
  let second = 0;
  const at = () =>
    `2026-10-10T02:${String(10 + Math.floor(second / 60)).padStart(2, "0")}:${String(second++ % 60).padStart(2, "0")}Z`;
  return list.flatMap((turn) => [
    {
      id: `evt_${turn.input}`,
      sessionId,
      at: at(),
      label: "User message",
      level: "info",
      detail: "",
      message: { id: turn.input, kind: "user", text: turn.prompt },
    },
    {
      id: `evt_${sessionId}_${turn.input}_thinking`,
      sessionId,
      at: at(),
      label: "Thinking",
      level: "info",
      detail: "thinking",
    },
    ...turn.answers.map(([suffix, text]) => ({
      id: `evt_${sessionId}_${turn.input}${suffix}`,
      sessionId,
      at: at(),
      label: "Response stream",
      level: "info",
      detail: text,
    })),
  ]);
}

function session(overrides) {
  const last = turns[turns.length - 1];
  return {
    id: sessionId,
    threadId: sessionId,
    workspaceId: "ws_test",
    agentId: "agent_test",
    deviceId: "dev_test",
    provider: "claude",
    source: "chat",
    status: "completed",
    title: "chat",
    prompt: last.prompt,
    input: { id: last.input, prompt: last.prompt },
    response: last.answers[last.answers.length - 1][1],
    createdLabel: "today",
    updatedLabel: "completed",
    events: eventsFor(turns),
    ...overrides,
  };
}

/** Each user prompt with the answer text shown after it. */
function shownAnswers(value) {
  const thread = chatThreadsFromSessions([value])[0];
  const messages = chatMessagesForThread(thread, {
    suppressedResponseFingerprints: new Set(),
  });
  const answers = [];
  let current;
  for (const message of messages) {
    if (message.role === "user") {
      current = { prompt: String(message.text), answer: undefined };
      answers.push(current);
    } else if (current && message.kind === undefined) {
      current.answer = String(message.text);
    }
  }
  return answers.map(({ prompt, answer }) => [prompt, answer]);
}

const expected = turns.map((turn) => [
  turn.prompt,
  turn.answers[turn.answers.length - 1][1],
]);

test("a stale response on the live path leaves every turn's answer its own", () => {
  let shown = session();
  // SSE session payloads without events, carrying an older turn's answer:
  // a running one (the server keeps the previous response while a turn
  // runs) and a completed one (its own completion was missed).
  for (const status of ["running", "completed"]) {
    shown = mergeLoadedAgentSession(shown, {
      ...session({ status, response: staleResponse }),
      events: undefined,
    });
    assert.deepEqual(shownAnswers(shown), expected);
  }
  // The stored events are what the server sent, never display text.
  assert.deepEqual(
    shown.events.map((event) => event.detail),
    eventsFor(turns).map((event) => event.detail),
  );
});

test("a stale response through the stream projection leaves answers intact", () => {
  const data = { workspace: { id: "ws_test" }, agentSessions: [session()] };
  const next = applyFoundryStreamEvent(data, {
    type: "agent_session_completed",
    payload: { ...session({ response: staleResponse }), events: undefined },
  });
  assert.deepEqual(shownAnswers(next.agentSessions[0]), expected);
});

test("a stale response with a full snapshot leaves every turn's answer its own", () => {
  const merged = mergeLoadedAgentSession(
    session(),
    session({ response: staleResponse }),
  );
  assert.deepEqual(shownAnswers(merged), expected);
  const fresh = mergeLoadedAgentSession(
    undefined,
    session({ response: staleResponse }),
  );
  assert.deepEqual(shownAnswers(fresh), expected);
});

test("a new turn without its answer yet never shows the previous answer", () => {
  const next = {
    input: "01a1239f-46ce-7ff5-92ef-2ee4e0fd1fab",
    prompt: "还有就是title的那个“✅”",
    answers: [],
  };
  const running = session({
    status: "running",
    input: { id: next.input, prompt: next.prompt },
    // The server has not cleared the previous turn's answer.
    response: turns[2].answers[0][1],
    events: eventsFor([...turns, next]),
  });
  const answers = shownAnswers(running);
  assert.deepEqual(answers.slice(0, 3), expected);
  assert.equal(answers[3][0], next.prompt);
  assert.equal(answers[3][1], undefined);
});

test("a finished turn whose answer events were missed still shows its answer", () => {
  const next = {
    input: "01a1239f-46ce-7ff5-92ef-2ee4e0fd1fab",
    prompt: "还有就是title的那个“✅”",
    answers: [],
  };
  const completed = session({
    input: { id: next.input, prompt: next.prompt },
    response: "改好了，已经部署到 dev",
    events: eventsFor([...turns, next]),
  });
  const answers = shownAnswers(completed);
  assert.deepEqual(answers.slice(0, 3), expected);
  assert.deepEqual(answers[3], [next.prompt, "改好了，已经部署到 dev"]);
  // A stale response (an earlier answer) is not shown there instead.
  const stale = shownAnswers({ ...completed, response: staleResponse });
  assert.deepEqual(stale.slice(0, 3), expected);
  assert.equal(stale[3][1], undefined);
});
