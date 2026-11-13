import assert from "node:assert/strict";
import test from "node:test";

const { claudeWriteRefusal, codexWriteRefusal, workspaceWriteRefusedLabel } =
  await import("../dist/session/workspace-write-refusals.js");

const ws = "/home/person/channel-ws";

test("the event is named for the person", () => {
  assert.equal(workspaceWriteRefusedLabel, "Workspace write refused");
});

test("a Bash write the read-only workspace refused names the path", () => {
  assert.equal(
    claudeWriteRefusal(
      {
        name: "Bash",
        input: { command: "echo x >> AGENTS.md" },
        content: "/bin/bash: line 1: AGENTS.md: Read-only file system",
        failed: true,
      },
      ws,
    ),
    `${ws}/AGENTS.md`,
  );
  assert.equal(
    claudeWriteRefusal(
      {
        name: "Bash",
        input: { command: "touch notes/a.md" },
        content: [
          {
            type: "text",
            text: "touch: cannot touch 'notes/a.md': Read-only file system",
          },
        ],
        failed: false,
      },
      ws,
    ),
    `${ws}/notes/a.md`,
  );
});

test("an Edit refused with EROFS names its file", () => {
  assert.equal(
    claudeWriteRefusal(
      {
        name: "Edit",
        input: {
          file_path: `${ws}/AGENTS.md`,
          old_string: "a",
          new_string: "b",
        },
        content: `EROFS: read-only file system, open '${ws}/AGENTS.md'`,
        failed: true,
      },
      ws,
    ),
    `${ws}/AGENTS.md`,
  );
});

test("unrelated errors and writes outside the workspace are not refusals", () => {
  const cases = [
    {
      name: "Bash",
      input: { command: "npm test" },
      content: "Error: expected 1 to equal 2",
      failed: true,
    },
    {
      name: "Bash",
      input: { command: "cat secret" },
      content: "cat: secret: Permission denied",
      failed: true,
    },
    {
      name: "Bash",
      input: { command: "touch /usr/x" },
      content: "touch: cannot touch '/usr/x': Read-only file system",
      failed: true,
    },
    {
      name: "Edit",
      input: { file_path: `${ws}/AGENTS.md` },
      content: "String to replace not found in file.",
      failed: true,
    },
    {
      name: "Write",
      input: { file_path: "/tmp/x" },
      content: "EROFS: read-only file system, open '/tmp/x'",
      failed: true,
    },
    {
      name: "Read",
      input: { file_path: `${ws}/AGENTS.md` },
      content: "EROFS",
      failed: true,
    },
  ];
  for (const tool of cases)
    assert.equal(claudeWriteRefusal(tool, ws), undefined, JSON.stringify(tool));
});

test("Codex commands and failed file changes inside the workspace are refusals", () => {
  assert.equal(
    codexWriteRefusal(
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "bash -lc 'echo x > AGENTS.md'",
          aggregated_output: "bash: line 1: AGENTS.md: Read-only file system\n",
          exit_code: 1,
          status: "failed",
        },
      },
      ws,
    ),
    `${ws}/AGENTS.md`,
  );
  assert.equal(
    codexWriteRefusal(
      {
        type: "item.completed",
        item: {
          type: "file_change",
          status: "failed",
          changes: [{ path: `${ws}/src/a.ts`, kind: "update" }],
        },
      },
      ws,
    ),
    `${ws}/src/a.ts`,
  );
  assert.equal(
    codexWriteRefusal(
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "make",
          aggregated_output: "make: *** [all] Error 2\n",
          status: "failed",
        },
      },
      ws,
    ),
    undefined,
  );
  assert.equal(
    codexWriteRefusal(
      {
        type: "item.completed",
        item: {
          type: "file_change",
          status: "completed",
          changes: [{ path: `${ws}/a.ts`, kind: "update" }],
        },
      },
      ws,
    ),
    undefined,
  );
});

test("the detail stays short", () => {
  const long = "a".repeat(400);
  const detail = claudeWriteRefusal(
    {
      name: "Bash",
      input: { command: "x" },
      content: `touch: cannot touch '${long}': Read-only file system`,
      failed: true,
    },
    ws,
  );
  assert.ok(detail.length <= 300);
});
