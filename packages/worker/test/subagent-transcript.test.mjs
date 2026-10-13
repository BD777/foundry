import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { subagentResponseFingerprint } from "@bd777/foundry-protocol";
import { subagentList } from "../dist/daemon/handlers/files.js";
import { readSubagentRecords } from "../dist/subagent-records.js";
import { claudeSubagentUsage } from "../dist/turn-usage.js";
import {
  agentSubagentDigest,
  listAgentSubagentDigests,
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
  try {
    // As the server reads them: off the wire.
    const read = async (payload) =>
      JSON.parse(JSON.stringify(await subagentList(workspace, payload)));
    const full = await read({ sessionId, workspaceId: "ws_1" });
    const digest = await read({
      sessionId,
      workspaceId: "ws_1",
      view: "digest",
    });
    assert.equal(full.view, undefined);
    assert.equal(full.subagents[0].prompt, "Find the bug");
    assert.equal(full.subagents[0].responseTexts.length, 3);
    assert.deepEqual(digest, {
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

test("a digest across a session's inputs is the list's, and follows appends", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "foundry-subagent-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const sessionId = "sess_inputs";
  const inputs = join(workspace, ".foundry", "sessions", sessionId, "inputs");
  const transcript = (inputId) => {
    mkdirSync(join(inputs, inputId), { recursive: true });
    return join(inputs, inputId, "claude-sdk.messages.jsonl");
  };
  const line = (record) => `${JSON.stringify(record)}\n`;
  const started = (id, extra = {}) => ({
    type: "system",
    subtype: "task_started",
    task_id: `task_${id}`,
    task_type: "local_agent",
    tool_use_id: `tool_${id}`,
    prompt: `do ${id}`,
    ...extra,
  });
  const answer = (id, text) => ({
    type: "assistant",
    parent_tool_use_id: `tool_${id}`,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
  const first = transcript("01_first");
  const second = transcript("02_second");
  writeFileSync(
    first,
    [
      started("a", { description: "Look", subagent_type: "Explore" }),
      // Main-thread records, and a subagent's tool result, are skipped.
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { role: "assistant", content: "main" },
      },
      {
        type: "user",
        parent_tool_use_id: "tool_a",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "big output" }],
        },
      },
      answer("a", "Found it."),
      answer("a", "Found it."),
      started("b"),
    ]
      .map(line)
      .join(""),
  );
  writeFileSync(
    second,
    [
      answer("b", "Partial"),
      {
        type: "system",
        subtype: "task_notification",
        task_id: "task_a",
        status: "completed",
        summary: "Looked",
        usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 },
      },
      {
        type: "system",
        subtype: "task_notification",
        task_id: "task_b",
        status: "stopped",
        summary: "B",
      },
    ]
      .map(line)
      .join(""),
  );
  const expected = async () =>
    (await listAgentSubagents(workspace, sessionId)).map(agentSubagentDigest);
  const digests = await listAgentSubagentDigests(workspace, sessionId);
  assert.deepEqual(digests, await expected());
  assert.deepEqual(
    digests.map(({ taskId, status, title, responseFingerprints }) => ({
      taskId,
      status,
      title,
      answers: responseFingerprints.length,
    })),
    [
      { taskId: "task_a", status: "completed", title: "Look", answers: 1 },
      { taskId: "task_b", status: "failed", title: "B", answers: 1 },
    ],
  );
  assert.equal(digests[0].usage.totalTokens, 10);

  // A later input starts another subagent, half a line at a time.
  const third = transcript("03_third");
  const text = line(started("c")) + line(answer("c", "Done c"));
  writeFileSync(third, text.slice(0, text.length - 7));
  appendFileSync(second, line(answer("b", "More b")));
  const partial = await listAgentSubagentDigests(workspace, sessionId);
  assert.deepEqual(partial, await expected());
  assert.equal(partial[1].responseFingerprints.length, 2);
  assert.equal(partial[2].responseFingerprints.length, 0);
  appendFileSync(third, text.slice(text.length - 7));
  const complete = await listAgentSubagentDigests(workspace, sessionId);
  assert.deepEqual(complete, await expected());
  assert.equal(complete[2].responseFingerprints.length, 1);
});

/**
 * The list as it was built from every subagent record of every input
 * before lists kept only what they show: the reference a list must equal.
 */
