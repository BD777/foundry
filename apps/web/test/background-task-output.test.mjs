import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

register("./bundler-resolve.mjs", import.meta.url);

const {
  backgroundOutputFollowRenewMs,
  backgroundOutputPollMs,
  backgroundOutputShownChars,
  mergeBackgroundOutput,
  useBackgroundTaskOutput,
} = await import("../src/features/chat/use-background-task-output.ts");

const base = {
  sessionId: "sess",
  taskId: "b1",
  truncated: false,
  bytes: 0,
  kind: "text",
};

test("a continued read adds to what is shown; its open line is replaced", () => {
  let shown = mergeBackgroundOutput(undefined, {
    ...base,
    content: "one\ntw",
    lineEnd: 4,
    stable: 4,
  });
  assert.equal(shown.output.content, "one\ntw");
  shown = mergeBackgroundOutput(shown, {
    ...base,
    content: "two\nthr",
    from: 4,
    lineEnd: 8,
    stable: 4,
  });
  assert.equal(shown.output.content, "one\ntwo\nthr");
  assert.equal(shown.output.from, undefined);
  assert.equal(shown.lineEnd, 8);
  assert.equal(
    mergeBackgroundOutput(shown, { ...base, content: "x", from: 4 }),
    undefined,
    "a read that continues something else is not used",
  );
  // Older devices answer without lineEnd: every read replaces what is shown.
  const old = mergeBackgroundOutput(shown, { ...base, content: "whole" });
  assert.equal(old.output.content, "whole");
  assert.equal(old.lineEnd, undefined);
});

test("what is shown keeps the end of the log from a line start", () => {
  const line = `${"x".repeat(99)}\n`;
  // An empty log, then its first lines.
  let shown = mergeBackgroundOutput(undefined, {
    ...base,
    content: "",
    lineEnd: 0,
    stable: 0,
  });
  shown = mergeBackgroundOutput(shown, {
    ...base,
    content: "\n\nfirst\n",
    from: 0,
    lineEnd: 8,
    stable: 8,
  });
  assert.equal(shown.output.content, "first\n", "no leading blank lines");
  const added = line.repeat(Math.ceil(backgroundOutputShownChars / 100) + 5);
  shown = mergeBackgroundOutput(shown, {
    ...base,
    content: added,
    from: 8,
    lineEnd: 8 + added.length,
    stable: added.length,
  });
  assert.ok(shown.output.content.length <= backgroundOutputShownChars);
  assert.ok(shown.output.content.startsWith("x"), "starts at a whole line");
  assert.ok(shown.output.content.endsWith(line));
  assert.equal(shown.output.truncated, true);
});

class FakeEventSource {
  static last;
  constructor() {
    FakeEventSource.last = this;
  }
  addEventListener() {}
  close() {}
}

/** A device's log as the output endpoint serves it. */
function fakeServer({ follows = true } = {}) {
  const reads = [];
  let log = "one\n";
  return {
    reads,
    grow(text) {
      log += text;
    },
    fetch: async (input) => {
      const url = new URL(String(input), "http://localhost");
      assert.match(url.pathname, /\/background-tasks\/b1\/output$/);
      const after = url.searchParams.get("after");
      reads.push({ after, follow: url.searchParams.get("follow") });
      const from = after === null ? 0 : Number(after);
      const body = {
        ...base,
        content: log.slice(from),
        bytes: log.length,
        lineEnd: log.length,
        stable: log.length - from,
        ...(after === null ? {} : { from }),
        ...(follows ? { following: true } : {}),
      };
      return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

async function page(t, server) {
  const window = new Window();
  const previous = new Map();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    EventSource: FakeEventSource,
    fetch: server.fetch,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const shown = {};
  let running = true;
  function Harness() {
    Object.assign(shown, useBackgroundTaskOutput("sess", "b1", running));
    return null;
  }
  const root = createRoot(window.document.createElement("div"));
  const settle = () =>
    act(async () => {
      for (let index = 0; index < 5; index++)
        await new Promise((resolve) => setImmediate(resolve));
    });
  await act(() => root.render(createElement(Harness)));
  await settle();
  t.after(async () => {
    await act(() => root.unmount());
    t.mock.timers.tick(1100);
    t.mock.timers.reset();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await window.happyDOM.close();
  });
  let id = 0;
  return {
    shown,
    settle,
    elapse: async (ms) => {
      await act(() => t.mock.timers.tick(ms));
      await settle();
    },
    push: async (payload) => {
      await act(() =>
        FakeEventSource.last.onmessage({
          lastEventId: `ep-${++id}`,
          data: JSON.stringify({
            type: "background_task_output_changed",
            payload,
          }),
        }),
      );
      await settle();
    },
    stop: async () => {
      running = false;
      await act(() => root.render(createElement(Harness)));
      await settle();
    },
  };
}

test("a followed log is read onward when it grows, not on a timer", async (t) => {
  const server = fakeServer();
  const p = await page(t, server);
  assert.deepEqual(server.reads, [{ after: null, follow: "1" }]);
  assert.equal(p.shown.output.content, "one\n");

  await p.elapse(backgroundOutputPollMs * 3);
  assert.equal(server.reads.length, 1, "no read while nothing grows");

  server.grow("two\n");
  await p.push({ workspaceId: "ws", sessionId: "sess", taskId: "other" });
  assert.equal(server.reads.length, 1, "another task's log is not read");
  await p.push({ workspaceId: "ws", sessionId: "sess", taskId: "b1" });
  assert.deepEqual(server.reads.at(-1), { after: "4", follow: "1" });
  assert.equal(p.shown.output.content, "one\ntwo\n");

  // The device's lease is renewed while the log is shown.
  await p.elapse(backgroundOutputFollowRenewMs);
  assert.deepEqual(server.reads.at(-1), { after: "8", follow: "1" });

  // An ended task is read once more, without following.
  server.grow("done\n");
  await p.stop();
  assert.deepEqual(server.reads.at(-1), { after: "8", follow: null });
  assert.equal(p.shown.output.content, "one\ntwo\ndone\n");
  const reads = server.reads.length;
  await p.elapse(backgroundOutputFollowRenewMs * 2);
  assert.equal(server.reads.length, reads);
});

test("a device that cannot follow a log has it read every few seconds", async (t) => {
  const server = fakeServer({ follows: false });
  const p = await page(t, server);
  assert.equal(server.reads.length, 1);
  await p.elapse(backgroundOutputPollMs);
  assert.equal(server.reads.length, 2);
  await p.elapse(backgroundOutputPollMs);
  assert.equal(server.reads.length, 3);
});
