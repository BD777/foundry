import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({
  url: "https://foundry.example/assistant?workspace=ws_project",
});
for (const key of [
  "window",
  "document",
  "navigator",
  "localStorage",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLDivElement",
  "MutationObserver",
  "ResizeObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "FocusEvent",
  "PopStateEvent",
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
globalThis.EventSource = class {
  addEventListener() {}
  close() {}
};

const now = Date.now();
const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
const minute = 60_000;

const settings = {
  assistantName: "",
  language: "",
  timezone: "Europe/London",
  speakingStyle: "auto",
  verbosity: "concise",
  extraInstructions: "",
  policy: {
    create_workspace: "auto",
    register_folder: "ask",
    rename_workspace: "auto",
    add_skill: "auto",
    remove_skill_created: "auto",
    remove_skill: "ask",
    bind_connector: "ask",
    unbind_connector: "ask",
    archive_workspace: "ask",
    restore_workspace: "auto",
  },
  devices: [{ deviceId: "dev_mac", allowWork: true, allowCreate: true }],
  preferredDeviceId: "",
  assistantProfileId: "",
  assistantModel: "",
  delegateModel: "device_default",
  homePage: true,
  simpleInterface: false,
  feishuDirectChat: true,
  feishuAppId: "",
  dailyDigest: false,
  dailyDigestTime: "09:00",
  activeHoursStart: "09:00",
  activeHoursEnd: "22:00",
  urgentAnytime: true,
  limits: {
    concurrentSessions: 4,
    dailySessions: 30,
    dailyWorkspaces: 3,
    weeklyWorkspaces: 10,
    hourlyTurns: 60,
    dailyDigestSessions: 50,
    stuckAfterMinutes: 240,
    monthlyTokenBudget: 0,
  },
};
const agent = {
  userId: "usr_1",
  workspaceId: "ws_pa",
  homeDeviceId: "dev_mac",
  state: "active",
  settings,
  promptVersion: "1",
  createdAt: iso(-60 * minute),
  updatedAt: iso(-60 * minute),
};
const devices = [
  { id: "dev_mac", label: "MacBook", status: "connected", owned: true },
];
const agentProfiles = [
  {
    id: "prof_claude",
    deviceId: "dev_mac",
    runtime: "claude",
    label: "Claude login",
    status: "healthy",
    configScope: "user",
    connectionType: "local_login",
  },
];
const assistantSession = {
  id: "sess_pa",
  workspaceId: "ws_pa",
  agentId: "agent_1",
  deviceId: "dev_mac",
  provider: "claude",
  role: "personal_agent",
  status: "completed",
  title: "Family budget",
  prompt: "make a budget page",
  startedAt: iso(-20 * minute),
  lastActivityAt: iso(-10 * minute),
  createdLabel: "",
  updatedLabel: "",
  input: { id: "in_1" },
  events: [
    {
      id: "evt_in_1",
      sessionId: "sess_pa",
      at: iso(-20 * minute),
      label: "User message",
      detail: "help me make a small web page to track family spending",
      level: "info",
      message: {
        id: "in_1",
        kind: "user",
        text: "help me make a small web page to track family spending",
      },
    },
    {
      id: "evt_tool",
      sessionId: "sess_pa",
      at: iso(-19 * minute),
      label: "Tool call",
      detail: "create_workspace",
      level: "info",
      message: { id: "tool_1", kind: "tool", text: "create_workspace" },
    },
    {
      id: "evt_sess_pa_in_1_response_stream",
      sessionId: "sess_pa",
      at: iso(-18 * minute),
      label: "Response stream",
      detail: "Good idea — I've started building it in “Family budget”.",
      level: "info",
    },
  ],
};
const proposal = {
  id: "prop_1",
  sessionId: "sess_pa",
  kind: "archive_workspace",
  workspaceId: "ws_blog",
  spec: {},
  summary: "Put “Old blog” away? Everything in it is kept.",
  status: "pending",
  createdAt: iso(-15 * minute),
  expiresAt: iso(24 * 60 * minute),
};
const task = {
  id: "task_1",
  conversationSessionId: "sess_pa",
  sessionId: "sess_helper",
  workspaceId: "ws_budget",
  title: "Build the family budget page",
  status: "running",
  readOnly: false,
  createdAt: iso(-17 * minute),
  updatedAt: iso(-5 * minute),
};

// A conversation from before the assistant moved to another computer.
const formerSession = {
  ...assistantSession,
  id: "sess_old",
  threadId: "sess_old",
  workspaceId: "ws_old",
  startedAt: iso(-6 * minute),
  lastActivityAt: iso(-5 * minute),
  input: { id: "in_old", prompt: "what's on my list?", at: iso(-6 * minute) },
  events: [
    {
      id: "evt_in_old",
      sessionId: "sess_old",
      at: iso(-6 * minute),
      label: "User message",
      detail: "",
      level: "info",
      message: { id: "in_old", kind: "user", text: "what's on my list?" },
    },
  ],
};

let overview;
let calls = [];
let tasks = [task];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), "https://foundry.example");
  const method = (init.method ?? "GET").toUpperCase();
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method, path: url.pathname, search: url.search, body });
  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const route = `${method} ${url.pathname}`;
  switch (route) {
    case "GET /api/agent-profiles":
      return json(agentProfiles);
    case "GET /api/personal-agent":
      return json(overview);
    case "GET /api/personal-agent/knowledge/vaults":
      return json(knowledgeVaults);
    case "GET /api/personal-agent/knowledge/publications":
    case "GET /api/personal-agent/knowledge/migrations":
    case "GET /api/personal-agent/knowledge/replica-cleanup":
    case "GET /api/personal-agent/operations":
    case "GET /api/personal-agent/maintenance":
    case "GET /api/personal-agent/context-patches":
    case "GET /api/personal-agent/runs":
    case "GET /api/personal-agent/run-controls":
    case "GET /api/personal-agent/knowledge/mutations":
    case "GET /api/personal-agent/memory":
    case "GET /api/personal-agent/knowledge/vaults/vault_test/entries":
      return json([]);
    case "GET /api/personal-agent/inbox":
      return json([]);
    case "POST /api/personal-agent/inbox":
      return json(
        {
          id: "inbox_1",
          rootId: "inbox_1",
          messageId: body.messageId,
          text: body.text,
          channel: "web",
          status: "pending",
          revision: 1,
          inputId: "input_saved",
          createdAt: iso(0),
          updatedAt: iso(0),
        },
        202,
      );
    case "POST /api/personal-agent/knowledge/vaults":
      knowledgeVaults = [
        {
          id: "vault_test",
          kind: body.kind,
          deviceId: body.deviceId,
          workspaceId: body.workspaceId || "ws_memory",
          rootPath: body.rootPath,
          epoch: 1,
          revision: 1,
          state: "waiting",
          reason: "memory_device_offline",
          createdAt: iso(0),
          updatedAt: iso(0),
        },
      ];
      return json(knowledgeVaults[0], 202);
    case "POST /api/personal-agent":
      overview = { agent, homeDeviceOnline: true };
      return json(agent, 201);
    case "GET /api/personal-agent/proposals":
      return json([proposal]);
    case "GET /api/personal-agent/tasks":
      return json(tasks);
    case "GET /api/personal-agent/list":
      return json([]);
    case "POST /api/personal-agent/proposals/prop_1/accept":
      return json({ ...proposal, status: "accepted" });
    case "POST /api/personal-agent/stop":
      return json({
        agent: { ...agent, state: "stopped" },
        stopped: 1,
        reply: "New work paused; 1 execution stop requested.",
      });
    case "GET /api/agent-sessions":
      return url.searchParams.get("workspaceId") === "ws_old"
        ? json([{ ...formerSession, events: undefined }])
        : json([{ ...assistantSession, events: undefined }]);
    case "GET /api/agent-sessions/sess_old":
      return json(formerSession);
    case "GET /api/agent-sessions/sess_pa":
      return json(assistantSession);
    case "POST /api/agent-sessions/sess_pa/messages":
      return json({ ...assistantSession, status: "running" });
    case "POST /api/agent-sessions":
      return json({ ...assistantSession, id: "sess_new" }, 201);
    case "PUT /api/personal-agent/settings":
      return json({ ...agent, settings: body });
    case "POST /api/personal-agent/timezone":
      return json({
        ...overview.agent,
        settings: {
          ...overview.agent.settings,
          timezone: overview.agent.settings.timezone || body.timezone,
        },
      });
    case "POST /api/personal-agent/home":
      return body.deviceId === "dev_pc"
        ? json({ ...agent, homeDeviceId: "dev_pc" })
        : json({ error: "That computer is offline." }, 409);
    case "GET /api/external-accounts":
      return json({ providers: [], apps: [], accounts: [] });
    case "GET /api/personal-agent/actions":
      return json(actions);
  }
  throw new Error(`unexpected ${route}`);
};

