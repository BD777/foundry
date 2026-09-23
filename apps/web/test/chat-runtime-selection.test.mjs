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
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: key === "window" ? window : window[key],
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { useChatRuntime } =
  await import("../src/features/chat/use-chat-runtime.ts");
const agent = (id, deviceId = "a") => ({
  id,
  deviceId,
  provider: "codex",
  status: "healthy",
  profileId: "codex_local",
  connectionType: "local_login",
});
async function mount(input = {}) {
  const container = document.createElement("div");
  const root = createRoot(container);
  let value;
  let props = {
    active: false,
    agents: [agent("one"), agent("two")],
    profiles: [],
    workspaceId: "w1",
    selectedChatId: "",
    onNotice: () => {},
    ...input,
  };
  function Harness() {
    value = useChatRuntime(props);
    return null;
  }
  const render = async (patch = {}) => {
    props = { ...props, ...patch };
    await act(async () => root.render(createElement(Harness)));
  };
  await render();
  return {
    get value() {
      return value;
    },
    render,
    close: async () => act(async () => root.unmount()),
  };
}

test("a selected agent disappearing cannot silently substitute another device/account", async () => {
  const view = await mount();
  try {
    await act(async () => view.value.selectAgent("two"));
    assert.equal(view.value.selectedAgent.id, "two");
    await view.render({ agents: [agent("one")] });
    assert.equal(view.value.selectedAgent, undefined);
    await act(async () => view.value.selectAgent("one"));
    assert.equal(view.value.selectedAgent.id, "one");
  } finally {
    await view.close();
  }
});

test("explicit workspace switch resets account selection into the new workspace", async () => {
  const view = await mount();
  try {
    await view.render({ workspaceId: "w2", agents: [agent("different", "b")] });
    assert.equal(view.value.selectedAgent.id, "different");
    assert.match(view.value.agentOptions[0].label, /Device account/);
  } finally {
    await view.close();
  }
});

test("history with a missing profile is blocked until an explicit account selection", async () => {
  const view = await mount({
    active: true,
    selectedChatId: "history",
    selectedChat: {
      id: "history",
      title: "Historical chat",
      profileId: "removed-profile",
      provider: "claude",
    },
  });
  try {
    assert.equal(view.value.selectedAgent, undefined);
    await act(async () => view.value.selectAgent("one"));
    assert.equal(view.value.selectedAgent.id, "one");
  } finally {
    await view.close();
  }
});

test("a failed directory refresh keeps configured models and can retry", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('{"error":"offline"}', { status: 503 });
  };
  const view = await mount({
    active: true,
    agents: [
      {
        id: "srv",
        deviceId: "a",
        provider: "claude",
        profileId: "prof_s",
        profileLabel: "team-relay",
        connectionType: "anthropic_compatible",
        status: "healthy",
      },
    ],
    profiles: [
      {
        id: "prof_s",
        deviceId: "a",
        runtime: "claude",
        connectionType: "anthropic_compatible",
        configScope: "workspace",
        origin: "server",
        label: "team-relay",
        baseUrl: "https://relay.example",
        models: ["configured-model-x"],
      },
    ],
  });
  try {
    assert.equal(calls, 1);
    assert.equal(view.value.modelLoadFailed, true);
    assert.deepEqual(
      view.value.modelOptions.map((option) => option.id),
      ["configured-model-x"],
    );
    await act(async () => view.value.retryModels());
    assert.equal(calls, 2);
    assert.deepEqual(
      view.value.modelOptions.map((option) => option.id),
      ["configured-model-x"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    await view.close();
  }
});

