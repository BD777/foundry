import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
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

test("a fixed worker detail translates; any other detail stays as written", () => {
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
