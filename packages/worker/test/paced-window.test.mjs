// DEV-084: with a server that acknowledges pieces, the reliable outbox keeps
// a window of events in flight instead of one message per round trip.
import assert from "node:assert/strict";
import test from "node:test";
import { daemonMessageTypes } from "@bd777/foundry-protocol";
import { ReliableSessionTransport, sendWebSocket } from "../dist/transport.js";

const features = { replyChunks: true, replyChunkAck: true };

function socket() {
  const messages = [];
  return {
    readyState: 1,
    bufferedAmount: 0,
    messages,
    send(value, callback) {
      messages.push(JSON.parse(value));
      // The kernel takes everything at once: only acknowledgements pace.
      queueMicrotask(() => callback?.());
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function event(transport, sessionId, n, size = 600) {
  return transport.send(daemonMessageTypes.sessionEvent, {
    event: {
      id: `evt_${sessionId}_${n}`,
      sessionId,
      label: "Response stream",
      detail: `${n} ${"x".repeat(size)}`,
    },
  });
}

const bytesOf = (messages) =>
  messages.reduce((sum, m) => sum + Buffer.byteLength(JSON.stringify(m)), 0);

test("a window of events goes per round trip, bounded by unacknowledged bytes", async () => {
  const ws = socket();
  const transport = new ReliableSessionTransport({ pacedWindowBytes: 8192 });
  transport.bind(ws, features);
  for (let n = 0; n < 100; n++) event(transport, "s1", n);
  await settle();
  const first = ws.messages.length;
  assert.ok(first > 5, `several events in flight (${first})`);
  // At most one frame beyond the window.
  assert.ok(bytesOf(ws.messages.slice(0, first - 1)) < 8192);
  // The kernel taking them is no credit.
  await settle();
  assert.equal(ws.messages.length, first);
  transport.acknowledge(ws.messages[0].id);
  await settle();
  assert.ok(ws.messages.length > first, "an acknowledgement lets more go");
  transport.unbind(ws);
});

test("events of a session keep their order through the window", async () => {
  const ws = socket();
  const transport = new ReliableSessionTransport({ pacedWindowBytes: 4096 });
  transport.bind(ws, features);
  for (let n = 0; n < 60; n++) event(transport, n % 2 ? "a" : "b", n, 200);
  let acked = 0;
  for (let round = 0; round < 200 && acked < 60; round++) {
    await settle();
    while (acked < ws.messages.length)
      transport.acknowledge(ws.messages[acked++].id);
  }
  const order = (sessionId) =>
    ws.messages
      .filter((m) => m.payload.event.sessionId === sessionId)
      .map((m) => Number(m.payload.event.detail.split(" ")[0]));
  assert.deepEqual(
    order("a"),
    [...Array(30)].map((_, i) => i * 2 + 1),
  );
  assert.deepEqual(
    order("b"),
    [...Array(30)].map((_, i) => i * 2),
  );
  assert.equal(ws.messages.length, 60, "each written once");
  transport.unbind(ws);
});

test("a reconnect or server handoff replays exactly what is unacknowledged, in order", async () => {
  // The server stores by envelope id and takes one it has as a no-op.
  const stored = [];
  const store = (message) => {
    if (!stored.some((m) => m.id === message.id)) stored.push(message);
  };
  const transport = new ReliableSessionTransport({ pacedWindowBytes: 4096 });
  const first = socket();
  transport.bind(first, features);
  const ids = [];
  for (let n = 0; n < 40; n++) ids.push(event(transport, "s", n, 300));
  await settle();
  const written = first.messages.length;
  assert.ok(written > 3 && written < 40);
  // The old server stored the first few; the acks of two of them were lost
  // with it (SIGHUP handoff), the rest never arrived.
  first.messages.slice(0, 5).forEach(store);
  transport.acknowledge(first.messages[0].id);
  transport.acknowledge(first.messages[1].id);
  transport.acknowledge(first.messages[2].id);
  first.readyState = 3;
  transport.unbind(first);
  const second = socket();
  transport.bind(second, features);
  let seen = 0;
  for (let round = 0; round < 400 && transport.pendingCount() > 0; round++) {
    await settle();
    while (seen < second.messages.length) {
      const message = second.messages[seen++];
      store(message);
      transport.acknowledge(message.id);
    }
  }
  assert.equal(transport.pendingCount(), 0);
  // Every unacknowledged one went again once, in order; nothing acknowledged did.
  assert.deepEqual(
    second.messages.map((m) => m.id),
    ids.slice(3),
  );
  // The server ends with each event once, in the order they were sent.
  assert.deepEqual(
    stored.map((m) => m.id),
    ids,
  );
});

test("an acknowledgement from a replaced socket grants nothing; an error releases its credit", async () => {
  const transport = new ReliableSessionTransport({ pacedWindowBytes: 1 });
  const first = socket();
  transport.bind(first, features);
  const a = event(transport, "s", 1);
  const b = event(transport, "s", 2);
  await settle();
  assert.deepEqual(
    first.messages.map((m) => m.id),
    [a],
  );
  // The server could not store it: it goes again later, and b may go now.
  assert.equal(transport.retryAfterError(a), true);
  await settle();
  assert.deepEqual(
    first.messages.map((m) => m.id),
    [a, b],
  );
  transport.unbind(first);
});

test("a stale credit stops counting without writing anything twice", async () => {
  let now = 1_000;
  const ws = socket();
  const transport = new ReliableSessionTransport({
    pacedWindowBytes: 1,
    staleCreditMs: 30_000,
    now: () => now,
  });
  transport.bind(ws, features);
  const a = event(transport, "s", 1);
  const b = event(transport, "s", 2);
  await settle();
  assert.deepEqual(
    ws.messages.map((m) => m.id),
    [a],
  );
  now += 30_000;
  // Anything that pumps notices the stale credit (a timer does otherwise).
  event(transport, "s", 3);
  await settle();
  assert.deepEqual(
    ws.messages.map((m) => m.id),
    [a, b],
  );
  assert.equal(
    ws.messages.filter((m) => m.id === a).length,
    1,
    "the stale message is not written again",
  );
  transport.unbind(ws);
});

test("a small reply goes ahead of queued events and does not wait for the backlog", async () => {
  const ws = socket();
  const transport = new ReliableSessionTransport({ pacedWindowBytes: 2048 });
  transport.bind(ws, features);
  for (let n = 0; n < 200; n++) event(transport, "s", n);
  await settle();
  const before = ws.messages.length;
  sendWebSocket(
    ws,
    daemonMessageTypes.agentRuntimeSettingsUpserted,
    { ok: true },
    "reply",
  );
  await settle();
  // Waits for room in the window, not behind the 200 events.
  transport.acknowledge(ws.messages[0].id);
  await settle();
  const index = ws.messages.findIndex(
    (m) => m.id === "reply" || m.payload?.id === "reply",
  );
  assert.ok(index >= before && index <= before + 1, `reply at ${index}`);
  transport.unbind(ws);
});
