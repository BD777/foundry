import assert from "node:assert/strict";
import { register } from "node:module";
import test, { afterEach, beforeEach } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);

// Synthetic fixtures only: fetch is replaced, no assistant or server is reached.
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
const { i18n } = await import("../src/i18n/index.ts");
await i18n.changeLanguage("en");
const { StopAssistantButton } =
  await import("../src/features/personal-agent/stop-assistant-button.tsx");
const { StatusSection } =
  await import("../src/features/personal-agent/settings-status.tsx");
const { stopPersonalAgent } = await import("../src/api/personal-agent.ts");

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const click = (element) =>
  act(async () => {
    element.click();
  });
const buttonNamed = (name, scope = window.document) =>
  [...scope.querySelectorAll("button")].find(
    (button) => button.textContent.trim() === name,
  );
const dialog = () => window.document.querySelector('[role="dialog"]');

let container;
let root;

beforeEach(() => {
  container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.document.body.innerHTML = "";
});

async function render(element) {
  await act(async () => root.render(element));
}

test("stop opens a confirmation, and cancel leaves the assistant running", async () => {
  const stops = [];
  await render(
    createElement(StopAssistantButton, {
      busy: false,
      helperCount: 2,
      onStop: () => stops.push("stop"),
    }),
  );
  await click(buttonNamed("Stop assistant work"));
  assert.ok(dialog(), "stop opens the dialog");
  assert.match(dialog().textContent, /cancels the 2 helpers/);
  assert.deepEqual(stops, [], "opening the dialog stops nothing");
  await click(buttonNamed("Cancel", dialog()));
  assert.equal(dialog(), null);
  assert.deepEqual(stops, [], "cancel stops nothing");
});

test("confirming calls the stop API exactly once and says how to resume", async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    requests.push(`${init.method ?? "GET"} ${String(input)}`);
    return new Response(
      JSON.stringify({
        reply: "Stopped.",
        agent: { id: "pa_1", state: "stopped" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    await render(
      createElement(StopAssistantButton, {
        busy: false,
        onStop: () => void stopPersonalAgent("pa_1"),
      }),
    );
    await click(buttonNamed("Stop assistant work"));
    assert.match(dialog().textContent, /Resume at any time/);
    await click(buttonNamed("Stop", dialog()));
    await flush();
    assert.equal(dialog(), null);
    const stopCalls = requests.filter((request) => request.endsWith("/stop"));
    assert.equal(stopCalls.length, 1, `stop API calls: ${requests.join(", ")}`);
    assert.match(stopCalls[0], /^POST /);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("settings status asks before stopping, with the helpers it is running", async () => {
  const notices = [];
  let stopCount = 0;
  const assistant = {
    tasks: [
      { id: "t1", status: "running", updatedAt: "2026-11-18T01:00:00Z" },
      { id: "t2", status: "queued", updatedAt: "2026-11-18T01:01:00Z" },
      { id: "t3", status: "done", updatedAt: "2026-11-18T01:02:00Z" },
    ],
    stopAll: async () => {
      stopCount += 1;
      return "Stopped.";
    },
  };
  await render(
    createElement(StatusSection, {
      agent: {
        id: "pa_1",
        state: "running",
        homeDeviceId: "dev_1",
        settings: {},
      },
      assistant,
      owned: [],
      onNotice: (message) => notices.push(message),
    }),
  );
  await click(buttonNamed("Stop assistant work", container));
  assert.match(dialog().textContent, /cancels the 2 helpers/);
  await click(buttonNamed("Cancel", dialog()));
  assert.equal(stopCount, 0, "cancel does not stop");
  await click(buttonNamed("Stop assistant work", container));
  await click(buttonNamed("Stop", dialog()));
  await flush();
  assert.equal(stopCount, 1, "confirm stops once");
  assert.deepEqual(notices, ["Stopped."]);
});

test("without running helpers the dialog does not name a count", async () => {
  await render(
    createElement(StopAssistantButton, { busy: false, onStop: () => {} }),
  );
  await click(buttonNamed("Stop assistant work"));
  assert.doesNotMatch(dialog().textContent, /\d+ helpers?/);
  assert.match(dialog().textContent, /cancels the helpers it is running/);
});
