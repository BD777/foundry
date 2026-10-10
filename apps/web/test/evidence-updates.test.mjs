import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";

register("./bundler-resolve.mjs", import.meta.url);

class FakeEventSource {
  static last;
  constructor() {
    FakeEventSource.last = this;
  }
  addEventListener() {}
  close() {}
}

test("evidence: a page load reads once the stream opens, and once more only for what may have been missed", async (t) => {
  const window = new Window();
  const previous = new Map();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    EventSource: FakeEventSource,
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
  const { foundryStreamOpenWaitMs } = await import("../src/api.ts");
  const { useEvidenceUpdates } =
    await import("../src/features/issue-detail/use-evidence-updates.ts");
  let reads = 0;
  function Panel({ revision }) {
    const loadOnOpen = useEvidenceUpdates(
      "issue",
      async () => {
        reads += 1;
      },
      () => {},
    );
    useEffect(() => loadOnOpen(), [loadOnOpen, revision]);
    return null;
  }
  const root = createRoot(window.document.createElement("div"));
  const step = (run) =>
    act(async () => {
      run();
      for (let index = 0; index < 3; index++)
        await new Promise((resolve) => setImmediate(resolve));
    });
  let id = 0;
  const send = (type, payload) =>
    FakeEventSource.last.onmessage({
      lastEventId: `ep-${++id}`,
      data: JSON.stringify({ type, payload }),
    });
  try {
    await step(() => root.render(createElement(Panel, { revision: 1 })));
    assert.equal(reads, 0, "the read waits for the stream");
    await step(() => FakeEventSource.last.onopen());
    await step(() => t.mock.timers.tick(1_000));
    assert.equal(reads, 1, "one read: the opening's resync adds none");

    // A burst of updates reads once after it; a resync reads once.
    await step(() => {
      for (let index = 0; index < 3; index++)
        send("evidence_updated", { issueId: "issue", workspaceId: "ws" });
    });
    await step(() => t.mock.timers.tick(100));
    assert.equal(reads, 2);
    await step(() => send("resync", { reason: "expired" }));
    await step(() => t.mock.timers.tick(100));
    assert.equal(reads, 3);
    // What the Issue shows changed: read again.
    await step(() => root.render(createElement(Panel, { revision: 2 })));
    assert.equal(reads, 4);

    // Another page load whose stream opens late: read, then once more.
    await step(() => root.render(null));
    await step(() => t.mock.timers.tick(1_100));
    await step(() => root.render(createElement(Panel, { revision: 1 })));
    await step(() => t.mock.timers.tick(foundryStreamOpenWaitMs));
    assert.equal(reads, 5, "a slow stream does not keep the panel empty");
    await step(() => FakeEventSource.last.onopen());
    await step(() => t.mock.timers.tick(100));
    assert.equal(reads, 6, "read again once the stream opened");
  } finally {
    await act(() => root.unmount());
    t.mock.timers.tick(1_100);
    t.mock.timers.reset();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await window.happyDOM.close();
  }
});
