import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);

const window = new Window();
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "MutationObserver",
  "ResizeObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "NodeFilter",
  "DOMRect",
])
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value:
      key === "window" || key === "document" || key === "navigator"
        ? window[key]
        : window[key],
  });
Object.defineProperty(globalThis, "getComputedStyle", {
  configurable: true,
  value: window.getComputedStyle.bind(window),
});
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: window.requestAnimationFrame.bind(window),
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: window.cancelAnimationFrame.bind(window),
});
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

const { createRoot } = await import("react-dom/client");
const { ProfilesFeature } = await import("../src/features/profiles/index.ts");

const profile = {
  authMode: "custom",
  baseUrl: "https://relay.test/v1",
  connectionType: "openai_compatible",
  hasCredential: true,
  id: "p1",
  label: "Relay",
  model: "gpt-5",
  runtime: "codex",
  updatedAtLabel: "2026-09-16T10:00:00Z",
};
const connectedDevice = {
  id: "d1",
  label: "Studio",
  status: "connected",
  lastSeenLabel: "just now",
};

async function renderFeature(overrides = {}) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const events = [];
  const onEvent = async (event) => {
    events.push(event);
    if (event.type === "save-profile")
      return {
        ...profile,
        ...event.input,
        id: event.input.id ?? "created-profile",
      };
    if (event.type === "start-authorization")
      return {
        id: "auth-1",
        profileId: event.profileId,
        runtime: "codex",
        status: "waiting_for_user",
        url: "https://auth.openai.com/codex/device",
        code: "ABCD-EFGHJ",
      };
    if (event.type === "load-models") return [{ id: "gpt-5.6" }];
    return profile;
  };
  await act(async () => {
    root.render(
      createElement(ProfilesFeature, {
        busy: false,
        devices: [connectedDevice],
        onEvent,
        profiles: [profile],
        ...overrides,
      }),
    );
  });

  const query = (selector) => window.document.querySelector(selector);
  const buttonWithText = (text) =>
    [...window.document.querySelectorAll("button")].find((button) =>
      button.textContent.includes(text),
    );
  const clickButton = async (text) => {
    const button = buttonWithText(text);
    assert.ok(button, `missing button containing ${text}`);
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };
  const type = async (selector, value) => {
    const input = query(selector);
    assert.ok(input, `missing input for ${selector}`);
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };

  return { buttonWithText, clickButton, container, events, query, root, type };
}

async function unmount(root) {
  await act(async () => root.unmount());
  window.document.body.replaceChildren();
}

test("profiles are flat cards and editing uses a modal with write-only credentials", async () => {
  const view = await renderFeature();

  assert.equal(view.query(".fdy-profile-card-grid") !== null, true);
  assert.equal(view.query(".fdy-profile-editor"), null);
  await view.clickButton("Relay");

  assert.equal(view.query('[role="dialog"]') !== null, true);
  const keyInput = view.query('input[aria-label="Profile API key"]');
  assert.equal(keyInput.type, "password");
  assert.equal(keyInput.value, "");
  assert.match(keyInput.placeholder, /leave blank to keep it/);

  await view.type('input[aria-label="Profile API key"]', "sk-rotated");
  await view.clickButton("Save connection");
  assert.equal(view.events[0].type, "save-profile");
  assert.equal(view.events[0].input.apiKey, "sk-rotated");
  assert.equal(view.query('input[aria-label="Profile API key"]').value, "");
  assert.ok(!view.container.textContent.includes("sk-rotated"));

  await unmount(view.root);
});

test("clearing a sealed credential takes a deliberate second click", async () => {
  const view = await renderFeature();
  await view.clickButton("Relay");

  await view.clickButton("Clear credential");
  assert.deepEqual(view.events, []);
  assert.ok(view.buttonWithText("Clear it for good?"));

  await view.clickButton("Clear it for good?");
  assert.deepEqual(
    view.events.map((event) => event.type),
    ["clear-credential"],
  );

  await unmount(view.root);
});

