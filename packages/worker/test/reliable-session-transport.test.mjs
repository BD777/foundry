import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { daemonMessageTypes, processLabels } from "@bd777/foundry-protocol";
import { ReliableSessionTransport } from "../dist/transport.js";

function socket() {
  const messages = [];
  return {
    messages,
    readyState: 1,
    send(value) {
      messages.push(JSON.parse(value));
    },
  };
}

/**
 * A socket on a slow uplink: what it is handed waits in bufferedAmount until
 * the network takes it (drain), and each send's callback runs once its
 * message left, as with ws.
 */
function slowSocket() {
  const inFlight = [];
  const link = {
    messages: [],
    readyState: 1,
    bufferedAmount: 0,
    send(value, callback) {
      const bytes = Buffer.byteLength(value);
      link.messages.push(JSON.parse(value));
      link.bufferedAmount += bytes;
      inFlight.push({ bytes, callback });
    },
    /** The network takes `bytes` of what the socket holds. */
    drain(bytes = Number.POSITIVE_INFINITY) {
      while (bytes > 0 && inFlight.length > 0) {
        const head = inFlight[0];
        const taken = Math.min(head.bytes, bytes);
        head.bytes -= taken;
        bytes -= taken;
        link.bufferedAmount -= taken;
        if (head.bytes === 0) {
          inFlight.shift();
          head.callback?.();
        }
      }
    },
  };
  return link;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function response(detail, id = "evt_session_response_stream") {
  return {
    event: {
      detail,
      id,
      label: "Response stream",
      sessionId: "session",
    },
  };
}

function toolEvent(index, padding = "") {
  return {
    event: {
      detail: `step ${index}${padding}`,
      id: `evt_session_${index}`,
      label: "Ran command",
      sessionId: "session",
    },
  };
}

test("replays unacknowledged lifecycle messages after reconnect", () => {
  const transport = new ReliableSessionTransport();
  const first = socket();
  transport.bind(first);
  transport.send(daemonMessageTypes.sessionStarted, { sessionId: "session" });
  assert.equal(first.messages.length, 1);

  transport.unbind(first);
  transport.send(daemonMessageTypes.sessionCompleted, {
    response: "done",
    sessionId: "session",
  });

  const second = socket();
  transport.bind(second);
  assert.deepEqual(
    second.messages.map((message) => message.type),
    [daemonMessageTypes.sessionStarted, daemonMessageTypes.sessionCompleted],
  );
  for (const message of second.messages) {
    transport.acknowledge(message.id);
  }
  assert.equal(transport.pendingCount(), 0);
});

test("coalesces cumulative response snapshots while disconnected", () => {
  const transport = new ReliableSessionTransport();
  transport.send(daemonMessageTypes.sessionEvent, response("h"));
  transport.send(daemonMessageTypes.sessionEvent, response("hello"));
  transport.send(daemonMessageTypes.sessionEvent, response("hello world"));
  assert.equal(transport.pendingCount(), 1);

  const connected = socket();
  transport.bind(connected);
  assert.equal(connected.messages.length, 1);
  assert.equal(connected.messages[0].payload.event.detail, "hello world");
});

test("an old socket closing cannot detach a newer connection", () => {
  const transport = new ReliableSessionTransport();
  const first = socket();
  const second = socket();
  transport.bind(first);
  transport.bind(second);
  transport.unbind(first);
  transport.send(daemonMessageTypes.sessionEvent, response("latest"));
  assert.equal(first.messages.length, 0);
  assert.equal(second.messages.length, 1);
});

test("never sends a message twice on an open socket, however long the ack takes", async () => {
  const transport = new ReliableSessionTransport({
    drainCheckMs: 1,
    failureRetryMs: 1,
  });
  const link = slowSocket();
  transport.bind(link);
  transport.send(daemonMessageTypes.sessionCompleted, {
    response: "done",
    sessionId: "session",
  });
  for (let index = 0; index < 20; index += 1) {
    transport.send(daemonMessageTypes.sessionEvent, toolEvent(index));
  }
  // The old transport resent all of these every second until acknowledged.
  await new Promise((resolve) => setTimeout(resolve, 30));
  link.drain();
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const ids = link.messages.map((message) => message.id);
  assert.equal(ids.length, 21);
  assert.equal(new Set(ids).size, 21);
  assert.equal(transport.pendingCount(), 21);

  // Registered again on the same connection: nothing goes twice either.
  transport.bind(link);
  assert.equal(link.messages.length, 21);
});

test("writes events only while the socket has room and keeps their order", async () => {
  const transport = new ReliableSessionTransport({
    highWaterMarkBytes: 1000,
    drainCheckMs: 60_000,
  });
  const link = slowSocket();
  transport.bind(link);
  const padding = "x".repeat(300);
  for (let index = 0; index < 50; index += 1) {
    transport.send(daemonMessageTypes.sessionEvent, toolEvent(index, padding));
  }
  // A few hundred bytes each: the socket holds about the threshold.
  const firstBurst = link.messages.length;
  assert.ok(firstBurst >= 2 && firstBurst <= 4, `wrote ${firstBurst}`);
  assert.equal(transport.outboxStats().queued, 50 - firstBurst);

  while (link.messages.length < 50) {
    const before = link.messages.length;
    link.drain(400);
    await settle();
    assert.ok(link.bufferedAmount < 1000 + 500, "the socket stays bounded");
    if (link.messages.length === before && link.bufferedAmount === 0)
      assert.fail("the outbox stopped writing with room on the socket");
  }
  assert.deepEqual(
    link.messages.map((message) => message.payload.event.detail.split("x")[0]),
    Array.from({ length: 50 }, (_, index) => `step ${index}`),
  );
  assert.equal(transport.outboxStats().queued, 0);
});

test("a backed-up socket is looked at again even when no write of ours finishes", async () => {
  const transport = new ReliableSessionTransport({
    highWaterMarkBytes: 100,
    drainCheckMs: 5,
  });
  const link = slowSocket();
  // An RPC reply written straight to the socket fills it.
  link.bufferedAmount = 5000;
  transport.bind(link);
  transport.send(daemonMessageTypes.sessionEvent, toolEvent(1));
  assert.equal(link.messages.length, 0);
  link.bufferedAmount = 0;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(link.messages.length, 1);
});

test("superseded messages waiting unsent are coalesced; nothing else is dropped", async () => {
  const transport = new ReliableSessionTransport({
    highWaterMarkBytes: 1,
    drainCheckMs: 60_000,
  });
  const link = slowSocket();
  transport.bind(link);
  // The first event fills the socket; everything after it waits.
  transport.send(daemonMessageTypes.sessionEvent, toolEvent(0));
  for (const detail of ["a", "ab", "abc"])
    transport.send(daemonMessageTypes.sessionEvent, response(detail));
  for (const task of ["task_1", "task_2"])
    for (const step of [1, 2, 3])
      transport.send(daemonMessageTypes.sessionEvent, {
        event: {
          id: `evt_progress_${task}_${step}`,
          sessionId: "session",
          label: processLabels.subtaskRunning,
          detail: `${task} step ${step}`,
          metadata: { taskId: task },
        },
      });
  for (const count of [1, 2])
    transport.send(daemonMessageTypes.sessionEvent, {
      event: {
        id: `evt_background_${count}`,
        sessionId: "session",
        label: "Background tasks",
        detail: "",
        metadata: { backgroundTaskSnapshot: new Array(count).fill({}) },
      },
    });
  for (const index of [1, 2])
    transport.send(daemonMessageTypes.sessionEvent, toolEvent(index));
  transport.send(daemonMessageTypes.sessionCompleted, {
    response: "abc",
    sessionId: "session",
  });

  link.drain();
  while (link.bufferedAmount > 0 || transport.outboxStats().queued > 0) {
    link.drain();
    await settle();
  }
  const sent = link.messages.map((message) =>
    message.type === daemonMessageTypes.sessionEvent
      ? message.payload.event.detail
      : message.type,
  );
  assert.deepEqual(sent, [
    "step 0",
    "abc",
    "task_1 step 3",
    "task_2 step 3",
    "",
    "step 1",
    "step 2",
    daemonMessageTypes.sessionCompleted,
  ]);
  assert.equal(
    link.messages[4].payload.event.metadata.backgroundTaskSnapshot.length,
    2,
  );
});

test("a session start overtakes queued events; replies wait behind at most the threshold", () => {
  const highWaterMarkBytes = 2000;
  const transport = new ReliableSessionTransport({
    highWaterMarkBytes,
    drainCheckMs: 60_000,
  });
  const link = slowSocket();
  transport.bind(link);
  for (let index = 0; index < 200; index += 1) {
    transport.send(
      daemonMessageTypes.sessionEvent,
      toolEvent(index, "x".repeat(200)),
    );
  }
  assert.ok(transport.outboxStats().queued > 150);

  transport.send(daemonMessageTypes.sessionStarted, {
    sessionId: "other",
    inputId: "input_2",
  });
  const started = link.messages.findIndex(
    (message) => message.type === daemonMessageTypes.sessionStarted,
  );
  assert.ok(started > 0 && started < 15, `session_started at ${started}`);

  // An RPC reply goes straight to the socket: ahead of it is what the
  // socket holds, bounded by the threshold, not the outbox's backlog.
  const ahead = link.bufferedAmount;
  link.send(
    JSON.stringify({ id: "rpc_1", type: daemonMessageTypes.sessionSteered }),
  );
  assert.ok(
    ahead < highWaterMarkBytes + 1000,
    `${ahead} bytes ahead of the reply`,
  );
});

test("resends after a reconnect what the server has not acknowledged, starts first", async () => {
  const transport = new ReliableSessionTransport({
    highWaterMarkBytes: 1,
    drainCheckMs: 60_000,
  });
  const first = slowSocket();
  transport.bind(first);
  transport.send(daemonMessageTypes.sessionEvent, toolEvent(1));
  transport.send(daemonMessageTypes.sessionEvent, toolEvent(2));
  transport.send(daemonMessageTypes.sessionStarted, { sessionId: "next" });
  transport.send(daemonMessageTypes.sessionEvent, toolEvent(3));
  // Written: event 1 (it filled the socket) and the start.
  assert.equal(first.messages.length, 2);
  transport.acknowledge(first.messages[0].id);

  transport.unbind(first);
  const second = socket();
  transport.bind(second);
  assert.deepEqual(
    second.messages.map((message) =>
      message.type === daemonMessageTypes.sessionEvent
        ? message.payload.event.detail
        : message.type,
    ),
    [daemonMessageTypes.sessionStarted, "step 2", "step 3"],
  );
  assert.equal(second.messages[0].id, first.messages[1].id);
});

test("a message the server refused goes again after a wait", async () => {
  const transport = new ReliableSessionTransport({ failureRetryMs: 5 });
  const connected = socket();
  transport.bind(connected);
  const id = transport.send(daemonMessageTypes.sessionCompleted, {
    response: "done",
    sessionId: "session",
  });
  assert.equal(transport.retryAfterError("msg_not_ours"), false);
  assert.equal(transport.retryAfterError(id), true);
  // Refused again before it went: still one retry.
  assert.equal(transport.retryAfterError(id), true);
  assert.equal(connected.messages.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(connected.messages.length, 2);
  assert.equal(connected.messages[1].id, id);

  transport.acknowledge(id);
  assert.equal(transport.retryAfterError(id), false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(connected.messages.length, 2);
});

test("reports how far behind the outbox is: what waits and what answers took, not answers that never came", () => {
  let now = 1_000;
  const transport = new ReliableSessionTransport({
    highWaterMarkBytes: 1,
    drainCheckMs: 60_000,
    now: () => now,
  });
  const link = slowSocket();
  transport.bind(link);
  const first = transport.send(daemonMessageTypes.sessionEvent, toolEvent(1));
  now = 3_000;
  transport.send(daemonMessageTypes.sessionEvent, toolEvent(2));
  transport.send(daemonMessageTypes.sessionEvent, toolEvent(3));
  now = 10_000;
  const stats = transport.outboxStats();
  assert.deepEqual(
    { ...stats, bufferedBytes: stats.bufferedBytes > 0 },
    {
      queued: 2,
      oldestQueuedMs: 7_000,
      unacknowledged: 3,
      ackLatencyMs: 0,
      bufferedBytes: true,
    },
  );
  transport.acknowledge(first);
  assert.equal(transport.outboxStats().ackLatencyMs, 9_000);
  // An answer from long ago says nothing about the link now.
  now += 3 * 60_000;
  assert.equal(transport.outboxStats().ackLatencyMs, 0);
});

test("a message with no answer for minutes goes once more, and only from a drained socket", async () => {
  const transport = new ReliableSessionTransport({
    answerTimeoutMs: 40,
    answerCheckMs: 10,
  });
  const connected = socket();
  transport.bind(connected);
  const id = transport.send(daemonMessageTypes.sessionCompleted, {
    response: "done",
    sessionId: "session",
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(
    connected.messages.map((message) => message.id),
    [id, id],
    "its answer was lost: once more, not every check",
  );
  transport.acknowledge(id);
  assert.equal(transport.pendingCount(), 0);

  const busy = slowSocket();
  const held = new ReliableSessionTransport({
    answerTimeoutMs: 40,
    answerCheckMs: 10,
  });
  held.bind(busy);
  held.send(daemonMessageTypes.sessionEvent, toolEvent(1));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(busy.messages.length, 1, "still on its way: no answer due");
  busy.drain();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(busy.messages.length, 2, "drained, unanswered: once more");
});

test("a message refused again and again waits for the next connection", async () => {
  const transport = new ReliableSessionTransport({
    failureRetryMs: 1,
    maxFailureRetries: 2,
  });
  const first = socket();
  transport.bind(first);
  const id = transport.send(daemonMessageTypes.sessionResumed, {
    sessionId: "finished",
  });
  for (let refusal = 0; refusal < 4; refusal += 1) {
    assert.equal(transport.retryAfterError(id), true);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(first.messages.length, 3, "sent, then retried twice");
  const second = socket();
  transport.bind(second);
  assert.deepEqual(
    second.messages.map((message) => message.id),
    [id],
  );
  assert.equal(transport.retryAfterError(id), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(second.messages.length, 2, "a new connection retries anew");
});

test("closing waits, bounded, for the server to take what the outbox holds", async () => {
  const transport = new ReliableSessionTransport();
  assert.equal(await transport.whenSettled(1_000), true, "nothing to wait for");
  const connected = socket();
  transport.bind(connected);
  const id = transport.send(daemonMessageTypes.sessionCompleted, {
    response: "done",
    sessionId: "session",
  });
  const settled = transport.whenSettled(5_000);
  setTimeout(() => transport.acknowledge(id), 10);
  assert.equal(await settled, true);

  transport.send(daemonMessageTypes.sessionCompleted, {
    response: "again",
    sessionId: "session",
  });
  assert.equal(await transport.whenSettled(20), false, "bounded");
  const gone = transport.whenSettled(5_000);
  transport.unbind(connected);
  assert.equal(await gone, false, "no socket left to carry it");
  assert.equal(await transport.whenSettled(5_000), false);
});

test("over a real socket whose peer stops reading, events wait in the outbox and arrive once, in order", async (t) => {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const received = [];
  let raw;
  server.on("upgrade", (request, socket, head) => {
    raw = socket;
    wss.handleUpgrade(request, socket, head, (peer) => {
      // The network stops taking bytes: what is sent backs up.
      socket.pause();
      peer.on("message", (data) => received.push(JSON.parse(String(data))));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  t.after(() => {
    client.terminate();
    wss.close();
    server.close();
  });
  await once(client, "open");

  const highWaterMarkBytes = 64 * 1024;
  const transport = new ReliableSessionTransport({ highWaterMarkBytes });
  transport.bind(client);
  const padding = "x".repeat(16 * 1024);
  const total = 1500;
  for (let index = 0; index < total; index += 1) {
    transport.send(daemonMessageTypes.sessionEvent, toolEvent(index, padding));
  }
  // Give the kernel buffers time to fill; the outbox holds the rest.
  for (let waited = 0; transport.outboxStats().queued === 0; waited += 10) {
    if (waited > 5_000) assert.fail("the socket never backed up");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    client.bufferedAmount < highWaterMarkBytes + 20 * 1024,
    `${client.bufferedAmount} bytes held by the socket`,
  );
  const backedUp = transport.outboxStats().queued;
  assert.ok(backedUp > 0 && backedUp < total);

  raw.resume();
  for (let waited = 0; received.length < total; waited += 10) {
    if (waited > 20_000) assert.fail(`only ${received.length} arrived`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(received.length, total, "nothing arrived twice");
  assert.deepEqual(
    received.map((message) => message.payload.event.id),
    Array.from({ length: total }, (_, index) => `evt_session_${index}`),
  );
  assert.equal(transport.outboxStats().queued, 0);
  assert.equal(transport.pendingCount(), total, "acknowledged by no one yet");
});
