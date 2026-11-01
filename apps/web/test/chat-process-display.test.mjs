import assert from "node:assert/strict";
import test from "node:test";
import {
  compactProcessToolDetail,
  isProcessRowRunning,
  processDisplayRows,
  processDisplaySummaryTitle,
} from "../src/components/conversation/chat-process-display.ts";

test("projects shell tool JSON into a compact command detail", () => {
  assert.deepEqual(
    compactProcessToolDetail({
      detail:
        'Bash\n\n```json\n{\n  "command": "pnpm test",\n  "description": "Run tests"\n}\n```',
      snippet: "Bash",
      title: "Used tool",
    }),
    { content: "$ pnpm test", label: "Shell" },
  );
});

test("projects command output into a compact shell transcript", () => {
  assert.deepEqual(
    compactProcessToolDetail({
      detail: "pnpm test\n\n```\n97 tests passed\n```",
      snippet: "pnpm test",
      title: "Ran command",
    }),
    { content: "$ pnpm test\n\n97 tests passed", label: "Shell" },
  );
});

test("coalesces tool lifecycle pairs into result language for the viewer", () => {
  const items = [
    {
      title: "Running command",
      detail: "git diff -- src/app.ts",
    },
    {
      title: "Ran command",
      detail: "git diff -- src/app.ts\n\n```\ndiff output\n```",
    },
    {
      title: "Using tool",
      detail: "Bash\n\n```json\n{}\n```",
    },
  ];
  const rows = processDisplayRows(items, false);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    detail: "git diff -- src/app.ts\n\n```\ndiff output\n```",
    snippet: "git diff -- src/app.ts",
    labelKey: "ranCommand",
    title: "Ran a command",
  });
  assert.deepEqual(rows[1], {
    detail: "",
    snippet: "Bash",
    labelKey: "usedTool",
    title: "Used a tool",
  });
});

test("keeps repeated completed actions as separate rows", () => {
  const items = [
    {
      title: "Searching",
      detail: "needle",
    },
    {
      title: "Searched",
      detail: "needle",
    },
    {
      title: "Searching",
      detail: "needle",
    },
    {
      title: "Searched",
      detail: "needle",
    },
  ];

  assert.equal(processDisplayRows(items, false).length, 2);
});

test("collapses consecutive identical status notifications in live and saved turns", () => {
  for (const title of ["Compacting context", "Requesting model"]) {
    const items = Array.from({ length: 5 }, () => ({
      title,
      detail: "Claude is compacting the conversation context.",
    }));
    for (const streaming of [true, false]) {
      const rows = processDisplayRows(items, streaming);
      assert.equal(rows.length, 1);
      assert.equal(
        rows[0].snippet,
        "Claude is compacting the conversation context.",
      );
    }
  }
});

test("preserves status transitions and changes beyond the first detail line", () => {
  const compacting = {
    title: "Compacting context",
    detail: "压缩\n\n第一阶段",
  };
  const requesting = { title: "Requesting model", detail: "生成响应" };
  const items = [
    compacting,
    { ...compacting, detail: "压缩\n\n第二阶段" },
    requesting,
    compacting,
  ];
  assert.equal(processDisplayRows(items, true).length, 4);
});

test("preserves identical tool starts as distinct executions", () => {
  const item = { title: "Using tool", detail: "Bash" };
  assert.equal(processDisplayRows([item, item], true).length, 2);
});

test("builds a compact completed summary from unique behavior types", () => {
  const rows = processDisplayRows(
    [
      {
        title: "已读取文件",
        detail: "src/app.ts",
      },
      {
        title: "Ran command",
        detail: "pnpm test",
      },
    ],
    false,
  );

  assert.equal(
    processDisplaySummaryTitle(rows, "已处理 12s", false),
    "Read files and ran commands",
  );
});

test("keeps the active behavior in progress while streaming", () => {
  const rows = processDisplayRows(
    [
      {
        title: "已读取文件",
        detail: "src/app.ts",
      },
      {
        title: "Running command",
        detail: "pnpm test",
      },
    ],
    true,
  );

  assert.equal(rows.at(-1)?.title, "Running a command");
  assert.equal(
    processDisplaySummaryTitle(rows, "处理中", true),
    "Running a command",
  );
});

test("worker labels show in the viewer's language; agent titles stay as written", () => {
  const rows = processDisplayRows(
    [
      { title: "Running command", detail: "pnpm test" },
      { title: "Ran command", detail: "pnpm test\n\n```\nok\n```" },
      { title: "Inspect the parser", detail: "src/parser.ts" },
    ],
    false,
  );
  assert.deepEqual(
    rows.map((row) => [row.title, row.labelKey]),
    [
      ["Ran a command", "ranCommand"],
      ["Inspect the parser", undefined],
    ],
  );
  assert.equal(
    processDisplaySummaryTitle(rows, "Processed", false),
    "Ran commands",
  );
});

test("only the newest untyped step stays running; typed calls keep their own status", () => {
  const rows = processDisplayRows(
    [
      {
        title: "Requesting the model",
        detail: "Claude is generating a response.",
      },
      { title: "Thinking", detail: "Claude is processing the request." },
      {
        id: "a",
        callId: "c1",
        status: "running",
        title: "Using tool",
        detail: "Bash",
      },
      {
        title: "Requesting the model",
        detail: "Claude is generating a response.",
      },
      { title: "Thinking", detail: "Claude is processing the request." },
      {
        id: "b",
        callId: "c2",
        status: "completed",
        title: "Used tool",
        detail: "ToolSearch",
      },
      { title: "Thinking", detail: "Claude is processing the request." },
    ],
    true,
  );
  assert.deepEqual(
    rows.map((row) => [row.title, isProcessRowRunning(row)]),
    [
      ["Requesting the model", false],
      ["Finished thinking", false],
      ["Using a tool", true],
      ["Requesting the model", false],
      ["Finished thinking", false],
      ["Used a tool", false],
      ["Thinking", true],
    ],
  );
});
