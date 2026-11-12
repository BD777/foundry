import assert from "node:assert/strict";
import { register } from "node:module";
import test, { afterEach, beforeEach } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);

const window = new Window({ url: "https://foundry.example/assistants" });
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLDivElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLFormElement",
  "MutationObserver",
  "ResizeObserver",
  "CustomEvent",
  "Event",
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
globalThis.EventSource = class {
  addEventListener() {}
  close() {}
};

const { createRoot } = await import("react-dom/client");
const { i18n } = await import("../src/i18n/index.ts");
await i18n.changeLanguage("en");
const { AssistantHome, AssistantList } =
  await import("../src/features/personal-agent/index.ts");
const { clearStoredAssistantId, persistAssistantId, storedAssistantId } =
  await import("../src/app/shell-preferences.ts");
const { WorkspaceAccessEditor } =
  await import("../src/features/personal-agent/workspace-access-editor.tsx");
const { MemorySection } =
  await import("../src/features/personal-agent/settings-memory.tsx");
const { KnowledgeSection } =
  await import("../src/features/personal-agent/settings-knowledge.tsx");

const iso = "2026-11-12T08:00:00Z";
const assistants = [
  {
    id: "asst_default",
    name: "Personal",
    isDefault: true,
    workspaceId: "ws_personal_home",
    homeDeviceId: "dev_studio",
    state: "active",
    permissionPackageId: "perm_default",
    createdAt: iso,
    updatedAt: iso,
  },
  {
    id: "asst_work",
    name: "Work assistant",
    isDefault: false,
    workspaceId: "ws_work_home",
    homeDeviceId: "dev_laptop",
    state: "stopped",
    permissionPackageId: "perm_work",
    createdAt: iso,
    updatedAt: iso,
  },
];
const homeAgent = {
  id: "asst_default",
  userId: "usr_1",
  workspaceId: "ws_personal_home",
  homeDeviceId: "dev_studio",
  state: "active",
  permissionPackageId: "perm_default",
  promptVersion: "test",
  settings: {
    assistantName: "Personal",
    timezone: "Asia/Shanghai",
  },
  createdAt: iso,
  updatedAt: iso,
};
const devices = [
  {
    id: "dev_studio",
    label: "Studio",
    status: "connected",
    lastSeenLabel: "now",
    owned: true,
  },
  {
    id: "dev_laptop",
    label: "Laptop",
    status: "disconnected",
    lastSeenLabel: "yesterday",
    owned: true,
  },
];
const workspaces = [
  {
    id: "ws_budget",
    name: "Family budget",
    localPath: "/Users/me/family-budget",
    deviceId: "dev_studio",
    deviceLabel: "Studio",
    baseline: "",
    contextSummary: "",
    acceptedCount: 0,
    resolvedCount: 0,
  },
  {
    id: "ws_archive",
    name: "Archive plans",
    localPath: "/Users/me/archive",
    deviceId: "dev_studio",
    deviceLabel: "Studio",
    baseline: "",
    contextSummary: "",
    acceptedCount: 0,
    resolvedCount: 0,
  },
  {
    id: "ws_garden",
    name: "Garden",
    localPath: "/Users/me/garden",
    deviceId: "dev_laptop",
    deviceLabel: "Laptop",
    baseline: "",
    contextSummary: "",
    acceptedCount: 0,
    resolvedCount: 0,
  },
];

