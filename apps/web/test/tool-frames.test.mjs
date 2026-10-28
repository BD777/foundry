import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { register } from "node:module";
register("./bundler-resolve.mjs", import.meta.url);

const { chatMessagesForThread } =
  await import("../src/features/chat/chat-model.ts");
const { latestScreen } =
  await import("../src/features/chat/chat-context-model.ts");

const at = (second) => `2026-10-29T10:00:${String(second).padStart(2, "0")}Z`;
const frame = (id, callId, second) => ({
  id,
  callId,
  tool: "mcp__playwright__browser_take_screenshot",
  source: "playwright-mcp",
  path: `/w/.foundry/attachments/frames/s/${id}.png`,
  mimeType: "image/png",
  bytes: 1000,
  width: 1280,
  height: 720,
  capturedAt: at(second),
});
const toolEvent = (callId, status, second) => ({
  id: `e-${callId}-${status}`,
  label: status === "running" ? "Using tool" : "Used tool",
  detail: "browser_take_screenshot",
  level: "info",
  at: at(second),
  message: {
    id: callId,
    kind: "tool",
    callId,
    status,
    title: status === "running" ? "Using tool" : "Used tool",
    text: "browser_take_screenshot",
  },
});
const frameEvent = (value, second) => ({
  id: `e-${value.id}`,
  label: "Tool frame",
  detail: "",
  level: "info",
  at: at(second),
  metadata: { toolFrame: value },
});

const session = {
  id: "s",
  workspaceId: "w",
  prompt: "Open the page",
  status: "completed",
  events: [
    toolEvent("c1", "running", 1),
    toolEvent("c1", "completed", 2),
    frameEvent(frame("f1", "c1", 2), 2),
    toolEvent("c2", "running", 3),
    toolEvent("c2", "completed", 4),
    frameEvent(frame("f2", "c2", 4), 4),
    frameEvent(frame("f3", "c2", 4), 4),
    {
      id: "answer",
      label: "Response stream",
      detail: "Done",
      level: "info",
      at: at(5),
      message: { id: "a", kind: "assistant", text: "Done" },
    },
  ],
};

test("a tool frame joins its tool's step and is never a step of its own", () => {
  const messages = chatMessagesForThread({ id: "t", sessions: [session] });
  const process = messages.find((message) => message.kind === "process");
  assert.ok(process, "the tool steps form a process group");
  assert.equal(
    messages.some((message) => /Tool frame/.test(message.title ?? "")),
    false,
  );
  const withFrames = process.processItems.filter((item) => item.frames);
  assert.deepEqual(
    withFrames.map((item) => item.frames.map((value) => value.id)),
    [["f1"], ["f2", "f3"]],
  );
  // Frames are read through their session.
  assert.equal(withFrames[0].frames[0].sessionId, "s");
});

test("the side panel's screen names the newest frame of the newest session", () => {
  const screen = latestScreen([
    session,
    { id: "s2", workspaceId: "w", events: [] },
  ]);
  assert.equal(screen.kind, "screen");
  assert.equal(screen.sessionId, "s");
  assert.equal(screen.latest.id, "f3");
  assert.equal(latestScreen([{ id: "x", events: [] }]), undefined);
});

async function mountScreen(list, item, language = "en") {
  const window = new Window({ url: "https://foundry.test/" });
  const requests = [];
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    fetch: (url) => {
      requests.push(String(url));
      if (String(url).endsWith("/frames"))
        return Promise.resolve(
          new Response(JSON.stringify(list), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      return Promise.resolve(new Response("", { status: 404 }));
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map();
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const { ScreenDetail } =
    await import("../src/features/chat/chat-detail-screen.tsx");
  const { i18n } = await import("../src/i18n/index.ts");
  await i18n.changeLanguage(language);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(ScreenDetail, { item }));
  });
  for (let index = 0; index < 5; index += 1)
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  return {
    container,
    requests,
    async cleanup() {
      await act(async () => root.unmount());
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

test("the screen follows the newest frame, moves by keyboard and says what was dropped", async () => {
  const frames = ["f1", "f2", "f3"].map((id, index) =>
    frame(id, `c${index}`, index),
  );
  const item = {
    id: "screen:s",
    kind: "screen",
    label: "Playwright MCP",
    sessionId: "s",
    latest: { ...frames[2], sessionId: "s" },
  };
  const view = await mountScreen(
    {
      frames,
      dropped: 3,
      limits: { count: 200, bytes: 50 * 1024 * 1024 },
    },
    item,
  );
  try {
    const { container } = view;
    const position = () =>
      container.querySelector(".fdy-chat-screen-position").textContent;
    assert.match(position(), /^3 of 3/);
    assert.match(container.textContent, /Showing the latest/);
    assert.match(container.textContent, /3 older screenshots were removed/);
    const thumbs = () => [
      ...container.querySelectorAll(".fdy-chat-screen-strip .fdy-frame-thumb"),
    ];
    assert.equal(thumbs().length, 3);
    // Only the frame shown is in the tab order; it is marked pressed.
    assert.deepEqual(
      thumbs().map((thumb) => thumb.getAttribute("tabindex")),
      ["-1", "-1", "0"],
    );
    assert.equal(thumbs()[2].getAttribute("aria-pressed"), "true");
    const strip = container.querySelector(".fdy-chat-screen-strip");
    const key = async (name) =>
      act(async () => {
        strip.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: name, bubbles: true }),
        );
      });
    await key("Home");
    assert.match(position(), /^1 of 3/);
    assert.match(container.textContent, /Back to latest/);
    await key("ArrowRight");
    assert.match(position(), /^2 of 3/);
    await key("End");
    assert.match(position(), /^3 of 3/);
    // Images are read through the session's frame route, never by path.
    assert.ok(
      view.requests.some((url) =>
        url.includes("/api/agent-sessions/s/frames/f3/image"),
      ),
    );
    assert.equal(
      view.requests.some((url) => url.includes("/api/local-files/image")),
      false,
    );
  } finally {
    await view.cleanup();
  }
});

test("the screen reads in Chinese too", async () => {
  const value = frame("f1", "c1", 1);
  const view = await mountScreen(
    {
      frames: [value],
      dropped: 1,
      limits: { count: 200, bytes: 50 * 1024 * 1024 },
    },
    {
      id: "screen:s",
      kind: "screen",
      label: "Playwright MCP",
      sessionId: "s",
      latest: { ...value, sessionId: "s" },
    },
    "zh-CN",
  );
  try {
    const text = view.container.textContent;
    assert.match(text, /第 1 \/ 1 张/);
    assert.match(text, /正在显示最新画面/);
    assert.match(text, /较早的 1 张画面已清理/);
    assert.match(text, /Esc 关闭/);
  } finally {
    await view.cleanup();
  }
});