let actions = [];
let knowledgeVaults = [];

const { createRoot } = await import("react-dom/client");
const { VirtuosoMockContext } = await import("react-virtuoso");
const { i18n } = await import("../src/i18n/index.ts");
await i18n.changeLanguage("en");
const { AssistantHome, AssistantSettings } =
  await import("../src/features/personal-agent/index.ts");
const model = await import("../src/features/personal-agent/assistant-model.ts");
const { ProposalCard } =
  await import("../src/features/personal-agent/proposal-card.tsx");
const { FeishuChatsPanel } =
  await import("../src/features/channels/feishu-chats-panel.tsx");

async function settle() {
  for (let index = 0; index < 4; index += 1)
    await act(async () => new Promise((done) => setTimeout(done, 0)));
}

async function render(component, props) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(
        VirtuosoMockContext.Provider,
        { value: { viewportHeight: 800, itemHeight: 100 } },
        createElement(component, props),
      ),
    ),
  );
  await settle();
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function button(container, text) {
  const found = [...container.querySelectorAll("button")].find(
    (node) => node.textContent.trim() === text,
  );
  assert.ok(found, `no button "${text}"`);
  return found;
}

async function type(container, text) {
  const textarea = container.querySelector("textarea");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    ).set;
    setter.call(textarea, text);
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
    textarea.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await act(async () => container.querySelector('[aria-label="Send"]').click());
  await settle();
}