const resources = {
  instances: [
    {
      id: "res_browser",
      key: "browser/chrome",
      type: "browser",
      platform: "macos",
      name: "Chrome with work login",
      source: { kind: "device", id: "dev_studio", label: "Studio" },
      state: "available",
      readiness: { ready: true, level: "configured" },
      backends: [],
      detector: "browser@1",
      discoveredAt: iso,
      lastSeenAt: iso,
    },
    {
      id: "res_screen",
      key: "computer_use/desktop",
      type: "computer_use",
      platform: "macos",
      name: "Studio screen",
      source: { kind: "device", id: "dev_studio", label: "Studio" },
      state: "unready",
      stateReason: "Accessibility permission",
      readiness: {
        ready: false,
        level: "installed",
        reason: "Accessibility permission",
      },
      backends: [],
      detector: "cua@1",
      discoveredAt: iso,
      lastSeenAt: iso,
    },
    {
      id: "res_gpu",
      key: "gpu/local",
      type: "gpu",
      platform: "linux",
      name: "Local GPU",
      source: { kind: "device", id: "dev_studio", label: "Studio" },
      state: "available",
      readiness: { ready: true, level: "configured" },
      backends: [],
      detector: "gpu@1",
      discoveredAt: iso,
      lastSeenAt: iso,
    },
    {
      id: "res_offline",
      key: "browser/offline",
      type: "browser",
      platform: "macos",
      name: "Offline browser",
      source: { kind: "device", id: "dev_studio", label: "Studio" },
      state: "offline",
      readiness: { ready: false, level: "installed" },
      backends: [],
      detector: "browser@1",
      discoveredAt: iso,
      lastSeenAt: iso,
    },
  ],
  sources: [
    {
      kind: "device",
      id: "dev_studio",
      label: "Studio",
      online: true,
      detectorErrors: [],
      allowRemoteCommands: true,
    },
  ],
};

function permissionPackage(
  include,
  scope = "listed",
  identityResources = { scope: "all", allowed: [] },
) {
  return {
    id: "perm_work",
    owner: "usr_1",
    workspaces: { scope, include, exclude: [] },
    connectorAccounts: [],
    identityResources,
  };
}

