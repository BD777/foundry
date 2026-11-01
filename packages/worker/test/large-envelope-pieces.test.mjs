import assert from "node:assert/strict";
import test from "node:test";
import { daemonMessageTypes } from "@bd777/foundry-protocol";
import { ReliableSessionTransport, sendWebSocket } from "../dist/transport.js";

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

/** Lets the network take everything, a slice at a time, until nothing is left. */
async function drainAll(link, transport, slice = 4096) {
  for (let rounds = 0; rounds < 100_000; rounds += 1) {
    const written = link.messages.length;
    link.drain(slice);
    await settle();
    if (
      link.bufferedAmount === 0 &&
      link.messages.length === written &&
      transport.outboxStats().queued === 0
    )
      return;
  }
  assert.fail("the socket never drained");
}

/** The envelope the pieces of id assemble, checking their order and end. */
function assembled(messages, id) {
  const pieces = messages.filter(
    (message) =>
      message.type === daemonMessageTypes.replyChunk &&
      message.payload.id === id,
  );
  assert.ok(pieces.length > 1, `${id} went in ${pieces.length} pieces`);
  pieces.forEach((piece, index) => {
    assert.equal(piece.payload.seq, index);
    assert.equal(piece.payload.last === true, index === pieces.length - 1);
  });
  return JSON.parse(pieces.map((piece) => piece.payload.data).join(""));
}

function scan(size, filler = "x") {
  return {
    skills: [{ name: "big", description: filler.repeat(size / filler.length) }],
  };
}

test("a small reply is not stuck behind a large one on a slow uplink", async () => {
  const highWaterMarkBytes = 64 * 1024;
  const pieceChars = 16 * 1024;
  const transport = new ReliableSessionTransport({
    highWaterMarkBytes,
    pieceChars,
    drainCheckMs: 5,
  });
  const link = slowSocket();
  transport.bind(link, { replyChunks: true });

  // A 1 MiB file chunk, as base64, answers a read.
  const payload = scan(1024 * 1024);
  sendWebSocket(link, daemonMessageTypes.skillsScanned, payload, "rpc_scan");
  assert.ok(
    link.bufferedAmount < highWaterMarkBytes + 2 * pieceChars,
    `${link.bufferedAmount} bytes of the large reply held by the socket`,
  );

  // A steer's answer and a session start go next: ahead of them is at most
  // the high-water mark and a piece, ~8 s at 10 KB/s, not ~100 s.
  const ahead = link.bufferedAmount;
  sendWebSocket(
    link,
    daemonMessageTypes.sessionSteered,
    { sessionId: "session" },
    "rpc_steer",
  );
  transport.send(daemonMessageTypes.sessionStarted, { sessionId: "next" });
  assert.ok(
    ahead < highWaterMarkBytes + 2 * pieceChars,
    `${ahead} bytes ahead of the small reply`,
  );
  const steer = link.messages.findIndex(
    (message) => message.id === "rpc_steer",
  );
  const started = link.messages.findIndex(
    (message) => message.type === daemonMessageTypes.sessionStarted,
  );
  assert.ok(steer > 0 && started > 0, "both went out at once");

  await drainAll(link, transport);
  const whole = assembled(link.messages, "rpc_scan");
  assert.deepEqual(whole, {
    id: "rpc_scan",
    payload,
    type: daemonMessageTypes.skillsScanned,
  });
  const firstPiece = link.messages.findIndex(
    (message) => message.type === daemonMessageTypes.replyChunk,
  );
  assert.ok(firstPiece < steer, "the large reply had started");
  assert.ok(
    link.messages.findLastIndex(
      (message) => message.type === daemonMessageTypes.replyChunk,
    ) > steer,
    "and finished after the small one",
  );
});

