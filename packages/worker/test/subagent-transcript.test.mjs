import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
        role: "assistant",
        content: [{ type: "text", text: "The bug is in app.ts." }],
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