let calls = [];
let permissionAnswers = {};
let memoryLayers = {
  assistantId: "asst_work",
  legacyUncopied: 0,
  layers: [
    {
      scope: "person",
      state: "active",
      entries: [
        {
          id: "entry_person",
          vaultId: "vault_person",
          scope: "person",
          title: "Prefers concise answers",
          revision: 3,
          hash: "sha256:person",
          sourceRef: "user-input:d1a782e5-b192-4251-a232-2469f4eb7510",
          updatedAt: iso,
        },
      ],
    },
    {
      scope: "assistant",
      state: "active",
      entries: [
        {
          id: "entry_assistant",
          vaultId: "vault_assistant",
          scope: "assistant",
          title: "Owns Project Atlas",
          revision: 7,
          hash: "sha256:assistant",
          sourceRef: "notes/project-atlas.md",
          updatedAt: iso,
        },
      ],
    },
  ],
};
function sortRecord(fields) {
  return {
    assistantId: "asst_default",
    assistantName: "",
    assistantIsDefault: true,
    confidence: "high",
    mentions: [],
    undoable: false,
    createdAt: iso,
    updatedAt: iso,
    ...fields,
  };
}
const emptySorting = { moves: [], suggestions: [] };
let memorySorting = emptySorting;
const realFetch = globalThis.fetch;
const mounted = new Set();
afterEach(async () => {
  await act(async () => {
    for (const entry of [...mounted]) entry.root.unmount();
  });
  mounted.clear();
  globalThis.fetch = realFetch;
  calls = [];
  permissionAnswers = {};
  memorySorting = emptySorting;
  memoryLayers = {
    ...memoryLayers,
    layers: memoryLayers.layers.map((layer) => ({
      ...layer,
      entries: layer.entries.map((entry) => ({ ...entry })),
    })),
  };
  document.body.replaceChildren();
});
async function fixtureFetch(input, init = {}) {
  const url = new URL(String(input), "https://foundry.example");
  const method = (init.method ?? "GET").toUpperCase();
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method, path: url.pathname, body });
  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  if (method === "POST" && url.pathname === "/api/assistants")
    return json({ ...assistants[1], id: "asst_created", name: body.name }, 201);
  if (method === "GET" && url.pathname === "/api/assistants/asst_default")
    return json({ agent: homeAgent, homeDeviceOnline: true });
  if (method === "GET" && url.pathname === "/api/agent-sessions")
    return json([]);
  if (
    method === "GET" &&
    [
      "/api/assistants/asst_default/inbox",
      "/api/assistants/asst_default/proposals",
      "/api/assistants/asst_default/tasks",
      "/api/assistants/asst_default/list",
      "/api/assistants/asst_default/operations",
    ].includes(url.pathname)
  )
    return json([]);
  if (method === "PATCH" && url.pathname === "/api/assistants/asst_work")
    return json({ ...assistants[1], name: body.name });
  if (method === "DELETE" && url.pathname === "/api/assistants/asst_work")
    return new Response(null, { status: 204 });
  if (method === "GET" && url.pathname === "/api/resources")
    return json(resources);
  if (
    method === "GET" &&
    url.pathname === "/api/assistants/asst_work/memory/layers"
  )
    return json(memoryLayers);
  if (
    method === "GET" &&
    url.pathname === "/api/assistants/asst_work/memory/sorting"
  )
    return json(memorySorting);
  if (
    method === "POST" &&
    url.pathname.startsWith("/api/assistants/asst_work/memory/sorting/")
  )
    return json({
      ...[...memorySorting.moves, ...memorySorting.suggestions].find((record) =>
        url.pathname.endsWith(`/${record.id}/action`),
      ),
      status: { undo: "undone", confirm: "confirmed", dismiss: "dismissed" }[
        body.action
      ],
    });
  if (
    method === "POST" &&
    url.pathname.startsWith("/api/assistants/asst_work/memory/layers/")
  )
    return json({ id: "knowledge_job", status: "captured" }, 202);
  if (
    method === "POST" &&
    url.pathname.startsWith("/api/assistants/asst_work/memory/entries/")
  )
    return json(
      {
        fromScope: url.pathname.includes("/entry_person/")
          ? "person"
          : "assistant",
        toScope: body.toScope,
        sourceEntryId: "entry_person",
        targetVaultId: "vault_move_target",
        targetEntryId: "entry_move_target",
        status: "captured",
      },
      202,
    );
  if (
    method === "POST" &&
    url.pathname.startsWith("/api/assistants/asst_work/knowledge/vaults/")
  )
    return json({ id: "knowledge_job", status: "captured" }, 202);
  if (
    method === "GET" &&
    url.pathname === "/api/assistants/asst_work/knowledge/vaults"
  )
    return json([
      {
        id: "vault_person",
        kind: "memory",
        scope: "person",
        workspaceId: "ws_budget",
        deviceId: "dev_studio",
        rootPath: "memory",
        epoch: 1,
        revision: 2,
        state: "active",
        createdAt: iso,
        updatedAt: iso,
      },
    ]);
  if (
    method === "GET" &&
    url.pathname ===
      "/api/assistants/asst_work/knowledge/vaults/vault_person/entries"
  )
    return json([
      {
        id: "entry_person",
        vaultId: "vault_person",
        epoch: 1,
        revision: 3,
        hash: "sha256:person",
        title: "Prefers concise answers",
        sourceRef: "user-input:d1a782e5-b192-4251-a232-2469f4eb7510",
        state: "active",
        updatedAt: iso,
      },
    ]);
  if (
    method === "GET" &&
    url.pathname === "/api/assistants/asst_work/knowledge/mutations"
  )
    return json([]);
  if (
    method === "GET" &&
    url.pathname === "/api/assistants/asst_work/knowledge/publications"
  )
    return json([]);
  if (
    method === "GET" &&
    url.pathname === "/api/assistants/asst_work/knowledge/migrations"
  )
    return json([]);
  if (
    method === "GET" &&
    url.pathname === "/api/assistants/asst_work/knowledge/replica-cleanup"
  )
    return json([]);
  if (method === "GET" && url.pathname.endsWith("/permission-package")) {
    const answer = permissionAnswers[url.pathname];
    if (answer) return json(answer);
  }
  if (method === "PUT" && url.pathname.endsWith("/permission-package"))
    return json(body);
  throw new Error(`unexpected ${method} ${url.pathname}`);
}
globalThis.fetch = fixtureFetch;
beforeEach(() => {
  globalThis.fetch = fixtureFetch;
});

async function render(component, props) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const entry = { root };
  mounted.add(entry);
  await act(async () => root.render(createElement(component, props)));
  await settle();
  return {
    container,
    root,
    async unmount() {
      await act(async () => root.unmount());
      mounted.delete(entry);
      container.remove();
    },
  };
}

async function settle() {
  for (let index = 0; index < 5; index += 1)
    await act(async () => new Promise((done) => setTimeout(done, 0)));
}

function button(root, text) {
  const match = [...root.querySelectorAll("button")].find(
    (node) => node.textContent.trim() === text,
  );
  assert.ok(match, `no button "${text}"`);
  return match;
}

