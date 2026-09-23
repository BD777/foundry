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
const { AccountsGate, inviteTokenFromPath, useAccountSession } =
  await import("../src/app/accounts-gate.tsx");
const { apiFetch } = await import("../src/api.ts");

const owner = {
  id: "user_1",
  username: "owner",
  displayName: "Owner",
  role: "admin",
  createdAt: "2026-09-23T00:00:00Z",
  updatedAt: "2026-09-23T00:00:00Z",
};

function jsonResponse(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Routes fetches by "METHOD path"; records every call. */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push({ method, path: url.pathname, init });
    const handler = routes[`${method} ${url.pathname}`];
    assert.ok(handler, `unexpected request ${method} ${url.pathname}`);
    return handler(init);
  };
  return calls;
}

function AppProbe() {
  const session = useAccountSession();
  return createElement(
    "p",
    { id: "app" },
    `app:${session.user?.username ?? "-"}`,
  );
}

async function renderGate(pathname = "/") {
  window.history.replaceState(null, "", pathname);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(AccountsGate, null, createElement(AppProbe)));
  });
  await act(async () => {});
  const text = () => container.textContent;
  const type = async (label, value) => {
    const field = [...container.querySelectorAll("label")].find((row) =>
      row.querySelector("span")?.textContent.startsWith(label),
    );
    assert.ok(field, `field ${label}`);
    const input = field.querySelector("input");
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };
  const submit = async () => {
    const form = container.querySelector("form");
    assert.ok(form, "form");
    await act(async () => {
      form.dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await act(async () => {});
  };
  return {
    container,
    text,
    type,
    submit,
    unmount: () => act(() => root.unmount()),
  };
}

test("an unreachable auth endpoint still renders the app and its own offline state", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  const view = await renderGate();
  assert.equal(view.text(), "app:-");
  await view.unmount();
});

test("first run asks for the setup code before creating the owner", async () => {
  const calls = stubFetch({
    "GET /api/auth/state": () => jsonResponse(200, { needsSetup: true }),
    "POST /api/auth/setup": () =>
      jsonResponse(201, { needsSetup: false, user: owner }),
  });
  const view = await renderGate();
  assert.match(view.text(), /Create the admin account/);
  await view.type("Setup code", "ABCD-EFGH-JKLM");
  await view.type("Username", "owner");
  await view.type("Password", "correct horse battery");
  await view.submit();

  const setup = calls.find((call) => call.path === "/api/auth/setup");
  assert.equal(setup.init.credentials, "include");
  assert.deepEqual(JSON.parse(setup.init.body), {
    username: "owner",
    displayName: "",
    password: "correct horse battery",
    setupCode: "ABCD-EFGH-JKLM",
  });
  assert.equal(view.text(), "app:owner");
  await view.unmount();
});

test("a wrong password stays on the sign-in form with the server message", async () => {
  let attempts = 0;
  stubFetch({
    "GET /api/auth/state": () => jsonResponse(200, { needsSetup: false }),
    "POST /api/auth/login": () =>
      ++attempts === 1
        ? jsonResponse(401, { error: "username or password is incorrect" })
        : jsonResponse(200, {
            needsSetup: false,
            user: owner,
          }),
  });
  const view = await renderGate();
  assert.match(view.text(), /Sign in to Foundry/);
  await view.type("Username", "owner");
  await view.type("Password", "wrong password");
  await view.submit();
  assert.match(view.text(), /username or password is incorrect/);

  await view.type("Password", "correct horse battery");
  await view.submit();
  assert.equal(view.text(), "app:owner");
  await view.unmount();
});

test("a 401 from any API call returns a signed-in user to the sign-in screen", async () => {
  let signedIn = true;
  stubFetch({
    "GET /api/auth/state": () =>
      jsonResponse(200, {
        needsSetup: false,
        ...(signedIn ? { user: owner } : {}),
      }),
    "GET /api/workspaces": () => jsonResponse(401, { error: "login required" }),
  });
  const view = await renderGate();
  assert.equal(view.text(), "app:owner");

  signedIn = false;
  await act(async () => {
    const response = await apiFetch("http://127.0.0.1:31982/api/workspaces");
    assert.equal(response.status, 401);
  });
  await act(async () => {});
  assert.match(view.text(), /Sign in to Foundry/);
  await view.unmount();
});

test("an invite link shows the invite form and lands in the app at /", async () => {
  const calls = stubFetch({
    "GET /api/auth/state": () => jsonResponse(200, { needsSetup: false }),
    "GET /api/auth/invites/tok_123": () =>
      jsonResponse(200, { role: "member", expiresAt: "2026-09-30T00:00:00Z" }),
    "POST /api/auth/invites/tok_123/accept": () =>
      jsonResponse(201, {
        user: { ...owner, id: "user_2", username: "newbie", role: "member" },
      }),
  });
  const view = await renderGate("/invite/tok_123");
  assert.match(view.text(), /Join Foundry/);
  assert.match(view.text(), /invited as member/);
  await view.type("Username", "newbie");
  await view.type("Password", "member password 1");
  await view.submit();

  assert.ok(
    calls.some((call) => call.path === "/api/auth/invites/tok_123/accept"),
  );
  assert.equal(view.text(), "app:newbie");
  assert.equal(window.location.pathname, "/");
  await view.unmount();
});

test("invite tokens are read only from /invite/<token>", () => {
  assert.equal(inviteTokenFromPath("/invite/abc-_1"), "abc-_1");
  assert.equal(inviteTokenFromPath("/invite/abc/"), "abc");
  assert.equal(inviteTokenFromPath("/invite/"), undefined);
  assert.equal(inviteTokenFromPath("/issues/invite/abc"), undefined);
});
