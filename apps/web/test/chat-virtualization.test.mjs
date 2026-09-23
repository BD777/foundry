import assert from "node:assert/strict";
import test from "node:test";
import { estimateChatMessageHeight } from "../src/components/conversation/chat-virtualization.ts";

test("does not cap very long Markdown messages to a single viewport", () => {
  const estimate = estimateChatMessageHeight({
    id: "long-answer",
    role: "bot",
    text: `# Summary\n\n${"A long answer with Markdown. ".repeat(180)}`,
  });

  assert.ok(estimate > 1200);
});
