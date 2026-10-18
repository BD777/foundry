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
    case "GET /api/personal-agent":
      return json(overview);
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
        reply: "Stopped everything, 1 thing in progress.",
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
    message: "Stopped everything, 1 thing in progress.",
  });
  assert.match(page.container.textContent, /Everything is stopped/);
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

test("a message continues the latest conversation on the assistant's runtime", async () => {
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
  assert.equal(sent.path, "/api/agent-sessions/sess_pa/messages");
  assert.equal(sent.body.prompt, "add an Excel export");
  assert.ok(sent.body.inputId);
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
  assert.equal(sent.path, "/api/agent-sessions/sess_pa/messages");
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
