import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";

import {
  computeDay,
  earnsNotice,
  isChase,
  loadContext,
  longestUncovered,
  openDatabase,
  personTexts,
  renderDay,
  summarize,
} from "./assistant-trial-readings.mjs";

// The tables the script reads, as the dev Server database creates them
// (sqlite_master on ~/.foundry/server/foundry.db, 2026-11-23).
const SCHEMA = `
CREATE TABLE "users" (
  id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')), password_hash TEXT NOT NULL, disabled_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, locale TEXT NOT NULL DEFAULT '');
CREATE TABLE assistants (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', is_default INTEGER NOT NULL DEFAULT 0,
  home_workspace_id TEXT NOT NULL UNIQUE, home_device_id TEXT NOT NULL, state TEXT NOT NULL, settings_json TEXT NOT NULL,
  permission_package_id TEXT NOT NULL DEFAULT '', prompt_version TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, stopped_at TEXT NOT NULL DEFAULT '', former_workspace_ids TEXT NOT NULL DEFAULT '[]',
  digest_sent_on TEXT NOT NULL DEFAULT '', connector_opt_out TEXT NOT NULL DEFAULT '[]',
  home_answer_at TEXT NOT NULL DEFAULT '', home_seen_at TEXT NOT NULL DEFAULT '');
CREATE TABLE pa_inbox (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, channel TEXT NOT NULL, message_id TEXT NOT NULL, text TEXT NOT NULL,
  status TEXT NOT NULL, revision INTEGER NOT NULL, input_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL DEFAULT '',
  waiting_reason TEXT NOT NULL DEFAULT '', lease_until TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, origin_json TEXT NOT NULL DEFAULT 'null', root_id TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT '', result_status TEXT NOT NULL DEFAULT '', result_text TEXT NOT NULL DEFAULT '',
  result_error TEXT NOT NULL DEFAULT '', result_truncated INTEGER NOT NULL DEFAULT 0, notify_pending INTEGER NOT NULL DEFAULT 0,
  assistant_id TEXT NOT NULL DEFAULT '', dismissed_by TEXT NOT NULL DEFAULT '', dismissed_at TEXT NOT NULL DEFAULT '',
  attachments_json TEXT NOT NULL DEFAULT '[]', annotations_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE(user_id, channel, message_id));
CREATE TABLE usage_turns (
  session_id TEXT NOT NULL, input_id TEXT NOT NULL, user_id TEXT NOT NULL DEFAULT '', workspace_id TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL DEFAULT '', parent_session_id TEXT NOT NULL DEFAULT '',
  entry TEXT NOT NULL CHECK (entry IN ('chat', 'chat_child', 'assistant', 'assistant_helper', 'issue', 'utility')),
  runtime TEXT NOT NULL DEFAULT '', profile_id TEXT NOT NULL DEFAULT '', provider_label TEXT NOT NULL DEFAULT '',
  requested_model TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0, model_ms INTEGER NOT NULL DEFAULT 0, ttft_ms INTEGER NOT NULL DEFAULT 0,
  timing_estimated INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  model_requests INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
  cost_source TEXT NOT NULL CHECK (cost_source IN ('reported', 'estimated', 'custom', 'unknown')),
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'canceled')), error_class TEXT NOT NULL DEFAULT '',
  UNIQUE (session_id, input_id));
CREATE TABLE message_channel_sessions (
  session_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, assistant_id TEXT NOT NULL, session_key TEXT NOT NULL,
  segment INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL, device_id TEXT NOT NULL, provider TEXT NOT NULL,
  status TEXT NOT NULL, parent_session_id TEXT NOT NULL DEFAULT '', payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, activity_at TEXT NOT NULL DEFAULT '');
CREATE TABLE agent_session_events (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, level TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
  state_key TEXT);
CREATE TABLE pending_items (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '',
  issue_id TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, item_key TEXT NOT NULL, state TEXT NOT NULL, payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT NOT NULL DEFAULT '', handler TEXT NOT NULL DEFAULT 'person',
  assistant_id TEXT NOT NULL DEFAULT '', deadline_at TEXT NOT NULL DEFAULT '', acknowledged_at TEXT NOT NULL DEFAULT '',
  notified_at TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL DEFAULT '');
CREATE TABLE person_notices (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, assistant_id TEXT NOT NULL DEFAULT '', item_id TEXT NOT NULL, kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', options_json TEXT NOT NULL DEFAULT '[]',
  allow_free_text INTEGER NOT NULL DEFAULT 0, link TEXT NOT NULL DEFAULT '', sink_id TEXT NOT NULL, target TEXT NOT NULL DEFAULT '',
  provider_message_id TEXT NOT NULL DEFAULT '', state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT '', ambiguous_at TEXT NOT NULL DEFAULT '', error_reason TEXT NOT NULL DEFAULT '',
  answered_by TEXT NOT NULL DEFAULT '', answer_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  card_stale INTEGER NOT NULL DEFAULT 0);
CREATE TABLE pa_items (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, text TEXT NOT NULL, when_text TEXT NOT NULL DEFAULT '', at TEXT NOT NULL DEFAULT '',
  remind INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, quote TEXT NOT NULL DEFAULT '', task_id TEXT NOT NULL DEFAULT '',
  source_session_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT NOT NULL DEFAULT '',
  reminded_at TEXT NOT NULL DEFAULT '', intent_revision INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1,
  source_input_id TEXT NOT NULL DEFAULT '', source_inbox_id TEXT NOT NULL DEFAULT '', capture_key TEXT NOT NULL DEFAULT '',
  capture_hash TEXT NOT NULL DEFAULT '', plan_json TEXT NOT NULL DEFAULT 'null', assistant_id TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT 'person', summary TEXT NOT NULL DEFAULT '', origin_json TEXT NOT NULL DEFAULT '',
  archived_at TEXT NOT NULL DEFAULT '', home_workspace_id TEXT NOT NULL DEFAULT '', holder_session_id TEXT NOT NULL DEFAULT '');
CREATE TABLE pa_item_events (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT '', assistant_id TEXT NOT NULL DEFAULT '', item_id TEXT NOT NULL,
  at TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE pa_item_helpers (
  session_id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, item_id TEXT NOT NULL, created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', ended_at TEXT NOT NULL DEFAULT '');
CREATE TABLE feishu_gateway_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_ref TEXT NOT NULL DEFAULT '', session_ref TEXT NOT NULL DEFAULT '',
  device_ref TEXT NOT NULL DEFAULT '', workspace_ref TEXT NOT NULL DEFAULT '', account_ref TEXT NOT NULL DEFAULT '',
  app_ref TEXT NOT NULL DEFAULT '', identity TEXT NOT NULL DEFAULT '', method TEXT NOT NULL, path TEXT NOT NULL,
  status INTEGER NOT NULL, bytes_in INTEGER NOT NULL DEFAULT 0, bytes_out INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0, outcome TEXT NOT NULL);
CREATE TABLE pa_upkeep_notices(assistant_id TEXT PRIMARY KEY,signature TEXT NOT NULL,notified_at TEXT NOT NULL);
`;

