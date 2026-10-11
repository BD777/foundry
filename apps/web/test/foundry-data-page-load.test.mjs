import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement, useState } from "react";
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
globalThis.EventSource = FakeEventSource;

const { foundryStreamOpenWaitMs } = await import("../src/stream/index.ts");
const { selectionFlight } = await import("../src/lib/single-flight.ts");
const { createStreamTouchLedger } =
  await import("../src/app/stream-touches.ts");
const { applyFoundryDataAnswer, readFoundryDataSelection, replayMissedEvents } =
  await import("../src/app/loaded-foundry-data.ts");
const { streamDownRefreshIntervalMs, useFoundryLiveData } =
  await import("../src/app/use-foundry-live-data.ts");
const { dataChangeRefreshDelayMs } =
  await import("../src/app/projections/data-changes.ts");

const settle = async () => {
  for (let index = 0; index < 5; index++)
    await new Promise((resolve) => setImmediate(resolve));
};

function workspaceData(overrides = {}) {
  return {
    workspace: { id: "ws", name: "Workspace" },
    workspaces: [],
    devices: [],
    providerHealth: [],
    agentProfiles: [],
    profiles: [],
    deviceProfiles: [],
    deviceSkillRoots: [],
    promotedSkills: [],
    workspaceSkillBindings: [],
    agents: [],
    workspaceFiles: [],
    agentSessions: [],
    skills: [],
    issues: [],
    chats: [],
    assets: [],
    ...overrides,
  };
}

/** The workspace data a page shows before its first read. */
function placeholder() {
  return { ...workspaceData(), workspace: { id: "", name: "No workspace" } };
}

const pageOnlyFields = ["promotedSkills", "skills"];

/**
 * A page that reads workspace data as App does: the live-data layer asks
 * for reads, which run one at a time through the selection flight and are
 * read and applied with App's own functions, starting from the placeholder
 * App starts from. `respond(fields)` is the server: it answers the fields
 * a request selected (undefined: the default set) with the whole data it
 * holds (or a promise of it, or a Response), which the fake narrows as the
 * server does.
 */
async function page(t, { respond, pageFields = [] } = {}) {
  const window = new Window();
  const previous = new Map();
  const requests = [];
  const fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/foundry-data", `unexpected ${url}`);
    const fields = url.searchParams.get("fields")?.split(",");
    requests.push(fields);
    const answer = await (respond?.(fields) ?? workspaceData());
    if (answer instanceof Response) return answer;
    const keep = (field) =>
      field === "workspace" ||
      (fields ? fields.includes(field) : !pageOnlyFields.includes(field));
    const narrowed = Object.fromEntries(
      Object.entries(answer).filter(([field]) => keep(field)),
    );
    return new Response(JSON.stringify(narrowed), {
      headers: { "Content-Type": "application/json" },
    });
  };
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
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
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  window.setTimeout = (...args) => globalThis.setTimeout(...args);
  window.clearTimeout = (id) => globalThis.clearTimeout(id);
  window.setInterval = (...args) => globalThis.setInterval(...args);
  window.clearInterval = (id) => globalThis.clearInterval(id);
  window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  const reads = [];
  const touches = createStreamTouchLedger();
  const shown = {};
  let setPageFields;
  let latest = { data: placeholder() };
  const readOnce = selectionFlight(async (selection, signal) => {
    reads.push({ all: selection.all, fields: [...selection.fields].sort() });
    const mark = touches.mark();
    try {
      const result = await readFoundryDataSelection(
        latest.data.workspace.id,
        selection,
        signal,
      );
      applyFoundryDataAnswer(result, mark, {
        touches,
        shown: () => latest.data,
        setData: latest.setData,
        setActiveWorkspaceId: () => {},
        setApiState: () => {},
      });
      return "applied";
    } catch {
      return "failed";
    }
  });
  function Harness() {
    const [data, setData] = useState(placeholder);
    const [fields, setFields] = useState(pageFields);
    setPageFields = setFields;
    latest = { data, setData };
    shown.data = data;
    shown.loaded = useFoundryLiveData({
      activeSession: false,
      devices: data.devices,
      enabled: true,
      onRefresh: readOnce,
      pageFields: fields,
      setData,
      touches,
      workspaceId: data.workspace.id || "ws",
    });
    return null;
  }
  const root = createRoot(window.document.createElement("div"));
  await act(() => root.render(createElement(Harness)));
  t.after(async () => {
    await act(() => root.unmount());
    // The tab's connection closes once nobody listens: the next page starts
    // afresh.
    t.mock.timers.tick(1100);
    t.mock.timers.reset();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await window.happyDOM.close();
  });
  const source = FakeEventSource.last;
  let id = 0;
  return {
    reads,
    requests,
    shown,
    open: async () => {
      await act(() => source.onopen());
      await act(settle);
    },
    fail: () => act(() => source.onerror()),
    tick: async (ms) => {
      await act(() => t.mock.timers.tick(ms));
      await act(settle);
    },
    send: (type, payload) =>
      act(() =>
        source.onmessage({
          lastEventId: `ep-${++id}`,
          data: JSON.stringify({ type, payload }),
        }),
      ),
    showPageFields: (fields) => act(() => setPageFields(fields)),
  };
}