test("the fixed words are handled before the model, whole message only", () => {
  assert.equal(model.channelCommand(" 停 "), "stop");
  assert.equal(model.channelCommand("STOP"), "stop");
  assert.equal(model.channelCommand("继续"), "resume");
  assert.equal(model.channelCommand("好的"), "accept");
  assert.equal(model.channelCommand("算了"), "decline");
  // The cards' button labels, and trailing punctuation as the server ignores it.
  assert.equal(model.channelCommand("不用了"), "decline");
  assert.equal(model.channelCommand("No thanks"), "decline");
  assert.equal(model.channelCommand("停！"), "stop");
  assert.equal(model.channelCommand("好的。"), "accept");
  assert.equal(model.channelCommand("stop the build"), undefined);
});

test("the fixed words act at once, never queued behind a reply", () => {
  const waiting = [
    { id: "p1", status: "pending", createdAt: "2026-10-15T00:00:00Z" },
  ];
  assert.equal(model.answeredWithoutModel("stop", false, []), true);
  assert.equal(model.answeredWithoutModel("停！", false, []), true);
  assert.equal(model.answeredWithoutModel("继续", true, []), true);
  // Not stopped: "continue" is an ordinary message for the assistant.
  assert.equal(model.answeredWithoutModel("继续", false, []), false);
  assert.equal(model.answeredWithoutModel("好的", false, waiting), true);
  assert.equal(model.answeredWithoutModel("好的", false, []), false);
  assert.equal(model.answeredWithoutModel("stop the build", false, []), false);
});

test("presets match §4 and loosening is detected per action", () => {
  assert.equal(model.matchingPreset(settings.policy), "default");
  const handsOff = model.presetPolicy("hands_off");
  assert.equal(handsOff.bind_connector, "ask");
  assert.equal(handsOff.archive_workspace, "auto");
  assert.equal(
    model.matchingPreset(model.presetPolicy("cautious")),
    "cautious",
  );
  assert.deepEqual(
    model.loosenedActions(settings.policy, {
      ...settings.policy,
      archive_workspace: "auto",
      rename_workspace: "ask",
    }),
    ["archive_workspace"],
  );
});

test("settings problems name the field and the cap", () => {
  assert.deepEqual(model.settingsProblems(settings), []);
  const problems = model.settingsProblems({
    ...settings,
    dailyDigestTime: "9",
    limits: { ...settings.limits, concurrentSessions: 9 },
  });
  assert.deepEqual(problems, [
    { kind: "time", field: "dailyDigestTime" },
    { kind: "limit", key: "concurrentSessions", min: 1, max: 8 },
  ]);
});

test("the conversation shows what was said, not the steps", () => {
  const lines = model.assistantLines([assistantSession]);
  assert.deepEqual(
    lines.map((line) => [line.role, line.text]),
    [
      ["person", "help me make a small web page to track family spending"],
      ["assistant", "Good idea — I've started building it in “Family budget”."],
    ],
  );
  const placed = model.placeProposals(lines, [proposal]);
  assert.ok("proposal" in placed[2]);
});

test("server notices are not shown as the person's words; a missed input still shows before its answer", () => {
  const session = {
    ...assistantSession,
    input: {
      id: "in_2",
      prompt: "what can you help with?",
      at: iso(-9 * minute),
    },
    events: [
      ...assistantSession.events,
      {
        id: "evt_notice",
        sessionId: "sess_pa",
        at: iso(-9.5 * minute),
        label: "User message",
        detail: "",
        level: "info",
        message: {
          id: "in_notice",
          kind: "user",
          text: '[Foundry] The person accepted and it is done.\n{"status": "applied"}',
        },
      },
      {
        id: "evt_sess_pa_in_2_response_stream",
        sessionId: "sess_pa",
        at: iso(-8 * minute),
        label: "Response stream",
        detail: "Anything you want done.",
        level: "info",
      },
    ],
  };
  assert.deepEqual(
    model.assistantLines([session]).map((line) => [line.role, line.text]),
    [
      ["person", "help me make a small web page to track family spending"],
      ["assistant", "Good idea — I've started building it in “Family budget”."],
      ["person", "what can you help with?"],
      ["assistant", "Anything you want done."],
    ],
  );
});

