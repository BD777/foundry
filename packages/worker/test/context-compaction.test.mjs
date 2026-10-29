import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeCompactSummary,
  claudeTranscriptFile,
  compactBoundaryUuid,
} from "../dist/claude-compact-summary.js";
import { ClaudeContextTracker } from "../dist/context-usage.js";
import { nativeChatTranscript } from "../dist/native-chat-transcript.js";

const summaryText =
  "This session is being continued from a previous conversation. Summary: DEV-083 synthetic.";

function claudeTranscript() {
  return [
    { type: "user", uuid: "u1", message: { role: "user", content: "hello" } },
    {
      type: "system",
      subtype: "compact_boundary",
      uuid: "b1",
      compactMetadata: {
        trigger: "manual",
        preTokens: 951800,
        postTokens: 38200,
      },
    },
    {
      type: "user",
      uuid: "s1",
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: { role: "user", content: summaryText },
    },
    { type: "user", uuid: "u2", message: { role: "user", content: "next" } },
  ];
}

// The SDK reports a compaction's counts; its summary is read from the
// session's own transcript (DEV-083).
test("the compaction's counts come from the SDK, its summary from the transcript", () => {
  const tracker = new ClaudeContextTracker({ resumed: false });
  const boundary = {
    type: "system",
    subtype: "compact_boundary",
    uuid: "b1",
    compact_metadata: {
      trigger: "manual",
      pre_tokens: 951800,
      post_tokens: 38200,
    },
  };
  const report = tracker.observe(boundary);
  assert.deepEqual(report.compaction, {
    trigger: "manual",
    preTokens: 951800,
    postTokens: 38200,
  });
  assert.equal(report.inputTokens, 38200);
  assert.equal(compactBoundaryUuid(boundary), "b1");
  assert.equal(compactBoundaryUuid({ type: "assistant" }), undefined);

  const home = mkdtempSync(join(tmpdir(), "dev083-claude-"));
  const dir = join(home, "projects", "-tmp-ws");
  const path = join(dir, "1b2c3d4e-0000-4000-8000-000000000000.jsonl");
  mkdirSync(dir, { recursive: true });
  // Before the summary is written there is none.
  writeFileSync(
    path,
    claudeTranscript()
      .slice(0, 2)
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  assert.equal(claudeCompactSummary(path, "b1"), undefined);
  writeFileSync(
    path,
    claudeTranscript()
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  assert.equal(claudeCompactSummary(path, "b1"), summaryText);
  assert.equal(claudeCompactSummary(path), summaryText);
  assert.equal(claudeCompactSummary(path, "other"), undefined);
  assert.equal(
    claudeTranscriptFile("1b2c3d4e-0000-4000-8000-000000000000", [home]),
    path,
  );
  assert.equal(claudeTranscriptFile("../etc", [home]), undefined);
});

// Imported chats show a compaction where it happened, with its summary as
// part of it, never as a message the person sent.
test("an imported Claude chat shows the compaction and keeps its summary off the person's messages", () => {
  const transcript = nativeChatTranscript(
    claudeTranscript().map((line) => JSON.stringify(line)),
    "claude",
  );
  assert.deepEqual(
    transcript.map((item) => item.kind),
    ["user", "boundary", "user"],
  );
  assert.deepEqual(transcript[1].compaction, {
    trigger: "manual",
    preTokens: 951800,
    postTokens: 38200,
    summary: summaryText,
  });
  assert.ok(
    !transcript.some(
      (item) => item.kind === "user" && item.text.includes("being continued"),
    ),
  );
});

test("an imported Codex compaction keeps a readable summary and shows one without it", () => {
  const lines = [
    {
      type: "compacted",
      payload: {
        message: "Local summary of the work so far.",
        replacement_history: [],
      },
    },
    { type: "event_msg", payload: { type: "user_message", message: "go on" } },
    {
      type: "compacted",
      payload: { message: "", replacement_history: [{ type: "compaction" }] },
    },
  ].map((line) => JSON.stringify(line));
  const transcript = nativeChatTranscript(lines, "codex");
  assert.deepEqual(
    transcript.map((item) => item.kind),
    ["boundary", "user", "boundary"],
  );
  assert.equal(
    transcript[0].compaction.summary,
    "Local summary of the work so far.",
  );
  assert.equal(transcript[2].compaction.summary, undefined);
});