async function openRowMenu(root, label) {
  const trigger = [...root.querySelectorAll("button")].find(
    (node) => node.getAttribute("aria-label") === label,
  );
  assert.ok(trigger, `no row menu "${label}"`);
  await act(async () => {
    trigger.dispatchEvent(
      new window.PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerType: "mouse",
      }),
    );
    trigger.click();
  });
  await settle();
  return [...document.querySelectorAll('[role="menuitem"]')];
}

async function input(node, value) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(node, value);
    node.dispatchEvent(new window.Event("input", { bubbles: true }));
    node.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await settle();
}

test("assistant rows create and confirm destructive deletion", async () => {
  permissionAnswers = {
    "/api/assistants/asst_work/permission-package": permissionPackage([
      "ws_budget",
      "ws_archive",
    ]),
  };
  const events = [];
  const page = await render(AssistantList, {
    assistants,
    devices,
    state: "ready",
    onEvent: (event) => events.push(event),
    onReload: async () => {},
    selectedAssistantId: "asst_work",
  });
  const text = page.container.textContent;
  assert.match(text, /Personal/);
  assert.match(text, /Default/);
  assert.match(text, /Can use all your projects and resources/);
  assert.match(text, /Work assistant/);
  assert.match(text, /2 projects selected/);
  assert.match(text, /Studio/);
  assert.match(text, /Paused/);
  const current = page.container.querySelector('[aria-current="true"]');
  assert.ok(current);
  assert.match(current.textContent, /Work assistant/);
  assert.equal(current.dataset.current, "true");
  assert.equal(
    [...page.container.querySelectorAll('[aria-current="true"]')].length,
    1,
  );

  const defaultActions = page.container.querySelector(
    '[aria-label="Actions for Personal"]',
  );
  assert.ok(defaultActions);
  await act(async () => {
    defaultActions.dispatchEvent(
      new window.PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerType: "mouse",
      }),
    );
    defaultActions.click();
  });
  await settle();
  const defaultItems = [...document.querySelectorAll('[role="menuitem"]')];
  assert.deepEqual(
    defaultItems.map((node) => node.textContent.trim()),
    ["Rename"],
  );
  await act(async () => defaultItems[0].click());
  await settle();
  let dialog = document.querySelector("[role=dialog]");
  assert.match(dialog.textContent, /Rename assistant/);
  await act(async () => button(dialog, "Cancel").click());
  await settle();

  await act(async () => button(page.container, "New assistant").click());
  dialog = document.querySelector("[role=dialog]");
  assert.ok(dialog);
  await input(dialog.querySelector("input"), "Research");
  await act(async () => button(dialog, "Create assistant").click());
  await settle();
  const created = calls.find(
    (call) => call.method === "POST" && call.path === "/api/assistants",
  );
  assert.deepEqual(created?.body, {
    name: "Research",
    homeDeviceId: "dev_studio",
  });
  assert.deepEqual(events.at(-1), {
    type: "assistant.created",
    assistantId: "asst_created",
  });

  const actions = page.container.querySelector(
    '[aria-label="Actions for Work assistant"]',
  );
  assert.ok(actions);
  await act(async () => {
    actions.dispatchEvent(
      new window.PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerType: "mouse",
      }),
    );
    actions.click();
  });
  await settle();
  const deleteItem = [...document.querySelectorAll('[role="menuitem"]')].find(
    (node) => node.textContent.trim().startsWith("Delete"),
  );
  assert.ok(deleteItem);
  await act(async () => deleteItem.click());
  await settle();
  dialog = document.querySelector("[role=dialog]");
  assert.match(dialog.textContent, /Delete Work assistant\?/);
  assert.match(dialog.textContent, /home workspace is archived/);
  assert.equal(
    calls.some((call) => call.method === "DELETE"),
    false,
    "nothing is deleted before confirmation",
  );
  await act(async () => button(dialog, "Delete").click());
  await settle();
  assert.ok(
    calls.some(
      (call) =>
        call.method === "DELETE" && call.path === "/api/assistants/asst_work",
    ),
  );
  await page.unmount();
});

