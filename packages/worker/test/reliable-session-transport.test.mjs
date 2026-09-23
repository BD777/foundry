import assert from "node:assert/strict";
import test from "node:test";
import { daemonMessageTypes } from "@foundry/protocol";
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

function response(detail) {
  return {
    event: {
      detail,
      id: "evt_session_response_stream",
      label: "Response stream",
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

test("retries an unacknowledged envelope without requiring a reconnect", async () => {
  const transport = new ReliableSessionTransport(5);
  const connected = socket();
  transport.bind(connected);
  transport.send(daemonMessageTypes.sessionCompleted, {
    response: "done",
    sessionId: "session",
  });

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(connected.messages.length >= 2);
  assert.equal(connected.messages[0].id, connected.messages[1].id);

  transport.acknowledge(connected.messages[0].id);
  const acknowledgedCount = connected.messages.length;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(connected.messages.length, acknowledgedCount);
});