test("bulk pieces take turns with events and other bulk envelopes", async () => {
  const transport = new ReliableSessionTransport({
    highWaterMarkBytes: 4096,
    pieceChars: 1024,
    drainCheckMs: 5,
  });
  const link = slowSocket();
  transport.bind(link, { replyChunks: true });
  sendWebSocket(link, daemonMessageTypes.skillsScanned, scan(64 * 1024), "big");
  sendWebSocket(
    link,
    daemonMessageTypes.skillsScanned,
    scan(4 * 1024),
    "small",
  );
  for (let index = 0; index < 20; index += 1)
    transport.send(daemonMessageTypes.sessionEvent, {
      event: { id: `evt_${index}`, sessionId: "s", detail: `step ${index}` },
    });
  await drainAll(link, transport, 512);

  const order = link.messages.map((message) =>
    message.type === daemonMessageTypes.replyChunk
      ? message.payload.id
      : message.type,
  );
  const lastSmall = order.lastIndexOf("small");
  const lastBig = order.lastIndexOf("big");
  assert.ok(
    lastSmall < lastBig,
    "the smaller one did not wait for the big one",
  );
  assert.ok(
    order.lastIndexOf(daemonMessageTypes.sessionEvent) < lastBig,
    "events did not wait for the big one",
  );
  assert.equal(assembled(link.messages, "big").id, "big");
  assert.equal(assembled(link.messages, "small").id, "small");
});

test("a piece never splits a surrogate pair", async () => {
  const transport = new ReliableSessionTransport({
    highWaterMarkBytes: 1 << 20,
    pieceChars: 101,
  });
  const link = slowSocket();
  transport.bind(link, { replyChunks: true });
  const payload = scan(4000, "a😀");
  sendWebSocket(link, daemonMessageTypes.skillsScanned, payload, "emoji");
  await drainAll(link, transport);
  for (const message of link.messages) {
    const data = message.payload.data;
    const code = data.charCodeAt(data.length - 1);
    assert.ok(code < 0xd800 || code > 0xdbff, "a piece ends inside a pair");
  }
  assert.deepEqual(assembled(link.messages, "emoji").payload, payload);
});

test("a socket that takes no pieces gets large envelopes whole", () => {
  const transport = new ReliableSessionTransport({
    highWaterMarkBytes: 1 << 20,
    pieceChars: 1024,
  });
  const link = slowSocket();
  transport.bind(link);
  sendWebSocket(link, daemonMessageTypes.fileRead, scan(64 * 1024), "whole");
  assert.deepEqual(
    link.messages.map((message) => [message.type, message.id]),
    [[daemonMessageTypes.fileRead, "whole"]],
  );

  // Bound again to the same socket, now taking pieces.
  transport.bind(link, { replyChunks: true });
  sendWebSocket(link, daemonMessageTypes.fileRead, scan(64 * 1024), "pieces");
  assert.equal(link.messages.at(-1).type, daemonMessageTypes.replyChunk);
});

test("pieces answer their own connection: a new one does not get them", async () => {
  const transport = new ReliableSessionTransport({
    highWaterMarkBytes: 1024,
    pieceChars: 512,
    drainCheckMs: 5,
  });
  const first = slowSocket();
  transport.bind(first, { replyChunks: true });
  sendWebSocket(first, daemonMessageTypes.fileRead, scan(64 * 1024), "old");
  const written = first.messages.length;
  assert.ok(written > 0);
  transport.unbind(first);
  first.drain();
  await settle();
  assert.equal(first.messages.length, written, "nothing more on the old one");

  const second = slowSocket();
  transport.bind(second, { replyChunks: true });
  await drainAll(second, transport);
  assert.equal(
    second.messages.filter(
      (message) => message.type === daemonMessageTypes.replyChunk,
    ).length,
    0,
  );
  // And a socket without an outbox writes as it always did.
  sendWebSocket(first, daemonMessageTypes.fileRead, scan(64 * 1024), "late");
  assert.equal(first.messages.at(-1).id, "late");
});