test("a promoted pair is one row: server for a new chat, legacy for its history", async () => {
  const device = agent("device-agent");
  Object.assign(device, {
    provider: "claude",
    profileId: "claude_local",
    profileLabel: "team-relay",
    connectionType: "env",
  });
  const server = agent("server-agent");
  Object.assign(server, {
    provider: "claude",
    profileId: "prof_server",
    profileLabel: "team-relay",
    connectionType: "anthropic_compatible",
  });
  const profileRows = [
    {
      id: "claude_local",
      deviceId: "a",
      runtime: "claude",
      origin: "device",
      promotedProfileId: "prof_server",
    },
    {
      id: "prof_server",
      deviceId: "a",
      runtime: "claude",
      origin: "server",
    },
  ];
  const fresh = await mount({
    active: true,
    agents: [device, server],
    profiles: profileRows,
  });
  try {
    // New chat auto-selects the server definition; only it is offered.
    assert.equal(fresh.value.selectedAgent.id, "server-agent");
    assert.deepEqual(
      fresh.value.agentOptions.map((option) => option.value),
      ["server-agent"],
    );
  } finally {
    await fresh.close();
  }
  const history = await mount({
    active: true,
    selectedChatId: "legacy-chat",
    selectedChat: {
      id: "legacy-chat",
      title: "Legacy",
      profileId: "claude_local",
      provider: "claude",
    },
    agents: [device, server],
    profiles: profileRows,
  });
  try {
    assert.equal(history.value.selectedAgent.id, "device-agent");
    // The pair is still a single row, now represented by the legacy value,
    // with no source subline: execution identity is preserved but hidden.
    assert.deepEqual(
      history.value.agentOptions.map((option) => option.value),
      ["device-agent"],
    );
    assert.equal(history.value.agentOptions[0].meta, undefined);
    // Selecting another agent, then back, explicitly chooses the server rep.
    await act(async () => history.value.selectAgent("server-agent"));
    assert.equal(history.value.selectedAgent.id, "server-agent");
    assert.deepEqual(
      history.value.agentOptions.map((option) => option.value),
      ["server-agent"],
    );
  } finally {
    await history.close();
  }
});

test("failed native model discovery stops instead of an automatic retry loop", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('{"error":"offline"}', { status: 503 });
  };
  const view = await mount({
    active: true,
    profiles: [
      {
        id: "codex_local",
        deviceId: "a",
        runtime: "codex",
        connectionType: "local_login",
      },
    ],
  });
  try {
    assert.equal(calls, 1);
    assert.equal(view.value.modelLoadFailed, true);
    await view.render();
    assert.equal(calls, 1);
    await view.render({
      workspaceId: "w2",
      agents: [agent("different", "b")],
      profiles: [
        {
          id: "codex_local",
          deviceId: "b",
          runtime: "codex",
          connectionType: "local_login",
        },
      ],
    });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await view.close();
  }
});

test("a promoted legacy chat loads the SERVER definition's catalog, not the dead device config", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  // The promoted-away device config answers 401 (its credential moved to the
  // sealed server profile); the server definition answers 200.
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body.profile.id);
    if (body.profile.id === "claude_local") {
      return new Response(JSON.stringify({ error: "relay answered 401" }), {
        status: 500,
      });
    }
    return new Response(JSON.stringify([{ id: "discovered-a" }]), {
      status: 200,
    });
  };
  const view = await mount({
    active: true,
    selectedChatId: "legacy-chat",
    selectedChat: {
      id: "legacy-chat",
      title: "Legacy",
      profileId: "claude_local",
      provider: "claude",
    },
    agents: [
      {
        id: "agent_device",
        deviceId: "a",
        provider: "claude",
        profileId: "claude_local",
        profileLabel: "team-relay",
        connectionType: "env",
        status: "healthy",
      },
      {
        id: "agent_server",
        deviceId: "a",
        provider: "claude",
        profileId: "prof_server",
        profileLabel: "team-relay",
        connectionType: "anthropic_compatible",
        status: "healthy",
      },
    ],
    profiles: [
      {
        id: "claude_local",
        deviceId: "a",
        runtime: "claude",
        origin: "device",
        connectionType: "anthropic_compatible",
        configScope: "device",
        baseUrl: "https://relay.example",
        label: "team-relay",
        model: "stale-local-model",
        models: [],
        promotedProfileId: "prof_server",
      },
      {
        id: "prof_server",
        deviceId: "a",
        runtime: "claude",
        origin: "server",
        connectionType: "anthropic_compatible",
        configScope: "workspace",
        baseUrl: "https://relay.example",
        label: "team-relay",
        model: "server-model",
        models: ["server-model"],
      },
    ],
  });
  try {
    // The discovery request must target the linked server profile...
    assert.deepEqual(requests, ["prof_server"]);
    // ...the configured server model is offered and no failure is shown.
    assert.deepEqual(
      view.value.modelOptions.map((option) => option.id),
      ["server-model", "discovered-a"],
    );
    assert.equal(view.value.modelLoadFailed, false);
    assert.equal(view.value.modelValue, "server-model");
  } finally {
    globalThis.fetch = originalFetch;
    await view.close();
  }
});
