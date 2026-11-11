import assert from "node:assert/strict";
import { register } from "node:module";
import test, { afterEach } from "node:test";
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

const { createRoot: createReactRoot } = await import("react-dom/client");
const { ToastProvider } = await import("../src/components/ui/toast.tsx");
const mountedRoots = new Set();
afterEach(async () => {
  await act(async () => {
    for (const root of [...mountedRoots]) root.unmount();
  });
  document.body.replaceChildren();
});
function createRoot(container) {
  const root = createReactRoot(container);
  const wrapped = {
    render: (node) => root.render(createElement(ToastProvider, null, node)),
    unmount: () => {
      if (!mountedRoots.has(wrapped)) return;
      document
        .querySelectorAll(".fdy-toast-close")
        .forEach((button) => button.click());
      root.unmount();
      mountedRoots.delete(wrapped);
    },
  };
  mountedRoots.add(wrapped);
  return wrapped;
}
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

const realFetch = globalThis.fetch;

/** The server's answers: a saved provider echoes its input. */
function serveProfiles({ path, body }) {
  if (path.endsWith("/models")) return Response.json([{ id: "gpt-5.6" }]);
  if (path === "/api/execution-default")
    return Response.json({
      saved: {
        providerId: "p1",
        runtime: "codex",
        model: "gpt-5",
        effort: "high",
        scope: "global",
      },
      effective: {
        providerId: "p1",
        runtime: "codex",
        model: "gpt-5",
        effort: "high",
        scope: "global",
      },
    });
  if (path === "/api/model-pools") return Response.json([]);
  if (path === "/api/model-notes")
    return Response.json({
      total: 1,
      offset: 0,
      notes: [
        {
          id: "note_1",
          providerKind: "api",
          providerId: "p1",
          runtime: "codex",
          model: "gpt-5",
          body: "Give exact files and commands.",
          authorUserId: "user_1",
          authorName: "Alice",
          createdAt: "2026-11-10T10:00:00Z",
        },
      ],
    });
  if (path.startsWith("/api/profiles") && body)
    return Response.json({
      ...profile,
      ...body,
      id: body.id ?? "created-profile",
    });
  return Response.json(profile);
}