test("a page load reads workspace data once, after the stream opened, and never polls while it is open", async (t) => {
  const view = await page(t);
  await view.tick(foundryStreamOpenWaitMs - 100);
  assert.deepEqual(view.reads, [], "no read before the stream opened");
  await view.open();
  assert.deepEqual(
    view.reads,
    [{ all: true, fields: [] }],
    "one read of the default set once the stream is open",
  );
  await view.tick(30 * 60_000);
  assert.equal(
    view.reads.length,
    1,
    "no periodic read while the stream is open",
  );
});

test("a stream slow to open: read anyway after the wait, and once more when it opens", async (t) => {
  const view = await page(t);
  await view.tick(foundryStreamOpenWaitMs);
  assert.equal(view.reads.length, 1, "the page does not stay empty");
  await view.tick(streamDownRefreshIntervalMs * 3);
  assert.equal(view.reads.length, 1, "an opening stream is not polled");
  await view.open();
  assert.equal(
    view.reads.length,
    2,
    "changes between that read and the stream may be missing: read again",
  );
  await view.tick(30 * 60_000);
  assert.equal(view.reads.length, 2);
});

test("a change streamed while the page-load read is in flight is not lost", async (t) => {
  let answer;
  const view = await page(t, {
    respond: () =>
      new Promise((resolve) => {
        // The server took its snapshot before the change below.
        answer = () =>
          resolve(
            workspaceData({
              chats: [{ id: "chat_1", title: "Before", preview: "" }],
              issues: [{ id: "iss_1", title: "Issue", status: "todo" }],
            }),
          );
      }),
  });
  await view.open();
  assert.equal(view.reads.length, 1);
  await view.send("chats_changed", {
    workspaceId: "ws",
    chats: [{ id: "chat_1", title: "After", preview: "" }],
    removed: [],
  });
  await view.send("issue_updated", {
    id: "iss_1",
    workspaceId: "ws",
    title: "Issue",
    status: "in_progress",
  });
  await view.tick(10);
  answer();
  await view.tick(10);
  assert.deepEqual(
    view.shown.data.chats.map((chat) => chat.title),
    ["After"],
    "the streamed chat stays over the older snapshot",
  );
  assert.equal(view.shown.data.issues[0].status, "in_progress");
  assert.equal(view.reads.length, 1, "and nothing is read again");
});

test("announced changes read only the fields they name; pushed chats need no read", async (t) => {
  const view = await page(t);
  await view.open();
  view.reads.length = 0;
  await view.send("foundry_data_changed", {
    workspaceId: "ws",
    resources: ["chats"],
  });
  await view.send("foundry_data_changed", {
    workspaceId: "",
    resources: ["devices", "agents"],
  });
  await view.send("foundry_data_changed", {
    workspaceId: "ws_other",
    resources: ["issues"],
  });
  await view.tick(dataChangeRefreshDelayMs + 10);
  assert.deepEqual(view.reads, [
    { all: false, fields: ["agents", "chats", "devices"] },
  ]);
  await view.send("foundry_data_changed", { workspaceId: "ws" });
  await view.tick(dataChangeRefreshDelayMs + 10);
  assert.deepEqual(
    view.reads.at(-1),
    { all: true, fields: [] },
    "an announcement naming no field reads the default set",
  );
  view.reads.length = 0;
  await view.send("chats_changed", {
    workspaceId: "ws",
    chats: [{ id: "chat_2", title: "Native", preview: "hi" }],
    removed: [],
  });
  await view.tick(10);
  assert.deepEqual(
    view.shown.data.chats.map((chat) => chat.id),
    ["chat_2"],
  );
  await view.send("chats_changed", {
    workspaceId: "ws",
    chats: [],
    removed: ["chat_2"],
  });
  await view.tick(dataChangeRefreshDelayMs + 10);
  assert.deepEqual(view.shown.data.chats, []);
  assert.deepEqual(view.reads, [], "a pushed change is applied without a read");
});

