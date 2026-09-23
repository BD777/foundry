import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);

// Synthetic fetch interception, not a live server: every fixture below is a
// worker-shaped inspection JSON. No real credential or endpoint is touched.
const window = new Window();
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "MutationObserver",
  "ResizeObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
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
const { AccountInspection } =
  await import("../src/features/devices/account-inspection.tsx");
const { checkInspection } =
  await import("../src/features/devices/account-inspection-store.ts");

const HOME = "/Users/tester/.codex";
const PERSONAL = "/Users/tester/.codex-personal";
const tick = (ms = 20) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
const jsonResponse = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json" },
  });

function inspection(overrides = {}) {
  return {
    runtime: "codex",
    source: HOME,
    sources: [HOME, PERSONAL],
    executionSource: HOME,
    checkedAt: new Date().toISOString(),
    status: "not_signed_in",
    message: "No ChatGPT login in this configuration.",
    usage: [],
    ...overrides,
  };
}

async function mount(deviceId, runtime = "codex") {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(AccountInspection, { deviceId, runtime, online: true }),
    ),
  );
  return {
    container,
    unmount: () => act(async () => root.unmount()),
    remount: async () => {
      await act(async () => root.unmount());
      const next = createRoot(container);
      await act(async () =>
        next.render(
          createElement(AccountInspection, { deviceId, runtime, online: true }),
        ),
      );
    },
  };
}

function buttonByLabel(container, match) {
  const button = [...container.querySelectorAll("button")].find((row) =>
    typeof match === "string"
      ? row.textContent.includes(match)
      : match(row.textContent),
  );
  assert.ok(button, `button ${match}`);
  return button;
}

async function chooseSource(container, path) {
  const trigger = container.querySelector(
    '[aria-label^="Account configuration to inspect"]',
  );
  // Radix DropdownMenu opens on pointer/keyboard activation, not the synthetic
  // click happy-dom dispatches; Enter is the keyboard activation path.
  trigger.dispatchEvent(
    new window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
  await tick();
  const item = [
    ...window.document.querySelectorAll('[role="menuitemradio"]'),
  ].find((row) => row.textContent.includes(path));
  assert.ok(item, `source option ${path}`);
  await act(async () => item.click());
  await tick();
}

test("collapsing or switching tabs keeps the selected config without a new default request", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push(JSON.parse(options.body).source);
    return jsonResponse(
      calls.at(-1) === PERSONAL
        ? inspection({
            source: PERSONAL,
            status: "verified",
            accountLabel: "tester@example.test",
            plan: "pro",
            message:
              "Verified by Codex's native account usage read. This is not a model request.",
            usage: [
              { usedPercent: 100, windowMinutes: 10080, resetsAt: 1900000000 },
            ],
          })
        : inspection(),
    );
  };
  const view = await mount("dev-keep");
  await tick();
  assert.deepEqual(calls, [undefined]);
  await chooseSource(view.container, PERSONAL);
  assert.deepEqual(calls, [undefined, PERSONAL]);
  assert.match(view.container.textContent, /tester@example\.test/);
  assert.match(view.container.textContent, /Verified online/);

  await view.remount(); // collapse the row / leave and re-enter the accounts tab
  assert.match(
    view.container.textContent,
    /tester@example\.test/,
    "the personal configuration stays selected after remount",
  );
  assert.match(
    view.container.textContent,
    /does not change the execution account/,
  );
  assert.deepEqual(
    calls,
    [undefined, PERSONAL],
    "remount restores the stored read instead of re-checking the worker default",
  );
  globalThis.fetch = originalFetch;
  await view.unmount();
});

test("a late response for the configuration left behind never replaces the selection", async () => {
  const calls = [];
  const deferred = new Map();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const source = JSON.parse(options.body).source;
    calls.push(source);
    let resolveCall;
    const promise = new Promise((resolve) => (resolveCall = resolve));
    promise.resolveWith = (body) => resolveCall(body);
    deferred.set(source, promise);
    return promise;
  };
  const view = await mount("dev-race");
  await tick();
  deferred.get(undefined).resolveWith(jsonResponse(inspection()));
  await tick();
  await chooseSource(view.container, PERSONAL);
  deferred.get(PERSONAL).resolveWith(
    jsonResponse(
      inspection({
        source: PERSONAL,
        status: "verified",
        accountLabel: "tester@example.test",
      }),
    ),
  );
  await tick();
  assert.match(view.container.textContent, /tester@example\.test/);
  // A home-config refresh is in flight while the user is viewing the personal
  // configuration (out-of-order delivery the serialized UI guards against too).
  checkInspection("dev-race", "codex", HOME);
  deferred
    .get(HOME)
    .resolveWith(
      jsonResponse(
        inspection({ status: "not_signed_in", message: "STALE HOME RESULT" }),
      ),
    );
  await tick();
  // The late home read lands in its own slot; the personal view is untouched.
  assert.match(view.container.textContent, /tester@example\.test/);
  assert.doesNotMatch(view.container.textContent, /STALE HOME RESULT/);
  assert.deepEqual(calls, [undefined, PERSONAL, HOME]);
  globalThis.fetch = originalFetch;
  await view.unmount();
});

