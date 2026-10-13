import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({ url: "https://foundry.example/" });
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "HTMLFormElement",
  "MutationObserver",
  "CustomEvent",
  "Event",
  "SubmitEvent",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "NodeFilter",
  "DOMRect",
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === "window" ? window : window[key],
  });
}
Object.assign(globalThis, {
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");

/** The tab's event stream; the test opens it and sends it messages. */
let stream;
globalThis.EventSource = class {
  constructor() {
    stream = this;
  }
  addEventListener() {}
  close() {}
  send(id, type, payload) {
    this.onmessage?.({
      lastEventId: id,
      data: JSON.stringify({ type, payload }),
    });
  }
};

const app = {
  id: "xapp_1",
  provider: "feishu",
  ownerUserId: "u_1",
  visibility: "personal",
  label: "Feishu app cli_app",
  clientId: "cli_app",
  appName: "Foundry Agent",
  tenantName: "Acme Org",
  accountNames: ["Ada"],
  hasSecret: true,
  createdVia: "pasted",
  createdAt: "",
  updatedAt: "",
};
const bot = (status) => ({
  workspaceId: "ws_1",
  app,
  status,
  chats: [],
});
const reads = [];
/** The next read's answer waits for this, when set. */
let gate;
globalThis.fetch = async (input, init = {}) => {
  assert.equal(init.method ?? "GET", "GET");
  assert.match(String(input), /\/api\/workspaces\/ws_1\/feishu$/);
  reads.push(String(input));
  await gate;
  return new Response(JSON.stringify({ ...bot("connected"), choices: [app] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

await import("../src/i18n/index.ts");
const { ChannelsFeature } = await import("../src/features/channels/index.ts");

test("the bot is read again when the stream may have missed a change", async () => {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const flush = () =>
    act(async () => new Promise((settle) => setTimeout(settle, 0)));
  const appId = () => container.querySelector('[aria-label^="Feishu app"]');
  await act(async () =>
    root.render(createElement(ChannelsFeature, { workspaceId: "ws_1" })),
  );
  await flush();
  assert.equal(reads.length, 1, "read on mount");
  assert.equal(appId().disabled, false);
  // The app by its name, organisation and account; never its raw ID.
  assert.match(appId().textContent, /Foundry Agent · Acme Org · Ada/);
  assert.match(
    container.textContent,
    /Foundry AgentAcme Org · Ada · Personal app/,
  );
  assert.equal(container.textContent.includes("cli_app"), false);

  // The first connection may postdate that read: read again, behind what
  // is shown, which stays usable meanwhile.
  let release;
  gate = new Promise((resolve) => (release = resolve));
  await act(async () => stream.onopen());
  await flush();
  assert.equal(reads.length, 2);
  assert.equal(appId().disabled, false, "a read again keeps the form usable");
  await act(async () => release());
  gate = undefined;
  await flush();

  // An update carries the bot: no read.
  await act(async () =>
    stream.send("ep-1", "feishu_bot_updated", bot("connecting")),
  );
  await act(async () =>
    stream.send("ep-2", "feishu_bot_updated", {
      ...bot("connected"),
      workspaceId: "ws_9",
    }),
  );
  await flush();
  assert.equal(reads.length, 2);

  // A reconnect that resumes: the server replays what was missed.
  await act(async () => {
    stream.onerror();
    stream.onopen();
  });
  await flush();
  assert.equal(reads.length, 2);

  // The server could not replay (overflow, expired): read again.
  await act(async () => stream.send("ep-3", "resync", { reason: "expired" }));
  await flush();
  assert.equal(reads.length, 3, "a resync reads the bot again");

  await act(async () => root.unmount());
  container.remove();
});

test("a read answered after an update does not put the older bot back", async () => {
  const { i18n } = await import("../src/i18n/index.ts");
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const flush = () =>
    act(async () => new Promise((settle) => setTimeout(settle, 0)));
  await act(async () =>
    root.render(createElement(ChannelsFeature, { workspaceId: "ws_1" })),
  );
  await flush();
  const shows = (status) =>
    container.textContent.includes(i18n.t(`feishu:status.${status}`));
  assert.ok(shows("connected"));

  // Read again (a resync); the bot changes while that read is answered.
  let release;
  gate = new Promise((resolve) => (release = resolve));
  const before = reads.length;
  await act(async () => stream.send("ep-4", "resync", { reason: "expired" }));
  await flush();
  assert.equal(reads.length, before + 1);
  await act(async () =>
    stream.send("ep-5", "feishu_bot_updated", bot("connecting")),
  );
  await flush();
  assert.ok(shows("connecting"));
  await act(async () => release());
  gate = undefined;
  await flush();
  assert.ok(shows("connecting"), "the read started before the update");

  await act(async () => root.unmount());
  container.remove();
});
