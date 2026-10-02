import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
register("./bundler-resolve.mjs", import.meta.url);

const { displayProcessDetail, displayProcessLabel, processLabelKey } =
  await import("../src/lib/process-labels.ts");
const { i18n } = await import("../src/i18n/index.ts");

test("a current worker label shows in the viewer's language", () => {
  assert.equal(displayProcessLabel("Using tool"), "Using a tool");
  assert.equal(displayProcessLabel("Session failed"), "Session failed");
  assert.equal(
    processLabelKey("Rate limited, waiting to retry"),
    "rateLimited",
  );
});

test("a label an older worker wrote in Chinese shows in English too", () => {
  assert.equal(displayProcessLabel("正在使用工具"), "Using a tool");
  assert.equal(
    displayProcessLabel("模型限流，等待重试"),
    "Rate limited, waiting to retry",
  );
  assert.equal(
    displayProcessLabel("原生会话已压缩上下文。"),
    "The native session compacted its context.",
  );
});

test("a fixed worker detail translates; any other detail stays as written", () => {
  assert.equal(
    displayProcessDetail("Claude 正在生成响应。"),
    "Claude is generating a response.",
  );
  assert.equal(
    displayProcessDetail("The model is thinking."),
    "The model is thinking.",
  );
  assert.equal(displayProcessDetail("pnpm test"), "pnpm test");
});

test("current English labels and details show in Chinese for a Chinese viewer", async () => {
  const previous = i18n.language;
  await i18n.changeLanguage("zh-CN");
  try {
    assert.equal(displayProcessLabel("Requesting model"), "正在请求模型");
    assert.equal(
      displayProcessDetail("Claude is generating a response."),
      "Claude 正在生成响应。",
    );
    assert.equal(displayProcessDetail("pnpm test"), "pnpm test");
  } finally {
    await i18n.changeLanguage(previous);
  }
});

test("an agent-written title is data and stays as written", () => {
  assert.equal(displayProcessLabel("Inspect the parser"), "Inspect the parser");
  assert.equal(displayProcessLabel("检查解析器"), "检查解析器");
  assert.equal(displayProcessLabel(undefined), undefined);
});

test("a legacy Chinese transcript renders in English", async () => {
  const window = new Window();
  const previous = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of ["Node", "Element", "HTMLElement", "Event", "MouseEvent"])
    globals[key] = window[key];
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  try {
    const { ProcessDisclosure } =
      await import("../src/components/conversation/chat-message-content.tsx");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        createElement(ProcessDisclosure, {
          items: [
            { title: "正在思考", detail: "Claude 正在整理思路。" },
            { title: "正在执行命令", detail: "pnpm test" },
            { title: "已执行命令", detail: "pnpm test\n\n```\nok\n```" },
          ],
          streaming: false,
          text: "",
          title: "已处理",
        }),
      ),
    );
    await act(async () =>
      container.querySelector(".fdy-chat-process-trigger").click(),
    );
    const text = container.textContent;
    assert.match(text, /Finished thinking/);
    assert.match(text, /Ran a command/);
    assert.match(text, /Claude is thinking\./);
    assert.doesNotMatch(text, /正在|已执行|思考完成/);
    await act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    await window.happyDOM.close();
  }
});