test("assistant title menu switches, checks the current row, lists all, and creates", async () => {
  const events = [];
  const page = await render(AssistantHome, {
    assistantId: "asst_default",
    agentProfiles: [],
    assistants,
    devices,
    workspaces: [],
    onEvent: (event) => events.push(event),
  });

  assert.equal(
    [...page.container.querySelectorAll("button")].some(
      (node) => node.textContent.trim() === "New assistant",
    ),
    false,
  );
  assert.ok(button(page.container, "Stop assistant work"));
  assert.ok(button(page.container, "Settings"));

  let items = await openRowMenu(page.container, "Switch assistant: Personal");
  const current = items.find((node) =>
    node.textContent.trim().startsWith("Personal"),
  );
  assert.ok(current);
  assert.equal(current.getAttribute("aria-current"), "true");
  assert.ok(items.some((node) => node.textContent.includes("All assistants")));

  const work = items.find((node) =>
    node.textContent.trim().startsWith("Work assistant"),
  );
  await act(async () => work.click());
  await settle();
  assert.deepEqual(events.at(-1), {
    type: "assistant.open",
    assistantId: "asst_work",
  });

  items = await openRowMenu(page.container, "Switch assistant: Personal");
  const all = items.find((node) => node.textContent.includes("All assistants"));
  await act(async () => all.click());
  await settle();
  assert.deepEqual(events.at(-1), { type: "assistants.open" });

  items = await openRowMenu(page.container, "Switch assistant: Personal");
  const create = items.find((node) =>
    node.textContent.includes("New assistant"),
  );
  await act(async () => create.click());
  await settle();
  const dialog = document.querySelector("[role=dialog]");
  assert.match(dialog.textContent, /New assistant/);
  assert.ok(button(dialog, "Create assistant"));
  await page.unmount();
});

test("the active assistant is remembered per person", () => {
  window.localStorage.clear();
  persistAssistantId("usr_1", "asst_work");
  assert.equal(storedAssistantId("usr_1"), "asst_work");
  assert.equal(storedAssistantId("usr_2"), "");
  assert.equal(
    window.localStorage.getItem("foundry.activeAssistantId.usr_1"),
    "asst_work",
  );
  clearStoredAssistantId("usr_1");
  assert.equal(storedAssistantId("usr_1"), "");
});

test("workspace and identity access save together in one permission package", async () => {
  permissionAnswers = {
    "/api/assistants/asst_work/permission-package": permissionPackage(
      ["ws_budget"],
      "listed",
      {
        scope: "all",
        allowed: ["res_browser", "res_screen", "res_offline"],
      },
    ),
    "/api/assistants/asst_default/permission-package": permissionPackage([
      "ws_garden",
    ]),
  };
  const notices = [];
  const page = await render(WorkspaceAccessEditor, {
    assistantId: "asst_work",
    assistants,
    devices,
    workspaces,
    onNotice: (message) => notices.push(message),
  });
  assert.match(page.container.textContent, /1 selected/);
  assert.match(
    page.container.textContent,
    /all your identity-bearing resources/,
  );
  assert.match(
    page.container.textContent,
    /do not change any third-party authorization/,
  );
  assert.match(
    page.container.textContent,
    /browser launcher still runs through its session/,
  );
  assert.equal(
    page.container.querySelector(
      'input[aria-label="Let this assistant use Chrome with work login"]',
    ),
    null,
  );
  assert.equal(button(page.container, "Save access").disabled, true);

  const search = page.container.querySelector(
    'input[aria-label="Search projects"]',
  );
  assert.ok(search);
  await input(search, "archive");
  assert.match(page.container.textContent, /Archive plans/);
  assert.doesNotMatch(page.container.textContent, /Family budget/);

  await act(async () =>
    button(page.container, "Select all on this computer").click(),
  );
  await input(search, "");
  assert.match(page.container.textContent, /2 selected/);
  await act(async () =>
    button(page.container, "Choose only some resources").click(),
  );
  assert.match(page.container.textContent, /Chrome with work login/);
  assert.match(page.container.textContent, /Studio screen/);
  assert.match(page.container.textContent, /Offline browser/);
  assert.doesNotMatch(page.container.textContent, /Local GPU/);
  const offlineBadge = [...page.container.querySelectorAll(".fdy-badge")].find(
    (node) =>
      node.textContent.trim() === "Device offline" &&
      node.closest("label")?.textContent.includes("Offline browser"),
  );
  assert.ok(offlineBadge);
  assert.match(offlineBadge.className, /fdy-badge-neutral/);
  assert.doesNotMatch(offlineBadge.className, /fdy-badge-slate/);
  const chrome = page.container.querySelector(
    'input[aria-label="Let this assistant use Chrome with work login"]',
  );
  const screen = page.container.querySelector(
    'input[aria-label="Let this assistant use Studio screen"]',
  );
  await act(async () => chrome.click());
  await act(async () => chrome.click());
  await act(async () => screen.click());
  await act(async () => button(page.container, "Save access").click());
  await settle();
  const saved = calls.find((call) => call.method === "PUT");
  assert.deepEqual(saved?.body.workspaces, {
    scope: "listed",
    include: ["ws_budget", "ws_archive"],
    exclude: [],
  });
  assert.deepEqual(saved?.body.identityResources, {
    scope: "listed",
    allowed: ["res_browser", "res_offline"],
  });
  assert.ok(notices.includes("Access saved."));

  await act(async () =>
    button(page.container, "Copy from another assistant").click(),
  );
  let dialog = document.querySelector("[role=dialog]");
  assert.match(dialog.textContent, /Copy project access/);
  await act(async () => button(dialog, "Continue").click());
  await settle();
  dialog = document.querySelector("[role=dialog]");
  assert.match(dialog.textContent, /Replace the current selection\?/);
  assert.match(dialog.textContent, /1 project/);
  await act(async () => button(dialog, "Replace selection").click());
  await settle();
  assert.match(page.container.textContent, /1 selected/);
  assert.ok(notices.includes("Access saved."));
  await page.unmount();
});

