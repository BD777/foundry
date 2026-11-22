#!/usr/bin/env node
// Daily readings of the assistant trial's exit criteria (G1–G8 in
// .foundry/reports/assistant-trust-audit-20261122.md §4), read from the
// Server database only. The database is opened read-only; nothing is sent.
//
//   node scripts/assistant-trial-readings.mjs [--date YYYY-MM-DD | --days N]
//     [--db PATH] [--user USERNAME] [--out-dir DIR]
//
// Days are Asia/Shanghai calendar days (UTC+8, no DST). --days N (default 1)
// writes the last N days ending today; today is partial.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const DEFAULT_DB = join(homedir(), ".foundry/server/foundry.db");
export const DEFAULT_OUT_DIR = join(
  homedir(),
  "workspace/foundry/.foundry/reports/assistant-trial",
);
export const CHAT_LINK = "https://dev.foundryapp.app/chats/";

const HOUR = 3600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;
const TZ_OFFSET = 8 * HOUR;

export const TARGETS = {
  itemCreateMs: MINUTE, // G2: on the list within 1 minute of the request
  itemLongMs: 10 * MINUTE, // G2: work longer than this must show its step
  noticeMs: 2 * MINUTE, // G3: Needs you entry to card sent
  chaseWindowMs: 30 * MINUTE, // G1: a follow-up this soon after the last message
  answerBackMs: 10 * MINUTE, // G3: an answer arriving in its session this soon
};

// Heuristics, labelled as such on the page.
export const SYNTHETIC_RE = /合成|\[测试\]|DEV-\d+|e2e-|smoke|synthetic/i;
export const CHASE_RE =
  /怎么样|进展|进度|好了[吗没]|还没|在吗|结果呢|回复呢|嗯[？?]|^[?？]+$/;
const CHASE_MAX_CHARS = 20;
const SEND_COMMAND_RE =
  /\b((?:olk|feishu-cli|lark-cli)\s+(?:im|msg)\s+(?:reply|send|post|forward|edit|\+messages-send|\+messages-reply)\b(?:\s+[\w:.-]+)?)/;

// Sources and states, as the Server defines them (apps/server/internal/store/pending_items.go).
const RETIRED_SOURCES = new Set(["project_upkeep", "memory_upkeep"]);
const NO_DECISION_SOURCES = new Set([
  "notice",
  "project_upkeep",
  "memory_upkeep",
]);

// ---------- small helpers ----------

export function dayWindow(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error(`not a YYYY-MM-DD date: ${date}`);
  const start = Date.parse(`${date}T00:00:00+08:00`);
  return { date, start, end: start + DAY };
}

export function shanghaiDate(ms) {
  return new Date(ms + TZ_OFFSET).toISOString().slice(0, 10);
}

function ms(ts) {
  if (!ts) return null;
  const v = Date.parse(ts);
  return Number.isNaN(v) ? null : v;
}

function iso(v) {
  return new Date(v).toISOString();
}

function inWindow(ts, w) {
  const v = ms(ts);
  return v !== null && v >= w.start && v < w.end;
}

