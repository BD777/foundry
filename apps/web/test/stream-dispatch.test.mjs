import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { fakeEventSourceClass } from "./fake-tabs.mjs";

register("./bundler-resolve.mjs", import.meta.url);

const { createFoundryStream } = await import("../src/stream/foundry-stream.ts");

function soloStream() {
  const sources = [];
  const EventSource = fakeEventSourceClass(sources);
  const stream = createFoundryStream({
    url: "http://api/api/events",
    eventSource: () => EventSource,
    tabs: () => undefined,
  });
  return { stream, source: () => sources.at(-1) };
}

const titles = (workspaceId) => ({ workspaceId, titles: [], removed: [] });

test("a subscriber that throws keeps the event from nobody, the projection first", (t) => {
  const errors = t.mock.method(console, "error", () => undefined);
  const { stream, source } = soloStream();
  const order = [];
  stream.onStreamEvent("chat_titles_changed", () => {
    order.push("feature that throws");
    throw new Error("broken feature");
  });
  stream.onStreamEvent("chat_titles_changed", () => order.push("feature"));
  stream.onAnyStreamEvent(() => order.push("projection"), {
    onOpen: () => {
      throw new Error("broken lifecycle");
    },
  });
  const opened = [];
  stream.onStreamLifecycle({ onOpen: () => opened.push("open") });
  source().open();
  assert.deepEqual(opened, ["open"], "a throwing onOpen stops no other");
  source().send("ep-1", "chat_titles_changed", titles("ws"));
  assert.deepEqual(order, ["projection", "feature that throws", "feature"]);
  assert.equal(errors.mock.callCount(), 2, "each failure is reported");
});

test("unsubscribing twice, after another subscribed the type, leaves the other subscribed", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { stream, source } = soloStream();
  const received = [];
  const stopFirst = stream.onStreamEvent("chat_titles_changed", () =>
    received.push("first"),
  );
  stopFirst();
  const stopSecond = stream.onStreamEvent("chat_titles_changed", () =>
    received.push("second"),
  );
  stopFirst();
  source().open();
  source().send("ep-1", "chat_titles_changed", titles("ws"));
  assert.deepEqual(received, ["second"]);

  // A second leave neither drops another subscriber's connection.
  const stopAny = stream.onAnyStreamEvent(() => undefined);
  stopAny();
  stopAny();
  t.mock.timers.tick(1_000);
  assert.equal(source().closed, false, "the second subscription keeps it");
  stopSecond();
  t.mock.timers.tick(1_000);
  assert.equal(source().closed, true);
});
