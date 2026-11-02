import assert from "node:assert/strict";
import test from "node:test";
import { PendingReplies } from "../dist/platform/pending-replies.js";

test("a reply settles the request with its id, once", async () => {
  const replies = new PendingReplies();
  const first = replies.wait("a");
  const second = replies.wait("b");
  assert.equal(replies.size, 2);
  assert.equal(replies.resolve("a", 1), true);
  assert.equal(replies.resolve("a", 2), false);
  assert.equal(replies.reject("b", new Error("no")), true);
  assert.equal(await first, 1);
  await assert.rejects(second, /no/);
  assert.equal(replies.size, 0);
});

test("a timeout or abort rejects and forgets the request", async () => {
  const replies = new PendingReplies();
  const timedOut = replies.wait(1, {
    timeout: { ms: 5, error: () => new Error("late") },
  });
  await assert.rejects(timedOut, /late/);
  assert.equal(replies.size, 0);
  const controller = new AbortController();
  const aborted = replies.wait(2, {
    signal: controller.signal,
    aborted: () => new Error("stopped"),
  });
  controller.abort();
  await assert.rejects(aborted, /stopped/);
  assert.equal(replies.resolve(2, "too late"), false);
});

test("rejectAll ends every request with its label; take hands a reply over", async () => {
  const replies = new PendingReplies();
  const one = replies.wait("x", { label: "thread/start" });
  const later = replies.wait("y", {
    timeout: { ms: 60_000, error: () => new Error("late") },
  });
  const settlers = replies.take("y");
  replies.rejectAll((label) => new Error(`${label} lost`));
  await assert.rejects(one, /thread\/start lost/);
  settlers.resolve("applied");
  assert.equal(await later, "applied");
});