test("a quiet conversation starts a new session; the home computer picks the runtime", () => {
  assert.equal(model.continuedSession([assistantSession])?.id, "sess_pa");
  assert.equal(
    model.continuedSession([assistantSession], now + 3 * 60 * minute),
    undefined,
  );
  assert.deepEqual(model.assistantRuntime(agentProfiles, "dev_mac", settings), {
    provider: "claude",
    profileId: "prof_claude",
  });
  assert.equal(
    model.assistantRuntime(agentProfiles, "dev_other", settings),
    undefined,
  );
});

const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

test("an assistant without a time zone gets the browser's, once; a set one stays", async () => {
  overview = {
    agent: { ...agent, settings: { ...agent.settings, timezone: "" } },
    homeDeviceOnline: true,
  };
  calls = [];
  const page = await render(AssistantHome, {
    agentProfiles,
    devices,
    workspaces: [],
    onEvent: () => {},
  });
  const fills = () =>
    calls.filter((call) => call.path === "/api/personal-agent/timezone");
  assert.deepEqual(
    fills().map((call) => call.body),
    [{ timezone: browserZone }],
  );
  await page.unmount();

  overview = {
    agent: {
      ...agent,
      settings: { ...agent.settings, timezone: "Asia/Tokyo" },
    },
    homeDeviceOnline: true,
  };
  calls = [];
  const settingsPage = await render(AssistantSettings, {
    section: "style",
    onSectionChange: () => {},
    agentProfiles,
    devices,
    onEvent: () => {},
  });
  assert.equal(fills().length, 0, JSON.stringify(calls));
  assert.equal(
    settingsPage.container.querySelector("#fdy-pa-timezone").value,
    "Asia/Tokyo",
  );
  await settingsPage.unmount();
  overview = { agent, homeDeviceOnline: true };
});

test("first visit offers a one-tap setup on the suggested computer", async () => {
  overview = { homeDeviceOnline: false, suggestedHomeDeviceId: "dev_mac" };
  calls = [];
  const events = [];
  const page = await render(AssistantHome, {
    agentProfiles,
    devices,
    workspaces: [],
    onEvent: (event) => events.push(event),
  });
  assert.match(page.container.textContent, /Give your assistant a home/);
  await act(async () => button(page.container, "Set up on MacBook").click());
  await settle();
  const setup = calls.find((call) => call.method === "POST");
  assert.deepEqual(setup, {
    method: "POST",
    path: "/api/personal-agent",
    search: "",
    body: { deviceId: "dev_mac", timezone: browserZone },
  });
  assert.ok(page.container.querySelector(".fdy-pa-home-conversation"));
  await page.unmount();
});

test("first visit never picks a shared computer; the person may still choose it", async () => {
  overview = { homeDeviceOnline: false };
  calls = [];
  const shared = {
    ...devices[0],
    sharesSystemAccountWith: [
      { deviceId: "dev_ann", deviceLabel: "Ann's Mac", ownerName: "Ann" },
    ],
  };
  const page = await render(AssistantHome, {
    agentProfiles,
    devices: [shared],
    workspaces: [],
    onEvent: () => {},
  });
  assert.match(page.container.textContent, /so none is picked for you/);
  assert.equal(button(page.container, "Set up").disabled, true);
  assert.ok(page.container.querySelector('[aria-label="Computer"]'));
  assert.equal(
    calls.filter((call) => call.method === "POST").length,
    0,
    JSON.stringify(calls),
  );
  await page.unmount();
});

test("home: plain words, proposal cards, what it's doing, stop before the model", async () => {
  overview = { agent, homeDeviceOnline: true };
  calls = [];
  const events = [];
  const page = await render(AssistantHome, {
    agentProfiles,
    devices,
    workspaces: [{ id: "ws_budget", name: "Family budget" }],
    onEvent: (event) => events.push(event),
  });
  // The transcript itself is virtualized (not laid out here); its lines
  // and cards are the projection's, tested above and below.
  const text = page.container.textContent;
  assert.match(text, /Assistant/);
  assert.match(text, /Build the family budget page/);
  assert.match(text, /In “Family budget”/);
  assert.doesNotMatch(text, /\b(workspace|device|session)s?\b/i);
  // The person's list is read beside it: open items and what closed today.
  assert.match(text, /Your list/);
  const listRead = calls.find(
    (call) => call.path === "/api/personal-agent/list",
  );
  assert.ok(listRead, JSON.stringify(calls));
  assert.ok(
    Number.isFinite(
      Date.parse(new URLSearchParams(listRead.search).get("closedSince")),
    ),
  );
  // Reading the assistant never asks for, or changes, the shown project.
  assert.ok(
    calls.every(
      (call) =>
        call.path.startsWith("/api/personal-agent") ||
        call.search === "?workspaceId=ws_pa" ||
        call.path === "/api/agent-sessions/sess_pa",
    ),
    JSON.stringify(calls),
  );

  // A bare "ok" answers the waiting proposal, without the model.
  calls = [];
  await type(page.container, "ok");
  assert.deepEqual(
    calls.filter((call) => call.method === "POST").map((call) => call.path),
    ["/api/personal-agent/proposals/prop_1/accept"],
  );
  assert.match(events.at(-1).message, /You said yes: Put “Old blog” away\?/);

  calls = [];
  await type(page.container, "stop");
  assert.deepEqual(
    calls.filter((call) => call.method === "POST").map((call) => call.path),
    ["/api/personal-agent/stop"],
  );
  assert.deepEqual(events.at(-1), {
    type: "notice.requested",
    message: "New work paused; 1 execution stop requested.",
  });
  assert.match(page.container.textContent, /New work paused/);
  assert.match(page.container.textContent, /execution stop receipts/);
  assert.doesNotMatch(page.container.textContent, /Everything is stopped/);
  await page.unmount();
});