test("broad workspace and identity access load clean until narrowed", async () => {
  permissionAnswers = {
    "/api/assistants/asst_default/permission-package": permissionPackage(
      workspaces.map((workspace) => workspace.id),
      "all",
      {
        scope: "all",
        allowed: ["res_browser", "res_screen", "res_offline"],
      },
    ),
  };
  const page = await render(WorkspaceAccessEditor, {
    assistantId: "asst_default",
    assistants,
    devices,
    workspaces,
    onNotice: () => {},
  });
  assert.match(
    page.container.textContent,
    /All workspaces, including future ones/,
  );
  assert.match(
    page.container.textContent,
    /all your identity-bearing resources, including ones added later/,
  );
  assert.equal(
    page.container.querySelector('input[aria-label="Search projects"]'),
    null,
  );
  assert.equal(
    page.container.querySelector(
      'input[aria-label="Let this assistant use Chrome with work login"]',
    ),
    null,
  );
  assert.equal(button(page.container, "Save access").disabled, true);

  await act(async () =>
    button(page.container, "Choose only some resources").click(),
  );
  assert.ok(
    page.container.querySelector(
      'input[aria-label="Let this assistant use Chrome with work login"]',
    ),
  );
  assert.equal(button(page.container, "Save access").disabled, false);
  await page.unmount();
});

test("memory page keeps one layered list and hides technical entry fields", async () => {
  const page = await render(KnowledgeSection, {
    assistantId: "asst_work",
    devices,
    workspaces,
    profiles: [],
  });
  const text = page.container.textContent;
  assert.equal(text.match(/Prefers concise answers/g)?.length, 1);
  assert.match(text, /Memory storage and maintenance/);
  assert.doesNotMatch(
    text,
    /Read \/ correct \/ share|entry_person|vault_person|user-input:|Revision 3/,
  );
  await page.unmount();
});

