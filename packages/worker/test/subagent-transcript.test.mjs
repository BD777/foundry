import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { subagentResponseFingerprint } from "@bd777/foundry-protocol";
import { sendSubagentList } from "../dist/session-helpers.js";
import {
  listAgentSubagents,
  readAgentSubagentTranscript,
} from "../dist/subagent-transcript.js";

test("reads only the selected local agent conversation", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "foundry-subagent-"));
  const sessionId = "sess_test";
  const sessionDirectory = join(workspace, ".foundry", "sessions", sessionId);
  mkdirSync(sessionDirectory, { recursive: true });
  const records = [
    {
      type: "system",
      subtype: "task_started",
      task_id: "task_agent",
      task_type: "local_agent",
      tool_use_id: "tool_agent",
      description: "Inspect the workspace",
      prompt: "Find the bug",
      subagent_type: "general-purpose",
    },
    {
      type: "user",
      uuid: "user_1",
      parent_tool_use_id: "tool_agent",
      message: {
        role: "user",
        content: [{ type: "text", text: "Find the bug" }],
      },
    },
    {
      type: "assistant",
      uuid: "assistant_1",
      parent_tool_use_id: "tool_agent",
      message: {
        id: "msg_sub",
        role: "assistant",
        content: [{ type: "text", text: "The bug is in app.ts." }],
        usage: { input_tokens: 300, output_tokens: 20 },
      },
    },
    {
      type: "assistant",
      uuid: "other_agent",
      parent_tool_use_id: "tool_other",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Other" }],
      },
    },
    {
      type: "system",
      subtype: "task_notification",
      task_id: "task_agent",
      status: "completed",
      summary: "Inspect the workspace",
      usage: { total_tokens: 4321, tool_uses: 3, duration_ms: 9000 },
    },
  ];
  writeFileSync(
    join(sessionDirectory, "claude-sdk.messages.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );

  try {
    const transcript = await readAgentSubagentTranscript(
      workspace,
      sessionId,
      "task_agent",
    );
    assert.equal(transcript.status, "completed");
    assert.equal(transcript.title, "Inspect the workspace");
    assert.deepEqual(
      transcript.messages.map(({ content, role }) => [role, content]),
      [
        ["user", "Find the bug"],
        ["assistant", "The bug is in app.ts."],
      ],
    );
    // The subagent's own totals, and each step's model request tokens.
    const usage = { totalTokens: 4321, toolUses: 3, durationMs: 9000 };
    assert.deepEqual(transcript.usage, usage);
    assert.equal(transcript.messages[1].requestUsage?.outputTokens, 20);
    assert.deepEqual(await listAgentSubagents(workspace, sessionId), [
      {
        prompt: "Find the bug",
        responseTexts: ["The bug is in app.ts."],
        sessionId,
        status: "completed",
        subagentType: "general-purpose",
        taskId: "task_agent",
        title: "Inspect the workspace",
        toolUseId: "tool_agent",
        usage,
      },
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("does not expose local bash tasks as subagent transcripts", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "foundry-subagent-"));
  const sessionId = "sess_test";
  const sessionDirectory = join(workspace, ".foundry", "sessions", sessionId);
  mkdirSync(sessionDirectory, { recursive: true });
  writeFileSync(
    join(sessionDirectory, "claude-sdk.messages.jsonl"),
    `${JSON.stringify({
      type: "system",
      subtype: "task_started",
      task_id: "task_bash",
      task_type: "local_bash",
      tool_use_id: "tool_bash",
      description: "Run a command",
    })}\n`,
  );

  try {
    assert.deepEqual(await listAgentSubagents(workspace, sessionId), []);
    await assert.rejects(
      () => readAgentSubagentTranscript(workspace, sessionId, "task_bash"),
      /subagent task was not found/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("answers a chat's list read with digests: fingerprints, no prompts", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "foundry-subagent-"));
  const sessionId = "sess_digest";
  const sessionDirectory = join(workspace, ".foundry", "sessions", sessionId);
  mkdirSync(sessionDirectory, { recursive: true });
  const answer = (uuid, text) => ({
    type: "assistant",
    uuid,
    parent_tool_use_id: "tool_agent",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
  writeFileSync(
    join(sessionDirectory, "claude-sdk.messages.jsonl"),
    `${[
      {
        type: "system",
        subtype: "task_started",
        task_id: "task_agent",
        task_type: "local_agent",
        tool_use_id: "tool_agent",
        description: "Inspect the workspace",
        prompt: "Find the bug",
      },
      answer("a1", "Looking."),
      answer("a2", "The bug is in app.ts."),
      // The same answer once trimmed: one fingerprint.
      answer("a3", "  The bug is in app.ts.\n"),
    ]
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`,
  );
  const replies = [];
  const socket = {
    readyState: 1,
    send: (data) => replies.push(JSON.parse(data)),
  };
  try {
    await sendSubagentList(socket, "msg_full", workspace, {
      sessionId,
      workspaceId: "ws_1",
    });
    await sendSubagentList(socket, "msg_digest", workspace, {
      sessionId,
      workspaceId: "ws_1",
      view: "digest",
    });
    const [full, digest] = replies;
    assert.equal(full.id, "msg_full");
    assert.equal(full.payload.view, undefined);
    assert.equal(full.payload.subagents[0].prompt, "Find the bug");
    assert.equal(full.payload.subagents[0].responseTexts.length, 3);
    assert.equal(digest.id, "msg_digest");
    assert.deepEqual(digest.payload, {
      sessionId,
      view: "digest",
      subagents: [
        {
          responseFingerprints: [
            subagentResponseFingerprint("Looking."),
            subagentResponseFingerprint("The bug is in app.ts."),
          ],
          sessionId,
          status: "running",
          taskId: "task_agent",
          title: "Inspect the workspace",
          toolUseId: "tool_agent",
        },
      ],
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
