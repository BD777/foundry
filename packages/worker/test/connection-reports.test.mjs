import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import {
  ConnectionRecorder,
  describeConnectionReport,
  onServerBytes,
  proxyHost,
  recentConnectionReports,
  takeConnectionReports,
  watchServerSilence,
  withConnectionReports,
} from "../dist/connection-reports.js";

test("each connection says who ended it and how long the server was silent", async () => {
  takeConnectionReports();
  const silent = new ConnectionRecorder();
  silent.serverPing();
  silent.countBytes({ bytesRead: 1200, bytesWritten: 900 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  silent.workerGaveUp();
  const first = silent.closed(1006);
  assert.equal(first.closedBy, "worker");
  assert.ok(first.sinceServerDataMs >= 15, "silence is measured");
  assert.equal(first.bytesReceived, 1200);
  assert.equal(first.bytesSent, 900);

  const dropped = new ConnectionRecorder();
  const reset = Object.assign(new Error("read ECONNRESET"), {
    code: "ECONNRESET",
  });
  dropped.socketError(reset);
  const second = dropped.closed(1006);
  assert.equal(second.closedBy, "network");
  assert.equal(second.error, "ECONNRESET: read ECONNRESET");

  const ended = new ConnectionRecorder();
  const third = ended.closed(4000, "device_removed");
  assert.equal(third.closedBy, "server");
  assert.equal(third.closeReason, "device_removed");

  // The next registration carries them once; diagnostics keep them.
  const hello = withConnectionReports({ device: { id: "dev" } });
  assert.equal(hello.connections.length, 3);
  assert.equal(withConnectionReports({}).connections, undefined);
  assert.ok(recentConnectionReports().length >= 3);
  assert.match(describeConnectionReport(first), /closed by worker/);
  assert.match(
    describeConnectionReport(first),
    /worker sent 900 bytes, received 1200 bytes/,
  );
  assert.doesNotMatch(describeConnectionReport(second), /bytes/);
});

test("the proxy is named by host only, never with its credentials", () => {
  assert.equal(proxyHost({}), undefined);
  assert.equal(
    proxyHost({ HTTPS_PROXY: "http://user:secret@proxy.corp:3128" }),
    "proxy.corp:3128",
  );
  assert.equal(proxyHost({ https_proxy: "proxy.corp" }), "proxy.corp");
});

/**
 * A server that completes the WebSocket handshake by hand and then hands its
 * raw socket to `onUpgrade`, so a test decides when every byte goes out.
 */
async function rawWebSocketServer(t, onUpgrade) {
  const server = createServer();
  const sockets = new Set();
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    const accept = createHash("sha1")
      .update(
        `${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
      )
      .digest("base64");
    const handshake = Buffer.from(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
        `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    onUpgrade(socket, handshake);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  t.after(() => client.terminate());
  return client;
}

/** One unmasked text frame, as a server sends it (payload under 64 KiB). */
function textFrame(text) {
  const payload = Buffer.from(text);
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
}

test("a large message arriving slowly is not silence; nothing after it is", async (t) => {
  const silenceMs = 300;
  const frame = textFrame("x".repeat(6000));
  const piece = Math.ceil(frame.length / 30);
  // 30 pieces 25ms apart: the one message takes ~750ms, more than twice
  // the silence limit, with no ping or other message alongside it.
  const socket = await rawWebSocketServer(t, async (raw, handshake) => {
    raw.write(handshake);
    for (let at = 0; at < frame.length; at += piece) {
      await delay(25);
      if (raw.destroyed) return;
      raw.write(frame.subarray(at, at + piece));
    }
  });
  let silentAt;
  t.after(
    watchServerSilence(socket, silenceMs, () => {
      silentAt ??= Date.now();
    }),
  );
  const opened = once(socket, "open").then(() => Date.now());
  const [message] = await once(socket, "message", {
    signal: AbortSignal.timeout(5_000),
  });
  const receivedAt = Date.now();
  assert.equal(String(message).length, 6000);
  assert.ok(
    receivedAt - (await opened) > silenceMs,
    "the message took longer to arrive than the silence limit",
  );
  assert.equal(silentAt, undefined, "arriving bytes kept the connection");

  await delay(silenceMs + 200);
  assert.ok(silentAt, "a server that then sends nothing is given up on");
  assert.ok(silentAt - receivedAt >= silenceMs - 20);
});

test("a server that sends nothing after the handshake is given up on", async (t) => {
  const socket = await rawWebSocketServer(t, (raw, handshake) =>
    raw.write(handshake),
  );
  const silent = new Promise((resolve) =>
    t.after(watchServerSilence(socket, 200, () => resolve(Date.now()))),
  );
  const openedAt = await once(socket, "open").then(() => Date.now());
  const silentAt = await Promise.race([silent, delay(2_000, "never")]);
  assert.notEqual(silentAt, "never", "the silence watch fired");
  assert.ok(silentAt - openedAt >= 180);
});

test("bytes that come with the handshake still reach ws as a message", async (t) => {
  // The first frame shares the handshake's write, so it reaches the client
  // with the 101 response; watching bytes must not take it from ws.
  const socket = await rawWebSocketServer(t, (raw, handshake) =>
    raw.write(Buffer.concat([handshake, textFrame("hello")])),
  );
  let chunks = 0;
  onServerBytes(socket, () => chunks++);
  const [message] = await once(socket, "message", {
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(String(message), "hello");
  await delay(10);
  assert.ok(chunks > 0, "the watcher saw the bytes too");
});
