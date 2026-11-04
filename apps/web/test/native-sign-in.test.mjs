import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);

// Synthetic fetch interception: no device signs in; the answers are
// server-shaped sign-in steps.
const window = new Window();
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
  "ResizeObserver",
  "CustomEvent",
  "Event",
  "SubmitEvent",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "FocusEvent",
  "NodeFilter",
  "DOMRect",
  "PopStateEvent",
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
await import("../src/i18n/index.ts");
const { RuntimeAccountRow } =
  await import("../src/features/profiles/device-accounts.tsx");
const { NativeSignInDialog } =
  await import("../src/features/profiles/native-sign-in-dialog.tsx");

const device = { id: "dev_1", label: "Studio Mac", status: "connected" };
const installed = [
  { provider: "claude", status: "missing_auth", cli: { installed: true } },
];
const tick = (ms = 20) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

function mount(element) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  return {
    container,
    root,
    render: (next) => act(async () => root.render(next)),
    button: (label) =>
      window.document.querySelector(`button[aria-label="${label}"]`),
    text: () => window.document.body.textContent,
    unmount: () => act(async () => root.unmount()),
  };
}

test("a signed-out device offers Sign in; a signed-in one offers Sign out", async (t) => {
  let asked = 0;
  const view = mount();
  t.after(view.unmount);
  const row = (profiles) =>
    createElement(RuntimeAccountRow, {
      device,
      runtime: "claude",
      profiles,
      health: installed,
      bindings: [],
      serverProfiles: [],
      onRefresh: async () => {},
      onSignIn: () => (asked += 1),
    });
  await view.render(row([]));
  const signIn = view.button("Sign in to Claude Code on Studio Mac");
  assert.ok(signIn, "the row offers Sign in");
  await act(async () => signIn.click());
  assert.equal(asked, 1);
  assert.equal(
    view.button("Actions for Claude Code on Studio Mac"),
    null,
    "nothing to sign out of",
  );

  await view.render(
    row([
      {
        id: "claude_local",
        deviceId: device.id,
        origin: "device",
        runtime: "claude",
        connectionType: "local_login",
        status: "healthy",
        accountLabel: "me@example.com",
      },
    ]),
  );
  assert.equal(view.button("Sign in to Claude Code on Studio Mac"), null);
  assert.match(view.text(), /Signed in as me@example\.com/);
  assert.ok(view.button("Actions for Claude Code on Studio Mac"));
});

test("the dialog shows Claude's page, sends the pasted code to the device and finishes", async (t) => {
  const requests = [];
  let completed = false;
  globalThis.fetch = async (url, init) => {
    const path = String(url).replace(/^.*\/api/, "/api");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push([path, body]);
    const step = (extra) =>
      new Response(
        JSON.stringify({ operationId: "nsi_0123456789abcdef", ...extra }),
        { headers: { "content-type": "application/json" } },
      );
    if (path.endsWith("/sign-in"))
      return step({
        status: "pending",
        verificationUrl: "https://claude.com/cai/oauth/authorize?code=true",
        codeEntry: true,
      });
    if (path.endsWith("/sign-in/code")) {
      completed = true;
      return step({ status: "pending" });
    }
    if (path.endsWith("/sign-in/poll"))
      return step({ status: completed ? "complete" : "pending" });
    return step({ status: "expired" });
  };
  let signedIn = 0;
  const view = mount();
  t.after(view.unmount);
  await view.render(
    createElement(NativeSignInDialog, {
      target: {
        deviceId: device.id,
        deviceName: device.label,
        runtime: "claude",
      },
      onClose: () => {},
      onSignedIn: () => (signedIn += 1),
    }),
  );
  await tick();
  assert.deepEqual(
    requests[0][0],
    "/api/devices/dev_1/accounts/claude/sign-in",
  );
  assert.ok(requests[0][1].requestId, "the begin names its request");
  const link = window.document.querySelector(
    'a[href^="https://claude.com/cai/oauth/authorize"]',
  );
  assert.ok(link, "the page to approve on is a link");
  const input = window.document.querySelector("form input");
  assert.ok(input, "the pasted code has a field");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(input, "the-code#state");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    window.document
      .querySelector("form")
      .dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
  });
  await tick();
  assert.deepEqual(
    requests.find(([path]) => path.endsWith("/sign-in/code"))?.[1],
    { operationId: "nsi_0123456789abcdef", code: "the-code#state" },
  );
  // The flow polls every few seconds; the next poll sees it finish.
  await tick(3300);
  assert.equal(signedIn, 1);
});