test("each provider model shows its orchestration notes", async () => {
  const view = await renderFeature();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.match(
    view.query("section")?.textContent ?? "",
    /Default execution model/,
  );
  assert.match(view.container.textContent, /Relay · gpt-5 · High/);
  assert.doesNotMatch(view.container.textContent, /\bp1\b/);
  const headings = [...view.container.querySelectorAll("h2,h3")];
  const endpoints = headings.find(
    (heading) => heading.textContent === "API endpoints",
  );
  const notes = headings.find(
    (heading) => heading.textContent === "Orchestration notes",
  );
  assert.ok(endpoints);
  assert.ok(notes);
  assert.ok(
    endpoints.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  const provider = [...view.container.querySelectorAll("summary")].find(
    (node) => node.textContent.includes("Relay"),
  );
  assert.ok(provider);
  await act(async () => {
    provider.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const model = [...provider.parentElement.querySelectorAll("summary")].find(
    (node) => node.textContent.includes("gpt-5"),
  );
  assert.ok(model);
  await act(async () => {
    model.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.match(model.parentElement.textContent, /Alice/);
  assert.match(
    model.parentElement.textContent,
    /Give exact files and commands/,
  );
  assert.ok(
    model.parentElement.querySelector(
      'button[aria-label="Edit note for gpt-5"]',
    ),
  );
  assert.ok(
    view.requests.some(
      (request) =>
        request.method === "GET" && request.path === "/api/model-notes",
    ),
  );
});

test("equivalent model pools can be chosen as the execution default and edited in place", async () => {
  const pool = {
    id: "mpool_flash",
    providerKind: "api",
    providerId: "p1",
    runtime: "codex",
    label: "DeepSeek Flash",
    members: [
      { model: "deepseek-v4.1-flash-1017", tokensPerMinute: 6_000_000 },
      { model: "deepseek/deepseek-flash", tokensPerMinute: 1_000_000 },
    ],
    createdAt: "2026-11-10T10:00:00Z",
    updatedAt: "2026-11-10T10:00:00Z",
  };
  const view = await renderFeature({}, (request) => {
    if (
      request.path === "/api/execution-default" &&
      (!request.method || request.method === "GET")
    )
      return Response.json({
        saved: {
          providerKind: "api",
          providerId: "p1",
          runtime: "codex",
          modelPoolId: pool.id,
          effort: "high",
          scope: "global",
          pool,
        },
        effective: {
          providerKind: "api",
          providerId: "p1",
          runtime: "codex",
          modelPoolId: pool.id,
          effort: "high",
          scope: "global",
          pool,
        },
      });
    if (request.path === "/api/model-pools" && request.method === "GET")
      return Response.json([pool]);
    if (request.path === "/api/model-pools" && request.method === "POST")
      return Response.json(
        { ...pool, ...request.body, id: "mpool_new" },
        { status: 201 },
      );
    return serveProfiles(request);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.match(view.container.textContent, /pool DeepSeek Flash \(2 ids\)/);
  assert.match(view.container.textContent, /Equivalent model pools/);
  assert.match(view.container.textContent, /deepseek\/deepseek-flash/);

  await view.clickButton("New pool");
  await view.type('input[aria-label="Pool name"]', "Fast fallback");
  await view.clickButton("Save pool");
  const created = view.requests.find(
    (request) =>
      request.method === "POST" && request.path === "/api/model-pools",
  );
  assert.ok(created);
  assert.equal(created.body.providerKind, "api");
  assert.equal(created.body.providerId, "p1");
  assert.equal(created.body.label, "Fast fallback");
  assert.ok(created.body.members.length >= 1);
});

async function renderFeature(overrides = {}, serve = serveProfiles) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const events = [];
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const request = {
      method: init.method ?? "GET",
      path: new URL(String(input)).pathname,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    return serve(request);
  };
  const onEvent = async (event) => {
    events.push(event);
  };
  await act(async () => {
    root.render(
      createElement(ProfilesFeature, {
        busy: false,
        devices: [connectedDevice],
        onEvent,
        profiles: [profile],
        tab: "endpoints",
        onTabChange: (tab) => events.push({ type: "tab", tab }),
        ...overrides,
      }),
    );
  });

  const query = (selector) => window.document.querySelector(selector);
  const buttonWithText = (text) =>
    [...window.document.querySelectorAll(".fdy-profile-card")].find((button) =>
      button.textContent.includes(text),
    ) ??
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

  return {
    buttonWithText,
    clickButton,
    container,
    events,
    query,
    requests,
    root,
    type,
  };
}

async function unmount(root) {
  await act(async () => root.unmount());
  window.document.body.replaceChildren();
  globalThis.fetch = realFetch;
}

const operationalRequests = (view) =>
  view.requests.filter(
    (request) =>
      !(
        request.method === "GET" &&
        (request.path === "/api/execution-default" ||
          request.path === "/api/model-pools")
      ),
  );
const sent = (view) =>
  operationalRequests(view).map(
    (request) => `${request.method} ${request.path}`,
  );

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
  await view.clickButton("Save provider");
  assert.deepEqual(sent(view), ["PUT /api/profiles/p1"]);
  assert.equal(operationalRequests(view)[0].body.apiKey, "sk-rotated");
  assert.deepEqual(view.events, [
    { type: "profiles.changed" },
    { type: "notice.requested", message: "Relay saved." },
  ]);
  assert.equal(view.query('input[aria-label="Profile API key"]').value, "");
  assert.ok(!view.container.textContent.includes("sk-rotated"));

  await unmount(view.root);
});

test("clearing a sealed credential takes a deliberate second click", async () => {
  const view = await renderFeature();
  await view.clickButton("Relay");

  await view.clickButton("Clear credential");
  assert.deepEqual(operationalRequests(view), []);
  assert.ok(view.buttonWithText("Clear it for good?"));

  await view.clickButton("Clear it for good?");
  assert.deepEqual(sent(view), ["POST /api/profiles/p1/credential/clear"]);

  await unmount(view.root);
});

test("deleting a profile also needs the second click", async () => {
  const view = await renderFeature();
  await view.clickButton("Relay");

  await view.clickButton("Delete");
  assert.deepEqual(operationalRequests(view), []);

  await view.clickButton("Delete this provider?");
  assert.deepEqual(sent(view), ["DELETE /api/profiles/p1"]);

  await unmount(view.root);
});

test("new connections only offer API endpoints, never a global official account", async () => {
  const view = await renderFeature({ profiles: [] });

  assert.match(view.container.textContent, /Add your first model provider/);
  assert.equal(view.query('[role="dialog"]'), null);
  await view.clickButton("New provider");

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
  // Subscriptions are their own group on the page, not server providers.
  assert.match(view.container.textContent, /Subscriptions/);
  await unmount(view.root);
});

test("a refused catalog reports inside the model picker and leaves the form usable", async () => {
  const view = await renderFeature({}, (request) =>
    request.path.endsWith("/models")
      ? Response.json(
          { error: "relay.test answered 401. Type the model instead." },
          { status: 502 },
        )
      : serveProfiles(request),
  );
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
  assert.equal(view.query('.fdy-alert[data-tone="error"]'), null);
  assert.equal(view.buttonWithText("Save provider").disabled, false);

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

test("each model's context window shows where it comes from and saves the person's own", async () => {
  const relay = {
    ...profile,
    model: "auto_model/alwaysday1_max",
    models: ["auto_model/alwaysday1_max", "gpt-5.5", "ark/60b-0614c"],
    contextWindows: { "ark/60b-0614c": 150_000 },
  };
  const view = await renderFeature({ profiles: [relay] }, (request) =>
    request.path.endsWith("/models")
      ? Response.json([
          { id: "auto_model/alwaysday1_max", contextWindow: 1_000_000 },
          { id: "ark/60b-0614c", contextWindow: 200_000 },
        ])
      : serveProfiles(request),
  );
  await view.clickButton("Relay");
  const section = [...window.document.querySelectorAll("details")].find(
    (details) =>
      details.querySelector("summary").textContent === "Context windows",
  );
  assert.ok(section, "missing the context windows section");
  // Opening the section reads the endpoint's windows from the server's copy.
  await act(async () => {
    section.open = true;
    section.dispatchEvent(new window.Event("toggle"));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const models = view.requests.filter((request) =>
    request.path.endsWith("/models"),
  );
  assert.equal(models.length, 1);
  assert.equal(models[0].body.refresh, undefined);
  const rows = Object.fromEntries(
    [...section.querySelectorAll(".fdy-context-window-row")].map((row) => [
      row.querySelector("label").textContent,
      [
        window.document.getElementById(
          row.querySelector("input").getAttribute("aria-describedby"),
        ).textContent,
        row.querySelector("input").value,
      ],
    ]),
  );
  assert.deepEqual(rows, {
    "auto_model/alwaysday1_max": ["Automatic: 1M · endpoint model list", ""],
    "gpt-5.5": ["Automatic: 272K · official model", ""],
    "ark/60b-0614c": ["Automatic: 200K · endpoint model list", "150K"],
  });

  // A typed window that is not one blocks saving until it is fixed.
  const input = '[aria-label="Context window for gpt-5.5"]';
  await view.type(input, "lots");
  assert.ok(view.query(".fdy-context-window-error"));
  assert.equal(view.buttonWithText("Save provider").disabled, true);
  await view.type(input, "400k");
  assert.equal(view.query(".fdy-context-window-error"), null);
  await view.clickButton("Save provider");
  const saved = view.requests.find((request) => request.method === "PUT");
  assert.deepEqual(saved.body.contextWindows, {
    "gpt-5.5": 400_000,
    "ark/60b-0614c": 150_000,
  });

  await unmount(view.root);
});

test("each model can set custom input, cache and output prices", async () => {
  const relay = { ...profile, models: ["gpt-5"] };
  const view = await renderFeature({ profiles: [relay] });
  await view.clickButton("Relay");
  const section = [...window.document.querySelectorAll("details")].find(
    (details) =>
      details.querySelector("summary").textContent === "Custom model prices",
  );
  assert.ok(section, "missing the custom model prices section");
  await act(async () => {
    section.open = true;
    section.dispatchEvent(new window.Event("toggle"));
  });

  await view.type(
    '[aria-label="Input price for gpt-5 per one million tokens"]',
    "2.5",
  );
  assert.match(section.textContent, /Enter all four prices/);
  assert.equal(view.buttonWithText("Save provider").disabled, true);

  await view.type(
    '[aria-label="Cache-read price for gpt-5 per one million tokens"]',
    "0.25",
  );
  await view.type(
    '[aria-label="Cache-write price for gpt-5 per one million tokens"]',
    "3.125",
  );
  await view.type(
    '[aria-label="Output price for gpt-5 per one million tokens"]',
    "10",
  );
  assert.doesNotMatch(section.textContent, /Enter all four prices/);
  assert.equal(view.buttonWithText("Save provider").disabled, false);

  await view.clickButton("Save provider");
  const saved = view.requests.find((request) => request.method === "PUT");
  assert.deepEqual(saved.body.modelPrices, {
    "gpt-5": {
      inputPerMillion: 2.5,
      cacheReadPerMillion: 0.25,
      cacheWritePerMillion: 3.125,
      outputPerMillion: 10,
    },
  });

  await unmount(view.root);
});

test("a compatible Codex endpoint shows its learned transport and saves an override", async () => {
  const relay = {
    ...profile,
    codexTransport: "auto",
    codexTransportLearned: {
      transport: "https",
      detail: "unexpected status 404 Not Found",
      learnedAt: "2026-10-14T08:00:00Z",
    },
  };
  const view = await renderFeature({ profiles: [relay] });
  const card = view.query(".fdy-profile-card").textContent;
  assert.match(card, /Transport: HTTPS · learned Oct 14, 2026/);
  await view.clickButton("Relay");
  const status = view.query('.fdy-profile-editor [role="status"]').textContent;
  assert.equal(
    status,
    "Transport: HTTPS (learned Oct 14, 2026: Codex fell back to HTTPS: unexpected status 404 Not Found)",
  );
  const group = view.query('[aria-label="Codex Responses transport"]');
  const websocket = [...group.querySelectorAll("button")].find(
    (button) => button.textContent === "WebSocket",
  );
  await act(async () => websocket.click());
  assert.equal(
    view.query('.fdy-profile-editor [role="status"]').textContent,
    "Transport: WebSocket (set here)",
  );
  await view.clickButton("Save provider");
  const saved = view.requests.find((request) => request.method === "PUT");
  assert.equal(saved.body.codexTransport, "websocket");
  await unmount(view.root);
});

test("a Claude endpoint has no Codex transport", async () => {
  const claude = {
    ...profile,
    runtime: "claude",
    connectionType: "anthropic_compatible",
  };
  const view = await renderFeature({ profiles: [claude] });
  await view.clickButton("Relay");
  assert.equal(view.query('[aria-label="Codex Responses transport"]'), null);
  await view.clickButton("Save provider");
  const saved = view.requests.find((request) => request.method === "PUT");
  assert.equal(saved.body.codexTransport, undefined);
  await unmount(view.root);
});

test("the kinds of provider are tabs and only the open one is shown", async () => {
  const view = await renderFeature({ tab: "subscriptions" });
  try {
    const tabs = [
      ...window.document.querySelectorAll(
        '[aria-label="Kinds of model provider"] button',
      ),
    ];
    assert.deepEqual(
      tabs.map((tab) => tab.textContent),
      ["Subscriptions", "API endpoints", "Launch environments"],
    );
    assert.equal(tabs[0].getAttribute("data-state"), "on");
    // The page-wide default execution model may name Relay; its endpoint
    // card belongs to the API endpoints tab only.
    assert.ok(
      ![...window.document.querySelectorAll(".fdy-profile-card")].some((card) =>
        card.textContent.includes("Relay"),
      ),
    );
    await view.clickButton("API endpoints");
    assert.deepEqual(view.events.at(-1), { type: "tab", tab: "endpoints" });
  } finally {
    await unmount(view.root);
  }
});

test("a connector's launch environment has the same defaults as a login", async () => {
  const limen = {
    id: "limen_default",
    deviceId: "d1",
    runtime: "claude",
    label: "Limen · default",
    connectionType: "external",
    origin: "device",
    configScope: "device",
    configLabel: "Limen connector",
    status: "healthy",
    model: "claude-sonnet-4-5",
    models: ["claude-sonnet-4-5", "claude-opus-4-1"],
    externalConnection: { executable: "/x", args: [], identity: "a" },
    connector: { kind: "limen", label: "Limen" },
  };
  const view = await renderFeature(
    {
      tab: "environments",
      agentProfiles: [limen],
      devices: [{ ...connectedDevice, owned: true }],
    },
    ({ path, body }) =>
      path.endsWith("/models")
        ? Response.json(limen.models.map((id) => ({ id })))
        : Response.json({ ...limen, ...body }),
  );
  try {
    const toggle = window.document.querySelector(
      '[aria-label="Defaults for Limen · default on Studio"]',
    );
    assert.ok(toggle, "missing the Defaults toggle");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    await act(async () => {
      toggle.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    const catalog = view.requests.find((r) => r.path.endsWith("/models"));
    assert.equal(catalog.body.profile.connectionType, "external");
    assert.equal(catalog.body.profile.id, "limen_default");
    assert.match(
      view.container.textContent,
      /Models Limen · default offers on this device/,
    );
    await view.clickButton("Save defaults");
    const saved = view.requests.find(
      (r) => r.method === "POST" && r.path === "/api/agent-profiles",
    );
    assert.equal(saved.body.connectionType, "external");
    assert.equal(saved.body.deviceId, "d1");
    assert.equal(saved.body.model, "claude-sonnet-4-5");
  } finally {
    await unmount(view.root);
  }
});

test("a launch environment whose quota is used up is a warning, its defaults still editable", async () => {
  const message =
    "Claude Code returned an error result: You've hit your weekly limit · resets 2pm (America/Toronto)";
  const limen = {
    id: "limen_default",
    deviceId: "d1",
    runtime: "claude",
    label: "Limen · default",
    connectionType: "external",
    origin: "device",
    configScope: "device",
    configLabel: "Limen connector",
    status: "unavailable",
    statusDetail: message,
    check: {
      status: "failed",
      checkedAt: "2026-11-06T02:00:00Z",
      message,
      reason: "quota_exhausted",
    },
    model: "claude-opus-4-1",
    models: ["claude-sonnet-4-5", "claude-opus-4-1"],
    externalConnection: { executable: "/x", args: [], identity: "a" },
    connector: { kind: "limen", label: "Limen" },
  };
  const view = await renderFeature(
    {
      tab: "environments",
      agentProfiles: [limen],
      devices: [{ ...connectedDevice, owned: true }],
    },
    ({ path, body }) =>
      path.endsWith("/models")
        ? Response.json(limen.models.map((id) => ({ id })))
        : Response.json({ ...limen, ...body }),
  );
  try {
    const text = view.container.textContent;
    assert.match(
      text,
      /Limen's quota is used up · resets 2pm \(America\/Toronto\)/,
    );
    assert.match(text, /Quota used up/);
    assert.doesNotMatch(text, /Last check failed|Check failed|did not answer/);
    assert.ok(view.buttonWithText("Check again"), "Check stays the retry");
    const toggle = window.document.querySelector(
      '[aria-label="Defaults for Limen · default on Studio"]',
    );
    assert.ok(toggle, "defaults stay reachable");
    await act(async () => {
      toggle.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.ok(view.buttonWithText("Save defaults"));
  } finally {
    await unmount(view.root);
  }
});

test("a provider is verified on an assigned device only after a second click that names the quota", async () => {
  const checkedAt = "2026-11-09T02:00:00Z";
  let checked = false;
  const view = await renderFeature(
    {
      deviceProfiles: [{ deviceId: "d1", enabled: true, profileId: "p1" }],
      agentProfiles: [],
    },
    (request) => {
      if (request.path === "/api/profiles/p1/check") {
        checked = true;
        return Response.json({ status: "passed", checkedAt });
      }
      return serveProfiles(request);
    },
  );
  try {
    await view.clickButton("Relay");
    assert.match(
      window.document.body.textContent,
      /Not verified on this device/,
    );
    await view.clickButton("Verify");
    assert.equal(checked, false, "the first click only explains the cost");
    assert.ok(view.buttonWithText("Run one short conversation? Uses quota"));
    await view.clickButton("Run one short conversation? Uses quota");
    const sentCheck = view.requests.find(
      (r) => r.path === "/api/profiles/p1/check",
    );
    assert.equal(sentCheck.method, "POST");
    assert.deepEqual(sentCheck.body, { deviceId: "d1" });
    assert.ok(
      view.events.some((event) => event.type === "profiles.changed"),
      "the page reads the stored result",
    );
  } finally {
    await unmount(view.root);
  }
});

test("a provider's check result shows per device and on its card; offline devices say why they cannot verify", async () => {
  const serverRow = (deviceId, check) => ({
    id: "p1",
    deviceId,
    origin: "server",
    runtime: "codex",
    label: "Relay",
    connectionType: "openai_compatible",
    configScope: "device",
    configLabel: "Server",
    status: "healthy",
    check,
  });
  const view = await renderFeature({
    devices: [
      connectedDevice,
      { id: "d2", label: "Laptop", status: "offline", lastSeenLabel: "1h" },
    ],
    deviceProfiles: [
      { deviceId: "d1", enabled: true, profileId: "p1" },
      { deviceId: "d2", enabled: true, profileId: "p1" },
    ],
    agentProfiles: [
      serverRow("d1", {
        status: "failed",
        checkedAt: "2026-11-09T02:00:00Z",
        message: "401 invalid key",
      }),
      serverRow("d2", { status: "passed", checkedAt: "2026-11-09T01:00:00Z" }),
    ],
  });
  try {
    assert.match(
      view.query(".fdy-profile-card").textContent,
      /Check failed on 1 device/,
    );
    await view.clickButton("Relay");
    const text = window.document.body.textContent;
    assert.match(text, /Check failed: 401 invalid key/);
    assert.match(text, /Verified · .* · Connect the device to verify/);
    const again = [...window.document.querySelectorAll("button")].filter(
      (button) => button.textContent === "Verify again",
    );
    assert.equal(again.length, 2);
    assert.equal(again[0].disabled, false);
    assert.equal(again[1].disabled, true, "an offline device cannot verify");
  } finally {
    await unmount(view.root);
  }
});

test("a refused check is reported inline on its device", async () => {
  const view = await renderFeature(
    {
      deviceProfiles: [{ deviceId: "d1", enabled: true, profileId: "p1" }],
    },
    (request) =>
      request.path === "/api/profiles/p1/check"
        ? Response.json(
            { error: "Studio's worker is too old; update its worker." },
            { status: 409 },
          )
        : serveProfiles(request),
  );
  try {
    await view.clickButton("Relay");
    await view.clickButton("Verify");
    await view.clickButton("Run one short conversation? Uses quota");
    const alert = view.query('[role="alert"]');
    assert.ok(alert, "missing the inline error");
    assert.match(
      alert.textContent,
      /Could not verify: Studio's worker is too old; update its worker\./,
    );
    assert.ok(view.buttonWithText("Verify"), "Verify stays the retry");
  } finally {
    await unmount(view.root);
  }
});
