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

globalThis.EventSource = class {
  close() {}
};
const { SharingFeature } = await import("../src/features/sharing/index.ts");

const members = [
  {
    userId: "u_alice",
    username: "alice",
    displayName: "Alice",
    role: "owner",
    deviceOwner: true,
    addedAt: "2026-09-23T00:00:00Z",
  },
  {
    userId: "u_bob",
    username: "bob",
    displayName: "Bob",
    role: "viewer",
    addedAt: "2026-09-23T00:00:00Z",
  },
];
const requests = [];
globalThis.fetch = async (input, init = {}) => {
  requests.push({
    url: String(input),
    method: init.method ?? "GET",
    body: init.body,
  });
  if ((init.method ?? "GET") === "GET")
    return new Response(JSON.stringify(members), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  return new Response(null, { status: 204 });
};

async function renderSharing(accessRole, currentUserId) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const left = [];
  await act(async () =>
    root.render(
      createElement(SharingFeature, {
        workspace: {
          id: "ws_1",
          name: "Shared",
          localPath: "/w",
          baseline: "main",
          contextSummary: "",
          acceptedCount: 0,
          resolvedCount: 0,
          accessRole,
        },
        deviceLabel: "Studio",
        currentUserId,
        canInvite: false,
        onLeft: () => left.push(true),
      }),
    ),
  );
  await act(async () => new Promise((settle) => setTimeout(settle, 0)));
  const buttons = () => [...container.querySelectorAll("button")];
  return {
    container,
    left,
    button: (text) => buttons().find((item) => item.textContent.includes(text)),
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("an owner manages everyone but the device owner, who always stays an Owner", async () => {
  const view = await renderSharing("owner", "u_alice");
  const text = view.container.textContent;
  assert.match(text, /Add a person/);
  assert.match(text, /Device owner/);
  assert.ok(view.container.querySelector('[aria-label^="Role for Bob"]'));
  assert.equal(
    view.container.querySelector('[aria-label^="Role for Alice"]'),
    null,
  );
  assert.equal(
    view.button("Leave"),
    undefined,
    "the device owner cannot leave",
  );
  assert.ok(view.button("Remove"), "an owner can remove Bob");
  await view.cleanup();
});

test("a viewer sees who has access and can only leave", async () => {
  requests.length = 0;
  const view = await renderSharing("viewer", "u_bob");
  const text = view.container.textContent;
  assert.doesNotMatch(text, /Add a person/);
  assert.match(text, /Only Owners can change who has access/);
  assert.equal(
    view.container.querySelector('[aria-label^="Role for Bob"]'),
    null,
  );
  const leave = view.button("Leave");
  assert.ok(leave);
  await act(async () => leave.click());
  await act(async () => view.button("Leave for good?").click());
  await act(async () => new Promise((settle) => setTimeout(settle, 0)));
  assert.ok(
    requests.some(
      (request) =>
        request.method === "DELETE" &&
        request.url.endsWith("/api/workspaces/ws_1/members/u_bob"),
    ),
  );
  assert.deepEqual(view.left, [true]);
  await view.cleanup();
});

test("the default Viewer role carries no run-code warning", async () => {
  const view = await renderSharing("owner", "u_alice");
  assert.doesNotMatch(view.container.textContent, /This role can run code/);
  await view.cleanup();
});
