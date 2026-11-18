import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({
  url: "https://foundry.example/assistant/settings/entry",
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
  "HTMLFormElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLDivElement",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
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

const openLarkInstance = {
  id: "app_openlark_1",
  label: "OpenLark",
  kind: "open-lark",
};
const readyInstance = () => ({
  connectorInstanceId: openLarkInstance.id,
  label: openLarkInstance.label,
});
let notifyInstances = [readyInstance()];
let notifyListStatus = 200;

let testResponse = {
  status: "failed",
  reason: "the connector does not take notices",
};
const calls = [];

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), "https://foundry.example");
  const method = (init.method ?? "GET").toUpperCase();
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method, path: url.pathname, body });
  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  if (
    method === "GET" &&
    url.pathname === "/api/personal-agent/notify/instances"
  ) {
    if (notifyListStatus !== 200)
      return json(
        { error: "the connectors could not be listed" },
        notifyListStatus,
      );
    return json({ instances: notifyInstances });
  }
  if (method === "POST" && url.pathname === "/api/personal-agent/notify/test")
    return json(testResponse);
  if (method === "POST" && url.pathname === "/api/personal-agent/notify/chat")
    return json({
      connectorInstanceId: body.connectorInstanceId,
      reason: "self_chat_not_found",
    });
  throw new Error(`unexpected ${method} ${url.pathname}`);
};

const { createRoot } = await import("react-dom/client");
const { i18n } = await import("../src/i18n/index.ts");
await i18n.changeLanguage("en");
const { NotifySection } =
  await import("../src/features/personal-agent/settings-notify.tsx");
const { findPersonalAgentNotifyChat } =
  await import("../src/api/personal-agent.ts");

async function settle() {
  for (let index = 0; index < 4; index += 1)
    await act(async () => new Promise((done) => setTimeout(done, 0)));
}

async function render(draft, change = () => {}) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(createElement(NotifySection, { draft, change })),
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

function buttonNamed(container, text) {
  const found = [...container.querySelectorAll("button")].find(
    (button) => button.textContent.trim() === text,
  );
  assert.ok(found, `no button "${text}"`);
  return found;
}

function kindCheckbox(container, label) {
  const found = [...container.querySelectorAll("label")].find((node) =>
    node.textContent.includes(label),
  );
  const input = found?.querySelector("input[type=checkbox]");
  assert.ok(input, `no ${label} checkbox`);
  return input;
}

const savedDraft = {
  notify: {
    sinks: [
      {
        connectorInstanceId: openLarkInstance.id,
        kinds: ["question", "approval", "hand_over", "ask"],
      },
    ],
  },
};

test("the notice setting renders the saved connector and its four kinds", async () => {
  const page = await render(savedDraft);
  try {
    assert.match(page.container.textContent, /Notices to you/);
    assert.match(page.container.textContent, /Kinds to notify/);
    for (const label of ["Questions", "Approvals", "Hand-overs", "Requests"])
      assert.match(page.container.textContent, new RegExp(label));
    assert.match(page.container.textContent, /Send a test notice/);
  } finally {
    await page.unmount();
  }
});

test("the test notice reports a failed send with its reason", async () => {
  testResponse = {
    status: "failed",
    reason: "the connector does not take notices",
  };
  calls.length = 0;
  const page = await render(savedDraft);
  try {
    await act(async () =>
      buttonNamed(page.container, "Send a test notice").click(),
    );
    await settle();
    const sent = calls.find(
      (call) => call.path === "/api/personal-agent/notify/test",
    );
    assert.deepEqual(sent?.body, { connectorInstanceId: openLarkInstance.id });
    assert.match(
      page.container.textContent,
      /The test notice failed: the connector does not take notices/,
    );
  } finally {
    await page.unmount();
  }
});

test("the test notice reports a sent message", async () => {
  testResponse = { status: "sent", messageId: "om_test" };
  const page = await render(savedDraft);
  try {
    await act(async () =>
      buttonNamed(page.container, "Send a test notice").click(),
    );
    await settle();
    assert.match(page.container.textContent, /The test notice was sent/);
  } finally {
    await page.unmount();
  }
});