test("while the stream is down, data is read every few seconds; resumed, never", async (t) => {
  const view = await page(t);
  await view.open();
  // A message gives the connection a place to resume from.
  await view.send("chats_changed", {
    workspaceId: "ws_other",
    chats: [],
    removed: [],
  });
  await view.fail();
  await view.tick(streamDownRefreshIntervalMs + 10);
  await view.tick(streamDownRefreshIntervalMs + 10);
  assert.equal(view.reads.length, 3, "the page-load read and two polls");
  await view.open();
  await view.tick(streamDownRefreshIntervalMs * 4);
  assert.equal(view.reads.length, 3, "resumed: the server replays the rest");
});

test("a connection that drops before any event resumes from its ready message: no read", async (t) => {
  const view = await page(t);
  await view.open();
  // The server's first message on a fresh stream carries only its id.
  await view.send("stream_ready", {});
  await view.fail();
  await view.open();
  await view.tick(10);
  assert.equal(view.reads.length, 1);
});

test("the catalog is read with the page load when a page shows it, and again only when it changed", async (t) => {
  const view = await page(t, {
    pageFields: ["promotedSkills"],
    respond: () =>
      workspaceData({ promotedSkills: [{ id: "skill_1", name: "review" }] }),
  });
  assert.equal(view.shown.loaded.has("promotedSkills"), false);
  await view.open();
  assert.deepEqual(view.reads, [{ all: true, fields: ["promotedSkills"] }]);
  assert.equal(view.shown.loaded.has("promotedSkills"), true);
  assert.equal(view.shown.data.promotedSkills.length, 1);
  await view.showPageFields([]);
  await view.showPageFields(["promotedSkills"]);
  assert.equal(view.reads.length, 1, "shown again unchanged: no read");
  await view.showPageFields([]);
  await view.send("foundry_data_changed", {
    workspaceId: "",
    resources: ["promotedSkills"],
  });
  await view.tick(dataChangeRefreshDelayMs + 10);
  assert.equal(view.reads.length, 1, "no page shows it: no read");
  assert.equal(
    view.shown.data.promotedSkills.length,
    1,
    "a whole read keeps it",
  );
  await view.showPageFields(["promotedSkills"]);
  await view.tick(10);
  assert.deepEqual(view.reads.at(-1), {
    all: false,
    fields: ["promotedSkills"],
  });
});

test("selection reads: callers meanwhile share one read covering all they asked for", async () => {
  const runs = [];
  const read = selectionFlight((selection) => {
    runs.push({ all: selection.all, fields: [...selection.fields].sort() });
    return new Promise((resolve) => setTimeout(resolve, 5));
  });
  const first = read({ fields: ["chats"] });
  read({ fields: ["issues"] });
  read({ all: true });
  read({ fields: ["devices"] });
  await first;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(runs, [
    { all: false, fields: ["chats"] },
    { all: true, fields: ["devices", "issues"] },
  ]);
});

test("a reload on a Skills page reads everything and the catalog in one whole read", async (t) => {
  const view = await page(t, {
    pageFields: ["promotedSkills"],
    respond: () =>
      workspaceData({
        chats: [{ id: "chat_1", title: "Chat", preview: "" }],
        promotedSkills: [{ id: "skill_1", name: "review" }],
      }),
  });
  await view.open();
  assert.equal(view.requests.length, 1, "one request");
  assert.ok(view.requests[0].includes("promotedSkills"));
  assert.equal(view.shown.data.workspace.id, "ws", "the workspace shows");
  assert.deepEqual(
    view.shown.data.chats.map((chat) => chat.id),
    ["chat_1"],
  );
  assert.equal(view.shown.data.promotedSkills.length, 1);
  assert.equal(view.shown.loaded.has("promotedSkills"), true);
});