test("deleting a profile also needs the second click", async () => {
  const view = await renderFeature();
  await view.clickButton("Relay");

  await view.clickButton("Delete");
  assert.deepEqual(view.events, []);

  await view.clickButton("Delete this connection?");
  assert.deepEqual(
    view.events.map((event) => event.type),
    ["delete-profile"],
  );

  await unmount(view.root);
});

test("new connections only offer API endpoints, never a global official account", async () => {
  const view = await renderFeature({ profiles: [] });

  assert.match(view.container.textContent, /Add your first model connection/);
  assert.equal(view.query('[role="dialog"]'), null);
  await view.clickButton("New connection");

  assert.equal(view.query('[role="dialog"]') !== null, true);
  assert.ok(view.query('input[aria-label="Profile base URL"]'));
  assert.equal(
    view.query('[aria-label="Profile authentication"]') !== null,
    false,
  );
  assert.equal(view.buttonWithText("Save and connect account"), undefined);

  await unmount(view.root);
});

test("legacy official profiles are retained as data but absent from global connections", async () => {
  const view = await renderFeature({
    profiles: [
      profile,
      {
        ...profile,
        id: "official",
        label: "Codex Provider",
        authMode: "official",
        connectionType: "local_login",
      },
    ],
  });
  assert.doesNotMatch(view.container.textContent, /Codex Provider/);
  assert.match(
    view.container.textContent,
    /Use a ChatGPT or Claude subscription\? Open device accounts/,
  );
  await unmount(view.root);
});

test("a refused catalog reports inside the model picker and leaves the form usable", async () => {
  const view = await renderFeature({
    onEvent: async (event) => {
      if (event.type === "load-models")
        throw new Error("relay.test answered 401. Type the model instead.");
      return { ...profile, ...event.input };
    },
  });
  await view.clickButton("Relay");

  await act(async () => {
    view.query(".fdy-model-combobox-trigger").click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await act(async () => {
    view
      .query('[aria-label="Refresh models from the endpoint"]')
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  // The endpoint's answer belongs next to the field that asked for it, and a
  // refused catalog must not take the page's error line or block saving.
  assert.match(window.document.body.textContent, /answered 401/);
  assert.equal(view.query(".fdy-profile-modal-error"), null);
  assert.equal(view.buttonWithText("Save connection").disabled, false);

  await unmount(view.root);
});

/**
 * The list used to badge credential placement ("Key sealed", "Device login"),
 * which said nothing about whether a profile could run and contradicted the
 * Device page. It now reports usability from the shared resolver.
 */
test("an unassigned connection is configured, not an authentication failure", async () => {
  const view = await renderFeature({
    deviceProfiles: [],
    providerHealth: [{ provider: "codex", status: "healthy" }],
  });

  const card = view.query(".fdy-profile-card");
  assert.match(card.textContent, /Configured · Not assigned/);
  // The old vocabulary described where the key lived, not whether it worked.
  assert.doesNotMatch(card.textContent, /Key sealed|Device login/);

  await unmount(view.root);
});

test("global connection usage counts devices without inheriting their health", async () => {
  const view = await renderFeature({
    deviceProfiles: [{ deviceId: "d1", enabled: true, profileId: "p1" }],
    providerHealth: [{ provider: "codex", status: "healthy" }],
  });

  const card = view.query(".fdy-profile-card");
  assert.match(card.textContent, /Configured · 1 device/);
  // With nothing to fix, the row is free to describe the model it runs.
  assert.match(card.textContent, /gpt-5/);

  await unmount(view.root);
});

test("a keyless connection is described neutrally, never as a warning", async () => {
  const view = await renderFeature({
    deviceProfiles: [{ deviceId: "d1", enabled: true, profileId: "p1" }],
    profiles: [{ ...profile, hasCredential: false }],
    providerHealth: [{ provider: "codex", status: "healthy" }],
  });

  const card = view.query(".fdy-profile-card");
  assert.match(card.textContent, /No key configured · 1 device/);
  // A keyless gateway is a valid configuration: the warn badge must not appear.
  assert.equal(card.querySelector(".fdy-badge-warn"), null);

  await unmount(view.root);
});
