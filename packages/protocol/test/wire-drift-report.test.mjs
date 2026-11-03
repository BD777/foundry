// The wire drift report's TypeScript half and its merge with the Go half,
// on synthetic traffic, against the worker's real handler types
// (scripts/wire-drift-report.mjs, docs/refactor/phase6-openapi-design.md S1).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildReport,
  formatReport,
  tsKinds,
} from "../../../scripts/wire-drift-report.mjs";
import {
  checkTs,
  loadWorkerShapes,
} from "../../../scripts/wire-drift/ts-shapes.mjs";

const shapes = loadWorkerShapes();

const issues = (kind, value) =>
  checkTs(shapes.checker, shapes.messages.get(kind).type, value).map(
    (issue) => `${issue.kind} ${issue.path}`,
  );

test("the worker's handler types are found, one call deep included", () => {
  assert.match(shapes.messages.get("read_file").text, /ReadFilePayload/);
  // (envelope.payload ?? {}) as Partial<X>
  assert.match(
    shapes.messages.get("read_session_file").text,
    /ReadSessionFilePayload/,
  );
  // readSessionUsage(envelope.payload): the parameter's type
  assert.ok(shapes.messages.has("read_session_usage"));
  // registered carries nothing the worker reads
  assert.ok(shapes.untyped.has("registered"));
  assert.equal(
    shapes.rest.get("POST /api/daemon/chats/sync").text,
    "SyncedChats",
  );
  assert.ok(shapes.rest.has("POST /api/daemon/sessions/{}/work-fire"));
});

test("checkTs finds unknown, missing, mistyped and null fields", () => {
  assert.deepEqual(issues("read_file", { workspaceId: "w", path: "a" }), []);
  assert.deepEqual(
    issues("read_file", { workspaceId: "w", path: 3, extra: true }).sort(),
    ["type payload.path", "unknown payload.extra"],
  );
  assert.deepEqual(issues("read_file", { workspaceId: "w" }), [
    "missing payload.path",
  ]);
  assert.deepEqual(issues("read_file", { workspaceId: null, path: "a" }), [
    "null payload.workspaceId",
  ]);
  // A literal union takes its members and placeholders, nothing else.
  assert.deepEqual(
    issues("steer_session", {
      sessionId: "s",
      message: "m",
      delivery: "interrupt",
    }),
    [],
  );
  assert.deepEqual(
    issues("steer_session", {
      sessionId: "s",
      message: "m",
      delivery: "sideways",
    }),
    ["type payload.delivery"],
  );
  assert.deepEqual(
    issues("steer_session", { sessionId: "s", message: "‹text 9 bytes›" }),
    [],
  );
});

test("the report merges both halves per kind and counts coverage", () => {
  const records = [
    {
      at: "2026-11-03T01:00:00Z",
      channel: "ws",
      dir: "out",
      kind: "read_file",
      payload: { workspaceId: "w", path: "a", stray: 1 },
    },
    {
      at: "2026-11-03T01:00:01Z",
      channel: "ws",
      dir: "out",
      kind: "registered",
    },
    // The worker's ack handler takes `X | undefined`: no payload is fine.
    { at: "2026-11-03T01:00:01Z", channel: "ws", dir: "out", kind: "ack" },
    {
      at: "2026-11-03T01:00:02Z",
      channel: "ws",
      dir: "in",
      kind: "hello",
      payload: {},
    },
    {
      at: "2026-11-03T01:00:03Z",
      channel: "rest",
      kind: "POST /api/daemon/chats/sync",
      status: 200,
      payload: {},
      response: { status: "synced", refused: "c1" },
    },
  ];
  const goReport = {
    declared: [
      {
        channel: "ws",
        dir: "out",
        kind: "read_file",
        goType: "httpapi.wsReadFilePayload",
      },
      {
        channel: "ws",
        dir: "out",
        kind: "registered",
        unchecked: "no payload",
      },
      { channel: "ws", dir: "out", kind: "ack", unchecked: "from a map" },
      {
        channel: "ws",
        dir: "out",
        kind: "cancel_session",
        goType: "httpapi.wsCancelSessionPayload",
      },
      {
        channel: "ws",
        dir: "in",
        kind: "hello",
        goType: "store.DaemonRegistration",
      },
      {
        channel: "rest",
        kind: "POST /api/daemon/chats/sync",
        goType: "request store.SyncChatsInput",
      },
    ],
    kinds: [
      {
        channel: "ws",
        dir: "out",
        kind: "read_file",
        samples: 1,
        shapes: 1,
        declared: "httpapi.wsReadFilePayload",
        issues: [{ kind: "unknown", path: "payload.stray", samples: 1 }],
      },
      { channel: "ws", dir: "out", kind: "registered", samples: 1, shapes: 1 },
      { channel: "ws", dir: "out", kind: "ack", samples: 1, shapes: 1 },
      {
        channel: "ws",
        dir: "in",
        kind: "hello",
        samples: 1,
        shapes: 1,
        declared: "store.DaemonRegistration",
        issues: [{ kind: "missing", path: "payload.device", samples: 1 }],
      },
      {
        channel: "rest",
        kind: "POST /api/daemon/chats/sync",
        samples: 1,
        shapes: 1,
        statuses: { 200: 1 },
      },
    ],
  };
  const report = buildReport({
    goReport,
    records,
    ts: tsKinds(records, shapes, checkTs),
  });
  assert.deepEqual(report.coverage["ws out"], {
    declared: 4,
    recorded: 3,
    missing: ["cancel_session"],
  });
  assert.equal(report.coverage["ws in"].recorded, 1);
  const byKind = Object.fromEntries(
    report.kinds.map((k) => [`${k.channel} ${k.dir} ${k.kind}`, k]),
  );
  assert.deepEqual(byKind["ws out read_file"].ts.issues, [
    { kind: "unknown", path: "payload.stray", samples: 1 },
  ]);
  assert.match(byKind["ws out registered"].ts.unchecked, /untyped/);
  assert.deepEqual(byKind["ws out ack"].ts.issues, []);
  assert.match(byKind["ws in hello"].ts.unchecked, /object literals/);
  // The worker's SyncedChats declares only refused.
  assert.deepEqual(byKind["rest  POST /api/daemon/chats/sync"].ts.issues, [
    {
      kind: "type",
      path: "response.refused",
      detail: "string for string[] | undefined",
      samples: 1,
    },
    { kind: "unknown", path: "response.status", samples: 1 },
  ]);
  const text = formatReport(report);
  assert.match(text, /ws out\s+3\/4 recorded/);
  assert.match(text, /not recorded \(ws out\): cancel_session/);
  assert.match(text, /unknown payload\.stray: 1\/1/);
});