test("a catalog read that does not apply is not taken as read, and is made again", async (t) => {
  let failCatalog = true;
  const view = await page(t, {
    respond: (fields) =>
      fields?.includes("promotedSkills") && failCatalog
        ? new Response("{}", { status: 500 })
        : workspaceData({ promotedSkills: [{ id: "skill_1", name: "x" }] }),
  });
  await view.open();
  await view.showPageFields(["promotedSkills"]);
  await view.tick(10);
  assert.equal(view.shown.loaded.has("promotedSkills"), false, "still loading");
  failCatalog = false;
  await view.tick(streamDownRefreshIntervalMs + 10);
  assert.equal(view.shown.loaded.has("promotedSkills"), true);
  assert.equal(view.shown.data.promotedSkills.length, 1);
});

test("a device coming online reads its agents and its scan folders", async (t) => {
  const view = await page(t, {
    respond: () =>
      workspaceData({
        devices: [{ id: "dev", label: "Mac", status: "disconnected" }],
      }),
  });
  await view.open();
  view.reads.length = 0;
  await view.send("device_status_changed", {
    workspaceId: "ws",
    deviceId: "dev",
    status: "connected",
    device: { id: "dev", label: "Mac", status: "connected" },
  });
  await view.tick(2_000);
  assert.deepEqual(view.reads, [
    {
      all: false,
      fields: ["agentProfiles", "agents", "deviceSkillRoots", "workspaces"],
    },
  ]);
});

test("a workspace switch keeps the changes streamed while it read", () => {
  const touches = createStreamTouchLedger();
  let data = {
    ...workspaceData(),
    workspace: { id: "ws_a", name: "A" },
  };
  const setData = (update) => {
    data = typeof update === "function" ? update(data) : update;
  };
  const before = Date.now();
  const event = (type, payload) => ({ type, payload });
  touches.record(
    event("chats_changed", {
      workspaceId: "ws_b",
      chats: [{ id: "old", title: "Old", preview: "" }],
      removed: [],
    }),
  );
  const requestedAt = Date.now() + 1;
  const later = () => {
    // Events that arrive after the request (recorded at a later time).
    const realNow = Date.now;
    Date.now = () => requestedAt + 5;
    touches.record(
      event("chats_changed", {
        workspaceId: "ws_b",
        chats: [{ id: "chat_b", title: "Renamed", preview: "" }],
        removed: [],
      }),
    );
    touches.record(
      event("foundry_data_changed", {
        workspaceId: "ws_b",
        resources: ["assets"],
      }),
    );
    touches.record(event("foundry_data_changed", { workspaceId: "ws_c" }));
    Date.now = realNow;
  };
  later();
  const mark = touches.mark();
  const missed = applyFoundryDataAnswer(
    {
      data: {
        ...workspaceData({
          chats: [{ id: "chat_b", title: "Before", preview: "" }],
        }),
        workspace: { id: "ws_b", name: "B" },
      },
      notModified: false,
      requestedAt,
    },
    mark,
    {
      touches,
      shown: () => data,
      setData,
      setActiveWorkspaceId: () => {},
      setApiState: () => {},
    },
  );
  assert.equal(data.workspace.id, "ws_b");
  assert.deepEqual(
    data.chats.map((chat) => chat.title),
    ["Renamed"],
    "the chat streamed during the switch, not the older answer, and not what came before the request",
  );
  assert.deepEqual(missed, { all: false, fields: ["assets"] });
  assert.ok(before <= requestedAt);
  // Events the ledger no longer holds: read the default set again.
  const full = createStreamTouchLedger();
  for (let index = 0; index < 600; index++)
    full.record(
      event("chats_changed", { workspaceId: "ws_b", chats: [], removed: [] }),
    );
  assert.deepEqual(replayMissedEvents(full, 0, "ws_b", setData), {
    all: true,
    fields: [],
  });
});

test("a list a server answers null is an empty list", async (t) => {
  const view = await page(t, {
    pageFields: ["promotedSkills"],
    respond: () =>
      new Response(
        JSON.stringify({
          ...workspaceData(),
          workspace: { id: "", name: "No workspace" },
          promotedSkills: null,
          deviceSkillRoots: null,
          workspaceSkillBindings: null,
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  });
  await view.open();
  assert.deepEqual(view.shown.data.promotedSkills, []);
  assert.deepEqual(view.shown.data.deviceSkillRoots, []);
  assert.deepEqual(view.shown.data.workspaceSkillBindings, []);
  assert.equal(view.shown.loaded.has("promotedSkills"), true);
});
