import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

register("./bundler-resolve.mjs", import.meta.url);

const {
  environmentPollMs,
  environmentRunReadMs,
  environmentSlowReadMs,
  useIssueEnvironment,
} = await import("../src/features/issue-detail/use-issue-environment.ts");

class FakeEventSource {
  static last;
  constructor() {
    FakeEventSource.last = this;
  }
  addEventListener() {}
  close() {}
}

const issue = {
  id: "issue_1",
  workspaceId: "ws_1",
  status: "in_progress",
  run: { id: "run_1" },
};

async function page(t, { notifies = true } = {}) {
  let reads = 0;
  const fetch = async (input) => {
    assert.match(String(input), /\/api\/issues\/issue_1\/environment$/);
    reads += 1;
    return new Response(
      JSON.stringify({
        status: "ok",
        revision: 0,
        environment: { status: "running", bytes: reads, repositories: [] },
        ...(notifies ? { notifiesChanges: true } : {}),
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  const window = new Window();
  const previous = new Map();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    EventSource: FakeEventSource,
    fetch,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const shown = {};
  function Harness() {
    Object.assign(shown, useIssueEnvironment(issue, 0));
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
    reads: () => reads,
    elapse: async (ms) => {
      await act(() => t.mock.timers.tick(ms));
      await settle();
    },
    send: async (type, payload) => {
      await act(() =>
        FakeEventSource.last.onmessage({
          lastEventId: `ep-${++id}`,
          data: JSON.stringify({ type, payload }),
        }),
      );
      await settle();
    },
  };
}

test("an environment is read when the device says it changed, not every few seconds", async (t) => {
  const p = await page(t);
  assert.equal(p.reads(), 1);
  assert.equal(p.shown.data.bytes, 1);
  await p.elapse(environmentPollMs * 5);
  assert.equal(p.reads(), 1, "nothing changed, nothing read");

  await p.send("issue_environment_changed", {
    workspaceId: "ws_1",
    issueId: "issue_other",
  });
  assert.equal(p.reads(), 1, "another Issue's change");
  await p.send("issue_environment_changed", {
    workspaceId: "ws_1",
    issueId: "issue_1",
  });
  assert.equal(p.reads(), 2);
  await p.send("issue_environment_changed", { workspaceId: "ws_1" });
  assert.equal(p.reads(), 3, "a change to every Issue of the workspace");
  assert.equal(p.shown.data.bytes, 3);

  // Changes no event names show within the slow read.
  await p.elapse(environmentSlowReadMs);
  assert.equal(p.reads(), 4);
});

test("while its run works an environment is read at most every few seconds", async (t) => {
  const p = await page(t);
  assert.equal(p.reads(), 1);
  await p.elapse(environmentRunReadMs);
  const runEvent = {
    id: "e",
    runId: "run_1",
    label: "Used tool",
    detail: "",
    level: "info",
  };
  for (let index = 0; index < 5; index++)
    await p.send("issue_run_event", runEvent);
  assert.equal(p.reads(), 2, "a burst of run events reads once");
  for (let index = 0; index < 5; index++)
    await p.send("issue_run_event", runEvent);
  assert.equal(p.reads(), 2);
  await p.elapse(environmentRunReadMs);
  assert.equal(p.reads(), 3, "the rest of the burst reads after the wait");
  await p.send("issue_run_event", { ...runEvent, runId: "run_other" });
  await p.elapse(environmentRunReadMs);
  assert.equal(p.reads(), 3, "another run's events");
});

test("a device that does not tell changes has the environment read every few seconds", async (t) => {
  const p = await page(t, { notifies: false });
  assert.equal(p.reads(), 1);
  await p.elapse(environmentPollMs);
  assert.equal(p.reads(), 2);
  await p.elapse(environmentPollMs);
  assert.equal(p.reads(), 3);
});
