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
const { WorkspaceExecutionDefaultFeature } =
  await import("../src/features/agent-defaults/index.ts");

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

const updatedBy = { userId: "user_1", name: "Orchestrator" };
const flashSummary = {
  id: "flash-1017",
  owner: "deepseek",
  displayName: "DeepSeek Flash 1017",
  aliasCount: 2,
  summary: "Fast and cheap for small, well-specified slices.",
  revision: 2,
  updatedAt: "2026-11-10T10:00:00Z",
  updatedBy,
};
const flashDetail = {
  guide: {
    id: "flash-1017",
    owner: "deepseek",
    displayName: "DeepSeek Flash 1017",
    aliases: [
      { providerId: "p1", runtime: "codex", model: "gpt-5" },
      { model: "deepseek/flash" },
    ],
    sections: {
      summary: "Fast and cheap for small, well-specified slices.",
      pitfalls: "- Drops **required** evidence when the brief is long",
    },
    revision: 2,
    updatedAt: "2026-11-10T10:00:00Z",
    updatedBy,
  },
  facts: {
    providers: [
      {
        alias: { model: "gpt-5" },
        contextWindow: 128000,
        workerGroupLabel: "Flash",
        tokensPerMinute: 6000000,
      },
    ],
    usage: {
      windowDays: 30,
      workerSessions: 12,
      requests: 340,
      avgRequestMs: 2400,
      tokPerSec: 58.3,
    },
  },
  observations: {
    total: 1,
    offset: 0,
    observations: [
      {
        id: "obs_1",
        guideId: "flash-1017",
        body: "Skipped the tests twice.",
        sessionIds: ["sess_42"],
        createdAt: "2026-11-09T10:00:00Z",
      },
    ],
  },
  revisions: [
    {
      revision: 2,
      changeSummary: "add pitfalls",
      updatedAt: "2026-11-10T10:00:00Z",
      updatedBy,
    },
    {
      revision: 1,
      changeSummary: "first draft",
      updatedAt: "2026-11-08T10:00:00Z",
      updatedBy,
    },
  ],
};
let guidesOverride;
let resolveOverride;
afterEach(() => {
  guidesOverride = undefined;
  resolveOverride = undefined;
});

/** The server's answers: a saved provider echoes its input. */
function serveProfiles({ path, body, method }) {
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
  if (path === "/api/worker-groups") return Response.json([]);
  if (path === "/api/model-guides")
    return Response.json({ guides: guidesOverride ?? [flashSummary] });
  if (path === "/api/model-guides/resolve") {
    const resolution = resolveOverride ?? {
      guide: flashSummary,
      suggestedId: "flash-1017",
      suggestedIdTaken: true,
    };
    return Response.json(
      method === "POST"
        ? { resolutions: body.targets.map(() => resolution) }
        : resolution,
    );
  }
  if (path === "/api/model-guides/flash-1017")
    return Response.json(flashDetail);
  if (path === "/api/model-guides/flash-1017/revisions/1")
    return Response.json({
      guideId: "flash-1017",
      revision: 1,
      changeSummary: "first draft",
      snapshot: { ...flashDetail.guide, revision: 1 },
    });
  if (path.startsWith("/api/profiles") && body)
    return Response.json({
      ...profile,
      ...body,
      id: body.id ?? "created-profile",
    });
  return Response.json(profile);
}