test("the check action is visibly busy, ignores double clicks and offers retry on failure", async () => {
  const pending = [];
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push(JSON.parse(options.body).source);
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  };
  const view = await mount("dev-busy");
  await tick();
  assert.deepEqual(calls, [undefined]);
  pending.shift().resolve(jsonResponse(inspection()));
  await tick();

  const check = () =>
    view.container.querySelector('[aria-label="Check account & usage"]');
  assert.ok(check());
  assert.match(check().textContent, /Check account/);
  await act(async () => check().click());
  assert.equal(check().disabled, true);
  assert.match(check().textContent, /Checking/);
  assert.equal(
    view.container
      .querySelector(".fdy-account-inspection")
      .getAttribute("aria-busy"),
    "true",
  );
  await act(async () => check().click()); // guarded while busy
  assert.equal(calls.length, 2, "double click must not send a second request");

  pending.shift().reject(new Error("Synthetic network interruption"));
  await tick();
  assert.match(view.container.textContent, /Synthetic network interruption/);
  assert.ok(buttonByLabel(view.container, "Retry"));
  assert.equal(check().disabled, false);

  await act(async () => buttonByLabel(view.container, "Retry").click());
  assert.equal(calls.length, 3);
  assert.equal(check().disabled, true);
  pending.shift().resolve(jsonResponse(inspection({ status: "local_login" })));
  await tick();
  assert.doesNotMatch(
    view.container.textContent,
    /Synthetic network interruption/,
  );
  assert.match(view.container.textContent, /Last checked/);
  assert.equal(check().disabled, false);
  globalThis.fetch = originalFetch;
  await view.unmount();
});

test("Claude checks only the local login and never promises online usage", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    jsonResponse({
      runtime: "claude",
      source: "/Users/tester/.claude",
      sources: ["/Users/tester/.claude"],
      executionSource: "/Users/tester/.claude",
      checkedAt: new Date().toISOString(),
      status: "local_login",
      message:
        "Claude Code reports local OAuth credentials. Its SDK does not expose an account quota read; online validity and remaining usage are not verified.",
      usage: [],
    });
  const view = await mount("dev-claude", "claude");
  await tick();
  assert.match(view.container.textContent, /Local login · unverified online/);
  assert.match(
    view.container.textContent,
    /does not expose an account quota read/,
  );
  assert.equal(view.container.querySelectorAll("progress").length, 0);
  assert.match(
    buttonByLabel(view.container, "Re-check local login").textContent,
    /Re-check local login/,
  );
  globalThis.fetch = originalFetch;
  await view.unmount();
});

test("same-second reads with different source lists still expose the fallback entry", async () => {
  // Regression for a verifier-found edge: two reads can share the exact same
  // checkedAt second while the device's configuration set changed between
  // them. Deriving the source list by timestamp-sorting cached results tied on
  // that second and could pick the stale list that still contained the gone
  // config, hiding "Back to Foundry's configuration".
  const SAME_TS = "2026-09-18T08:00:00.000Z";
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls += 1;
    const source = JSON.parse(options.body).source;
    if (source === PERSONAL)
      return jsonResponse(
        inspection({
          source: PERSONAL,
          sources: [HOME], // the personal directory disappeared on this read
          status: "unavailable",
          checkedAt: SAME_TS,
          message:
            "This configuration is no longer present on the device, so its account cannot be checked.",
        }),
      );
    return jsonResponse(
      inspection({ sources: [HOME, PERSONAL], checkedAt: SAME_TS }),
    );
  };
  const view = await mount("dev-same-second");
  await tick();
  await chooseSource(view.container, PERSONAL);
  await tick();
  // Both stored reads share SAME_TS; the store's accepted-response identity
  // (not timestamp ordering) must win, so the fallback stays visible.
  assert.match(view.container.textContent, /no longer present on this device/);
  const back = buttonByLabel(view.container, "Back to Foundry’s configuration");
  assert.ok(back, "fallback entry must not be lost on same-second reads");
  // Back must target the execution source the unavailable read itself
  // reported (HOME), not the stale cached list that still contained PERSONAL.
  const callsAtBack = calls;
  await act(async () => back.click());
  await tick();
  assert.doesNotMatch(
    view.container.textContent,
    /no longer present on this device/,
  );
  assert.match(
    view.container.textContent,
    /Foundry uses: \/Users\/tester\/\.codex/,
  );
  // HOME was cached by the auto-check, so Back to it needs no new request.
  assert.equal(
    calls,
    callsAtBack,
    "Back to cached execution source needs no request",
  );
  globalThis.fetch = originalFetch;
  await view.unmount();
});

test("a configuration that disappeared is explained and offers the execution config back", async () => {
  let removed = false;
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const source = JSON.parse(options.body).source;
    calls++;
    if (removed)
      return jsonResponse(
        inspection({
          source: source ?? HOME,
          sources: [HOME],
          status: "unavailable",
          message:
            "This configuration is no longer present on the device, so its account cannot be checked.",
        }),
      );
    return jsonResponse(
      source === PERSONAL
        ? inspection({
            source: PERSONAL,
            status: "verified",
            accountLabel: "tester@example.test",
          })
        : inspection(),
    );
  };
  const view = await mount("dev-gone");
  await tick();
  await chooseSource(view.container, PERSONAL);
  assert.match(view.container.textContent, /tester@example\.test/);
  removed = true;
  await act(async () => buttonByLabel(view.container, "Check account").click());
  await tick();
  assert.match(view.container.textContent, /no longer present on this device/);
  const callsBeforeBack = calls;
  await act(async () =>
    buttonByLabel(view.container, "Back to Foundry’s configuration").click(),
  );
  await tick();
  assert.match(view.container.textContent, /Foundry uses:/);
  assert.doesNotMatch(view.container.textContent, /no longer present/);
  assert.equal(
    calls,
    callsBeforeBack,
    "returning to the cached execution config issues no request",
  );
  globalThis.fetch = originalFetch;
  await view.unmount();
});
