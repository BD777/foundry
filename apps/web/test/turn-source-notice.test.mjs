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

// The prompt is the frame written for the model; the page reads only the
// fields the server set on the source.
const notice = (text, source) => ({
  id: "input_notice",
  role: "user",
  text,
  at: "2026-11-24T03:35:00.000Z",
  inputSource: { kind: "foundry_notice", ...source },
});

const render = (message) =>
  renderToStaticMarkup(
    createElement(TurnSourceRow, { message, source: turnSource(message) }),
  );

const inChinese = async (check) => {
  await i18n.changeLanguage("zh-CN");
  try {
    await check();
  } finally {
    await i18n.changeLanguage("en");
  }
};

test("an answer the person gave shows as theirs, in their language, from the source's fields", () =>
  inChinese(() => {
    const question = "明天下午的周会要不要取消？\n“周会”指 3 点那个";
    const answer = notice("whatever the frame says", {
      noticeKind: "question_answer",
      question,
      personWords: "照常",
    });
    const source = turnSource(answer);
    assert.equal(source.kind, "notice");
    assert.equal(source.relay, "question_answer");
    assert.equal(source.title, "明天下午的周会要不要取消？");
    // The whole question under the expansion.
    assert.equal(source.detail, question);
    assert.equal(sourceBody(answer), "照常");
    const markup = render(answer);
    assert.match(markup, /你回答了：明天下午的周会要不要取消？/);
    assert.match(markup, />照常</);
    assert.doesNotMatch(markup, /Foundry|whatever the frame says/);
  }));

test("a decision note relays only the person's words", () =>
  inChinese(() => {
    const note = notice("frame", {
      noticeKind: "decision_note",
      question: "Delete old-draft.txt?",
      personWords: "先确认没有别的引用",
    });
    assert.equal(turnSource(note).relay, "decision_note");
    assert.equal(sourceBody(note), "先确认没有别的引用");
    assert.match(render(note), /你补充了说明：Delete old-draft.txt\?/);
    // Without a subject the label stands alone.
    const bare = notice("frame", {
      noticeKind: "decision_note",
      personWords: "先确认",
    });
    assert.match(render(bare), /你补充了说明</);
  }));

test("a notice without the fields, stored before them, keeps the generic row", () => {
  const legacy = notice(
    '[Foundry] the person answered your question "Q".\nTheir answer:\nA',
    { noticeKind: "question_answer" },
  );
  assert.equal(turnSource(legacy).relay, undefined);
  assert.match(render(legacy), /Foundry notice/);
  const reminder = notice("[Foundry] 提醒：交周报", {
    noticeKind: "reminder",
    personWords: "ignored",
  });
  assert.equal(turnSource(reminder).relay, undefined);
});
