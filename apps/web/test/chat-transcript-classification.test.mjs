import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);
const { chatMessages, transcriptDisplayMessages } =
  await import("../src/features/chat/chat-model.ts");

const chat = { id: "native-chat", provider: "codex", profileLabel: "Codex" };
const explanation = "先用 Embedding 召回，再用 Reranker 精排。\n".repeat(70);
const answers = [
  `${explanation}\n\`\`\`python\nrerank(candidates)\n\`\`\``,
  `<article>${explanation}</article>`,
  JSON.stringify({ explanation }),
  "tool calling 是模型调用工具的机制。",
  "function rank() 返回排序结果。",
  "# AGENTS.md instructions\n这里解释工作区指令的含义。",
];

test("structured native messages preserve every answer and explicit process kind", () => {
  const answer = `${answers[0]}\nUser: quoted user\nCodex: quoted assistant`;
  const messages = chatMessages({
    ...chat,
    handoffContext: "Codex: stale fallback",
    transcript: [
      { id: "u", kind: "user", text: "Question" },
      { id: "r", kind: "reasoning", text: "Saved summary", title: "思考摘要" },
      { id: "t", kind: "tool", text: "pwd", title: "exec" },
      { id: "a", kind: "assistant", text: answer },
      { id: "a2", kind: "assistant", text: "Another answer" },
    ],
  });
  assert.deepEqual(
    messages.map((m) => m.kind),
    [undefined, "process", undefined, undefined],
  );
  assert.equal(messages[1].processItems[0].detail, "Saved summary");
  assert.equal(messages[1].processItems[0].title, "思考摘要");
  assert.equal(messages[1].processItems.length, 2);
  assert.equal(messages[2].text, answer);
  assert.equal(messages[3].text, "Another answer");
});

for (const provider of ["codex", "claude"]) {
  for (const [index, answer] of answers.entries()) {
    test(`${provider} preserves assistant answer ${index} as visible text`, () => {
      const messages = chatMessages({
        ...chat,
        provider,
        handoffContext: `User: 解释一下\n\n${provider === "codex" ? "Codex" : "Claude"}: ${answer}`,
      });
      assert.equal(messages.length, 2);
      assert.equal(messages[1].role, "bot");
      assert.equal(messages[1].kind, undefined);
      assert.equal(messages[1].text, answer);
    });
  }
}

test("explicit user context stays folded while the request stays visible", () => {
  const context = "# AGENTS.md instructions\nFollow workspace conventions.";
  const messages = transcriptDisplayMessages({
    chat,
    role: "user",
    text: `${context}\n\n## My request for Codex:\nExplain ranking`,
  });
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].text, "Explain ranking");
  assert.equal(messages[1].kind, "tool");
  assert.equal(messages[1].text, context);
});

test("native truncation boundary remains separate from a long answer", () => {
  const messages = transcriptDisplayMessages({
    chat,
    role: "bot",
    text: `Earlier context truncated.\n\n${answers[0]}`,
  });
  assert.equal(messages[0].kind, "boundary");
  assert.equal(messages[1].kind, undefined);
  assert.equal(messages[1].text, answers[0]);
});