test("unticking a kind saves the rest, and the last kind cannot be removed", async () => {
  const changes = [];
  const draft = {
    notify: {
      sinks: [
        { connectorInstanceId: openLarkInstance.id, kinds: ["question"] },
      ],
    },
  };
  const page = await render(draft, (patch) => changes.push(patch));
  try {
    const approvals = kindCheckbox(page.container, "Approvals");
    await act(async () => approvals.click());
    assert.deepEqual(changes.at(-1), {
      notify: {
        sinks: [
          {
            connectorInstanceId: openLarkInstance.id,
            kinds: ["question", "approval"],
          },
        ],
      },
    });
    const question = kindCheckbox(page.container, "Questions");
    await act(async () => question.click());
    assert.equal(changes.length, 1, "removing the last kind must not save");
  } finally {
    await page.unmount();
  }
});

test("discovery failure is a reason the setting can show, with a chat id fallback", async () => {
  const result = await findPersonalAgentNotifyChat(undefined, {
    connectorInstanceId: openLarkInstance.id,
  });
  assert.equal(result.reason, "self_chat_not_found");
  assert.equal(result.chat, undefined);
  assert.equal(calls.at(-1).path, "/api/personal-agent/notify/chat");
});

test("an instance that can carry notices is listed and shown as the saved connector", async () => {
  calls.length = 0;
  const page = await render(savedDraft);
  try {
    assert.match(page.container.textContent, /OpenLark/);
    assert.doesNotMatch(
      page.container.textContent,
      /No connector takes notices yet/,
    );
    assert.ok(
      calls.some(
        (call) =>
          call.method === "GET" &&
          call.path === "/api/personal-agent/notify/instances",
      ),
      "the list comes from the notify instances route",
    );
    assert.equal(
      calls.some((call) => call.path === "/api/external-accounts"),
      false,
      "the apps list leaves extension instances out, so the kinds are not read from it",
    );
  } finally {
    await page.unmount();
  }
});

test("an instance that cannot carry notices is listed with its reason and what Foundry does", async () => {
  notifyInstances = [
    {
      connectorInstanceId: "app_openlark_2",
      label: "byte-dev OpenLark",
      reason: "waiting_device",
    },
  ];
  try {
    const page = await render({});
    try {
      assert.match(
        page.container.textContent,
        /byte-dev OpenLark cannot take notices yet\. No online device reaches it\./,
      );
      assert.match(page.container.textContent, /retried automatically/);
      assert.doesNotMatch(
        page.container.textContent,
        /No connector takes notices yet/,
      );
    } finally {
      await page.unmount();
    }
  } finally {
    notifyInstances = [readyInstance()];
  }
});

test("an installed extension that predates notices says the update picks it up", async () => {
  notifyInstances = [
    {
      connectorInstanceId: "app_openlark_3",
      label: "OpenLark",
      reason: "connector_not_notifiable",
    },
  ];
  try {
    const page = await render({});
    try {
      assert.match(
        page.container.textContent,
        /OpenLark cannot take notices yet\. Its installed extension does not take notices yet\./,
      );
    } finally {
      await page.unmount();
    }
  } finally {
    notifyInstances = [readyInstance()];
  }
});

test("with no extension instance the setting asks for a connector", async () => {
  notifyInstances = [];
  try {
    const page = await render({});
    try {
      assert.match(
        page.container.textContent,
        /No connector takes notices yet/,
      );
    } finally {
      await page.unmount();
    }
  } finally {
    notifyInstances = [readyInstance()];
  }
});

test("a failed connector list is reported, not shown as no connector", async () => {
  notifyListStatus = 500;
  try {
    const page = await render({});
    try {
      assert.match(
        page.container.textContent,
        /The connectors could not be listed/,
      );
      assert.doesNotMatch(
        page.container.textContent,
        /No connector takes notices yet/,
      );
    } finally {
      await page.unmount();
    }
  } finally {
    notifyListStatus = 200;
  }
});

test("the Foundry bot is listed first as recommended and needs no self chat", async () => {
  const bot = {
    connectorInstanceId: "builtin:feishu",
    label: "Foundry 飞书机器人",
    reason: "",
    recommended: true,
  };
  notifyInstances = [bot, readyInstance()];
  calls.length = 0;
  const page = await render({
    notify: {
      sinks: [
        {
          connectorInstanceId: bot.connectorInstanceId,
          kinds: ["question", "ask"],
        },
      ],
    },
  });
  try {
    assert.match(page.container.textContent, /Foundry 飞书机器人/);
    assert.match(page.container.textContent, /推荐|recommended/);
    assert.equal(
      calls.some((call) => call.path === "/api/personal-agent/notify/chat"),
      false,
      "the bot is not asked for a self chat",
    );
  } finally {
    await page.unmount();
    notifyInstances = [readyInstance()];
  }
});
