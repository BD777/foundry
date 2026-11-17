import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

register("./bundler-resolve.mjs", import.meta.url);

await import("../src/i18n/index.ts");
const { turnSource } =
  await import("../src/components/conversation/turn-source.ts");
const { TurnSourceRow } =
  await import("../src/components/conversation/turn-source-row.tsx");

const reportInput = (sentBy) => ({
  id: "input_report",
  role: "user",
  text: "Foundry report: finished",
  at: "2026-11-18T05:28:00.000Z",
  inputSource: {
    kind: "child_report",
    sessionId: "sess_helper",
    title: "合成验证 DEV-289 汇报",
    status: "completed",
    response: "Done.",
  },
  ...(sentBy ? { sentBy } : {}),
});

const render = (message) =>
  renderToStaticMarkup(
    createElement(TurnSourceRow, { message, source: turnSource(message) }),
  );

test("a helper's report row links its title to the helper's chat", () => {
  const message = reportInput();
  assert.equal(turnSource(message).sessionId, "sess_helper");
  const markup = render(message);
  assert.match(markup, /<a [^>]*href="\/chats\/sess_helper"[^>]*>/);
  assert.match(markup, />合成验证 DEV-289 汇报<\/a>/);
});

test("a report whose sender the viewer cannot open stays unlinked", () => {
  const message = reportInput({
    sessionId: "sess_helper",
    label: "另一个会话",
  });
  assert.equal(turnSource(message).sessionId, undefined);
  const markup = render(message);
  assert.doesNotMatch(markup, /href="\/chats\/sess_helper"/);
  assert.match(markup, />另一个会话<\/strong>/);
});