export function clip(text, n = 120) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function cell(text, n = 120) {
  return clip(text, n).replace(/\|/g, "\\|").replace(/`/g, "'");
}

export function fmtDuration(v) {
  if (v === null || v === undefined) return "—";
  const neg = v < 0;
  let s = Math.round(Math.abs(v) / 1000);
  let out;
  if (s < 60) out = `${s}s`;
  else if (s < 3600)
    out = `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  else if (s < 86400)
    out = `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  else {
    const d = Math.floor(s / 86400);
    s %= 86400;
    out = `${d}d${Math.floor(s / 3600)}h`;
  }
  return neg ? `-${out}` : out;
}

function fmtClock(v) {
  if (v === null || v === undefined) return "—";
  return new Date(v + TZ_OFFSET).toISOString().slice(5, 16).replace("T", " ");
}

function chat(sessionId) {
  return sessionId ? `[\`${sessionId}\`](${CHAT_LINK}${sessionId})` : "—";
}

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

function parseJSON(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// The person's own words in an inbox entry. A web entry is their message; a
// message-channel entry is a batch whose messages say whether the sender is
// the person (two formats have been written over time).
export function personTexts(channel, text) {
  if (channel === "web") return [String(text ?? "")];
  const out = [];
  const body = String(text ?? "");
  const blocks = body.split(/\n(?=message \d+:|Message \S+ from )/);
  for (const block of blocks) {
    const isPerson =
      /sender is the person: yes/.test(block) ||
      /, the person themselves at /.test(block);
    if (!isPerson) continue;
    const trigger =
      block.match(/^\s*text without trigger: (.*)$/m) ??
      block.match(/^\s*text: (.*)$/m);
    const quoted = block.match(/^> (.*)$/m);
    const words = trigger?.[1] ?? quoted?.[1];
    if (words !== undefined) out.push(words);
  }
  return out;
}

export function isChase(text) {
  const t = String(text ?? "").trim();
  return t.length > 0 && t.length <= CHASE_MAX_CHARS && CHASE_RE.test(t);
}

// Whether a pending item earns a card (personNoticeKind and noticeDecision in
// apps/server/internal/httpapi/person_notice_items.go): open for the person,
// and a question, the assistant's own ask, an item wait or a connector write.
export function earnsNotice(row, payload) {
  if (RETIRED_SOURCES.has(row.source)) return false;
  if ((row.handler || "person") !== "person") return false;
  switch (row.source) {
    case "assistant_question":
    case "item_wait":
      return true;
    case "connector_write":
      return Boolean(payload.connectorWrite);
    case "question":
      return (
        Boolean(payload.title) && Boolean(payload.messageId || payload.handedAt)
      );
    default:
      return false;
  }
}

// Longest stretch in [from, to] not covered by any interval.
export function longestUncovered(from, to, intervals) {
  const clipped = intervals
    .map(([a, b]) => [Math.max(a, from), Math.min(b, to)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let cursor = from;
  let longest = 0;
  for (const [a, b] of clipped) {
    if (a > cursor) longest = Math.max(longest, a - cursor);
    cursor = Math.max(cursor, b);
  }
  return Math.max(longest, to - cursor);
}

// ---------- database ----------

export function openDatabase(path) {
  return new DatabaseSync(path, { readOnly: true });
}

export function loadContext(db, username) {
  const user = db
    .prepare("SELECT id, username FROM users WHERE username = ?")
    .get(username);
  if (!user) throw new Error(`no user named ${username}`);
  const assistants = db
    .prepare(
      "SELECT id, name, is_default, home_workspace_id, state FROM assistants WHERE owner_user_id = ? ORDER BY is_default DESC, created_at",
    )
    .all(user.id);
  const assistantIds = new Set(assistants.map((a) => a.id));
  // The assistants' conversations: their home and channel sessions. The
  // home workspace also holds utility sessions (project summaries), which
  // are not conversations, so the home workspace alone is not the test.
  const sessions = new Set();
  for (const r of db
    .prepare(
      "SELECT DISTINCT session_id FROM pa_inbox WHERE user_id = ? AND session_id <> ''",
    )
    .all(user.id))
    sessions.add(r.session_id);
  for (const r of db
    .prepare(
      "SELECT DISTINCT session_id FROM usage_turns WHERE user_id = ? AND entry = 'assistant'",
    )
    .all(user.id))
    sessions.add(r.session_id);
  const channelSession = db.prepare(
    "SELECT session_id FROM message_channel_sessions WHERE assistant_id = ?",
  );
  for (const a of assistants)
    for (const r of channelSession.all(a.id)) sessions.add(r.session_id);
  return { user, assistants, assistantIds, assistantSessions: sessions };
}

function statements(db) {
  return {
    eventById: db.prepare(
      "SELECT created_at FROM agent_session_events WHERE id = ?",
    ),
    replyEvents: db.prepare(`SELECT id, created_at,
        json_extract(payload_json, '$.label') AS label,
        json_extract(payload_json, '$.message.kind') AS kind,
        json_extract(payload_json, '$.message.id') AS mid,
        length(coalesce(json_extract(payload_json, '$.detail'), '')) AS dlen,
        length(coalesce(json_extract(payload_json, '$.message.text'), '')) AS tlen
      FROM agent_session_events WHERE session_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at`),
    userMessages: db.prepare(`SELECT id, created_at,
        json_extract(payload_json, '$.metadata.inputSource.kind') AS src,
        substr(json_extract(payload_json, '$.message.text'), 1, 400) AS text
      FROM agent_session_events
      WHERE session_id = ? AND created_at >= ? AND created_at < ? AND json_extract(payload_json, '$.label') = 'User message'
      ORDER BY created_at`),
    toolEvents: db.prepare(`SELECT created_at,
        json_extract(payload_json, '$.message.id') AS mid,
        substr(json_extract(payload_json, '$.message.text'), 1, 600) AS text
      FROM agent_session_events
      WHERE session_id = ? AND created_at >= ? AND created_at < ?
        AND json_extract(payload_json, '$.label') IN ('Used tool', 'Ran command')
        AND (instr(payload_json, ' im ') > 0 OR instr(payload_json, ' msg ') > 0)
      ORDER BY created_at`),
    firstChild: db.prepare(
      "SELECT id, created_at FROM agent_sessions WHERE parent_session_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at LIMIT 1",
    ),
    children: db.prepare(
      "SELECT id FROM agent_sessions WHERE parent_session_id = ? AND created_at >= ? AND created_at < ?",
    ),
    inboxById: db.prepare("SELECT created_at FROM pa_inbox WHERE id = ?"),
    itemById: db.prepare(
      "SELECT id, holder_session_id, source_session_id FROM pa_items WHERE id = ?",
    ),
    itemEvents: db.prepare(
      "SELECT at, actor, kind, detail_json FROM pa_item_events WHERE item_id = ? ORDER BY at",
    ),
    itemHelpers: db.prepare(
      "SELECT session_id, created_at, status, ended_at FROM pa_item_helpers WHERE item_id = ? ORDER BY created_at",
    ),
    noticesOfItem:
      db.prepare(`SELECT id, kind, state, attempts, error_reason, answered_by,
        provider_message_id <> '' AS sent, created_at, updated_at FROM person_notices WHERE item_id = ? ORDER BY created_at`),
    pendingOfSession: db.prepare(
      "SELECT id, source, state, handler, session_id, created_at, resolved_at, payload_json FROM pending_items WHERE session_id = ?",
    ),
    itemWaitsOf: db.prepare(
      "SELECT id, source, state, handler, session_id, created_at, resolved_at, payload_json FROM pending_items WHERE user_id = ? AND source = 'item_wait' AND instr(payload_json, ?) > 0",
    ),
  };
}

// ---------- the day's readings ----------

export function computeDay(db, ctx, date, now = Date.now()) {
  const w = dayWindow(date);
  const lo = iso(w.start - DAY);
  const hi = iso(w.end + DAY);
  const q = statements(db);
  const userId = ctx.user.id;
  const partial = now < w.end;

  // --- person requests to an assistant (G1, G8, G4 test traffic) ---
  const inboxRows = db
    .prepare(
      `SELECT id, channel, text, status, session_id, assistant_id, input_id, created_at, updated_at,
        result_status, length(result_text) > 0 AS has_result
      FROM pa_inbox WHERE user_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at`,
    )
    .all(userId, lo, hi)
    .filter((r) => inWindow(r.created_at, w));
  const requests = [];
  let othersEntries = 0;
  for (const r of inboxRows) {
    const words = personTexts(r.channel, r.text);
    if (words.length === 0) {
      othersEntries++;
      continue;
    }
    const at = ms(r.created_at);
    requests.push({
      inboxId: r.id,
      channel: r.channel === "web" ? "web" : "通道",
      sessionId: r.session_id,
      assistantId: r.assistant_id,
      inputId: r.input_id,
      at,
      text: words.join(" / "),
      resultStatus: r.result_status,
      ...firstReply(q, r, at),
    });
  }
  requests.sort((a, b) => a.at - b.at);
  const bySession = new Map();
  for (const r of requests) {
    const prev = bySession.get(r.sessionId);
    r.chase = Boolean(
      prev && r.at - prev.at <= TARGETS.chaseWindowMs && isChase(r.text),
    );
    bySession.set(r.sessionId, r);
  }
  for (let i = 0; i < requests.length; i++) {
    const r = requests[i];
    const next = requests.slice(i + 1).find((x) => x.sessionId === r.sessionId);
    const until = next ? next.at : r.at + 2 * HOUR;
    const child = r.sessionId
      ? q.firstChild.get(r.sessionId, iso(r.at - 1000), iso(until))
      : undefined;
    r.dispatch = child
      ? { sessionId: child.id, ms: ms(child.created_at) - r.at }
      : null;
  }

  // --- pending items opened today, and earlier ones still open today (G3, G1, G4) ---
  const pendingRows = db
    .prepare(
      `SELECT id, source, state, handler, session_id, assistant_id, created_at, resolved_at, deadline_at, outcome, payload_json
      FROM pending_items WHERE user_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at`,
    )
    .all(userId, lo, hi)
    .filter((r) => inWindow(r.created_at, w));
  const carriedRows = db
    .prepare(
      `SELECT id, source, state, handler, session_id, assistant_id, created_at, resolved_at, deadline_at, outcome, payload_json
      FROM pending_items WHERE user_id = ? AND created_at < ? AND (state = 'open' OR resolved_at >= ?) ORDER BY created_at`,
    )
    .all(userId, iso(w.start), iso(w.start))
    .filter(
      (r) =>
        ms(r.created_at) < w.start &&
        (r.state === "open" || ms(r.resolved_at) >= w.start),
    );

  const waits = [];
  const otherPending = new Map();
  const noDecision = [];
  const assistantAsks = [];
  for (const r of pendingRows) {
    const p = parseJSON(r.payload_json, {});
    if (NO_DECISION_SOURCES.has(r.source))
      noDecision.push({ id: r.id, source: r.source, at: ms(r.created_at) });
    if (
      ctx.assistantIds.has(r.assistant_id) &&
      (r.source === "assistant_question" ||
        r.source === "item_wait" ||
        (r.source === "question" && p.handedAt))
    )
      assistantAsks.push(r.id);
    if (earnsNotice(r, p)) waits.push(describeWait(q, r, p, now));
    else if (!RETIRED_SOURCES.has(r.source)) {
      const key = `${r.source}${r.handler === "assistant" ? "（助理处理）" : ""}`;
      otherPending.set(key, (otherPending.get(key) ?? 0) + 1);
    }
  }
  const carried = carriedRows
    .map((r) => [r, parseJSON(r.payload_json, {})])
    .filter(([r, p]) => earnsNotice(r, p))
    .map(([r, p]) => describeWait(q, r, p, now));

  // --- items the assistant took on today (G2), and items closed today (G3, G5) ---
  const itemRows = db
    .prepare(
      `SELECT id, owner, status, assistant_id, source_session_id, holder_session_id, source_inbox_id, source_input_id,
        created_at, closed_at, summary, plan_json, text
      FROM pa_items WHERE user_id = ? AND ((created_at >= ? AND created_at < ?) OR (closed_at >= ? AND closed_at < ?))`,
    )
    .all(userId, lo, hi, lo, hi);
  const items = [];
  const closed = [];
  for (const r of itemRows) {
    const helpers = q.itemHelpers.all(r.id);
    if (r.owner !== "assistant" && helpers.length === 0) continue;
    if (inWindow(r.created_at, w))
      items.push({
        ...describeItem(q, r, helpers, now),
        inAssistantConversation: ctx.assistantSessions.has(
          r.source_session_id || r.holder_session_id,
        ),
      });
    if (inWindow(r.closed_at, w))
      closed.push(describeClosed(q, ctx, r, helpers));
  }
  items.sort((a, b) => a.createdAt - b.createdAt);
  closed.sort((a, b) => a.closedAt - b.closedAt);

  // --- assistant conversations: Foundry notices, test traffic, outbound sends (G4, G6) ---
  const foundryNotices = [];
  const synthetic = [];
  const inboxInputIds = new Set(inboxRows.map((r) => r.input_id));
  for (const r of requests)
    if (SYNTHETIC_RE.test(r.text))
      synthetic.push({
        where: `收件箱 ${r.channel}`,
        sessionId: r.sessionId,
        at: r.at,
        text: r.text,
      });
  const sends = [];
  const sendSessions = new Set();
  for (const sessionId of ctx.assistantSessions) {
    for (const m of q.userMessages.all(sessionId, lo, hi)) {
      if (!inWindow(m.created_at, w)) continue;
      if (m.src === "foundry_notice")
        foundryNotices.push({ sessionId, at: ms(m.created_at), text: m.text });
      const inputId = m.id.startsWith("evt_") ? m.id.slice(4) : "";
      if (
        m.src === "person" &&
        !inboxInputIds.has(inputId) &&
        SYNTHETIC_RE.test(m.text ?? "")
      )
        synthetic.push({
          where: "助理会话",
          sessionId,
          at: ms(m.created_at),
          text: m.text,
        });
    }
    sendSessions.add(sessionId);
    for (const c of q.children.all(sessionId, iso(w.start), iso(w.end)))
      sendSessions.add(c.id);
  }
  for (const it of [...items, ...closed])
    for (const h of it.helperIds ?? []) sendSessions.add(h);
  const seenCalls = new Set();
  for (const sessionId of sendSessions) {
    for (const e of q.toolEvents.all(sessionId, iso(w.start), iso(w.end))) {
      const m = (e.text ?? "").match(SEND_COMMAND_RE);
      if (!m || /\s--help\b/.test(e.text)) continue;
      const key = e.mid || `${sessionId}@${e.created_at}`;
      if (seenCalls.has(key)) continue;
      seenCalls.add(key);
      sends.push({
        sessionId,
        at: ms(e.created_at),
        command: m[1],
        via: "会话里的发送命令",
      });
    }
  }
  for (const g of db
    .prepare(
      `SELECT at, session_ref, identity, method, path, status FROM feishu_gateway_requests
      WHERE user_ref = ? AND at >= ? AND at < ? AND method <> 'GET' AND path LIKE '/open-apis/im/v1/messages%' ORDER BY at`,
    )
    .all(userId, iso(w.start), iso(w.end))
    .filter((g) => g.identity === "user" || sendSessions.has(g.session_ref)))
    sends.push({
      sessionId: g.session_ref,
      at: ms(g.at),
      command: `${g.method} ${g.path} → ${g.status}`,
      via: `飞书网关（${g.identity === "user" ? "本人身份" : g.identity || "—"}）`,
    });
  sends.sort((a, b) => a.at - b.at);
  const connectorWrites = pendingRows
    .filter((r) => r.source === "connector_write")
    .map((r) => r.id);

  const upkeep = db
    .prepare("SELECT assistant_id, notified_at FROM pa_upkeep_notices")
    .all()
    .filter(
      (r) => ctx.assistantIds.has(r.assistant_id) && inWindow(r.notified_at, w),
    );
  const lateCards = [];
  for (const wt of [...waits, ...carried])
    for (const n of wt.notices)
      if (
        inWindow(n.created_at, w) &&
        wt.resolvedAt !== null &&
        wt.resolvedAt < ms(n.created_at)
      )
        lateCards.push(wt.id);

  return {
    date,
    window: w,
    partial,
    generatedAt: now,
    user: ctx.user,
    assistants: ctx.assistants,
    requests,
    othersEntries,
    waits,
    carried,
    otherPending: [...otherPending.entries()].sort((a, b) => b[1] - a[1]),
    noDecision,
    assistantAsks,
    items,
    closed,
    foundryNotices,
    upkeep,
    lateCards,
    synthetic,
    sends,
    connectorWrites,
  };
}

function firstReply(q, inbox, at) {
  const input = inbox.input_id;
  const userEvent = input ? q.eventById.get(`evt_${input}`) : undefined;
  const from = userEvent ? ms(userEvent.created_at) : at;
  if (inbox.session_id) {
    for (const e of q.replyEvents.all(
      inbox.session_id,
      iso(from),
      iso(at + 6 * HOUR),
    )) {
      const ofInput =
        !input || e.id.includes(input) || (e.mid ?? "").startsWith(input);
      const isReply =
        (e.label === "Response stream" && e.dlen > 0) ||
        (e.kind === "assistant" && e.tlen > 0);
      if (ofInput && isReply)
        return { replyMs: ms(e.created_at) - at, replyFrom: "会话事件" };
    }
  }
  if (inbox.has_result && inbox.result_status === "completed")
    return {
      replyMs: ms(inbox.updated_at) - at,
      replyFrom: "收件箱结束时间（近似）",
    };
  return { replyMs: null, replyFrom: "没有答复记录" };
}

function describeWait(q, r, p, now) {
  const created = ms(r.created_at);
  const handed = ms(p.handedAt);
  const entry = handed !== null && handed > created ? handed : created;
  let askedAt = null;
  if (
    r.source === "item_wait" &&
    typeof p.eventId === "string" &&
    p.eventId.includes("@")
  )
    askedAt = ms(p.eventId.slice(p.eventId.lastIndexOf("@") + 1));
  else if (p.eventId) {
    const e = q.eventById.get(p.eventId);
    if (e) askedAt = ms(e.created_at);
  }
  const notices = q.noticesOfItem.all(r.id);
  const first = notices[0];
  const sentAt = first && first.state === "sent" ? ms(first.updated_at) : null;
  const resolvedAt = ms(r.resolved_at);
  let ending;
  if (r.state === "open") ending = "open";
  else if (r.state === "replied" || r.outcome === "person_answered")
    ending = "answered";
  else if (r.state === "dismissed") ending = "dismissed";
  else ending = "ended_unanswered";
  let target = r.session_id;
  if (!target && p.waitItemId) {
    const item = q.itemById.get(p.waitItemId);
    target = item?.holder_session_id || item?.source_session_id || "";
  }
  let answerBack = null;
  if (ending === "answered" && target && resolvedAt !== null) {
    const arrived = q.userMessages
      .all(
        target,
        iso(resolvedAt - 5000),
        iso(resolvedAt + TARGETS.answerBackMs),
      )
      .some((m) => m.src !== "child_report");
    answerBack = arrived;
  }
  return {
    id: r.id,
    source: r.source,
    rule: p.rule ?? "",
    assistantId: r.assistant_id,
    sessionId: r.session_id,
    waitItemId: p.waitItemId ?? "",
    title: p.title ?? "",
    createdAt: created,
    entryAt: entry,
    askedAt,
    entryMs: askedAt !== null ? entry - askedAt : null,
    notices,
    noticeState: first ? first.state : "none",
    noticeError: first?.error_reason ?? "",
    queuedMs: first ? ms(first.created_at) - entry : null,
    sentMs: sentAt !== null ? sentAt - entry : null,
    sentKnown: Boolean(first && first.sent),
    ending,
    outcome: r.outcome,
    resolvedAt,
    openForMs: ending === "open" ? now - entry : null,
    pastDeadline:
      ending === "open" && r.deadline_at !== "" && ms(r.deadline_at) < now,
    target,
    answerBack,
  };
}

// When the item's helpers were running: each helper session from its start,
// and from every later input it received (a helper sent more work runs
// again), to the next helper_ended the item recorded for it; a helper still
// running runs to the end of the item's life.
function helperIntervals(q, events, helpers, lifeEnd) {
  const ends = new Map();
  const starts = new Map();
  for (const e of events) {
    const d = parseJSON(e.detail_json, {});
    if (!d.sessionId) continue;
    const list =
      e.kind === "helper_started"
        ? starts
        : e.kind === "helper_ended"
          ? ends
          : null;
    if (!list) continue;
    if (!list.has(d.sessionId)) list.set(d.sessionId, []);
    list.get(d.sessionId).push(ms(e.at));
  }
  const intervals = [];
  for (const sessionId of helperSessionIds(events, helpers)) {
    const h = helpers.find((x) => x.session_id === sessionId);
    const begins = [...(starts.get(sessionId) ?? [])];
    if (h) begins.push(ms(h.created_at));
    const first = Math.min(...begins);
    for (const m of q.userMessages.all(sessionId, iso(first), iso(lifeEnd)))
      begins.push(ms(m.created_at));
    const stops = (ends.get(sessionId) ?? []).sort((a, b) => a - b);
    for (const b of begins) {
      const stop = stops.find((t) => t >= b);
      if (stop !== undefined) intervals.push([b, stop]);
      else if (!h || h.status === "running") intervals.push([b, lifeEnd]);
    }
  }
  return intervals;
}

function helperSessionIds(events, helpers) {
  const ids = new Set(helpers.map((h) => h.session_id));
  for (const e of events)
    if (e.kind === "helper_started") {
      const d = parseJSON(e.detail_json, {});
      if (d.sessionId) ids.add(d.sessionId);
    }
  return [...ids];
}

function requestTime(q, r) {
  if (r.source_inbox_id) {
    const inbox = q.inboxById.get(r.source_inbox_id);
    if (inbox) return { at: ms(inbox.created_at), from: "收件箱" };
  }
  if (r.source_input_id) {
    const e = q.eventById.get(`evt_${r.source_input_id}`);
    if (e) return { at: ms(e.created_at), from: "来源会话的消息" };
  }
  return { at: null, from: "无记录" };
}

function describeItem(q, r, helpers, now) {
  const created = ms(r.created_at);
  const closedAt = ms(r.closed_at);
  const lifeEnd = closedAt ?? now;
  const events = q.itemEvents.all(r.id);
  const req = requestTime(q, r);
  const firstHelper = events.find((e) => e.kind === "helper_started");
  const life = lifeEnd - created;
  let quietMs = null;
  if (life > TARGETS.itemLongMs) {
    const points = [
      created,
      ...events.map((e) => ms(e.at)).filter((t) => t > created && t < lifeEnd),
      lifeEnd,
    ].sort((a, b) => a - b);
    const covered = helperIntervals(q, events, helpers, lifeEnd);
    quietMs = 0;
    for (let i = 1; i < points.length; i++)
      quietMs = Math.max(
        quietMs,
        longestUncovered(points[i - 1], points[i], covered),
      );
  }
  const plan = parseJSON(r.plan_json, null);
  const last = events.at(-1);
  return {
    id: r.id,
    owner: r.owner,
    status: r.status,
    text: r.text,
    sessionId: r.holder_session_id || r.source_session_id,
    createdAt: created,
    closedAt,
    requestAt: req.at,
    requestFrom: req.from,
    createMs: req.at !== null ? created - req.at : null,
    helperCount: helperSessionIds(events, helpers).length,
    helperIds: helperSessionIds(events, helpers),
    firstHelperMs:
      firstHelper && req.at !== null ? ms(firstHelper.at) - req.at : null,
    lifeMs: life,
    quietMs,
    lastEvent: last ? `${last.kind}（${fmtClock(ms(last.at))}）` : "—",
    step:
      r.status === "open"
        ? clip(plan?.waitingFor || plan?.nextAction || plan?.progress || "", 80)
        : "",
  };
}

function describeClosed(q, ctx, r, helpers) {
  const closedAt = ms(r.closed_at);
  const helperIds = helperSessionIds(q.itemEvents.all(r.id), helpers);
  const sessions = new Set(
    [r.holder_session_id, r.source_session_id, ...helperIds].filter(Boolean),
  );
  const candidates = [...q.itemWaitsOf.all(ctx.user.id, r.id)];
  for (const s of sessions) candidates.push(...q.pendingOfSession.all(s));
  const openAtClose = new Set();
  for (const p of candidates) {
    const payload = parseJSON(p.payload_json, {});
    if (p.source === "item_wait" && payload.waitItemId !== r.id) continue;
    if (!earnsNotice(p, payload)) continue;
    const opened = ms(p.created_at);
    const resolved = ms(p.resolved_at);
    if (
      opened < closedAt &&
      (p.state === "open" || (resolved !== null && resolved > closedAt))
    )
      openAtClose.add(p.id);
  }
  return {
    id: r.id,
    status: r.status,
    owner: r.owner,
    sessionId: r.holder_session_id || r.source_session_id,
    closedAt,
    summary: r.summary,
    helperIds,
    openRequests: [...openAtClose],
  };
}

// ---------- the page ----------

const ENDING_WORDS = {
  open: "仍开着",
  answered: "本人已答",
  dismissed: "本人关掉",
  ended_unanswered: "未答即结束",
};

export function summarize(d) {
  const replyTimes = d.requests.map((r) => r.replyMs).filter((v) => v !== null);
  const missed = d.waits.filter(
    (w) => w.noticeState === "none" || w.noticeState === "failed",
  );
  const lateCard = d.waits.filter(
    (w) =>
      w.noticeState !== "none" &&
      w.noticeState !== "failed" &&
      (w.sentMs ?? w.queuedMs) > TARGETS.noticeMs,
  );
  return {
    requests: d.requests.length,
    noTraffic: d.requests.length === 0,
    replyMedian: percentile(replyTimes, 50),
    replyP90: percentile(replyTimes, 90),
    noReply: d.requests.filter((r) => r.replyMs === null).length,
    chases: d.requests.filter((r) => r.chase).length,
    asks: d.assistantAsks.length,
    items: d.items.length,
    itemsSlow: d.items.filter(
      (i) => i.createMs !== null && i.createMs > TARGETS.itemCreateMs,
    ).length,
    itemsQuiet: d.items.filter(
      (i) => i.quietMs !== null && i.quietMs > TARGETS.itemLongMs,
    ).length,
    waits: d.waits.length,
    missed: missed.length,
    lateCard: lateCard.length,
    endedUnanswered: d.waits.filter((w) => w.ending === "ended_unanswered")
      .length,
    stillOpen: [...d.waits, ...d.carried].filter((w) => w.ending === "open")
      .length,
    closedWithOpen: d.closed.filter((c) => c.openRequests.length > 0).length,
    noDecision:
      d.noDecision.length +
      d.foundryNotices.length +
      d.upkeep.length +
      d.lateCards.length,
    synthetic: d.synthetic.length,
    sends: d.sends.length,
  };
}

function verdict(value, limit) {
  if (value === null) return "—";
  return value <= limit ? "未超" : "超出";
}

export function renderDay(d) {
  const s = summarize(d);
  const L = [];
  const push = (...lines) => L.push(...lines);
  push(`# 助理试用读数 ${d.date}${d.partial ? "（当天未结束）" : ""}`, "");
  push(
    `- 日期：${d.date}，按 Asia/Shanghai（UTC+8）自然日；${d.partial ? `截至 ${fmtClock(d.generatedAt)}` : "整天"}。`,
    `- 数据：Server 库，以只读方式打开，没有写入、没有发消息。脚本 \`scripts/assistant-trial-readings.mjs\`。`,
    `- 本人：\`${d.user.username}\`（\`${d.user.id}\`）。`,
    `- 助理：${d.assistants.map((a) => `${a.name || "默认助理"} \`${a.id}\`（home \`${a.home_workspace_id}\`${a.state === "active" ? "" : `，${a.state}`}）`).join("；")}。`,
    `- 准出标准见 \`.foundry/reports/assistant-trust-audit-20261122.md\` §4。下面只有能从记录读出来的部分；判断类的标准只给抽查链接，不打分。`,
    "",
  );

  if (s.noTraffic) {
    push(
      "> **数据为 0 的原因：无助理流量。** 本人当天没有给任何一个助理发过消息（Web 和通道收件箱都没有本人的条目），所以 G1、G8 没有样本。读数为 0 不代表达标。",
    );
    const fromChats = d.items.filter((i) => !i.inAssistantConversation).length;
    if (d.items.length > 0)
      push(
        ">",
        `> 当天仍有 ${d.items.length} 件 owner 为助理（或带帮手）的事项，其中 ${fromChats} 件来自工作区 Chat 代管（来源会话不是助理会话），不是本人对助理说的；G2 按这些事项读。`,
      );
    push("");
  }

  push("## 一览", "");
  push("| 标准 | 读数 | 口径与来源 |", "|---|---|---|");
  push(
    `| G8 首个答复 | ${s.requests ? `中位 ${fmtDuration(s.replyMedian)}，p90 ${fmtDuration(s.replyP90)}，无答复 ${s.noReply}` : "无样本"} | 本人给助理的每条消息（\`pa_inbox\`）到会话里第一段助理答复文字（\`agent_session_events\`） |`,
  );
  push(
    `| G1 追问（启发式） | ${s.chases} | 同一助理会话里，30 分钟内又发、${CHASE_MAX_CHARS} 字以内且像「怎么样 / 进展 / 还没 / ？」的消息 |`,
  );
  push(
    `| G1 助理问本人 | ${s.asks}${s.requests ? `（每条请求 ${(s.asks / s.requests).toFixed(2)}）` : ""} | 当天开出、带助理 id 的 \`assistant_question\`、\`item_wait\` 和助理转交的提问（\`pending_items\`） |`,
  );
  push(
    `| G2 进事项 >1 分钟 | ${s.itemsSlow} / ${s.items} | 当天新建、owner 为助理或带帮手的事项（\`pa_items\`），从请求到事项建立 |`,
  );
  push(
    `| G2 看不出在做什么 >10 分钟 | ${s.itemsQuiet} / ${s.items} | 事项开着期间，既没有事项事件、也没有帮手在跑的最长时段（\`pa_item_events\`、\`pa_item_helpers\`） |`,
  );
  push(
    `| G3 漏通知 | ${s.missed} / ${s.waits} | 当天开出、按规则该发卡片的请求里，没有 \`person_notices\` 或发送失败的 |`,
  );
  push(
    `| G3 卡片晚于 2 分钟 | ${s.lateCard} / ${s.waits} | 进 Needs you 到卡片发出（发出时间不可读时用入队时间） |`,
  );
  push(
    `| G3 未答即结束 | ${s.endedUnanswered} | 当天开出的请求被作废、自动收掉或助理关掉，本人没有答 |`,
  );
  push(
    `| G3 到今天仍开着 | ${s.stillOpen} | 当天开出的和之前留下的请求，在生成时仍是 open |`,
  );
  push(
    `| G3 带着未答请求关闭的事项 | ${s.closedWithOpen} | 当天关闭的事项，关闭时还有它的等本人请求开着 |`,
  );
  push(
    `| G4 无需决定的打扰 | ${s.noDecision} | 推进助理会话的 Foundry 知会、维护通知、\`notice\` 类条目、卡片发出时请求已结束 |`,
  );
  push(
    `| G4 测试流量（启发式） | ${s.synthetic} | 本人真实助理会话和收件箱里像合成测试的消息 |`,
  );
  push(
    `| G6 对外发送（抽查） | ${s.sends} | 助理及其帮手会话里的发送命令、飞书网关的消息写入 |`,
  );
  push("");

  push("## 准出对照（只含记录能读出的部分）", "");
  push("| 准出条件 | 当天 | 是否由记录读出 |", "|---|---|---|");
  push(`| 漏通知 0 次 | ${s.missed} | 是（G3） |`);
  push(
    `| 本人追问 ≤ 2 次 | ${s.chases}（${verdict(s.chases, 2)}） | 部分：文字是启发式匹配 |`,
  );
  push(
    `| 不必要的提问 ≤ 2 次 | 提问 ${s.asks} 次，是否必要需本人判断 | 否：只给上限 |`,
  );
  push(`| 「说完成其实没完成」0 次 | 见 G5 抽查 | 否 |`);
  push(`| 对外发错 0 次 | 见 G6 抽查 | 否 |`);
  push(`| 7 天内覆盖 ≥ 8 类任务 | — | 否：任务归类要本人判断 |`);
  push("", "准出看的是 7 天合计，这里是单日读数。", "");

  push("## G8 一问一答：首个答复时间（近似）", "");
  if (d.requests.length === 0) push("当天本人没有给助理发消息。", "");
  else {
    push(
      "答复时间取会话里第一段助理答复文字（`Response stream` 或助理消息）的时间；没有事件时用收件箱结束时间并注明。是否「有用」读不出来。派活时间是这条消息之后第一个子会话的建立时间。",
      "",
    );
    push(
      "| 时间 | 入口 | 会话 | 本人的话（截断） | 首个答复 | 派出帮手 | 追问 |",
      "|---|---|---|---|---|---|---|",
    );
    for (const r of d.requests)
      push(
        `| ${fmtClock(r.at)} | ${r.channel} | ${chat(r.sessionId)} | ${cell(r.text, 60)} | ${fmtDuration(r.replyMs)}${r.replyFrom === "会话事件" ? "" : `（${r.replyFrom}）`} | ${r.dispatch ? `${fmtDuration(r.dispatch.ms)} ${chat(r.dispatch.sessionId)}` : "—"} | ${r.chase ? "是" : ""} |`,
      );
    push("");
  }
  if (d.othersEntries)
    push(
      `另有 ${d.othersEntries} 条通道条目是别人的消息，不计入本人的请求。`,
      "",
    );

  push("## G2 进度可见", "");
  if (d.items.length === 0)
    push("当天没有新建 owner 为助理或带帮手的事项。", "");
  else {
    push(
      "请求时间：来自收件箱的事项用收件箱时间，来自会话的事项用那条消息的时间。「最长无可见进展」只在事项开了 10 分钟以上时计算：事项事件之间、且没有帮手在跑的最长时段（持有会话自己在做的事，事项上看不到，不算）。",
      "",
    );
    push(
      "| 事项 | 状态 | 会话 | 请求→建立 | 帮手 | 首个帮手 | 开了多久 | 最长无可见进展 | 最后一条事件 / 当前一步 |",
      "|---|---|---|---|---|---|---|---|---|",
    );
    for (const i of d.items)
      push(
        `| \`${i.id}\` ${cell(i.text, 40)} | ${i.status}${i.owner === "assistant" ? "" : "（本人的）"} | ${chat(i.sessionId)} | ${fmtDuration(i.createMs)}${i.requestAt === null ? "（无请求记录）" : ""} | ${i.helperCount} | ${fmtDuration(i.firstHelperMs)} | ${fmtDuration(i.lifeMs)}${i.closedAt === null ? "（未关）" : ""} | ${i.quietMs === null ? "—" : `${fmtDuration(i.quietMs)}${i.quietMs > TARGETS.itemLongMs ? " ⚠" : ""}`} | ${i.lastEvent}${i.step ? `；${cell(i.step, 60)}` : ""} |`,
      );
    push("");
  }

  push("## G3 要本人时：请求、卡片和答复", "");
  push(
    "按 Server 的规则（`httpapi/person_notice_items.go` 的 `personNoticeKind`），该发卡片的是：带消息或转交过的提问、助理自己的提问、事项等本人、连接器写入。卡片表是 `person_notices`；发出时间只有状态仍为 sent 时可读，否则用入队时间。",
    "",
  );
  const waitTable = (rows) => {
    push(
      "| 请求 | 来源 | 会话 / 事项 | 提问→进 Needs you | 进 Needs you→卡片 | 卡片 | 结果 | 答复送回会话 |",
      "|---|---|---|---|---|---|---|---|",
    );
    for (const w of rows) {
      const card =
        w.noticeState === "none"
          ? "**无卡片**"
          : `${w.noticeState}${w.noticeError ? `（${cell(w.noticeError, 40)}）` : ""}`;
      const toCard =
        w.noticeState === "none"
          ? "—"
          : w.sentMs !== null
            ? fmtDuration(w.sentMs)
            : `入队 ${fmtDuration(w.queuedMs)}${w.sentKnown ? "，已发出" : ""}`;
      const ending = `${ENDING_WORDS[w.ending]}${w.ending === "ended_unanswered" ? `（${w.outcome || "—"}${w.rule === "held" ? "，原生提问" : ""}）` : ""}${w.ending === "open" ? ` ${fmtDuration(w.openForMs)}${w.pastDeadline ? "，已过旧截止时间" : ""}` : ""}`;
      const back =
        w.answerBack === null ? "—" : w.answerBack ? "是" : "**未见**";
      push(
        `| \`${w.id}\` ${cell(w.title, 50)} | ${w.source}${w.assistantId ? "（助理）" : ""} | ${w.waitItemId ? `\`${w.waitItemId}\` ` : ""}${chat(w.sessionId || w.target)} | ${fmtDuration(w.entryMs)} | ${toCard} | ${card} | ${ending} | ${back} |`,
      );
    }
    push("");
  };
  if (d.waits.length === 0) push("当天没有开出该发卡片的请求。", "");
  else waitTable(d.waits);
  if (d.carried.length) {
    push(`之前开出、当天开始时仍开着的请求（${d.carried.length} 条）：`, "");
    waitTable(d.carried);
  }
  if (d.otherPending.length)
    push(
      `当天还有不发卡片的条目（按规则只在 Web 上列出）：${d.otherPending.map(([k, n]) => `${k} ${n}`).join("、")}。`,
      "",
    );
  const withOpen = d.closed.filter((c) => c.openRequests.length > 0);
  if (withOpen.length) {
    push("带着未答请求关闭的事项：", "");
    for (const c of withOpen)
      push(
        `- \`${c.id}\` ${chat(c.sessionId)}，关闭于 ${fmtClock(c.closedAt)}，未答：${c.openRequests.map((x) => `\`${x}\``).join("、")}`,
      );
    push("");
  }

  push("## G4 不打扰", "");
  push(
    `- 推进助理会话的 Foundry 知会（\`inputSource.kind = foundry_notice\`，每条触发一轮）：${d.foundryNotices.length}。`,
    `- 维护通知（\`pa_upkeep_notices\` 只留每个助理最近一次）：${d.upkeep.length}。`,
    `- 无需决定的条目（\`pending_items\` 的 notice / 已退役的 upkeep 来源）：${d.noDecision.length}。`,
    `- 卡片入队时请求已结束：${d.lateCards.length}${d.lateCards.length ? `（${d.lateCards.map((x) => `\`${x}\``).join("、")}）` : ""}。`,
    "",
  );
  for (const n of d.foundryNotices.slice(0, 10))
    push(`  - ${fmtClock(n.at)} ${chat(n.sessionId)}：${cell(n.text, 80)}`);
  push(
    `测试流量（启发式：文字含 合成、[测试]、DEV-数字、e2e-、smoke、synthetic；本人讨论开发时也会命中，需看一眼）：${d.synthetic.length}。`,
    "",
  );
  for (const t of d.synthetic.slice(0, 15))
    push(
      `- ${fmtClock(t.at)} ${t.where} ${chat(t.sessionId)}：${cell(t.text, 80)}`,
    );
  if (d.synthetic.length) push("");

  push("## G5 诚实：当天关成完成的事项（抽查）", "");
  const done = d.closed.filter((c) => c.status === "done");
  if (done.length === 0) push("当天没有关成 done 的事项。", "");
  else {
    push("记录读不出「完成」是否属实，请本人抽查：", "");
    for (const c of done)
      push(
        `- \`${c.id}\` ${chat(c.sessionId)} ${fmtClock(c.closedAt)}：${cell(c.summary, 120) || "（没有收尾摘要）"}`,
      );
    push("");
  }

  push("## G6 不越权：对外发送（抽查）", "");
  push(
    "来源：助理会话、它们当天的子会话和事项帮手里，形如 `olk im reply/send`、`feishu-cli msg send` 的命令（启发式，只列命令头，不列正文）；以及飞书网关的消息写入。读不出收件人是不是第三方、内容对不对。",
    "",
  );
  if (d.sends.length === 0) push("当天没有。", "");
  else {
    for (const x of d.sends)
      push(
        `- ${fmtClock(x.at)} ${x.via} ${chat(x.sessionId)}：\`${cell(x.command, 80)}\``,
      );
    push("");
  }
  if (d.connectorWrites.length)
    push(
      `当天的连接器写入请求：${d.connectorWrites.map((x) => `\`${x}\``).join("、")}。`,
      "",
    );

  push("## G7 找得回", "", "记录读不出，需要本人用一句描述去找。", "");

  push("## 局限", "");
  push(
    "- 「有用」「必要」「属实」都读不出来；G5、G6、G7 只给抽查链接。",
    "- 追问、测试流量、对外发送是文字匹配，会漏也会误报。",
    "- 卡片发出时间只在卡片仍为 sent 时可读；已答或作废的卡片只读得到入队时间。",
    "- 事项等本人的「开始等」时间取自请求自身的 key；帮手的再次运行只按事件近似。",
    "- 派出帮手只认这条消息之后新建的子会话；把活续给已有帮手的读不出来。",
    "- 请求、卡片、事项的状态是生成时的状态，不是当天结束时的；历史日期的「仍开着」指到生成时。",
    "- 没有过滤已归档会话里的请求（Web 上不显示它们）。",
    "",
  );
  return L.join("\n");
}

// ---------- CLI ----------

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: "string", default: DEFAULT_DB },
      user: { type: "string", default: "windeng" },
      "out-dir": { type: "string", default: DEFAULT_OUT_DIR },
      days: { type: "string", default: "1" },
      date: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(
      "usage: node scripts/assistant-trial-readings.mjs [--date YYYY-MM-DD | --days N] [--db PATH] [--user NAME] [--out-dir DIR]\n",
    );
    return;
  }
  const now = Date.now();
  let dates;
  if (values.date) {
    dayWindow(values.date);
    dates = [values.date];
  } else {
    const n = Number.parseInt(values.days, 10);
    if (!Number.isInteger(n) || n < 1)
      throw new Error(`--days must be a positive integer: ${values.days}`);
    const today = dayWindow(shanghaiDate(now)).start;
    dates = Array.from({ length: n }, (_, i) =>
      shanghaiDate(today - (n - 1 - i) * DAY),
    );
  }
  const db = openDatabase(resolve(values.db));
  try {
    const ctx = loadContext(db, values.user);
    const outDir = resolve(values["out-dir"]);
    mkdirSync(outDir, { recursive: true });
    for (const date of dates) {
      const readings = computeDay(db, ctx, date, now);
      const path = join(outDir, `${date}.md`);
      writeFileSync(path, renderDay(readings));
      const s = summarize(readings);
      process.stdout.write(
        `${path}  requests=${s.requests} items=${s.items} waits=${s.waits} missed=${s.missed} stillOpen=${s.stillOpen} chases=${s.chases} synthetic=${s.synthetic} sends=${s.sends}\n`,
      );
    }
  } finally {
    db.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