test("memory shows automatic sorting with undo and suggestions to share", async () => {
  memorySorting = {
    moves: [
      sortRecord({
        id: "msort_qa",
        kind: "move",
        status: "moved",
        fromScope: "person",
        toScope: "assistant",
        title: "Weichao is QA",
        reason: "A colleague at work.",
        mentions: ["Weichao"],
        undoable: true,
      }),
      sortRecord({
        id: "msort_old",
        kind: "move",
        status: "undone",
        fromScope: "person",
        toScope: "assistant",
        assistantId: "asst_work",
        assistantName: "ByteWork",
        assistantIsDefault: false,
        title: "Atlas launches next month",
        reason: "A project date.",
      }),
    ],
    suggestions: [
      sortRecord({
        id: "msort_vim",
        kind: "suggestion",
        status: "suggested",
        fromScope: "assistant",
        toScope: "person",
        assistantId: "asst_work",
        assistantName: "ByteWork",
        assistantIsDefault: false,
        confidence: "medium",
        title: "Uses vim",
        reason: "Maybe only at work.",
      }),
      sortRecord({
        id: "msort_dark",
        kind: "suggestion",
        status: "suggested",
        fromScope: "assistant",
        toScope: "person",
        assistantId: "asst_work",
        assistantName: "ByteWork",
        assistantIsDefault: false,
        confidence: "low",
        title: "Prefers dark mode",
        reason: "Unclear.",
      }),
    ],
  };
  const page = await render(MemorySection, { assistantId: "asst_work" });
  await settle();
  const text = page.container.textContent;
  assert.match(text, /Recent automatic sorting/);
  assert.match(
    text,
    /Moved from the shared layer to “Assistant”\. A colleague at work\./,
  );
  assert.match(text, /Undone/);
  assert.match(text, /Suggested to share/);
  assert.match(text, /From “ByteWork”\. Maybe only at work\./);
  assert.equal(
    [...page.container.querySelectorAll("button")].filter(
      (node) => node.textContent.trim() === "Undo",
    ).length,
    1,
  );

  await act(async () =>
    page.container
      .querySelector('button[aria-label="Undo moving “Weichao is QA”"]')
      .click(),
  );
  await settle();
  const vim = [...page.container.querySelectorAll("li")].find((node) =>
    node.textContent.includes("Uses vim"),
  );
  await act(async () => button(vim, "Share").click());
  await settle();
  const dark = [...page.container.querySelectorAll("li")].find((node) =>
    node.textContent.includes("Prefers dark mode"),
  );
  await act(async () => button(dark, "Ignore").click());
  await settle();

  const actions = calls
    .filter(
      (call) =>
        call.method === "POST" &&
        call.path.startsWith("/api/assistants/asst_work/memory/sorting/"),
    )
    .map((call) => [call.path.split("/").at(-2), call.body.action]);
  assert.deepEqual(actions, [
    ["msort_qa", "undo"],
    ["msort_vim", "confirm"],
    ["msort_dark", "dismiss"],
  ]);
  await page.unmount();
});