const USER = "user_test";
const ASSISTANT = "asst_test";
const NOW = Date.parse("2026-11-23T00:00:00Z");

let dir;
let db;

// Inserts a row, filling the NOT NULL columns without a default the test
// does not care about.
function insert(w, table, row) {
  const filled = { ...row };
  for (const col of w.prepare(`PRAGMA table_info(${table})`).all()) {
    if (
      col.notnull &&
      col.dflt_value === null &&
      !col.pk &&
      !(col.name in filled)
    )
      filled[col.name] = /INT|REAL/.test(col.type) ? 0 : "";
  }
  const cols = Object.keys(filled);
  w.prepare(
    `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
  ).run(...cols.map((c) => filled[c]));
}

function userMessage(w, sessionId, inputId, at, text) {
  insert(w, "agent_session_events", {
    id: `evt_${inputId}`,
    session_id: sessionId,
    level: "info",
    created_at: at,
    payload_json: JSON.stringify({
      label: "User message",
      metadata: { inputSource: { kind: "person" } },
      message: { id: inputId, kind: "user", text },
    }),
  });
}

function responseStream(w, sessionId, inputId, at, detail) {
  insert(w, "agent_session_events", {
    id: `evt_${sessionId}_${inputId}_response_stream`,
    session_id: sessionId,
    level: "info",
    created_at: at,
    payload_json: JSON.stringify({ label: "Response stream", detail }),
  });
}

function build(path) {
  const w = new DatabaseSync(path);
  w.exec(SCHEMA);
  insert(w, "users", {
    id: USER,
    username: "windeng",
    username_key: "windeng",
    display_name: "W",
    role: "admin",
  });
  insert(w, "assistants", {
    id: ASSISTANT,
    owner_user_id: USER,
    is_default: 1,
    home_workspace_id: "ws_home",
    home_device_id: "dev_1",
    state: "active",
    settings_json: "{}",
  });
  // Two web messages to the assistant, the second a chase; then a synthetic one with no answer.
  const inbox = (id, input, at, text) =>
    insert(w, "pa_inbox", {
      id,
      user_id: USER,
      channel: "web",
      message_id: id,
      text,
      status: "resolved",
      revision: 1,
      input_id: input,
      session_id: "sess_home",
      assistant_id: ASSISTANT,
      created_at: at,
      updated_at: at,
    });
  inbox("inbox_1", "in1", "2026-11-21T02:00:00Z", "帮我查一下出差政策");
  userMessage(
    w,
    "sess_home",
    "in1",
    "2026-11-21T02:00:01Z",
    "帮我查一下出差政策",
  );
  responseStream(
    w,
    "sess_home",
    "in1",
    "2026-11-21T02:00:31Z",
    "好的，我派人去查。",
  );
  inbox("inbox_2", "in2", "2026-11-21T02:10:00Z", "怎么样了？");
  userMessage(w, "sess_home", "in2", "2026-11-21T02:10:00Z", "怎么样了？");
  responseStream(w, "sess_home", "in2", "2026-11-21T02:10:20Z", "还在查。");
  inbox(
    "inbox_3",
    "in3",
    "2026-11-21T07:00:00Z",
    "合成验证 DEV-999：请只回复 OK",
  );
  insert(w, "agent_sessions", {
    id: "sess_helper",
    workspace_id: "ws_work",
    agent_id: "a",
    device_id: "dev_1",
    provider: "claude",
    status: "completed",
    parent_session_id: "sess_home",
    payload_json: "{}",
    created_at: "2026-11-21T02:01:00Z",
    updated_at: "2026-11-21T02:30:00Z",
  });

  // The item the first message became, with one helper; it is closed while its wait is open.
  insert(w, "pa_items", {
    id: "pai_1",
    user_id: USER,
    text: "查出差政策",
    status: "done",
    owner: "assistant",
    assistant_id: ASSISTANT,
    source_session_id: "sess_home",
    source_inbox_id: "inbox_1",
    created_at: "2026-11-21T02:00:40Z",
    updated_at: "2026-11-21T06:00:00Z",
    closed_at: "2026-11-21T06:00:00Z",
    summary: "查到了，附出处。",
  });
  const ev = (id, at, kind, detail = {}) =>
    insert(w, "pa_item_events", {
      id,
      user_id: USER,
      assistant_id: ASSISTANT,
      item_id: "pai_1",
      at,
      actor: "assistant",
      kind,
      detail_json: JSON.stringify(detail),
    });
  ev("e1", "2026-11-21T02:00:40Z", "created");
  ev("e2", "2026-11-21T02:01:00Z", "helper_started", {
    sessionId: "sess_helper",
  });
  ev("e3", "2026-11-21T02:30:00Z", "helper_ended", {
    sessionId: "sess_helper",
  });
  ev("e4", "2026-11-21T06:00:00Z", "status_changed");
  insert(w, "pa_item_helpers", {
    session_id: "sess_helper",
    assistant_id: ASSISTANT,
    item_id: "pai_1",
    created_at: "2026-11-21T02:01:00Z",
    status: "done",
    ended_at: "2026-11-21T02:30:00Z",
  });

  // A question in a chat: asked 30s before it entered Needs you, card sent 90s later, answered and delivered.
  const pending = (row) =>
    insert(w, "pending_items", {
      user_id: USER,
      workspace_id: "ws_work",
      item_key: row.id,
      updated_at: row.created_at,
      ...row,
    });
  insert(w, "agent_session_events", {
    id: "evt_q1",
    session_id: "sess_chat",
    level: "info",
    created_at: "2026-11-21T02:59:30Z",
    payload_json: JSON.stringify({
      label: "Response stream",
      detail: "选 A 还是 B？",
    }),
  });
  pending({
    id: "pnd_q1",
    session_id: "sess_chat",
    source: "question",
    state: "replied",
    outcome: "person_answered",
    created_at: "2026-11-21T03:00:00Z",
    resolved_at: "2026-11-21T03:20:00Z",
    payload_json: JSON.stringify({
      title: "选 A 还是 B？",
      messageId: "m1/c1",
      eventId: "evt_q1",
    }),
  });
  insert(w, "person_notices", {
    id: "n1",
    user_id: USER,
    item_id: "pnd_q1",
    kind: "question",
    sink_id: "builtin:feishu",
    provider_message_id: "om_1",
    state: "sent",
    created_at: "2026-11-21T03:00:10Z",
    updated_at: "2026-11-21T03:01:30Z",
  });
  userMessage(w, "sess_chat", "in_answer", "2026-11-21T03:20:02Z", "A");
  // A native question that expired after 3 minutes with no card.
  pending({
    id: "pnd_q2",
    session_id: "sess_chat",
    source: "question",
    state: "superseded",
    outcome: "auto_resolved",
    created_at: "2026-11-21T04:00:00Z",
    resolved_at: "2026-11-21T04:03:00Z",
    payload_json: JSON.stringify({
      title: "要不要继续？",
      messageId: "m2/c2",
      rule: "held",
    }),
  });
  // The item's wait on the person: card sent 4 minutes after it opened; still open.
  pending({
    id: "pnd_w1",
    source: "item_wait",
    state: "open",
    assistant_id: ASSISTANT,
    created_at: "2026-11-21T05:00:00Z",
    payload_json: JSON.stringify({
      title: "请确认结论",
      waitItemId: "pai_1",
      eventId: "item_wait:pai_1:abc@2026-11-21T04:59:58Z",
    }),
  });
  insert(w, "person_notices", {
    id: "n3",
    user_id: USER,
    assistant_id: ASSISTANT,
    item_id: "pnd_w1",
    kind: "ask",
    sink_id: "builtin:feishu",
    provider_message_id: "om_3",
    state: "sent",
    created_at: "2026-11-21T05:00:01Z",
    updated_at: "2026-11-21T05:04:00Z",
  });
  // A failure: Needs you lists it, no card by design.
  pending({
    id: "pnd_f1",
    session_id: "sess_chat",
    source: "turn_failed",
    state: "done",
    created_at: "2026-11-21T08:00:00Z",
    payload_json: JSON.stringify({ title: "429" }),
  });
  w.close();
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "assistant-trial-"));
  const path = join(dir, "foundry.db");
  build(path);
  db = openDatabase(path);
});

after(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a day with assistant traffic", () => {
  const ctx = loadContext(db, "windeng");
  const d = computeDay(db, ctx, "2026-11-21", NOW);
  const s = summarize(d);

  assert.equal(s.requests, 3);
  assert.equal(s.replyMedian, 20_000);
  assert.equal(s.replyP90, 31_000);
  assert.equal(s.noReply, 1);
  assert.equal(s.chases, 1);
  assert.equal(d.requests[0].dispatch.ms, 60_000);
  assert.equal(s.synthetic, 1);

  assert.equal(s.items, 1);
  assert.equal(d.items[0].createMs, 40_000);
  assert.equal(d.items[0].quietMs, 3.5 * 3600_000);

  assert.equal(s.waits, 3);
  const q1 = d.waits.find((w) => w.id === "pnd_q1");
  assert.equal(q1.entryMs, 30_000);
  assert.equal(q1.sentMs, 90_000);
  assert.equal(q1.answerBack, true);
  const q2 = d.waits.find((w) => w.id === "pnd_q2");
  assert.equal(q2.noticeState, "none");
  assert.equal(q2.ending, "ended_unanswered");
  assert.equal(d.waits.find((w) => w.id === "pnd_w1").entryMs, 2_000);
  assert.equal(s.missed, 1);
  assert.equal(s.lateCard, 1);
  assert.equal(s.endedUnanswered, 1);
  assert.equal(s.stillOpen, 1);
  assert.equal(s.closedWithOpen, 1);
  assert.deepEqual(d.closed[0].openRequests, ["pnd_w1"]);
  assert.equal(s.asks, 1);
  assert.deepEqual(d.otherPending, [["turn_failed", 1]]);

  const page = renderDay(d);
  assert.match(page, /# 助理试用读数 2026-11-21\n/);
  assert.doesNotMatch(page, /无助理流量/);
  assert.match(page, /`pnd_q2`|pnd_q2/);
});

test("a day with no assistant traffic says so", () => {
  const ctx = loadContext(db, "windeng");
  const d = computeDay(db, ctx, "2026-11-19", NOW);
  const s = summarize(d);
  assert.equal(s.requests, 0);
  assert.equal(s.waits, 0);
  assert.equal(s.missed, 0);
  const page = renderDay(d);
  assert.match(page, /无助理流量/);
  assert.match(page, /不代表达标/);
});

test("helpers", () => {
  assert.deepEqual(
    personTexts(
      "mc:x",
      "message 1:\n  sender is the person: yes\n  text without trigger: 重跑那批\nmessage 2:\n  sender is the person: no\n  text: 好的\n",
    ),
    ["重跑那批"],
  );
  assert.equal(isChase("怎么样了？"), true);
  assert.equal(isChase("？"), true);
  assert.equal(
    isChase("帮我看看这个方案怎么样，顺便把三个备选都列出来再比较一下"),
    false,
  );
  assert.equal(
    earnsNotice({ source: "turn_failed", handler: "person" }, {}),
    false,
  );
  assert.equal(
    earnsNotice(
      { source: "question", handler: "assistant" },
      { title: "x", messageId: "m" },
    ),
    false,
  );
  assert.equal(
    earnsNotice(
      { source: "question", handler: "person" },
      { title: "x", handedAt: "t" },
    ),
    true,
  );
  assert.equal(
    longestUncovered(0, 100, [
      [10, 20],
      [15, 40],
      [90, 95],
    ]),
    50,
  );
});
