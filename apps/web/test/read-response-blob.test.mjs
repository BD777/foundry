import test from "node:test";
import assert from "node:assert/strict";
import { readResponseBlob } from "../src/lib/read-response-blob.ts";

test("stream progress reports complete raw bytes and abort cancels the reader", async () => {
  const updates = [];
  let stream;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        stream = controller;
      },
    }),
    { headers: { "Content-Length": "5", "Content-Type": "image/png" } },
  );
  const controller = new AbortController();
  const work = readResponseBlob(response, controller.signal, (value) =>
    updates.push(value),
  );
  stream.enqueue(Uint8Array.from([0, 1]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(updates, [{ received: 2, total: 5 }]);
  stream.enqueue(Uint8Array.from([2, 3, 4]));
  stream.close();
  const blob = await work;
  assert.equal(blob.type, "image/png");
  assert.deepEqual(
    [...new Uint8Array(await blob.arrayBuffer())],
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(updates.at(-1), { received: 5, total: 5 });
  let cancelled = false;
  const pending = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  );
  const abort = new AbortController();
  const waiting = readResponseBlob(pending, abort.signal, () => {});
  abort.abort();
  await assert.rejects(waiting);
  assert.equal(cancelled, true);
});
