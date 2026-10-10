import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("./bundler-resolve.mjs", import.meta.url);

/** EventSource as the stream module uses it; tests drive each source. */
class FakeEventSource {
  static all = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.closed = false;
    this.named = new Map();
    FakeEventSource.all.push(this);
  }
  addEventListener(type, listener) {
    this.named.set(type, listener);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  /** A dropped connection the browser retries itself (CONNECTING). */
  drop() {
    this.readyState = 0;
    this.onerror?.();
  }
  /** An error status (a proxy's 502): the browser gives this source up. */
  fail() {
    this.readyState = 2;
    this.onerror?.();
  }
  send(id, type, payload) {
    this.onmessage?.({
      lastEventId: id,
      data: JSON.stringify({ type, payload }),
    });
  }
  static get last() {
    return FakeEventSource.all.at(-1);
  }
}
globalThis.EventSource = FakeEventSource;

const {
  foundryStreamQuietMs,
  foundryStreamReopenDelaysMs,
  reconnectFoundryStream,
  subscribeFoundryEvents,
} = await import("../src/api.ts");

const flush = () => new Promise((resolve) => setImmediate(resolve));

function recorder() {
  const log = [];
  const events = [];
  return {
    log,
    events,
    subscribe: () =>
      subscribeFoundryEvents((event) => events.push(event), {
        onOpen: () => log.push("open"),
        onError: () => log.push("error"),
        onResync: ({ initial }) =>
          log.push(initial ? "resync:initial" : "resync"),
      }),
  };
}

async function closeAll(unsubscribes) {
  unsubscribes.forEach((unsubscribe) => unsubscribe());
  await new Promise((resolve) => setTimeout(resolve, 1100));
}

test("one connection per tab; a reconnect that resumes asks nobody to reload", async () => {
  FakeEventSource.all.length = 0;
  const app = recorder();
  const queue = recorder();
  const stopApp = app.subscribe();
  const stopQueue = queue.subscribe();
  assert.equal(FakeEventSource.all.length, 1, "subscribers share a source");
  const source = FakeEventSource.last;
  assert.equal(source.url, "http://127.0.0.1:31982/api/events");

  source.open();
  assert.deepEqual(
    app.log,
    ["open", "resync:initial"],
    "the first connection: state loaded before it may predate it",
  );
  assert.deepEqual(queue.log, ["open", "resync:initial"]);

  // A subscriber joining an open stream loads after it: no resync.
  const late = recorder();
  const stopLate = late.subscribe();
  await flush();
  assert.deepEqual(late.log, ["open"]);

  source.send("ep-1", "chat_titles_changed", { workspaceId: "ws" });
  source.send("ep-2", "chat_layout_changed", { workspaceId: "ws" });
  source.send("ep-3", "not_a_client_event", { workspaceId: "ws" });
  assert.deepEqual(
    app.events.map((event) => event.type),
    ["chat_titles_changed", "chat_layout_changed"],
    "new push types arrive; unknown ones are dropped",
  );

  app.log.length = queue.log.length = late.log.length = 0;
  source.drop();
  source.open();
  assert.deepEqual(
    app.log,
    ["error", "open"],
    "the browser resent Last-Event-ID: the server replays, nobody reloads",
  );
  assert.deepEqual(late.log, ["error", "open"]);
  assert.equal(FakeEventSource.all.length, 1, "the browser reconnected it");

  app.log.length = 0;
  source.send("ep-4", "resync", { reason: "expired" });
  assert.deepEqual(app.log, ["resync"], "a resync asks for a reload");
  assert.deepEqual(late.log.slice(-1), ["resync"]);

  await closeAll([stopApp, stopQueue, stopLate]);
  assert.equal(source.closed, true, "closed once nobody listens");
});

