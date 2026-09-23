import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
register("./bundler-resolve.mjs", import.meta.url);
const { useIssueContract } =
  await import("../src/features/issue-detail/use-issue-contract.ts");

const draft = (revision = 1) => ({
  id: `contract-${revision}`,
  revision,
  status: "draft",
  contentDigest: `digest-${revision}`,
  goal: { text: "Write a welcome note", media: [] },
  criteria: [],
  inScope: [],
  outOfScope: [],
  constraints: [],
});
async function harness(t, fetcher) {
  const window = new Window(),
    previous = new Map();
  class EventSource {
    close() {}
  }
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    sessionStorage: window.sessionStorage,
    EventSource,
    fetch: fetcher,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  let controller,
    issue = {
      id: "test",
      runtime: "claude",
      status: "blocked",
      sourceInput: "hi",
      messages: [],
    };
  const root = createRoot(document.createElement("div"));
  function Probe() {
    controller = useIssueContract(issue, () => {});
    return null;
  }
  t.after(async () => {
    await act(() => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  });
  const render = async (next = {}) => {
    issue = { ...issue, ...next };
    await act(async () => {
      root.render(createElement(Probe));
    });
  };
  await render();
  return {
    get state() {
      return controller;
    },
    render,
  };
}

test("reference response loss retries the exact write despite newer visible draft; clarification retry keeps its key", async (t) => {
  let records = [draft()],
    loseReference = true,
    failClarify = true;
  const saves = [],
    clarifies = [];
  const h = await harness(t, async (url, options) => {
    if (options.method === "GET")
      return Response.json({ items: records, total: records.length });
    const request = {
      key: options.headers["Idempotency-Key"],
      body: JSON.parse(options.body),
    };
    if (url.endsWith("/contracts")) {
      saves.push(request);
      records = [{ ...draft(2), ...request.body.content }, draft()];
      if (loseReference) {
        loseReference = false;
        throw new Error("reference response lost");
      }
      return Response.json(records[0]);
    }
    clarifies.push(request);
    if (failClarify) {
      failClarify = false;
      throw new Error("Agent unavailable");
    }
    return Response.json({});
  });
  const attachment = { id: "material", name: "reference.txt" };
  await act(async () => {
    await assert.rejects(
      h.state.send("Use the reference", [attachment]),
      /response lost/,
    );
  });
  await h.render({ draftContractRevision: 2 });
  assert.equal(h.state.draft.revision, 2);
  await act(async () => {
    await assert.rejects(
      h.state.send("Use the reference", [attachment]),
      /Agent unavailable/,
    );
  });
  assert.deepEqual(saves[0], saves[1]);
  await act(async () => {
    assert.equal(
      await h.state.send("Use the reference", [attachment]),
      "replied",
    );
  });
  assert.deepEqual(clarifies[0], clarifies[1]);
  assert.equal(clarifies[0].body.expectedRevision, 2);
  assert.equal(saves.length, 2);
  assert.equal(h.state.busy, false);
});

test("successful clarification stays successful when subsequent refresh fails; old drafts never auto-dispatch", async (t) => {
  let failRead = false,
    writes = 0;
  const h = await harness(t, async (_url, options) => {
    if (options.method === "GET") {
      if (failRead) throw new Error("offline");
      return Response.json({ items: [draft()], total: 1 });
    }
    writes++;
    failRead = true;
    return Response.json({});
  });
  assert.equal(writes, 0);
  await act(async () => {
    assert.equal(await h.state.send("Clarify this", []), "replied");
  });
  assert.match(h.state.error, /操作已保存/);
  assert.equal(writes, 1);
});

test("confirmation submits the displayed revision and digest, not a newer loaded draft", async (t) => {
  let records = [draft(4)];
  const writes = [];
  const h = await harness(t, async (url, options) => {
    if (options.method === "GET")
      return Response.json({ items: records, total: records.length });
    writes.push({ url, body: JSON.parse(options.body) });
    return new Response("contract_changed", { status: 409 });
  });
  const displayed = h.state.draft;
  records = [draft(5)];
  await h.render({ draftContractRevision: 5 });
  await act(async () => {
    await assert.rejects(h.state.confirm(displayed), /contract_changed/);
  });
  assert.match(writes[0].url, /contracts\/4\/confirm$/);
  assert.deepEqual(writes[0].body, { expectedContentDigest: "digest-4" });
  assert.equal(h.state.draft.revision, 5);
});