async function recordsList(workspace, sessionId, paths) {
  const records = [];
  for (const path of paths) records.push(...(await readSubagentRecords(path)));
  const text = (value) => (typeof value === "string" ? value : "");
  const answers = (record) => {
    const content =
      record.type === "assistant" && record.message?.role === "assistant"
        ? record.message.content
        : undefined;
    if (typeof content === "string") return content.trim() ? [content] : [];
    if (!Array.isArray(content)) return [];
    return content.flatMap((item) =>
      typeof item === "string"
        ? item.trim()
          ? [item]
          : []
        : item?.type === "text" && text(item.text).trim()
          ? [item.text]
          : [],
    );
  };
  const status = (notification) =>
    ({ failed: "failed", completed: "completed", stopped: "failed" })[
      text(notification?.status)
    ] ?? "running";
  return records
    .filter(
      (record) =>
        record.type === "system" &&
        record.subtype === "task_started" &&
        text(record.task_type) === "local_agent" &&
        text(record.task_id) &&
        text(record.tool_use_id),
    )
    .map((started) => {
      const notification = [...records]
        .reverse()
        .find(
          (record) =>
            record.type === "system" &&
            record.subtype === "task_notification" &&
            text(record.task_id) === started.task_id,
        );
      const usage = notification && claudeSubagentUsage(notification);
      return {
        prompt: text(started.prompt) || undefined,
        responseTexts: [
          ...new Set(
            records
              .filter(
                (record) =>
                  text(record.parent_tool_use_id) === started.tool_use_id,
              )
              .flatMap(answers),
          ),
        ],
        sessionId,
        status: status(notification),
        subagentType: text(started.subagent_type) || undefined,
        taskId: started.task_id,
        title:
          text(started.description) ||
          text(notification?.summary) ||
          "Subagent",
        toolUseId: started.tool_use_id,
        ...(usage ? { usage } : {}),
      };
    });
}

test("a session's list and digests equal those of its full records, across many inputs and appends", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "foundry-subagent-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const sessionId = "sess_many_inputs";
  const inputs = join(workspace, ".foundry", "sessions", sessionId, "inputs");
  const line = (record) => `${JSON.stringify(record)}\n`;
  const started = (id, extra = {}) => ({
    type: "system",
    subtype: "task_started",
    task_id: `task_${id}`,
    task_type: "local_agent",
    tool_use_id: `tool_${id}`,
    description: `Task ${id}`,
    prompt: `do ${id}`,
    ...extra,
  });
  const answer = (id, content) => ({
    type: "assistant",
    parent_tool_use_id: `tool_${id}`,
    message: { role: "assistant", content },
  });
  const notification = (id, status, extra = {}) => ({
    type: "system",
    subtype: "task_notification",
    task_id: `task_${id}`,
    status,
    summary: `${id} ${status}`,
    ...extra,
  });
  // More inputs than the record cache keeps files, as in a long session.
  const paths = [];
  for (let index = 0; index < 24; index++) {
    const id = `n${index}`;
    const directory = join(inputs, String(index).padStart(3, "0"));
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "claude-sdk.messages.jsonl");
    paths.push(path);
    writeFileSync(
      path,
      [
        {
          type: "assistant",
          parent_tool_use_id: null,
          message: { role: "assistant", content: "main thread" },
        },
        started(
          id,
          index % 3 ? {} : { subagent_type: "Explore", description: "" },
        ),
        {
          type: "system",
          subtype: "task_started",
          task_id: `bash_${id}`,
          task_type: "local_bash",
          tool_use_id: `tool_bash_${id}`,
        },
        answer(id, [
          { type: "text", text: `Looking at ${id}` },
          { type: "tool_use", id: `use_${id}`, name: "Read", input: {} },
        ]),
        {
          type: "user",
          parent_tool_use_id: `tool_${id}`,
          message: {
            role: "user",
            content: [{ type: "tool_result", content: "x".repeat(4000) }],
          },
        },
        // A subagent's own subagent.
        started(`${id}_inner`, { parent_tool_use_id: `tool_${id}` }),
        answer(`${id}_inner`, `inner ${id}`),
        answer(id, `Looking at ${id}`),
        answer(id, ["plain string block", { type: "text", text: "   " }]),
        ...(index % 4 === 0 ? [notification(id, "running")] : []),
        notification(
          id,
          ["completed", "failed", "stopped"][index % 3],
          index % 2
            ? { usage: { total_tokens: index, tool_uses: 1, duration_ms: 5 } }
            : {},
        ),
        // A later input answers for an earlier input's subagent.
        ...(index > 0 ? [answer(`n${index - 1}`, `late answer ${index}`)] : []),
      ]
        .map(line)
        .join(""),
    );
  }
  const assertEqualsRecords = async () => {
    const expected = await recordsList(workspace, sessionId, paths);
    const list = await listAgentSubagents(workspace, sessionId);
    assert.equal(JSON.stringify(list), JSON.stringify(expected));
    assert.deepEqual(
      await listAgentSubagentDigests(workspace, sessionId),
      expected.map(agentSubagentDigest),
    );
    return list;
  };
  const list = await assertEqualsRecords();
  assert.equal(list.length, 48);
  assert.equal(list[0].responseTexts.length, 3);
  // Read again unchanged, then after an append ending in half a record.
  await assertEqualsRecords();
  const last = paths.at(-1);
  const tail =
    line(answer("n23", "final")) + line(notification("n23", "completed"));
  appendFileSync(last, line(started("extra")) + tail.slice(0, -9));
  const partial = await assertEqualsRecords();
  assert.equal(partial.at(-1).taskId, "task_extra");
  appendFileSync(last, tail.slice(-9));
  const complete = await assertEqualsRecords();
  assert.equal(
    complete.find((subagent) => subagent.taskId === "task_n23").status,
    "completed",
  );
});

