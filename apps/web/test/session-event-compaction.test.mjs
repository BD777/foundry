import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
register("./bundler-resolve.mjs", import.meta.url);
const { chatMessagesForThread } =
  await import("../src/features/chat/thread/chat-model.ts");
const { processDisplayRows, processDisplaySummary } =
  await import("../src/components/conversation/chat-process-display.ts");
const { chatContextCardForSessions, chatSessionStatus } =
  await import("../src/features/chat/context/chat-context-model.ts");

// One session as the server's transcript API returned it before and after
// compacting its events (apps/server/internal/httpapi,
// TestSessionEventCompactionKeepsTranscript writes it).
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/session-event-compaction.json", import.meta.url),
    "utf8",
  ),
);

// What the chat shows: its messages, each process group's rows and summary
// as ProcessDisclosure draws them, and the side panel. A group's id is a
// React key named after its first step, and its text shows only without
// rows: neither is content.
function shown(read) {
  const session = { ...read.session, events: read.events, panel: read.panel };
  const messages = chatMessagesForThread({ sessions: [session] }).map(
    (message) => {
      if (message.kind !== "process") return message;
      const { id: _id, text, processItems, ...rest } = message;
      const rows = processDisplayRows(processItems, Boolean(message.streaming));
      return {
        ...rest,
        ...(rows.length === 0 ? { text } : {}),
        rows,
        summary: processDisplaySummary(
          rows,
          message.title ?? "",
          Boolean(message.streaming),
        ),
      };
    },
  );
  return {
    messages,
    status: chatSessionStatus(session),
    card: chatContextCardForSessions([session]),
  };
}

test("a compacted session's transcript and panel show what they showed before", () => {
  const { before, after } = fixture;
  assert.ok(
    after.events.length < before.events.length,
    "the fixture removes events",
  );
  assert.ok(before.panel && after.panel, "each read brings its panel");
  const shownBefore = shown(before);
  assert.ok(
    shownBefore.messages.some((message) => message.kind === "process"),
    "the fixture has process groups",
  );
  assert.deepEqual(shown(after), shownBefore);
  assert.equal(after.conversation, before.conversation);
});
