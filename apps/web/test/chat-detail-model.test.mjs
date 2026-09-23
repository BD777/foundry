import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register("./bundler-resolve.mjs", import.meta.url);
const { chatMessagesForSubagentTranscript } =
  await import("../src/features/chat/chat-transcript-model.ts");

test("projects subagent transcripts into the shared chat message model", () => {
  const messages = chatMessagesForSubagentTranscript({
    messages: [
      { content: "Do the work", id: "user", role: "user" },
      {
        content: "I should inspect the file.",
        id: "thought",
        role: "assistant",
        title: "思考",
      },
      {
        content: '{"file_path":"/tmp/input.txt"}',
        id: "tool",
        role: "tool",
        title: "Read",
      },
      { content: "Finished.", id: "answer", role: "assistant" },
    ],
    sessionId: "session",
    status: "completed",
    taskId: "task",
    title: "Task",
    toolUseId: "tool-use",
  });

  assert.deepEqual(
    messages.map(({ copyAlways, kind, role, title }) => ({
      copyAlways,
      kind,
      role,
      title,
    })),
    [
      { copyAlways: false, kind: undefined, role: "user", title: undefined },
      {
        copyAlways: false,
        kind: "process",
        role: "bot",
        title: "已处理",
      },
      { copyAlways: true, kind: undefined, role: "bot", title: undefined },
    ],
  );
  assert.deepEqual(
    messages[1].processItems.map((item) => item.title),
    ["思考", "Read"],
  );
  assert.equal(
    messages[1].processItems[0].detail,
    "I should inspect the file.",
  );
});
