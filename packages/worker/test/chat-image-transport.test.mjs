import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { daemonMessageTypes } from "@bd777/foundry-protocol";
import { DaemonDispatch } from "../dist/daemon/dispatch.js";
import { registerFileHandlers } from "../dist/daemon/handlers/files.js";
import {
  readAttachmentImageChunk,
  writeAttachmentChunk,
} from "../dist/workspace-attachments.js";
import { ReliableSessionTransport, sendWebSocket } from "../dist/transport.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(190467 - 8, 7),
]);

function workspace(t) {
  const path = mkdtempSync(join(tmpdir(), "foundry-image-concurrency-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function slowSocket() {
  const messages = [];
  const callbacks = [];
  return {
    readyState: 1,
    bufferedAmount: 0,
    messages,
    send(value, callback) {
      messages.push(JSON.parse(value));
      this.bufferedAmount += Buffer.byteLength(value);
      callbacks.push(callback);
    },
    drain() {
      this.bufferedAmount = 0;
      callbacks.splice(0).forEach((callback) => callback?.());
    },
  };
}

function assembled(messages) {
  const pieces = new Map();
  const result = [];
  for (const message of messages) {
    if (message.type !== daemonMessageTypes.replyChunk) {
      result.push(message);
      continue;
    }
    const { id, data, seq, last } = message.payload;
    const parts = pieces.get(id) ?? [];
    assert.equal(seq, parts.length);
    parts.push(data);
    pieces.set(id, parts);
    if (last) {
      result.push(JSON.parse(parts.join("")));
      pieces.delete(id);
    }
  }
  assert.equal(pieces.size, 0, "no abandoned assembly");
  return result;
}

test("an image read answers while an unrelated async daemon handler is still pending", async (t) => {
  const workspacePath = workspace(t);
  const { path } = writeAttachmentChunk({
    workspacePath,
    relativePath: "shot.png",
    offset: 0,
    data: png,
    final: true,
  });
  const socket = slowSocket();
  const dispatch = new DaemonDispatch();
  registerFileHandlers(dispatch);
  let finish;
  dispatch.on(
    "slow",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const ctx = { socket, roster: { folderFor: () => workspacePath } };
  const pending = dispatch.dispatch({ type: "slow" }, ctx);
  try {
    await dispatch.dispatch(
      {
        type: daemonMessageTypes.attachmentRead,
        id: "read",
        payload: { workspaceId: "ws", path, offset: 0, maxBytes: png.length },
      },
      ctx,
    );
    assert.equal(
      socket.messages[0].type,
      daemonMessageTypes.attachmentChunkRead,
    );
    assert.equal(
      Buffer.from(socket.messages[0].payload.dataBase64, "base64").length,
      64 * 1024,
    );
  } finally {
    finish();
    await pending;
  }
  const parts = [];
  for (let offset = 0; offset < png.length;) {
    const chunk = readAttachmentImageChunk({
      workspacePath,
      path,
      offset,
      maxBytes: png.length,
    });
    assert.equal(chunk.size, png.length);
    assert.ok(chunk.data.length <= 64 * 1024);
    parts.push(chunk.data);
    offset += chunk.data.length;
  }
  assert.deepEqual(Buffer.concat(parts), png);
});

test("large reliable snapshots yield to image replies and preserve reliable event order", async () => {
  const transport = new ReliableSessionTransport({
    highWaterMarkBytes: 1024,
    pieceChars: 512,
  });
  const socket = slowSocket();
  transport.bind(socket, { replyChunks: true });
  const first = transport.send(daemonMessageTypes.sessionEvent, {
    event: { id: "one", detail: "😀".repeat(4000) },
  });
  const second = transport.send(daemonMessageTypes.sessionEvent, {
    event: { id: "two", detail: "next" },
  });
  sendWebSocket(
    socket,
    daemonMessageTypes.attachmentChunkRead,
    { dataBase64: "x".repeat(1000) },
    "image",
  );
  for (
    let i = 0;
    i < 200 && (transport.queuedCount() || socket.bufferedAmount);
    i++
  ) {
    socket.drain();
    await settle();
  }
  assert.ok(
    socket.messages.every(
      (message) => Buffer.byteLength(JSON.stringify(message)) < 2400,
    ),
    "every frame is bounded, including a reliable event",
  );
  const result = assembled(socket.messages);
  assert.deepEqual(
    result
      .filter((message) => message.type === daemonMessageTypes.sessionEvent)
      .map((message) => message.id),
    [first, second],
  );
  assert.equal(
    result[0].id,
    "image",
    "the image completes before the huge snapshot",
  );
  assert.equal(transport.pendingCount(), 2, "reliable events still await ACK");
  transport.acknowledge(first);
  transport.acknowledge(second);
  transport.unbind(socket);
});

test("partly sent snapshots finish when coalesced and restart from piece zero after reconnect", async () => {
  const transport = new ReliableSessionTransport({
    highWaterMarkBytes: 1,
    pieceChars: 128,
  });
  const socket = slowSocket();
  transport.bind(socket, { replyChunks: true });
  const event = (detail) => ({
    event: { id: "same", label: "Response stream", detail },
  });
  transport.send(
    daemonMessageTypes.sessionEvent,
    event("a".repeat(3000)),
    "old",
  );
  transport.send(
    daemonMessageTypes.sessionEvent,
    event("b".repeat(3000)),
    "new",
  );
  transport.send(
    daemonMessageTypes.sessionEvent,
    event("c".repeat(3000)),
    "latest",
  );
  assert.equal(
    transport.pendingCount(),
    2,
    "the in-progress and latest snapshots remain",
  );
  for (let i = 0; i < 200 && transport.queuedCount(); i++) {
    socket.drain();
    await settle();
  }
  assert.deepEqual(
    assembled(socket.messages).map((message) => message.id),
    ["old", "latest"],
  );
  transport.unbind(socket);
  const reconnect = slowSocket();
  transport.bind(reconnect, { replyChunks: true });
  assert.equal(reconnect.messages[0].payload.seq, 0);
  for (let i = 0; i < 200 && transport.queuedCount(); i++) {
    reconnect.drain();
    await settle();
  }
  assert.deepEqual(
    assembled(reconnect.messages).map((message) => message.id),
    ["old", "latest"],
  );
  transport.acknowledge("old");
  transport.acknowledge("latest");
  transport.unbind(reconnect);
});

test("production-sized skill inventory and snapshots keep wire messages bounded", async (t) => {
  const transport = new ReliableSessionTransport();
  const socket = slowSocket();
  transport.bind(socket, { replyChunks: true });
  transport.send(
    daemonMessageTypes.sessionEvent,
    { event: { id: "snapshot", detail: "x".repeat(512 * 1024) } },
    "snapshot",
  );
  sendWebSocket(
    socket,
    daemonMessageTypes.skillsScanned,
    { skills: [{ description: "x".repeat(616 * 1024) }] },
    "scan",
  );
  sendWebSocket(
    socket,
    daemonMessageTypes.attachmentChunkRead,
    { dataBase64: png.subarray(0, 64 * 1024).toString("base64") },
    "image",
  );
  for (
    let i = 0;
    i < 300 && (transport.queuedCount() || socket.bufferedAmount);
    i++
  ) {
    socket.drain();
    await settle();
  }
  const frames = socket.messages.map((message) =>
    Buffer.byteLength(JSON.stringify(message)),
  );
  const maxFrameBytes = Math.max(...frames);
  assert.ok(
    maxFrameBytes < 17 * 1024,
    `largest wire message: ${maxFrameBytes}`,
  );
  const result = assembled(socket.messages);
  assert.ok(
    result.findIndex((message) => message.id === "image") <
      result.findIndex((message) => message.id === "snapshot"),
  );
  t.diagnostic(
    JSON.stringify({
      logicalSnapshotBytes: 512 * 1024,
      logicalSkillDescriptionBytes: 616 * 1024,
      imageChunkBytes: 64 * 1024,
      wireMessages: frames.length,
      maxFrameBytes,
    }),
  );
  transport.acknowledge("snapshot");
  transport.unbind(socket);
});

test("interactive file bytes overtake scans while bulk waits for remote piece credit", async () => {
  const socket = slowSocket();
  const transport = new ReliableSessionTransport();
  transport.bind(socket, { replyChunks: true, replyChunkAck: true });
  const event = transport.send(daemonMessageTypes.sessionEvent, {
    event: { id: "large", detail: "x".repeat(512 * 1024) },
  });
  sendWebSocket(
    socket,
    daemonMessageTypes.skillsScanned,
    { description: "s".repeat(616 * 1024) },
    "scan",
  );
  assert.equal(
    socket.messages.length,
    1,
    "only one bulk frame is allowed ahead of a read",
  );
  assert.ok(Buffer.byteLength(JSON.stringify(socket.messages[0])) < 4500);
  socket.drain();
  await settle();
  assert.equal(
    socket.messages.length,
    1,
    "kernel drain alone is not a remote credit",
  );
  sendWebSocket(
    socket,
    daemonMessageTypes.attachmentChunkRead,
    { dataBase64: Buffer.alloc(115000).toString("base64") },
    "image",
  );
  for (let n = 0; n < 20; n++) {
    socket.drain();
    await settle();
  }
  const image = assembled(
    socket.messages.filter((m) => m.payload?.id !== event),
  ).find((m) => m.id === "image");
  assert.equal(Buffer.from(image.payload.dataBase64, "base64").length, 115000);
  assert.equal(
    socket.messages.filter((m) => m.payload?.id === event).length,
    1,
    "bulk stayed paused while the image completed",
  );
  let acked = 0;
  for (let n = 0; n < 2000; n++) {
    while (acked < socket.messages.length) {
      const message = socket.messages[acked++];
      if (message.type === daemonMessageTypes.replyChunk)
        transport.acknowledgePiece(message.payload.id, message.payload.seq);
      else transport.acknowledge(message.id);
    }
    socket.drain();
    await settle();
    if (socket.bufferedAmount === 0 && acked === socket.messages.length) break;
  }
  const all = assembled(socket.messages);
  assert.ok(all.some((m) => m.id === event));
  assert.ok(all.some((m) => m.id === "scan"));
  transport.acknowledge(event);
  transport.unbind(socket);
});

test("bulk credits bound actual UTF-8 and escaped JSON bytes", async () => {
  const socket = slowSocket(),
    transport = new ReliableSessionTransport();
  transport.bind(socket, { replyChunks: true, replyChunkAck: true });
  const id = transport.send(daemonMessageTypes.sessionEvent, {
    event: { detail: '第😀行\n"'.repeat(6000) },
  });
  let seen = 0;
  for (let n = 0; n < 2000; n++) {
    while (seen < socket.messages.length) {
      const frame = socket.messages[seen++];
      assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= 4096);
      transport.acknowledgePiece(frame.payload.id, frame.payload.seq);
    }
    socket.drain();
    await settle();
    if (socket.bufferedAmount === 0 && seen === socket.messages.length) break;
  }
  const all = assembled(socket.messages);
  assert.equal(all[0].id, id);
  assert.equal(all[0].payload.event.detail, '第😀行\n"'.repeat(6000));
  transport.acknowledge(id);
  transport.unbind(socket);
});

test("small bulk reports cannot fill the TCP queue and stale sockets cannot grant credit", async () => {
  const first = slowSocket(),
    transport = new ReliableSessionTransport();
  transport.bind(first, { replyChunks: true, replyChunkAck: true });
  for (let n = 0; n < 50; n++)
    sendWebSocket(
      first,
      daemonMessageTypes.skillsScanned,
      { description: "x".repeat(1000) },
      `scan-${n}`,
    );
  assert.equal(
    first.messages.length,
    1,
    "all ordinary reports, including small ones, share the bulk credit",
  );
  sendWebSocket(first, daemonMessageTypes.heartbeat, {});
  sendWebSocket(
    first,
    daemonMessageTypes.attachmentChunkRead,
    { dataBase64: "tiny" },
    "tiny",
  );
  assert.equal(first.messages.at(-1).id, "tiny");
  transport.unbind(first);
  const id = transport.send(daemonMessageTypes.sessionEvent, {
    event: { detail: "第😀行".repeat(1000) },
  });
  const current = slowSocket();
  transport.bind(current, { replyChunks: true, replyChunkAck: true });
  assert.equal(current.messages.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(current.messages[0])) <= 4096);
  transport.acknowledgePiece(id, 0, first);
  assert.equal(current.messages.length, 1);
  transport.acknowledgePiece(id, 0, current);
  assert.equal(current.messages.length, 2);
  transport.unbind(current);
});

test("original progress blocks are small while the default image block stays compatible", (t) => {
  const workspacePath = workspace(t);
  const { path } = writeAttachmentChunk({
    workspacePath,
    relativePath: "progress.png",
    offset: 0,
    data: png,
    final: true,
  });
  const input = { workspacePath, path, offset: 0, maxBytes: 20 * 1024 * 1024 };
  assert.equal(readAttachmentImageChunk(input).data.length, 65536);
  assert.deepEqual(
    readAttachmentImageChunk({ ...input, chunkBytes: 4096 }).data,
    png.subarray(0, 4096),
  );
  assert.deepEqual(
    readAttachmentImageChunk({ ...input, offset: 4096, chunkBytes: 4096 }).data,
    png.subarray(4096, 8192),
  );
  assert.throws(
    () => readAttachmentImageChunk({ ...input, chunkBytes: 0 }),
    /chunk size/,
  );
});