test("a subagent's transcript read from the inputs holding it is the one read from all of them", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "foundry-subagent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const line = (record) => `${JSON.stringify(record)}\n`;
  const started = (id, extra = {}) => ({
    type: "system",
    subtype: "task_started",
    task_id: `task_${id}`,
    task_type: "local_agent",
    tool_use_id: `tool_${id}`,
    description: `Task ${id}`,
    prompt: `do ${id}`,
    ...extra,
  });
  const message = (id, uuid, role, content, extra = {}) => ({
    type: role,
    uuid,
    parent_tool_use_id: `tool_${id}`,
    message: { role, content },
    ...extra,
  });
  // Twenty inputs: the subagent starts in the fourth, answers there and in
  // the eighth, and a line in the twelfth quotes its parent key in a field.
  const inputs = Array.from({ length: 20 }, (_, index) => [
    line(started(`other${index}`)),
    line(
      message(`other${index}`, `o${index}`, "assistant", [
        { type: "text", text: `other ${index}` },
      ]),
    ),
  ]);
  inputs[3].push(
    line(started("bash", { task_type: "local_bash" })),
    line(started("target", { subagent_type: "Explore" })),
    line(
      message("target", "t1", "assistant", [
        { type: "text", text: "Reading" },
        {
          type: "tool_use",
          id: "use_1",
          name: "Read",
          input: { path: "a.ts" },
        },
      ]),
    ),
    line(
      message("target", "t2", "user", [
        { type: "tool_result", tool_use_id: "use_1", content: "file body" },
      ]),
    ),
  );
  inputs[7].push(
    line(
      message("target", "t3", "assistant", [
        { type: "text", text: "Found it" },
      ]),
    ),
  );
  inputs[11].push(
    line(
      message(
        "other11",
        "q1",
        "assistant",
        [{ type: "text", text: "quoted" }],
        { note: { parent_tool_use_id: "tool_target" } },
      ),
    ),
  );
  inputs[15].push(
    line({
      type: "system",
      subtype: "task_notification",
      task_id: "task_target",
      status: "completed",
      summary: "done",
      usage: { total_tokens: 7, tool_uses: 1, duration_ms: 3 },
    }),
  );
  const session = (name, files) => {
    const workspace = join(root, name);
    files.forEach((text, index) => {
      const directory = join(
        workspace,
        ".foundry",
        "sessions",
        "sess_t",
        "inputs",
        String(index).padStart(3, "0"),
      );
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "claude-sdk.messages.jsonl"), text);
    });
    return workspace;
  };
  const split = session(
    "split",
    inputs.map((lines) => lines.join("")),
  );
  const whole = session("whole", [inputs.flat().join("")]);
  const read = (workspace, taskId) =>
    readAgentSubagentTranscript(workspace, "sess_t", taskId).then(
      (value) => JSON.stringify(value),
      (error) => `error: ${error.message}`,
    );
  for (const taskId of [
    "task_target",
    "task_other3",
    "task_other19",
    "task_bash",
    "task_missing",
  ])
    assert.equal(await read(split, taskId), await read(whole, taskId), taskId);
  const transcript = JSON.parse(await read(split, "task_target"));
  assert.equal(transcript.status, "completed");
  assert.equal(transcript.usage.totalTokens, 7);
  assert.equal(transcript.subagentType, "Explore");
  const contents = transcript.messages.map((item) => item.content);
  assert.equal(contents.length, 5);
  assert.deepEqual(
    [contents[0], contents[1], contents[3], contents[4]],
    ["do target", "Reading", "file body", "Found it"],
  );
  assert.match(await read(split, "task_bash"), /subagent task was not found/);
});
