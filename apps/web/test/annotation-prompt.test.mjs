import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./bundler-resolve.mjs", import.meta.url);
const {
  anchorFromSent,
  anchorStillMatches,
  anchorTextHash,
  annotationInstruction,
  promptItem,
  sentAnnotation,
  serializeAnnotatedPrompt,
  stripAnnotationWrapper,
} = await import("../src/components/conversation/annotations.ts");

const items = [
  {
    id: "a1",
    selectedText: "sel",
    comment: "c",
    source: { messageId: "m1", startOffset: 3, endOffset: 6 },
  },
  { id: "a2", selectedText: "x", source: { messageId: "m2" } },
];

test("serialises annotations exactly as the Codex App wraps them", () => {
  const prompt = serializeAnnotatedPrompt("请补充", items);
  assert.equal(
    prompt,
    [
      "",
      "# Response annotations:",
      'Each item contains text selected from an earlier Codex response and may include a user comment. Treat items as Annotation 1, Annotation 2, and so on in array order. Use every selection as context and address every comment. For every annotation you address, include `:codex-annotation{index="N" id="ID"}`, where N is its one-based array position and ID is its exact id (omit the id attribute if absent). Do not use unstructured annotation labels.',
      "<response-annotations>",
      '[{"id":"a1","text":"sel","annotation":"c","source":{"messageId":"m1","startOffset":3,"endOffset":6}},{"id":"a2","text":"x","source":{"messageId":"m2"}}]',
      "</response-annotations>",
      "",
      "## My request:",
      "请补充",
    ].join("\n"),
  );
  assert.equal(annotationInstruction.split("\n").length, 1);
});

test("strips the wrapper back to the person's message, also after server trimming", () => {
  const prompt = serializeAnnotatedPrompt("请补充", items);
  assert.equal(stripAnnotationWrapper(prompt), "请补充");
  assert.equal(stripAnnotationWrapper(prompt.trim()), "请补充");
});

test("an empty message strips to empty, with or without its edges", () => {
  const prompt = serializeAnnotatedPrompt("", items);
  assert.equal(stripAnnotationWrapper(prompt), "");
  assert.equal(stripAnnotationWrapper(prompt.trim()), "");
});

test("leaves a message without the wrapper unchanged", () => {
  assert.equal(stripAnnotationWrapper("plain text"), "plain text");
  assert.equal(
    stripAnnotationWrapper("# Response annotations: mentioned in prose"),
    "# Response annotations: mentioned in prose",
  );
});

test("a draft annotation becomes a prompt item with its offsets", () => {
  const item = promptItem({
    id: "a1",
    selectedText: "sel",
    sourceEventId: "m1",
    anchor: { start: 3, end: 6, textHash: anchorTextHash("sel") },
  });
  assert.deepEqual(item, {
    id: "a1",
    selectedText: "sel",
    source: { messageId: "m1", startOffset: 3, endOffset: 6 },
  });
});

test("a sent annotation keeps its offsets and restores the anchor", () => {
  const sent = sentAnnotation({
    id: "a1",
    sourceEventId: "m1",
    selectedText: "sel",
    comment: "c",
    anchor: { start: 3, end: 6, textHash: "ignored" },
    turnNumber: 2,
  });
  assert.deepEqual(sent, {
    id: "a1",
    sourceEventId: "m1",
    selectedText: "sel",
    comment: "c",
    startOffset: 3,
    endOffset: 6,
    turnNumber: 2,
  });
  const anchor = anchorFromSent(sent);
  assert.deepEqual(anchor, {
    start: 3,
    end: 6,
    textHash: anchorTextHash("sel"),
  });
  assert.equal(anchorStillMatches("abcdefghi", anchor), false);
  assert.equal(anchorStillMatches("abcselghi", anchor), true);
});