test("what it's doing shows work waiting for an offline computer as waiting", async () => {
  overview = { agent, homeDeviceOnline: true };
  tasks = [{ ...task, waitingFor: "Studio" }];
  const page = await render(AssistantHome, {
    agentProfiles,
    devices,
    workspaces: [{ id: "ws_budget", name: "Family budget" }],
    onEvent: () => {},
  });
  const text = page.container.textContent;
  assert.match(text, /Waiting for Studio to come online/);
  assert.doesNotMatch(text, /In progress/);
  tasks = [task];
  await page.unmount();
});

test("a message is durably received before runtime selection or continuation", async () => {
  overview = { agent, homeDeviceOnline: true };
  const page = await render(AssistantHome, {
    agentProfiles,
    devices,
    workspaces: [],
    onEvent: () => {},
  });
  calls = [];
  await type(page.container, "add an Excel export");
  const sent = calls.find((call) => call.method === "POST");
  assert.equal(sent.path, "/api/personal-agent/inbox");
  assert.equal(sent.body.text, "add an Excel export");
  assert.ok(sent.body.messageId);
  assert.equal(
    calls.some(
      (call) =>
        call.method === "POST" && call.path.startsWith("/api/agent-sessions"),
    ),
    false,
  );
  await page.unmount();
});

test("after a move the conversation keeps its history; new messages go to the new home", async () => {
  overview = {
    agent: { ...agent, formerWorkspaceIds: ["ws_old"] },
    homeDeviceOnline: true,
  };
  calls = [];
  const page = await render(AssistantHome, {
    agentProfiles,
    devices,
    workspaces: [],
    onEvent: () => {},
  });
  assert.ok(
    calls.some((call) => call.search === "?workspaceId=ws_old"),
    "the former project's sessions are read",
  );
  // The transcript is virtualized (not laid out here): both conversations
  // are read in full.
  assert.ok(calls.some((call) => call.path === "/api/agent-sessions/sess_old"));
  assert.ok(calls.some((call) => call.path === "/api/agent-sessions/sess_pa"));
  await type(page.container, "anything new?");
  const sent = calls.find((call) => call.method === "POST");
  assert.equal(sent.path, "/api/personal-agent/inbox");
  await page.unmount();
});

test("Channels: a direct chat the assistant takes is shown as the assistant's", async () => {
  const chat = {
    id: "route_1",
    appId: "xapp_1",
    workspaceId: "ws_project",
    kind: "p2p",
    chatId: "oc_123456",
    chatName: "Me and the bot",
    boundUserId: "usr_1",
    assistantWorkspaceId: "ws_pa",
    createdAt: iso(-60 * minute),
    updatedAt: iso(-60 * minute),
  };
  const bot = (workspaceId) => ({
    workspaceId,
    app: { id: "xapp_1", provider: "feishu", label: "Bot" },
    status: "connected",
    chats: [chat],
  });
  const base = {
    loading: false,
    pairing: false,
    onGenerateCode: async () => {},
    onUnbind: async () => {},
    onRefreshName: async () => {},
    currentUserId: "usr_1",
    workspaceNameOf: (id) =>
      id === "ws_project" ? "Family budget" : undefined,
  };
  const home = await render(FeishuChatsPanel, {
    ...base,
    bot: bot("ws_pa"),
    workspaceName: "Assistant",
  });
  assert.match(home.container.textContent, /Paired with “Family budget”/);
  assert.ok(
    ![...home.container.querySelectorAll("button")].some((node) =>
      /Unbind/.test(node.textContent),
    ),
    "managed where it was paired",
  );
  await home.unmount();
  const paired = await render(FeishuChatsPanel, {
    ...base,
    bot: bot("ws_project"),
    workspaceName: "Family budget",
  });
  assert.match(
    paired.container.textContent,
    /Your assistant answers this chat now/,
  );
  button(paired.container, "Assistant settings");
  button(paired.container, "Unbind");
  await paired.unmount();
});

