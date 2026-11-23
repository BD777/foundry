import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

register("./bundler-resolve.mjs", import.meta.url);

const { i18n } = await import("../src/i18n/index.ts");
const { sourceBody, turnSource } =
  await import("../src/components/conversation/turn-source.ts");
const { TurnSourceRow } =
  await import("../src/components/conversation/turn-source-row.tsx");

const notice = (text, noticeKind) => ({
  id: "input_notice",
  role: "user",
  text,
  at: "2026-11-24T03:35:00.000Z",
  inputSource: {
    kind: "foundry_notice",
    ...(noticeKind ? { noticeKind } : {}),
  },
  // The server sends an answer as by the conversation itself.
  sentBy: { sessionId: "sess_home", label: "助理" },
});

const render = (message) =>
  renderToStaticMarkup(
    createElement(TurnSourceRow, { message, source: turnSource(message) }),
  );

// The server's AnswerFrame: Go's %q of the question, then the answer.
const answer = notice(
  '[Foundry] the person answered your question "明天下午的周会要不要取消？\\n\\"周会\\"指 3 点那个".\nTheir answer:\n照常',
  "question_answer",
);

test("an answer the person gave shows as theirs, in their language, never the model's frame", async () => {
  await i18n.changeLanguage("zh-CN");
  try {
    const source = turnSource(answer);
    assert.equal(source.kind, "notice");
    assert.equal(source.relay, "question_answer");
    assert.equal(source.title, "明天下午的周会要不要取消？");
    // The whole question, line break and quotes decoded, under the expansion.
    assert.equal(
      source.detail,
      '明天下午的周会要不要取消？\n"周会"指 3 点那个',
    );
    assert.equal(sourceBody(answer), "照常");
    const markup = render(answer);
    assert.match(markup, /你回答了：明天下午的周会要不要取消？/);
    assert.match(markup, />照常</);
    assert.doesNotMatch(markup, /Foundry|the person answered|Their answer/);
  } finally {
    await i18n.changeLanguage("en");
  }
});

test("an item's answer and a decision note relay only the person's words", async () => {
  await i18n.changeLanguage("zh-CN");
  try {
    const itemAnswer = notice(
      '[Foundry] the person answered what item pai_1 waits on them for: "新 NAS 的名字".\nTheir answer:\nnas2-test.local',
      "question_answer",
    );
    assert.equal(turnSource(itemAnswer).title, "新 NAS 的名字");
    assert.equal(sourceBody(itemAnswer), "nas2-test.local");
    const note = notice(
      '[Foundry] the person sent more information about "Delete old-draft.txt?"; they have not decided it, so it stays open.\nTheir message:\n先确认没有别的引用',
      "decision_note",
    );
    assert.equal(turnSource(note).relay, "decision_note");
    assert.equal(sourceBody(note), "先确认没有别的引用");
    assert.match(render(note), /你补充了说明：Delete old-draft.txt\?/);
  } finally {
    await i18n.changeLanguage("en");
  }
});

test("other notices keep their text and the generic label", () => {
  const reminder = notice("[Foundry] 提醒：交周报", "reminder");
  assert.equal(turnSource(reminder).relay, undefined);
  assert.match(render(reminder), /Foundry notice/);
  // A frame without its separator is shown as it came, not guessed at.
  const odd = notice(
    '[Foundry] the person answered your question "Q".',
    "question_answer",
  );
  assert.equal(turnSource(odd).relay, undefined);
});