test("a source the browser gave up on is opened again, resuming, with capped backoff", async (t) => {
  FakeEventSource.all.length = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = recorder();
  const stop = app.subscribe();
  const first = FakeEventSource.last;
  first.open();
  first.send("ep-7", "chat_titles_changed", { workspaceId: "ws" });
  app.log.length = 0;

  first.fail();
  assert.equal(first.closed, true);
  assert.deepEqual(app.log, ["error"]);
  // Subscribing meanwhile must not open a second connection beside the timer.
  const other = recorder();
  const stopOther = other.subscribe();
  assert.equal(FakeEventSource.all.length, 1);

  t.mock.timers.tick(foundryStreamReopenDelaysMs[0] - 1);
  assert.equal(FakeEventSource.all.length, 1, "waits before reopening");
  t.mock.timers.tick(1);
  assert.equal(FakeEventSource.all.length, 2);
  const second = FakeEventSource.last;
  assert.equal(
    second.url,
    "http://127.0.0.1:31982/api/events?lastEventId=ep-7",
    "resumes after the last message seen",
  );

  // It fails again: the next wait is longer.
  second.fail();
  t.mock.timers.tick(foundryStreamReopenDelaysMs[1] - 1);
  assert.equal(FakeEventSource.all.length, 2);
  t.mock.timers.tick(1);
  const third = FakeEventSource.last;
  assert.equal(FakeEventSource.all.length, 3);

  app.log.length = 0;
  other.log.length = 0;
  third.open();
  assert.deepEqual(app.log, ["open"], "resumed: the server replays, no reload");
  assert.deepEqual(
    other.log,
    ["open"],
    "a subscriber that joined during the outage needs no reload either",
  );

  // After a good connection the backoff starts over.
  third.fail();
  t.mock.timers.tick(foundryStreamReopenDelaysMs[0]);
  assert.equal(FakeEventSource.all.length, 4);

  // Ever more failures never wait longer than the cap.
  for (let index = 0; index < 8; index++) {
    FakeEventSource.last.fail();
    t.mock.timers.tick(foundryStreamReopenDelaysMs.at(-1));
  }
  assert.equal(FakeEventSource.all.length, 12);

  stop();
  stopOther();
  t.mock.timers.tick(1100);
  assert.equal(FakeEventSource.last.closed, true);
  FakeEventSource.last.fail();
  t.mock.timers.tick(60_000);
  assert.equal(FakeEventSource.all.length, 12, "nobody listens: no reopen");
});

test("a connection with nowhere to resume from asks for a reload", async () => {
  FakeEventSource.all.length = 0;
  const app = recorder();
  const stop = app.subscribe();
  const source = FakeEventSource.last;
  source.open();
  app.log.length = 0;
  // No message (no id) arrived before the drop: events may be lost.
  source.drop();
  source.open();
  assert.deepEqual(app.log, ["error", "open", "resync"]);
  await closeAll([stop]);

  // Once nobody listened, the next subscriber starts afresh.
  const next = recorder();
  const stopNext = next.subscribe();
  assert.equal(FakeEventSource.last.url, "http://127.0.0.1:31982/api/events");
  FakeEventSource.last.open();
  assert.deepEqual(next.log, ["open", "resync:initial"]);
  await closeAll([stopNext]);
});

test("a connection that may have died silently is reopened, resuming", async (t) => {
  FakeEventSource.all.length = 0;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const app = recorder();
  const stop = app.subscribe();
  const first = FakeEventSource.last;
  first.open();
  first.send("ep-3", "chat_titles_changed", { workspaceId: "ws" });
  t.mock.timers.tick(45_000);
  assert.equal(foundryStreamQuietMs(), 45_000, "silent since the last message");
  app.log.length = 0;

  reconnectFoundryStream();
  assert.equal(first.closed, true);
  const second = FakeEventSource.last;
  assert.equal(
    second.url,
    "http://127.0.0.1:31982/api/events?lastEventId=ep-3",
  );
  second.open();
  assert.deepEqual(app.log, ["open"], "it resumes: nobody reloads");
  assert.equal(foundryStreamQuietMs(), 0);

  stop();
  t.mock.timers.tick(1100);
  reconnectFoundryStream();
  assert.equal(FakeEventSource.all.length, 2, "nobody listens: nothing opens");
});