test("the model guides list opens a guide's details", async () => {
  const view = await renderFeature({ tab: "guides" });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const headings = [...view.container.querySelectorAll("h2,h3")].map(
    (heading) => heading.textContent,
  );
  assert.ok(headings.includes("Model guides"));
  assert.ok(
    !headings.includes("Execution models"),
    "the guides section is its own page",
  );
  assert.equal(
    view.container.querySelector('[aria-label="Runtime"]'),
    null,
    "the runtime and device filters do not apply to guides",
  );
  assert.equal(view.container.querySelector('[aria-label^="Device"]'), null);
  const row = window.document.querySelector(
    'button[aria-label="Open guide DeepSeek Flash 1017"]',
  );
  assert.ok(row);
  assert.match(row.textContent, /flash-1017/);
  assert.match(row.textContent, /2 aliases/);
  assert.match(row.textContent, /Fast and cheap/);
  assert.match(row.textContent, /Orchestrator/);
  await act(async () => {
    row.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const dialog = window.document.querySelector(".fdy-dialog");
  assert.ok(dialog);
  const text = dialog.textContent;
  assert.match(text, /Known pitfalls/);
  assert.match(text, /required/);
  assert.match(text, /deepseek\/flash/);
  assert.match(text, /128,000 tokens/);
  assert.match(text, /58\.3 tok\/s/);
  assert.match(text, /2\.4 s/);
  assert.match(text, /Skipped the tests twice/);
  assert.match(text, /Add to the pitfalls of the flash-1017 guide/);
  assert.ok(dialog.querySelector('button[aria-label="Copy the example"]'));
  assert.ok(dialog.querySelector('a[href*="sess_42"]'));
  assert.equal(
    dialog.querySelectorAll("textarea, input[type=text]").length,
    0,
    "guides are read-only",
  );
});

test("without guides the section says how they come to exist", async () => {
  guidesOverride = [];
  const view = await renderFeature({ tab: "guides" });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.match(
    view.container.textContent,
    /No guides yet\. Your orchestrator creates one the first time it hands work to a model/,
  );
});

test("the default execution model links to its guide, or says there is none", async () => {
  const view = await renderFeature({ tab: "default" });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  const link = window.document.querySelector(
    'button[aria-label="Open the guide for DeepSeek Flash 1017"]',
  );
  assert.ok(link);
  assert.match(link.textContent, /Guide: DeepSeek Flash 1017/);
  assert.ok(
    view.requests.some(
      (request) =>
        request.path === "/api/model-guides/resolve" &&
        request.method === "GET",
    ),
  );
  document.body.replaceChildren();
  resolveOverride = { suggestedId: "gpt-5", suggestedIdTaken: false };
  const empty = await renderFeature({ tab: "default" });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  assert.match(empty.container.textContent, /No guide yet/);
});

const groupMember = (model, providerId = "p1", runtime = "codex") => ({
  providerKind: "api",
  providerId,
  runtime,
  model,
  tokensPerMinute: 6_000_000,
  weight: 1,
});

/** One saved group whose members come from two providers, and the default naming it. */
function serveWorkerGroups() {
  const group = {
    id: "wg_flash",
    label: "DeepSeek Flash",
    members: [
      groupMember("deepseek-v4.1-flash-1017"),
      groupMember("deepseek/deepseek-flash", "p2"),
    ],
    createdAt: "2026-11-10T10:00:00Z",
    updatedAt: "2026-11-10T10:00:00Z",
  };
  const groups = [group];
  const executionDefault = { workerGroupId: group.id, scope: "global", group };
  return {
    groups,
    serve(request) {
      if (request.path === "/api/execution-default" && request.method === "GET")
        return Response.json({
          saved: executionDefault,
          effective: executionDefault,
        });
      if (request.path === "/api/worker-groups" && request.method === "GET")
        return Response.json(groups);
      if (request.path === "/api/worker-groups" && request.method === "POST") {
        const created = { ...group, ...request.body, id: "wg_new" };
        groups.push(created);
        return Response.json(created, { status: 201 });
      }
      return serveProfiles(request);
    },
  };
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

test("the default execution model can be a worker group, managed in the Worker groups section", async () => {
  const { serve } = serveWorkerGroups();
  const view = await renderFeature({ tab: "default" }, serve);
  await settle();
  assert.match(
    view.container.textContent,
    /Worker group DeepSeek Flash \(2 models\)/,
  );
  assert.ok(view.query('button[aria-label^="Worker group:"]'));
  assert.ok(
    !view.query('button[aria-label^="Model provider:"]'),
    "a group default shows no provider or model fields",
  );
  assert.equal(
    view.query('[aria-label="Group name"]'),
    null,
    "groups are edited in their own section, not here",
  );
  assert.ok(view.buttonWithText("Manage worker groups"));
  await unmount(view.root);
});

test("a worker group is created with members from different providers", async () => {
  const { serve } = serveWorkerGroups();
  const view = await renderFeature({ tab: "groups" }, serve);
  await settle();
  const editGroup = view.query(
    'button[aria-label="Edit worker group DeepSeek Flash"]',
  );
  assert.ok(editGroup);
  assert.match(editGroup.textContent, /By quota/);
  await view.clickButton("New worker group");
  await view.type('input[aria-label="Group name"]', "Fast fallback");
  assert.ok(view.query('button[aria-label^="Provider of model 1"]'));
  await view.clickButton("Save group");
  const created = view.requests.find(
    (request) =>
      request.method === "POST" && request.path === "/api/worker-groups",
  );
  assert.ok(created);
  assert.equal(created.body.label, "Fast fallback");
  assert.equal(created.body.members[0].providerId, "p1");
  assert.equal(created.body.members[0].runtime, "codex");
  assert.ok(created.body.members[0].model);
  assert.equal("providerId" in created.body, false);
  assert.match(view.container.textContent, /Fast fallback/);
  await unmount(view.root);
});

test("worker group weights lock while another model has a quota", async () => {
  const { serve } = serveWorkerGroups();
  const view = await renderFeature({ tab: "groups" }, serve);
  await settle();
  await view.clickButton("DeepSeek Flash");
  await view.type('input[aria-label="Tokens per minute for model 2"]', "");
  await settle();

  const section = view.query('[aria-label="Worker groups"]');
  const weights = [
    ...section.querySelectorAll('input[aria-label^="Rotation weight"]'),
  ];
  assert.equal(weights.length, 2);
  assert.ok(weights.every((input) => input.disabled));
  assert.equal(
    weights[0].getAttribute("aria-describedby"),
    "worker-group-mode-hint",
  );
  assert.match(
    section.querySelector("#worker-group-mode-hint").textContent,
    /Weights are not used\./,
  );
  assert.equal(
    section.querySelector('.fdy-field-hint[data-tone="warning"]').textContent,
    "Other models have quotas set, so this model will not be selected. Add Tokens / minute, or clear every quota to use weights.",
  );
  assert.match(
    section.textContent,
    /Picks by remaining quota: each new worker gets the model with the most tokens left in the last minute\. Weights are not used\. Members a device cannot use are skipped\./,
  );
  await unmount(view.root);
});

test("worker group weights edit when no model has a quota", async () => {
  const { serve } = serveWorkerGroups();
  const view = await renderFeature({ tab: "groups" }, serve);
  await settle();
  await view.clickButton("DeepSeek Flash");
  await view.type('input[aria-label="Tokens per minute for model 1"]', "");
  await view.type('input[aria-label="Tokens per minute for model 2"]', "");
  await settle();

  const section = view.query('[aria-label="Worker groups"]');
  const weights = [
    ...section.querySelectorAll('input[aria-label^="Rotation weight"]'),
  ];
  assert.equal(weights.length, 2);
  assert.ok(weights.every((input) => !input.disabled));
  assert.equal(
    section.querySelector('.fdy-field-hint[data-tone="warning"]'),
    null,
  );
  assert.match(
    section.textContent,
    /No quotas set: new workers rotate through the models by weight\. Members a device cannot use are skipped\./,
  );
  await unmount(view.root);
});

async function renderWorkspaceExecution(
  executionDefault,
  endpoint,
  groups = [],
) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const requests = [];
  const workspaceId = "ws_execution";
  globalThis.fetch = async (input, init = {}) => {
    const request = {
      method: init.method ?? "GET",
      path: new URL(String(input)).pathname,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    if (
      request.method === "GET" &&
      request.path === `/api/workspaces/${workspaceId}/execution-default`
    )
      return Response.json(executionDefault);
    if (request.method === "GET" && request.path === "/api/worker-groups")
      return Response.json(groups);
    if (request.method === "GET" && request.path.endsWith("/models"))
      return Response.json([]);
    if (
      request.method === "GET" &&
      request.path === "/api/model-guides/resolve"
    )
      return Response.json({
        suggestedId: endpoint.model,
        suggestedIdTaken: false,
      });
    if (
      request.method === "PUT" &&
      request.path === `/api/workspaces/${workspaceId}/execution-default`
    ) {
      const saved = { ...request.body, scope: "workspace" };
      return Response.json({ workspaceId, saved, effective: saved });
    }
    throw new Error(`unexpected ${request.method} ${request.path}`);
  };
  await act(async () => {
    root.render(
      createElement(WorkspaceExecutionDefaultFeature, {
        profiles: [],
        servers: [endpoint],
        workspaceId,
      }),
    );
  });
  await settle();

  const choose = async (ariaLabel, optionText) => {
    const trigger = [...window.document.querySelectorAll("button")].find(
      (button) => {
        const label = button.getAttribute("aria-label") ?? "";
        return label === ariaLabel || label.startsWith(`${ariaLabel}:`);
      },
    );
    assert.ok(trigger, `missing ${ariaLabel} picker`);
    await act(async () => {
      trigger.dispatchEvent(
        new window.PointerEvent("pointerdown", { bubbles: true, button: 0 }),
      );
      trigger.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const option = [
      ...window.document.querySelectorAll('[role="menuitemradio"]'),
    ].find((item) => item.textContent.includes(optionText));
    assert.ok(option, `missing ${optionText} in ${ariaLabel}`);
    await act(async () => {
      option.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };
  const clickButton = async (text) => {
    const button = [...window.document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent.trim() === text,
    );
    assert.ok(button, `missing ${text}`);
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };
  const clickAria = async (ariaLabel) => {
    const button = window.document.querySelector(
      `button[aria-label="${ariaLabel}"]`,
    );
    assert.ok(button, `missing button ${ariaLabel}`);
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };
  return { choose, clickAria, clickButton, container, requests, root };
}

test("workspace execution saves the API endpoint, model and effort as protocol fields only", async () => {
  const endpoint = {
    ...profile,
    id: "prof_byte_llm",
    label: "byte-llm-gateway",
    model: "gpt-5",
    models: ["gpt-5", "flux/GPT-6.1-Sol"],
  };
  const view = await renderWorkspaceExecution(
    { effective: { scope: "none" } },
    endpoint,
  );
  try {
    assert.match(
      view.container.textContent,
      /Agents hand work to this model only after you start orchestration with \/foundry-orchestration in a chat; otherwise they use their own subagents as usual\./,
    );
    await view.choose("Model provider", "byte-llm-gateway");
    await view.choose("Model", "flux/GPT-6.1-Sol");
    await view.choose("Effort", "High");
    await view.clickButton("Save workspace override");
    const saved = view.requests.find((request) => request.method === "PUT");
    assert.deepEqual(saved.body, {
      providerKind: "api",
      providerId: endpoint.id,
      runtime: "codex",
      model: "flux/GPT-6.1-Sol",
      effort: "high",
      alternatives: [],
    });
    assert.equal("workerGroupId" in saved.body, false);
    assert.equal("modelPoolId" in saved.body, false);
  } finally {
    await unmount(view.root);
  }
});

test("workspace execution saves model and worker group alternatives as protocol fields only", async () => {
  const endpoint = {
    ...profile,
    id: "prof_alternatives",
    label: "Alternatives gateway",
    model: "gpt-5",
    models: ["gpt-5", "gpt-6.1"],
  };
  const group = {
    id: "wg_fallback",
    label: "Fallback group",
    members: [groupMember("deepseek-v4.1-flash-1017")],
    createdAt: "2026-11-12T10:00:00Z",
    updatedAt: "2026-11-12T10:00:00Z",
  };
  const view = await renderWorkspaceExecution(
    {
      effective: {
        providerKind: "api",
        providerId: endpoint.id,
        runtime: "codex",
        model: "gpt-5",
        effort: "high",
        alternatives: [],
        scope: "global",
      },
    },
    endpoint,
    [group],
  );
  try {
    await view.clickButton("Add");
    await view.choose("Model provider 1", "Alternatives gateway");
    await view.choose("Model 1", "gpt-6.1");
    await view.choose("Effort 1", "High");
    await view.clickButton("Add");
    await view.choose("Source 2", "A worker group");
    await view.choose("Worker group 2", "Fallback group");
    await view.clickButton("Save workspace override");

    const saved = view.requests.find((request) => request.method === "PUT");
    assert.deepEqual(saved.body.alternatives, [
      {
        providerKind: "api",
        providerId: endpoint.id,
        runtime: "codex",
        model: "gpt-6.1",
        effort: "high",
      },
      { workerGroupId: group.id },
    ]);
    assert.equal("group" in saved.body.alternatives[1], false);
  } finally {
    await unmount(view.root);
  }
});

test("removing a workspace execution alternative changes the saved payload", async () => {
  const endpoint = {
    ...profile,
    id: "prof_remove_alternative",
    label: "Removal gateway",
    model: "gpt-5",
    models: ["gpt-5", "gpt-6.1"],
  };
  const saved = {
    providerKind: "api",
    providerId: endpoint.id,
    runtime: "codex",
    model: "gpt-5",
    effort: "high",
    alternatives: [
      {
        providerKind: "api",
        providerId: endpoint.id,
        runtime: "codex",
        model: "gpt-6.1",
        effort: "high",
      },
      {
        providerKind: "api",
        providerId: endpoint.id,
        runtime: "codex",
        model: "gpt-5",
        effort: "low",
      },
    ],
    scope: "workspace",
  };
  const view = await renderWorkspaceExecution(
    { saved, effective: saved },
    endpoint,
  );
  try {
    await view.clickAria("Remove alternative 1");
    await view.clickButton("Save workspace override");
    const request = view.requests.find(
      (candidate) => candidate.method === "PUT",
    );
    assert.deepEqual(request.body.alternatives, [saved.alternatives[1]]);
  } finally {
    await unmount(view.root);
  }
});

test("a workspace without an override shows the inherited execution alternatives read-only", async () => {
  const endpoint = {
    ...profile,
    id: "prof_inherited_alternatives",
    label: "Inherited gateway",
    model: "gpt-5",
    models: ["gpt-5", "gpt-6.1"],
  };
  const group = {
    id: "wg_inherited",
    label: "Inherited group",
    members: [groupMember("deepseek-v4.1-flash-1017")],
    createdAt: "2026-11-12T10:00:00Z",
    updatedAt: "2026-11-12T10:00:00Z",
  };
  const inherited = {
    providerKind: "api",
    providerId: endpoint.id,
    runtime: "codex",
    model: "gpt-5",
    effort: "high",
    alternatives: [
      {
        providerKind: "api",
        providerId: endpoint.id,
        runtime: "codex",
        model: "gpt-6.1",
        effort: "high",
      },
      { workerGroupId: group.id, group },
    ],
    scope: "global",
  };
  const view = await renderWorkspaceExecution(
    { effective: inherited },
    endpoint,
    [group],
  );
  try {
    assert.match(view.container.textContent, /The orchestrator may also use/);
    assert.match(
      view.container.textContent,
      /Inherited from the global default/,
    );
    assert.match(
      view.container.textContent,
      /Inherited gateway · gpt-6\.1 · High/,
    );
    assert.match(view.container.textContent, /Worker group Inherited group/);
    assert.match(view.container.textContent, /2 alternatives/);
    assert.equal(
      view.container.querySelector('button[aria-label^="Model provider 1"]'),
      null,
    );
    assert.equal(
      view.container.querySelector('button[aria-label="Remove alternative 1"]'),
      null,
    );
  } finally {
    await unmount(view.root);
  }
});

test("execution summary names an API model and an unresolved worker group", async () => {
  const endpoint = {
    ...profile,
    id: "prof_byte_llm",
    label: "byte-llm-gateway",
    model: "flux/GPT-6.1-Sol",
  };
  const modelView = await renderWorkspaceExecution(
    {
      effective: {
        providerKind: "api",
        providerId: endpoint.id,
        runtime: "codex",
        model: "flux/GPT-6.1-Sol",
        effort: "high",
        scope: "global",
      },
    },
    endpoint,
  );
  try {
    assert.match(
      modelView.container.textContent,
      /byte-llm-gateway · flux\/GPT-6\.1-Sol · High — global default/,
    );
  } finally {
    await unmount(modelView.root);
  }

  const groupView = await renderWorkspaceExecution(
    {
      effective: {
        workerGroupId: "wgroup_missing",
        scope: "global",
      },
    },
    endpoint,
  );
  try {
    assert.match(
      groupView.container.textContent,
      /wgroup_missing \(worker group no longer available\)/,
    );
    assert.doesNotMatch(
      groupView.container.textContent,
      /\(no longer available\) · · Runtime default/,
    );
  } finally {
    await unmount(groupView.root);
  }
});

test("model pickers show a placeholder, never a selectable placeholder option", async () => {
  const empty = { scope: "global" };
  const view = await renderFeature({ tab: "default" }, (request) =>
    request.path === "/api/execution-default" && request.method === "GET"
      ? Response.json({ effective: empty })
      : serveProfiles(request),
  );
  await settle();
  const triggers = [
    ...view.container.querySelectorAll('button[aria-haspopup="menu"]'),
  ];
  assert.ok(triggers.length >= 2, "the provider and model pickers render");
  let menusWithItems = 0;
  for (const trigger of triggers) {
    await act(async () => {
      trigger.dispatchEvent(
        new window.PointerEvent("pointerdown", { bubbles: true, button: 0 }),
      );
      trigger.click();
    });
    await settle();
    const labels = [
      ...window.document.querySelectorAll(
        '[role="menuitemradio"], [role="option"], [role="menuitem"]',
      ),
    ].map((item) => item.textContent.trim());
    if (labels.length) menusWithItems += 1;
    assert.ok(
      !labels.some((label) => /^choose (a|an) /i.test(label)),
      `no placeholder option among ${JSON.stringify(labels)}`,
    );
    await act(async () => {
      window.document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
  }
  assert.ok(menusWithItems > 0, "at least one picker opened with options");
  const { agents } = await import("../src/i18n/locales/en/agents.ts");
  for (const key of ["chooseProvider", "chooseModel"])
    assert.equal(key in agents.executionDefault, false, key);
  await unmount(view.root);
});

test("the guides section lists the models in use that no guide covers, with a suggested id and an example sentence", async () => {
  resolveOverride = { suggestedId: "gpt-5", suggestedIdTaken: false };
  const view = await renderFeature({ tab: "guides" });
  await settle();
  const notice = view.query("[data-unlinked-models]");
  assert.ok(notice, "the default model has no guide");
  assert.match(notice.textContent, /Models without a guide/);
  assert.match(notice.textContent, /gpt-5/);
  assert.match(notice.textContent, /Suggested id: gpt-5/);
  assert.match(notice.textContent, /Execution models/);
  assert.ok(notice.querySelector('button[aria-label="Copy the example"]'));
  assert.ok(
    view.requests.some(
      (request) =>
        request.method === "POST" &&
        request.path === "/api/model-guides/resolve" &&
        request.body.targets.some((target) => target.model === "gpt-5"),
    ),
  );
  await unmount(view.root);

  resolveOverride = undefined;
  const covered = await renderFeature({ tab: "guides" });
  await settle();
  assert.equal(
    covered.query("[data-unlinked-models]"),
    null,
    "nothing is shown when every model has a guide",
  );
  await unmount(covered.root);
});

test("endpoint models link to their guide in small type; models without one show nothing", async () => {
  const relay = { ...profile, model: "gpt-5", models: ["gpt-5", "gpt-5-mini"] };
  const view = await renderFeature({ tab: "endpoints", profiles: [relay] });
  await settle();
  const tags = view.query("[data-model-guide-tags]");
  assert.ok(tags);
  assert.ok(
    tags.querySelector('button[aria-label^="Open the guide DeepSeek Flash"]'),
  );
  await unmount(view.root);
  resolveOverride = { suggestedId: "gpt-5", suggestedIdTaken: false };
  const none = await renderFeature({ tab: "endpoints", profiles: [relay] });
  await settle();
  assert.equal(none.query("[data-model-guide-tags]"), null);
  await unmount(none.root);
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
        (request.method === "GET" &&
          (request.path === "/api/execution-default" ||
            request.path === "/api/worker-groups" ||
            request.path.startsWith("/api/model-guides"))) ||
        (request.method === "POST" &&
          request.path === "/api/model-guides/resolve")
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

test("Model providers is a flat section menu in two groups, and the filters belong to the model source sections only", async () => {
  const view = await renderFeature({ tab: "subscriptions" });
  try {
    const nav = window.document.querySelector("[data-provider-nav]");
    assert.deepEqual(
      [...nav.querySelectorAll("section")].map((group) => [
        group.querySelector("h2").textContent,
        [...group.querySelectorAll("a")].map((item) => item.textContent),
      ]),
      [
        ["Execution", ["Execution models", "Worker groups", "Model guides"]],
        [
          "Model sources",
          ["Subscriptions", "API endpoints", "Launch environments"],
        ],
      ],
    );
    const items = [...nav.querySelectorAll("a")];
    assert.deepEqual(
      items.map((item) => item.textContent),
      [
        "Execution models",
        "Worker groups",
        "Model guides",
        "Subscriptions",
        "API endpoints",
        "Launch environments",
      ],
    );
    assert.deepEqual(
      items.map((item) => item.getAttribute("href")),
      [
        "default",
        "groups",
        "guides",
        "subscriptions",
        "endpoints",
        "environments",
      ].map((section) => `/model-providers/${section}`),
    );
    assert.equal(items[3].getAttribute("aria-current"), "page");
    assert.ok(view.query('[aria-label="Runtime"]'));
    assert.ok(view.query('[aria-label^="Device"]'));
    // The page-wide default execution model may name Relay; its endpoint
    // card belongs to the API endpoints section only.
    assert.ok(
      ![...window.document.querySelectorAll(".fdy-profile-card")].some((card) =>
        card.textContent.includes("Relay"),
      ),
    );
    await act(async () => {
      items[4].dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    assert.deepEqual(view.events.at(-1), { type: "tab", tab: "endpoints" });
  } finally {
    await unmount(view.root);
  }
  for (const tab of ["default", "groups", "guides"]) {
    const other = await renderFeature({ tab });
    try {
      assert.equal(other.query('[aria-label="Runtime"]'), null, tab);
      assert.equal(other.query('[aria-label^="Device"]'), null, tab);
      assert.equal(other.query(".fdy-profile-card"), null, tab);
    } finally {
      await unmount(other.root);
    }
  }
  for (const tab of ["endpoints", "environments"]) {
    const filtered = await renderFeature({ tab });
    try {
      assert.ok(filtered.query('[aria-label="Runtime"]'), tab);
      assert.ok(filtered.query('[aria-label^="Device"]'), tab);
    } finally {
      await unmount(filtered.root);
    }
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