test("settings: loosening the rules takes a second confirmation", async () => {
  overview = { agent, homeDeviceOnline: true, usage: undefined };
  calls = [];
  const page = await render(AssistantSettings, {
    section: "rules",
    onSectionChange: () => {},
    devices,
    agentProfiles,
    onEvent: () => {},
  });
  assert.match(page.container.textContent, /When to ask me/);
  await act(async () => button(page.container, "Hands off").click());
  await act(async () => button(page.container, "Save changes").click());
  assert.match(
    page.container.textContent,
    /This lets your assistant do more without asking/,
  );
  assert.ok(!calls.some((call) => call.method === "PUT"));
  await act(async () => button(page.container, "Yes, save").click());
  await settle();
  const put = calls.find((call) => call.method === "PUT");
  assert.equal(put.path, "/api/personal-agent/settings");
  assert.equal(put.body.policy.archive_workspace, "auto");
  assert.equal(put.body.policy.bind_connector, "ask");
  await page.unmount();
});

test("settings: the simple interface is saved with the settings and reaches the shell", async () => {
  overview = { agent, homeDeviceOnline: true };
  calls = [];
  const events = [];
  const page = await render(AssistantSettings, {
    section: "entry",
    onSectionChange: () => {},
    devices,
    agentProfiles,
    onEvent: (event) => events.push(event),
  });
  await act(async () => button(page.container, "Simple").click());
  await act(async () => button(page.container, "Save changes").click());
  await settle();
  const put = calls.find((call) => call.method === "PUT");
  assert.equal(put.body.simpleInterface, true);
  assert.deepEqual(
    events.find((event) => event.type === "interface.changed"),
    { type: "interface.changed", mode: "simple" },
  );
  await page.unmount();
});

test("settings: moving the assistant sends the chosen computer and reads it again", async () => {
  const twoComputers = [
    ...devices,
    { id: "dev_pc", label: "Desktop", status: "connected", owned: true },
    { id: "dev_old", label: "Old laptop", status: "offline", owned: true },
  ];
  overview = { agent, homeDeviceOnline: true };
  calls = [];
  const events = [];
  const page = await render(AssistantSettings, {
    section: "status",
    onSectionChange: () => {},
    devices: twoComputers,
    agentProfiles,
    onEvent: (event) => events.push(event),
  });
  await act(async () => button(page.container, "Move").click());
  await settle();
  const move = calls.find((call) => call.path === "/api/personal-agent/home");
  assert.equal(move.method, "POST");
  assert.deepEqual(move.body, { deviceId: "dev_pc" });
  assert.ok(
    calls.some(
      (call) => call.method === "GET" && call.path === "/api/personal-agent",
    ),
    "the overview is read again after moving",
  );
  assert.deepEqual(events.at(-1), {
    type: "notice.requested",
    message: "Your assistant now lives on Desktop.",
  });
  await page.unmount();
});

test("settings: the activity reads as people speak, never ids or the assistant's instructions", async () => {
  overview = { agent, homeDeviceOnline: true };
  actions = [
    {
      id: "paa_1",
      tool: "update_workspace",
      argsSummary: 'update ws_trip; name "Trip"',
      workspaceId: "ws_trip",
      decision: "ask",
      outcome: "proposed",
      createdAt: "2026-10-15T00:00:00Z",
    },
    {
      id: "paa_2",
      tool: "rename_workspace",
      argsSummary: "Shall I rename “Travel” to “Trip”?",
      workspaceId: "ws_trip",
      outcome: "applied",
      confirmedVia: "web",
      createdAt: "2026-10-15T00:01:00Z",
    },
    {
      id: "paa_3",
      tool: "create_workspace",
      argsSummary: 'create "Garden" (empty)',
      outcome: "refused",
      refusal: "limit",
      error: "limit reached: Tell them plainly you cannot do more now",
      createdAt: "2026-10-15T00:02:00Z",
    },
  ];
  const page = await render(AssistantSettings, {
    section: "activity",
    onSectionChange: () => {},
    devices,
    agentProfiles,
    workspaces: [{ id: "ws_trip", name: "Trip" }],
    onEvent: () => {},
  });
  await settle();
  const text = page.container.textContent;
  assert.match(text, /Trip/);
  assert.match(text, /Shall I rename “Travel” to “Trip”\?/);
  for (const internal of [
    "ws_trip",
    "update ws",
    "Tell them plainly",
    'create "Garden"',
  ])
    assert.ok(!text.includes(internal), `the activity shows ${internal}`);
  actions = [];
  await page.unmount();
});