test("memory reads two layers, adds to each, and confirms moving to shared", async () => {
  const corrected = [];
  const published = [];
  const reviewed = [];
  const page = await render(MemorySection, {
    assistantId: "asst_work",
    onCorrect: (entry) => corrected.push(entry.id),
    onPublish: (entry) => published.push(entry.id),
    onReviewSource: (entry) => reviewed.push(entry.id),
  });
  const text = page.container.textContent;
  assert.match(text, /About you \(shared by all assistants\)/);
  assert.match(text, /This assistant/);
  assert.match(text, /Prefers concise answers/);
  assert.match(text, /Owns Project Atlas/);
  assert.equal(text.match(/Prefers concise answers/g)?.length, 1);
  assert.equal(text.match(/Owns Project Atlas/g)?.length, 1);
  assert.doesNotMatch(text, /entry_person|vault_person|user-input:/);
  assert.equal(
    [...page.container.querySelectorAll("button")].some(
      (node) => node.textContent.trim() === "Edit",
    ),
    false,
  );

  const personInput = page.container.querySelector(
    'input[aria-label="Something for About you (shared by all assistants) to remember"]',
  );
  assert.ok(personInput);
  const expirySummary = [...page.container.querySelectorAll("summary")].find(
    (node) => node.textContent.trim() === "Valid until (optional)",
  );
  assert.ok(expirySummary);
  await act(async () => expirySummary.click());
  const expiryInput = page.container.querySelector(
    'input[aria-label="Valid until (optional)"]',
  );
  assert.ok(expiryInput);
  await input(expiryInput, "2027-01-01T00:00:00Z");
  await input(personInput, "Prefers morning meetings");
  await act(async () =>
    button(personInput.closest("form"), "Remember").click(),
  );
  await settle();

  const assistantInput = page.container.querySelector(
    'input[aria-label="Something for This assistant to remember"]',
  );
  assert.ok(assistantInput);
  await input(assistantInput, "Atlas ships in December");
  await act(async () =>
    button(assistantInput.closest("form"), "Remember").click(),
  );
  await settle();

  const additions = calls.filter(
    (call) =>
      call.method === "POST" &&
      call.path.startsWith("/api/assistants/asst_work/memory/layers/"),
  );
  assert.equal(additions.length, 2);
  assert.equal(
    additions[0].path,
    "/api/assistants/asst_work/memory/layers/person/entries",
  );
  assert.match(additions[0].body.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(additions[0].body.title, "Prefers morning meetings");
  assert.equal(additions[0].body.body, "Prefers morning meetings");
  assert.equal(additions[0].body.expiresAt, "2027-01-01T00:00:00Z");
  assert.equal(
    additions[1].path,
    "/api/assistants/asst_work/memory/layers/assistant/entries",
  );
  assert.equal(additions[1].body.title, "Atlas ships in December");
  assert.equal(additions[1].body.body, "Atlas ships in December");

  let items = await openRowMenu(
    page.container,
    "Actions for “Prefers concise answers”",
  );
  assert.deepEqual(
    items.map((node) => node.textContent.trim()),
    ["Correct", "Share to…", "Move to this assistant", "Forget"],
  );
  await act(async () => items[0].click());
  await settle();
  assert.deepEqual(corrected, ["entry_person"]);
  items = await openRowMenu(
    page.container,
    "Actions for “Prefers concise answers”",
  );
  await act(async () => items[1].click());
  await settle();
  assert.deepEqual(published, ["entry_person"]);

  items = await openRowMenu(page.container, "Actions for “Owns Project Atlas”");
  assert.deepEqual(
    items.map((node) => node.textContent.trim()),
    [
      "Correct",
      "Share to…",
      "Review file edits",
      "Move to shared layer",
      "Forget",
    ],
  );
  await act(async () => items[2].click());
  await settle();
  assert.deepEqual(reviewed, ["entry_assistant"]);

  items = await openRowMenu(page.container, "Actions for “Owns Project Atlas”");
  await act(async () => items[3].click());
  const dialog = document.querySelector("[role=dialog]");
  assert.match(dialog.textContent, /Move to the shared layer\?/);
  assert.match(dialog.textContent, /every one of your assistants/);
  assert.match(dialog.textContent, /able to recall it/);
  await act(async () => button(dialog, "Move").click());
  await settle();

  const moved = calls.find(
    (call) =>
      call.method === "POST" &&
      call.path ===
        "/api/assistants/asst_work/memory/entries/entry_assistant/move",
  );
  assert.deepEqual(moved?.body, {
    toScope: "person",
    expectedRevision: 7,
    expectedHash: "sha256:assistant",
  });

  const personEntry = [...page.container.querySelectorAll("li")].find((node) =>
    node.textContent.includes("Prefers concise answers"),
  );
  assert.ok(personEntry);
  items = await openRowMenu(
    page.container,
    "Actions for “Prefers concise answers”",
  );
  await act(async () => items.at(-1).click());
  const forgetDialog = document.querySelector("[role=dialog]");
  assert.match(forgetDialog.textContent, /Forget this memory\?/);
  assert.match(forgetDialog.textContent, /no longer be recalled/);
  assert.match(forgetDialog.textContent, /conversation history and backups/);
  await act(async () => button(forgetDialog, "Forget").click());
  await settle();

  const forgotten = calls.find(
    (call) =>
      call.method === "POST" &&
      call.path ===
        "/api/assistants/asst_work/knowledge/vaults/vault_person/entries",
  );
  assert.equal(forgotten?.body.action, "forget");
  assert.equal(forgotten?.body.entryId, "entry_person");
  assert.equal(forgotten?.body.expectedRevision, 3);
  assert.equal(forgotten?.body.expectedHash, "sha256:person");
  assert.match(forgotten?.body.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(
    calls.some(
      (call) =>
        call.method !== "GET" &&
        call.path === "/api/assistants/asst_work/memory",
    ),
    false,
  );
  await page.unmount();
});
