// A message steered into a running turn with annotations reads like a sent
// one: the person's own text, the annotations beside it, never the wrapper
// the model reads.
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { panel } from "./fixtures/session-panel.mjs";

register("./bundler-resolve.mjs", import.meta.url);
const { sessionTranscriptEntries } =
  await import("../src/features/chat/thread/transcript-adapters.ts");
const { annotatedPromptText } =
  await import("../src/components/conversation/annotations.ts");

const annotation = {
  id: "a1",
  selectedText: "香蕉 3",
  comment: "待确认",
  sourceEventId: "agent-session:sess_s:answer",
  anchor: { start: 7, end: 11, textHash: "x" },
};

test("a steered message with annotations shows the person's text, not the wrapper", () => {
  const wrapped = annotatedPromptText("看一下这个价格", [annotation]);
  const steer = {
    id: "evt_steer",
    sessionId: "sess_s",
    at: "2026-11-17T16:01:19.000Z",
    label: "Steered into active turn",
    detail: wrapped,
    level: "info",
    message: {
      id: "steer_1",
      kind: "user",
      text: wrapped,
      annotations: [
        {
          id: "a1",
          selectedText: "香蕉 3",
          comment: "待确认",
          sourceEventId: "agent-session:sess_s:answer",
          startOffset: 7,
          endOffset: 11,
        },
      ],
    },
  };
  const entries = sessionTranscriptEntries({
    agentId: "agent_test",
    createdLabel: "just now",
    deviceId: "dev_test",
    events: [steer],
    panel: panel(),
    id: "sess_s",
    prompt: "first",
    provider: "codex",
    status: "running",
    title: "first",
    updatedLabel: "running",
    workspaceId: "ws_test",
  });
  const entry = entries.find((item) => item.steered);
  assert.ok(entry, "the steer is in the transcript");
  assert.equal(entry.text, "看一下这个价格");
  assert.doesNotMatch(entry.text, /Response annotations/);
  assert.equal(entry.annotations?.length, 1);
});