test("a proposal card answers once, then shows what became of it", async () => {
  const answers = [];
  const page = await render(ProposalCard, {
    proposal,
    onAnswer: async (accept) => answers.push(accept),
  });
  assert.match(page.container.textContent, /Needs your OK/);
  assert.match(page.container.textContent, /Put “Old blog” away\?/);
  await act(async () => button(page.container, "No thanks").click());
  assert.deepEqual(answers, [false]);
  await page.unmount();

  const decided = await render(ProposalCard, {
    proposal: { ...proposal, status: "expired" },
    onAnswer: async () => {},
  });
  assert.match(decided.container.textContent, /Expired — nothing was changed/);
  assert.equal(decided.container.querySelectorAll("button").length, 0);
  await decided.unmount();
});

test("memory location is independent from the assistant home and survives an offline source", async () => {
  overview = { agent, homeDeviceOnline: true };
  calls = [];
  knowledgeVaults = [];
  const page = await render(AssistantSettings, {
    section: "memory",
    onSectionChange: () => {},
    devices: [
      {
        id: "dev_memory",
        label: "Memory desktop",
        status: "connected",
        owned: true,
      },
      ...devices,
    ],
    workspaces: [],
    agentProfiles,
    onEvent: () => {},
  });
  try {
    assert.match(
      page.container.textContent,
      /This can differ from the device that runs your assistant/,
    );
    await act(async () =>
      button(page.container, "Set memory location").click(),
    );
    await settle();
    const capture = calls.find(
      (call) =>
        call.method === "POST" &&
        call.path === "/api/personal-agent/knowledge/vaults",
    );
    assert.equal(capture.body.deviceId, "dev_memory");
    assert.equal(capture.body.createNew, true);
    assert.ok(
      !calls.some(
        (call) =>
          call.method === "POST" && call.path === "/api/personal-agent/home",
      ),
    );
    assert.match(page.container.textContent, /Memory desktop/);
    assert.match(page.container.textContent, /source computer is offline/);
  } finally {
    await page.unmount();
    knowledgeVaults = [];
  }
});

test("item plan preserves routing, dependencies and an unknown execution without claiming completion", async () => {
  const { PersonList } =
    await import("../src/features/personal-agent/person-list.tsx");
  const next = [];
  const item = {
    id: "item-plan",
    text: "Compare synthetic options",
    status: "open",
    createdAt: iso(-minute),
    updatedAt: iso(0),
    revision: 3,
    intentRevision: 2,
    remind: false,
    plan: {
      mode: "execute",
      progress: "waiting",
      workspaceId: "ws_trip",
      nextAction: "Review the existing comparison",
      waitingFor: "Owner receipt",
      route: {
        kind: "continue",
        reason: "The previous owner already has the sources",
        needsClarification: false,
      },
      dependencies: ["before"],
      workRefs: [
        {
          kind: "session",
          id: "sess_synthetic",
          workspaceId: "ws_trip",
          relation: "executing",
        },
      ],
    },
  };
  const page = await render(PersonList, {
    items: [
      item,
      {
        id: "before",
        text: "Agree on criteria",
        status: "open",
        remind: false,
        createdAt: iso(-minute),
        updatedAt: iso(0),
      },
    ],
    tasks: [],
    error: "",
    operations: [
      {
        id: "op-synthetic",
        itemId: item.id,
        status: "unknown",
        createdAt: iso(0),
        workspaceId: "ws_trip",
        sessionId: "sess_synthetic",
      },
    ],
    workspaces: [{ id: "ws_trip", name: "Comparison" }],
    onTick: async () => {},
    onEdit: async () => {},
    onDelete: async () => {},
    onContinue: async (row) => next.push(row.id),
  });
  assert.match(
    page.container.textContent,
    /previous owner already has the sources/,
  );
  assert.match(page.container.textContent, /Waiting on: Agree on criteria/);
  assert.match(page.container.textContent, /Outcome unknown/);
  assert.match(
    page.container.textContent,
    /Reconcile its existing conversation/,
  );
  assert.equal(
    page.container.querySelector('input[type="checkbox"]').checked,
    false,
  );
  await act(async () =>
    button(page.container, "Ask assistant to continue").click(),
  );
  assert.deepEqual(next, [item.id]);
  await page.unmount();
});

test("assistant conversation never attributes a helper handoff to the person", () => {
  const at = iso(0);
  const input = {
    id: "helper-input",
    prompt: "internal execution receipt",
    at,
    sentBySessionId: "helper",
  };
  for (const present of [false, true]) {
    const session = {
      ...assistantSession,
      input,
      events: present
        ? [
            {
              id: "helper-event",
              sessionId: assistantSession.id,
              at,
              label: "User message",
              detail: input.prompt,
              metadata: { sentBySessionId: "helper" },
              message: { id: input.id, kind: "user", text: input.prompt, at },
            },
          ]
        : [],
    };
    assert.equal(
      model
        .assistantLines([session])
        .some((line) => line.role === "person" && line.text === input.prompt),
      false,
    );
  }
});

