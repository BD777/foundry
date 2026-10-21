import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { createHash } from "node:crypto";
import test from "node:test";
import { WebSocketServer, createWebSocketStream } from "ws";
import {
  openServiceTunnel,
  validServiceTunnelTarget,
} from "../dist/service-tunnels.js";
import { protectHTTPPort } from "../dist/protected-http-ports.js";
import { availableDaemonCapabilities } from "../dist/workspace-ops.js";

test("tunnels refuse control ports, unknown protocols and old hosts", () => {
  for (const port of [0, 22, 443, 1023, 31982, 31983, 65536, 1.5])
    assert.equal(
      validServiceTunnelTarget(port, "http", "https://control.example"),
      false,
    );
  assert.equal(
    validServiceTunnelTarget(18082, "ftp", "https://control.example"),
    false,
  );
  assert.equal(
    validServiceTunnelTarget(18082, "http", "http://127.0.0.1:18082"),
    false,
  );
  const unprotect = protectHTTPPort(18082);
  assert.equal(
    validServiceTunnelTarget(18082, "http", "https://control.example"),
    false,
  );
  unprotect();
  assert.equal(
    validServiceTunnelTarget(18082, "http", "https://control.example"),
    true,
  );
  assert.equal(
    availableDaemonCapabilities({ supportsCapability: () => false }).includes(
      "service_tunnels_v1",
    ),
    false,
  );
});

test("outbound framed data preserves large bidirectional bytes and closes local sockets", async () => {
  let localSocket;
  const local = createServer((socket) => {
    localSocket = socket;
    socket.pipe(socket);
  });
  local.listen(0, "127.0.0.1");
  await once(local, "listening");
  const remote = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  await once(remote, "listening");
  const connected = once(remote, "connection");
  const close = openServiceTunnel({
    serverURL: `http://127.0.0.1:${remote.address().port}`,
    headers: {},
    request: {
      streamId: "a".repeat(64),
      workspaceId: "synthetic",
      port: local.address().port,
      protocol: "http",
    },
  });
  const [ws] = await connected;
  const stream = createWebSocketStream(ws, { highWaterMark: 32 * 1024 });
  const data = Buffer.alloc(4 * 1024 * 1024, 123);
  const received = [];
  let size = 0;
  const answer = new Promise((resolve) =>
    stream.on("data", (chunk) => {
      received.push(chunk);
      size += chunk.length;
      if (size === data.length) resolve();
    }),
  );
  for (let at = 0; at < data.length; at += 32 * 1024) {
    if (!stream.write(data.subarray(at, at + 32 * 1024)))
      await once(stream, "drain");
  }
  await answer;
  assert.equal(
    createHash("sha256").update(Buffer.concat(received)).digest("hex"),
    createHash("sha256").update(data).digest("hex"),
  );
  stream.on("error", () => {});
  const localClosed = once(localSocket, "close");
  close();
  await localClosed;
  ws.terminate();
  stream.destroy();
  await new Promise((resolve) => remote.close(resolve));
  await new Promise((resolve) => local.close(resolve));
});

test("a silent data channel releases its local socket even while control stays up", async () => {
  const local = createServer();
  local.listen(0, "127.0.0.1");
  await once(local, "listening");
  const remote = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(remote, "listening");
  const localConnected = once(local, "connection");
  const remoteConnected = once(remote, "connection");
  const closed = new Promise((resolve) =>
    openServiceTunnel({
      serverURL: `http://127.0.0.1:${remote.address().port}`,
      headers: {},
      request: {
        streamId: "b".repeat(64),
        workspaceId: "synthetic",
        port: local.address().port,
        protocol: "http",
      },
      silenceMs: 100,
      onClose: resolve,
    }),
  );
  const [localSocket] = await localConnected;
  const [ws] = await remoteConnected;
  const localClosed = once(localSocket, "close");
  await closed;
  await localClosed;
  ws.terminate();
  await new Promise((resolve) => remote.close(resolve));
  await new Promise((resolve) => local.close(resolve));
});

test("the daemon refuses a tunnel for an unregistered execution workspace before opening sockets", async () => {
  const { DaemonDispatch } = await import("../dist/daemon/dispatch.js");
  const { registerServiceTunnelHandlers } =
    await import("../dist/daemon/handlers/service-tunnels.js");
  const dispatch = new DaemonDispatch();
  registerServiceTunnelHandlers(dispatch);
  await assert.rejects(
    dispatch.dispatch(
      {
        type: "service_tunnel_open",
        payload: {
          streamId: "c".repeat(64),
          workspaceId: "foreign",
          port: 18082,
          protocol: "http",
        },
      },
      {
        roster: {
          folderFor() {
            throw new Error("workspace is not registered");
          },
        },
      },
    ),
    /not registered/,
  );
});
