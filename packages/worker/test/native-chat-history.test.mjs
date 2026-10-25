import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "native-history-"));
process.env.CODEX_HOME = join(root, "codex");
const { nativeChatThreadsForWorkspace, nativeChatHistory } =
  await import("../dist/native-chat.js");
const { nativeChatTranscript } =
  await import("../dist/native-chat-transcript.js");

const id = "01a166bd-0000-7000-8000-000000000001";
const workspace = join(root, "workspace");
mkdirSync(workspace);

function record(type, payload, at) {
  return JSON.stringify({ timestamp: at, type, payload });
}

/** A Codex log of many turns, a few of them with large tool output. */
function writeLog() {
  const lines = [
    record(
      "session_meta",
      { id, cwd: workspace, originator: "Codex Desktop" },
      "2026-10-23T03:10:00.000Z",
    ),
  ];
  for (let turn = 0; turn < 60; turn += 1) {
    const at = new Date(Date.UTC(2026, 9, 23, 4, turn)).toISOString();
    lines.push(
      record(
        "response_item",
        {
          type: "message",
          id: `user-${turn}`,
          role: "user",
          content: [{ type: "input_text", text: `question ${turn}` }],
        },
        at,
      ),
      record(
        "response_item",
        {
          type: "function_call",
          id: `call-${turn}`,
          call_id: `c${turn}`,
          name: "exec",
          arguments: "ls",
        },
        at,
      ),
      record(
        "response_item",
        {
          type: "function_call_output",
          call_id: `c${turn}`,
          output: "x".repeat(turn === 30 ? 1_500_000 : 40_000),
        },
        at,
      ),
      record(
        "response_item",
        {
          type: "message",
          id: `answer-${turn}`,
          role: "assistant",
          content: [{ type: "output_text", text: `answer ${turn}` }],
        },
        at,
      ),
    );
  }
  const dir = join(process.env.CODEX_HOME, "sessions", "2026", "10", "23");
  mkdirSync(dir, { recursive: true });
  const text = `${lines.join("\n")}\n`;
  writeFileSync(join(dir, `rollout-2026-10-23T11-10-39-${id}.jsonl`), text);
  const offsets = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += Buffer.byteLength(line) + 1;
  }
  return { lines, offsets };
}

test("a long native chat carries its latest part and pages back to its start", async () => {
  const log = writeLog();
  const [chat] = await nativeChatThreadsForWorkspace(
    { id: "ws_history", localPath: workspace },
    [],
  );
  assert.equal(chat.nativeSessionId, id);
  assert.ok(chat.transcriptBefore > 0, "the latest part, not the whole log");
  assert.equal(chat.transcript.at(-1).text, "answer 59");
  assert.ok(!chat.transcript.some((message) => message.kind === "boundary"));

  const pages = [chat.transcript];
  let before = chat.transcriptBefore;
  while (before > 0) {
    const page = await nativeChatHistory(workspace, "codex", id, before);
    assert.ok(page.before < before, "every page moves back");
    pages.unshift(page.transcript);
    before = page.before;
  }
  const paged = pages.flat();
  const whole = nativeChatTranscript(log.lines, "codex", log.offsets);
  assert.deepEqual(
    paged.map((message) => message.id),
    whole.map((message) => message.id),
    "the pages put together are the whole log, each step once",
  );
  // The 1.5 MB tool output, longer than a page, arrives whole on its own.
  assert.ok(paged.some((message) => message.text.length >= 1_000_000));
});

test("history is read only for a chat of the asking workspace", async () => {
  writeLog();
  const other = join(root, "other");
  mkdirSync(other, { recursive: true });
  await assert.rejects(
    () => nativeChatHistory(other, "codex", id, 4096),
    /not on this device/,
  );
  await assert.rejects(
    () => nativeChatHistory(workspace, "codex", id, 0),
    /positive byte offset/,
  );
});