test("a completed item keeps evidence in compact details and does not ask for verification again", async () => {
  const { ItemPlan } =
    await import("../src/features/personal-agent/person-list-plan.tsx");
  const item = {
    id: "done-item",
    status: "done",
    plan: {
      mode: "execute",
      progress: "review",
      evidence: [
        {
          kind: "file",
          ref: "result.md",
          summary: "verified synthetic result",
        },
      ],
    },
  };
  const page = await render(ItemPlan, {
    item,
    items: [item],
    workspaces: [],
    operations: [
      {
        id: "done-op",
        itemId: item.id,
        status: "review",
        reason: "execution_completed_requires_evidence",
        createdAt: iso(0),
      },
    ],
  });
  const details = page.container.querySelector("details");
  assert.equal(details.open, false);
  assert.match(page.container.textContent, /Completed/);
  assert.match(page.container.textContent, /Result available/);
  assert.doesNotMatch(
    page.container.textContent,
    /still needs verification|Review result/,
  );
  assert.match(details.textContent, /verified synthetic result/);
  await page.unmount();
});

test("target-default runtime keeps model and effort selectable without pinning the execution device", async () => {
  const { ModelsSection } =
    await import("../src/features/personal-agent/settings-models.tsx");
  const draft = {
    ...settings,
    runDefault: {
      profileId: "device_default",
      runtime: "codex",
      model: "synthetic-model",
      effort: "high",
    },
    roleOverrides: {},
  };
  const home = {
    id: "synthetic-device",
    label: "Synthetic desktop",
    status: "connected",
  };
  const page = await render(ModelsSection, {
    draft,
    change: () => {},
    home,
    devices: [home],
    workspaces: [],
    agentProfiles: [
      {
        id: "codex_local",
        deviceId: home.id,
        runtime: "codex",
        label: "Synthetic Codex",
        status: "healthy",
        models: ["synthetic-model"],
        configScope: "device",
        connectionType: "local_login",
      },
    ],
  });
  const buttons = [...page.container.querySelectorAll("button")];
  for (const name of [
    "Shared default Model",
    "Shared default Reasoning effort",
  ]) {
    const choice = buttons.find((b) =>
      b.getAttribute("aria-label")?.startsWith(name),
    );
    assert.ok(choice, name);
    assert.equal(choice.disabled, false, name);
  }
  assert.match(
    page.container.textContent,
    /Each target checks its own support/,
  );
  assert.equal(draft.runDefault.deviceId, undefined);
  await page.unmount();
});

test("checking an item complete does not present its unsettled execution as stopped", async () => {
  const { ItemPlan } =
    await import("../src/features/personal-agent/person-list-plan.tsx");
  const item = {
    id: "manual-done",
    status: "done",
    plan: { mode: "execute", progress: "working" },
  };
  const page = await render(ItemPlan, {
    item,
    items: [item],
    workspaces: [],
    operations: [
      {
        id: "running-op",
        itemId: item.id,
        status: "delivered",
        createdAt: iso(0),
      },
    ],
  });
  assert.match(
    page.container.querySelector('[role="status"]').textContent,
    /may still be running/,
  );
  await page.unmount();
});

test("role settings load the person's account catalog independently of the active workspace", async () => {
  overview = {
    agent: {
      ...agent,
      settings: {
        ...settings,
        runDefault: {
          profileId: "prof_claude",
          deviceId: "dev_mac",
          runtime: "claude",
        },
      },
    },
    homeDeviceOnline: true,
  };
  calls = [];
  const page = await render(AssistantSettings, {
    section: "models",
    onSectionChange: () => {},
    devices,
    agentProfiles: [],
    workspaces: [],
    onEvent: () => {},
  });
  assert.ok(calls.some((c) => c.path === "/api/agent-profiles"));
  assert.match(page.container.textContent, /Claude login/);
  assert.doesNotMatch(page.container.textContent, /Unavailable: prof_claude/);
  await page.unmount();
  overview = { agent, homeDeviceOnline: true };
});

test("completion evidence opens its owner workspace instead of the workspace currently in the sidebar", async () => {
  const { ItemPlan } =
    await import("../src/features/personal-agent/person-list-plan.tsx");
  const oldURL = window.location.href;
  const item = {
    id: "cross-domain-evidence",
    status: "done",
    plan: {
      workspaceId: "ws_domain",
      workRefs: [
        {
          kind: "session",
          id: "sess_owner",
          workspaceId: "ws_owner",
          relation: "executing",
        },
      ],
      evidence: [
        {
          kind: "session",
          ref: "sess_owner#completed-input",
          summary: "verified result",
        },
      ],
    },
  };
  const page = await render(ItemPlan, {
    item,
    items: [item],
    operations: [],
    workspaces: [],
  });
  await act(async () => button(page.container, "Open evidence").click());
  assert.equal(window.location.pathname, "/chats/sess_owner");
  assert.equal(
    new URL(window.location.href).searchParams.get("workspace"),
    "ws_owner",
  );
  await page.unmount();
  window.history.replaceState(null, "", oldURL);
});
