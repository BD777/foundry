# DEV-249 后台任务的命令和输出放在「展开」里的代码块

2026-11-16。本人反馈（截图：`att_dmweucqo60qd_0_image.png`，DEV-246 的回合来源行）：

> 这个样式不错是不错，但 background 的具体内容（如果是 shell 命令或者其他 code 那种），可以分别展示，在下面搞个「展开」然后用 code 组件包住之类的，会更好。

状态：已部署 dev（train14-20261116）；Agent 代验收（2026-11-16，范围见验收记录）；已合入 main（PR #271）。本项仅以定向测试、typecheck、UI audits 与合成截图验证，未做真实检查。

## 问题

DEV-246 的 `TurnSourceRow` 把后台任务的提示词首行（最长 200 字符）当作标题，于是整条命令挤在标题行：

```
后台任务完成：Background command "export PATH=…; for i in $(seq 1 36); do out=$(olk im read … | python3 -c '
```

标题既读不出「做了什么」，也看不到完整的命令、退出状态和输出。

## 改动

### 契约：完成的后台任务带公开字段（DEV-249）

- 新增 `AgentSessionTimerFireTask`：`id`、`kind`（command/monitor/workflow/subagent/other）、`description`、`status`（running/completed/failed/stopped/ended）、`exitCode`。
- `AgentSessionTimerFire` 新增 `tasks` 数组。它只带公开字段：命令和输出仍只经成员权限的 output 读取，事件不携带命令（沿用 `AgentBackgroundTask` 的既有约束）。
- 生成文件同步更新（Go / TS / schema）。

### Worker

- `runtime.notifications` 从「摘要字符串」改为 `{ taskId, summary }`：`task_notification` 即使没有摘要也记下任务 id。
- `finishClaudeContinuation` 在发布后台续答时，从 `ClaudeBackgroundTaskTracker.snapshot()` 取出这些任务的公开字段，写进 `timerFire.tasks`。提示词仍保留摘要拼接，旧读者不受影响。

### Web

- `transcript-adapters.ts` 的 timer-fire 转换：
  - `continuationBody`：整段提示词（上限 8 KB），供展开查看；
  - `continuationCatchUp`：补发的定时任务仍显示「延迟送达」说明；
  - `backgroundTasks`：来自 `timerFire.tasks`，并补上会话 id，供命令/输出读取。
- `turn-source.ts`：
  - 后台行不再把提示词塞进标题；有结构化任务时标题只用任务描述/类型/结果，否则只显示「后台任务完成」。
  - 定时任务标题取首行、最长 80 字符；提示词更长或多行时，完整内容进入展开区。
- `turn-source-row.tsx`：
  - 标题行：`后台任务完成 · 命令 · <任务描述> · exit 0 · 时间`；多个任务显示「后台任务完成 · N 个任务」。
  - 「展开 / 收起」默认收起。展开后命令用聊天里 Markdown 围栏同一套 `CodeBlock`（`bash`，带复制按钮），输出末尾用第二个 `CodeBlock`（`text`，最多 2 KB）。
  - 命令和输出按需经既有 `GET /api/agent-sessions/{id}/background-tasks/{taskId}/output` 读取，沿用其成员权限；非成员展开时看到「仅工作区成员可查看」。
  - 旧事件没有任务 id：只把提示词/摘要放在展开区，按纯文本显示，不猜测命令。
  - 定时任务的展开区显示完整提示词（纯文本，限高滚动）。
- 来源行正文的 Markdown：helper 汇报、其他会话的消息、Foundry 通知用聊天回答同一个 `MarkdownContent` 渲染（新增 `compact` 走 1.45 行高），保留 6 行折叠与「展开完整内容」；本人的文本和通道消息保持原样，不套 Markdown。
- `chat-message-list.tsx` 的 memo 比较补上新增字段；中英文案同步。

## 验证

- Worker 定向测试（本机，`packages/worker`）：`test/claude-background-task-lifecycle.test.mjs` 8 pass；断言后台续答的 `timerFire.tasks` 为 `{id: bsleep, kind: command, description: "Sleep 12 minutes", status: completed, exitCode: 0}`，且不含 `command`。
- Web 定向测试（本机 + CanWendeMac-mini）：`test/session-turns.test.mjs` 10 pass；覆盖结构化任务、旧事件、定时任务长提示词的标题/展开。
- Web typecheck：CanWendeMac-mini PASS（`remote-check … --web typecheck`）。
- `audit:ui`（15 个 audits）：CanWendeMac-mini PASS（含 `audit:copy` 0 debt、`audit:state-layout`、`audit:component-system`、`audit:hints`）。
- 截图：scratch stack（从本 worktree 构建）以 e2e-alice 登录，浏览器内替换所选会话的 `agent-session-threads` / `foundry-data` 响应为合成事件，并 mock 该任务的 output 读取（未写栈内数据）：
  - `.foundry/attachments/dev249/dev249-collapsed-light.png`（1440，浅色，收起）
  - `.foundry/attachments/dev249/dev249-expanded-light.png`（1440，浅色，展开命令/输出）
  - `.foundry/attachments/dev249/dev249-collapsed-narrow.png`（390，浅色，收起）
  - `.foundry/attachments/dev249/dev249-expanded-narrow.png`（390，浅色，展开）
  - `.foundry/attachments/dev249/dev249-report-markdown-light.png`（1440，helper 汇报的 Markdown 正文）

## 验收步骤

1. 本人提问后，后台任务结束并异步续答：来源行标题为「后台任务完成 · 命令 · <任务描述> · exit 0 · 时间」，不再出现整条命令。
2. 点「展开」：命令以 `bash` 代码块显示（带复制），输出末尾以 `text` 代码块显示；再点「收起」恢复。
3. 非工作区成员展开时显示「命令和输出仅工作区成员可查看」。
4. 定时任务的提示词很长或多行时，标题只显示首行（最多 80 字符），展开显示完整提示词。
5. 旧的后台任务事件没有任务 id：标题只有「后台任务完成」，提示词/摘要在展开里按纯文本显示。
6. helper 汇报、其他会话消息或 Foundry 通知的正文按 Markdown 渲染（粗体、`代码`、列表），超过 6 行仍可展开；本人消息和通道消息不套 Markdown。

## 限制

- 本次改动之前存下的后台事件没有 `timerFire.tasks`，无法从文本可靠地找回任务 id（不猜），因此这些行只有展开的纯文本摘要，没有命令/输出代码块。
- 命令和输出来自成员权限的既有读取接口；查看者没有成员权限时不会显示，截图中的 output 是浏览器 mock 的合成结果。
- 截图中的会话、任务描述与命令均为合成数据。
