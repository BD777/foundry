import assert from "node:assert/strict";
import test from "node:test";
import {
  compactProcessToolDetail,
  processDisplayRows,
  processDisplaySummaryTitle,
} from "../src/components/conversation/chat-process-display.ts";

test("projects shell tool JSON into a compact command detail", () => {
  assert.deepEqual(
    compactProcessToolDetail({
      detail:
        'Bash\n\n```json\n{\n  "command": "pnpm test",\n  "description": "Run tests"\n}\n```',
      snippet: "Bash",
      title: "已使用工具",
    }),
    { content: "$ pnpm test", label: "Shell" },
  );
});

test("projects command output into a compact shell transcript", () => {
  assert.deepEqual(
    compactProcessToolDetail({
      detail: "pnpm test\n\n```\n97 tests passed\n```",
      snippet: "pnpm test",
      title: "已执行命令",
    }),
    { content: "$ pnpm test\n\n97 tests passed", label: "Shell" },
  );
});

test("coalesces tool lifecycle pairs and presents terminal result language", () => {
  const items = [
    {
      title: "正在执行命令",
      detail: "git diff -- src/app.ts",
    },
    {
      title: "已执行命令",
      detail: "git diff -- src/app.ts\n\n```\ndiff output\n```",
    },
    {
      title: "正在使用工具",
      detail: "Bash\n\n```json\n{}\n```",
    },
  ];
  const rows = processDisplayRows(items, false);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    detail: "git diff -- src/app.ts\n\n```\ndiff output\n```",
    snippet: "git diff -- src/app.ts",
    title: "已执行命令",
  });
  assert.deepEqual(rows[1], {
    detail: "",
    snippet: "Bash",
    title: "已使用工具",
  });
});

test("keeps repeated completed actions as separate rows", () => {
  const items = [
    {
      title: "正在搜索",
      detail: "needle",
    },
    {
      title: "已搜索",
      detail: "needle",
    },
    {
      title: "正在搜索",
      detail: "needle",
    },
    {
      title: "已搜索",
      detail: "needle",
    },
  ];

  assert.equal(processDisplayRows(items, false).length, 2);
});

test("collapses consecutive identical status notifications in live and saved turns", () => {
  for (const title of ["正在压缩上下文", "正在请求模型"]) {
    const items = Array.from({ length: 5 }, () => ({
      title,
      detail: "Claude 正在整理会话上下文。",
    }));
    for (const streaming of [true, false]) {
      const rows = processDisplayRows(items, streaming);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].snippet, items[0].detail);
    }
  }
});

test("preserves status transitions and changes beyond the first detail line", () => {
  const compacting = { title: "正在压缩上下文", detail: "压缩\n\n第一阶段" };
  const requesting = { title: "正在请求模型", detail: "生成响应" };
  const items = [
    compacting,
    { ...compacting, detail: "压缩\n\n第二阶段" },
    requesting,
    compacting,
  ];
  assert.equal(processDisplayRows(items, true).length, 4);
});

test("preserves identical tool starts as distinct executions", () => {
  const item = { title: "正在使用工具", detail: "Bash" };
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
        title: "已执行命令",
        detail: "pnpm test",
      },
    ],
    false,
  );

  assert.equal(
    processDisplaySummaryTitle(rows, "已处理 12s", false),
    "已读取文件并运行了命令",
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
        title: "正在执行命令",
        detail: "pnpm test",
      },
    ],
    true,
  );

  assert.equal(rows.at(-1)?.title, "正在执行命令");
  assert.equal(
    processDisplaySummaryTitle(rows, "处理中", true),
    "正在执行命令",
  );
});
