# DEV-142 Claude 会话的上下文用量被夸大

## 问题

2026-11-06 本人：会话 `sess_1793895611867661522`（Claude，AsterGate · kiro/claude-opus-5-5 · High，CanWendeMac-mini）右侧显示「Context 1.6M / 1M · 157%」和红色“上下文已满”提示，实际只用了 3 个回合。

## 调查

- dev 数据库里该会话最后一条 `contextUsage` 为 1,571,849，与最新一次主线程 `requestUsage` 一致（cache read 1,571,207）。Server 与 Web 只显示最新值，错误来自 Worker。
- 与 Claude Code 自己每回合的 `result.usage` 对比（输出 token 每次完全一致）：

| 回合           | Foundry 按请求累加 | Claude Code result |
| -------------- | ------------------ | ------------------ |
| 3（1 个请求）  | 1,331,423          | 157,326            |
| 4（5 个请求）  | 7,902,026          | 1,021,261          |
| 2（55 个请求） | 36,260,850         | 5,641,507          |

- 根因：`ClaudeRequestUsageTracker`（`packages/worker/src/session/usage/turn-usage.ts`）把同一请求的 `message_start`、assistant 消息和 `message_delta` 的用量按字段取最大值。经 AsterGate/kiro 中转时，`message_start` 的提示词用量是估算值，常比 `message_delta` 高数倍（例：cache read 539,683 对 235,015），于是估算值胜出。Claude Code 的 `result.usage` 正好等于各请求 `message_delta` 之和（本机 9 个回合逐一核对）。
- 同一追踪器还产出每个请求的 `requestUsage`，所以界面上的单请求用量也被夸大；回合合计（“6.5M in”）来自 `result.usage`，是对的。Codex 用 rollout 的 `last_token_usage`，不受影响。

## 修复

`message_delta` 到达时，它报告的每个提示词计数（大于 0 的 input、cache read、cache write）替换 start 的估算值；没报告的保留 start 的值（有的中转在 start 只发 0，有的在 delta 不带提示词计数）；输出 token 仍取较大值。上下文用量仍是最新一次主线程请求的 input + cache read + cache write。

## 验证

- 新增回归测试 `packages/worker/test/request-usage-stream.test.mjs`：用真实请求的数字（start 539,683 / delta 235,015 → 235,352），以及 start 偏低、delta 不带提示词计数两种情况。`request-usage-stream`、`turn-usage`、`context-usage`、`step-usage`、`native-usage` 测试全部通过。
- 用本机真实 kiro 会话日志重放新旧追踪器：旧值 284,546 / 603,631 / 313,937，新值 148,990 / 269,317 / 138,462，与 Claude Code 的 `message_delta` 一致；原本一致的日志不变。

## 限制

- 原生聊天导入（`native-usage.ts`、`subagent-transcript.ts`、`native-chat-transcript.ts`）只读 assistant 消息的用量，经同类中转时可能同样偏高；尚未用真实原生 JSONL 核实。
- 已经记录的旧会话数值不会回改；会话的下一个请求结束后显示正确值。

## 验收步骤

1. Worker 更新后，在 `sess_1793895611867661522`（或任一 AsterGate 的 Claude 会话）发一条消息。预期：回答结束后 Context 显示几十万量级，不超过 1M，没有“上下文已满”提示。
2. 对比右侧 Tokens 行与 Context 行。预期：Context 不会因为一个回合里请求多就超过窗口。

## 时间线

- 2026-11-06 01:40 根因确认、修复与测试完成；未部署、未提交。

- 2026-11-06 03:20 UTC+8：已合入 main，PR #206（squash `03b62a30`）；dev Server/Web 已切到 main（Web `d8c1b9352ad92570`），Worker `0.5.7-dev.298.g03b62a30` 已发布并更新到 7 台在线设备（byte-dev、sg-chaos 各有旧执行宿主承载运行中的回合，结束后换新）。

## 后续：修复后仍显示 1.7M（2026-11-06）

本人反馈：Worker `0.5.7-dev.302` 下，`sess_1793895611867661522` 仍显示「Context 1.7M / 1M · 174%」和“上下文已满”。

### 调查

- 只读 dev 库的真实事件（01:51 UTC 这一请求 `msg_49baf…`）：01:51:43 “Thought”与 01:51:47 “Using tool”两个步骤各带 `requestUsage` 1,738,959（assistant 消息重复 `message_start` 的估算）；01:51:47.91 `contextUsage` 301,585；01:51:47.95 追踪器的 `requestUsage` 301,585 / 输出 691。Worker 存的值是对的。
- 右侧 Context 行与“上下文已满”来自 Server 推导的面板（`store.DeriveSessionPanel` → `deriveUsage` 取最新 `contextUsage`；Web `chat-context-model.ts` `chatSessionStatus` → `chat-session-status.tsx` `contextLevel`），不读请求报告。用真实事件按时间截断重放 `DeriveSessionPanel`：01:51:44 时为 1,736,451 / 1M（2026-11-05 18:29 旧 Worker 记下的最后一条报告，即 174%），01:51:47.93 起为 301,585 / 1M，最新为 302,757 / 1M（30%）。因此 174% 是修复前的旧报告，一直保留到修复后第一个请求结束；之后面板正确。若本人在 01:51:47 UTC 之后仍看到 174%，存储的事件无法复现，需截图时间或刷新后复核。
- 仍然偏高的是过程组的步骤用量（“1.7M in”）：真实事件经 Web 的 `sessionTranscriptEntries` + `projectTranscript` 重放，该组 `stepUsage.inputTokens` 为 1,738,959。三处按请求合并时逐字段取最大值，估算值胜过之后的结算值：
  - Web `transcript-adapters.ts` `applyRequestUsage`：结算报告并入已带估算的步骤时取 `Math.max`；
  - Web `transcript-projection.ts` `stepUsage`：同一请求的多个步骤取最大；
  - Server `sqlitestore/session_event_compaction_plan.go` `maxRequestUsage`：压缩空闲会话时把结算报告折进步骤后删除报告，同样取最大，会把估算值永久写进步骤。
- 契约（`contracts/models/chats.yaml` `ModelRequestUsage`）本就规定“its last report counts”，取最大违背契约。

### 修复

- 合并改为“后来的报告替换提示词计数（input、cache read、cache write），输出取较大值”：Web 新增 `laterRequestUsage`（`transcript-projection.ts`），`applyRequestUsage` 与 `stepUsage` 共用；Server 压缩的 `maxRequestUsage` 改为同语义的 `laterRequestUsage`，与 Web 保持一致。已记录的会话（两种报告都在）重新打开即显示正确值。
- Worker 不改：步骤上的估算是第一份报告，追踪器的结算报告总在其后到达，按契约以后者为准。去掉步骤用量会让无追踪器的后台续跑（`handleClaudeContinuationMessage`）与“思考后直接回答”的过程组失去用量，并破坏与原生聊天导入的一致性。代价：请求结算前的几秒内，步骤仍显示估算值。

### 验证

- 真实事件重放（Web 实际代码）：修改前过程组 1,738,959 in / 691 out，修改后 301,585 in / 691 out；下一组由 3,479,135 变为 604,342（301,585 + 302,757）。
- 新增回归测试：Web `apps/web/test/step-usage.test.mjs`（同一请求先报 1,738,959 再报 301,585 → 显示 301,585，Context 为 “301.6K / 1M · 30%”，等级 normal，无“上下文已满”；修改前失败）；Server `TestPlanFoldsTheSettledPromptOverAnOverstatedStep`（修改前失败）；Worker `request-usage-stream.test.mjs` 固定契约：步骤带估算、追踪器给出 301,585。
- `step-usage`、`session-event-compaction`、`transcript-pipeline`、`agent-questions-thread`（Web），`go test ./internal/sqlitestore -run TestPlan`、`./internal/httpapi -run TestSessionEventCompaction`，Worker `request-usage-stream`、`step-usage` 通过；Web `pnpm typecheck`、Worker build 通过。

### 限制

- 修改前已被压缩的会话，结算报告已删、步骤上存的是最大值，无法回改。
- 原生聊天与子代理转录仍只有 assistant 消息的估算（见上文限制）。

### 验收步骤

1. 部署 Server/Web 后打开 `sess_1793895611867661522`。预期：右侧 Context 约 300K / 1M（30% 上下），无“上下文已满”；01:51 那组步骤显示约 302K in，而不是 1.7M。

- 2026-11-06 16:40 UTC+8（编排接手）：发现这一轮的 Server 部分从未生效——10:10 做了备份、11:24 重启过，但运行的仍是 05:25 构建的二进制（`grep -a` 只有 `maxRequestUsage`，没有 `laterRequestUsage`）。从 dev 工作区重新构建 Server（含 `laterRequestUsage`），在线备份 `backups/foundry-20261106-1640-pre-server-dev142b.db`（integrity ok），旧二进制留作 `releases/dev023-candidate/foundry-server.pre-dev142b-server`，`pm2 restart foundry-server`（不带 `--update-env`）；healthz 200，7 台在线设备全部重连。部署前 `go test ./internal/sqlitestore -run TestPlan`（含 `TestPlanFoldsTheSettledPromptOverAnOverstatedStep`）、`./internal/httpapi -run SessionEventCompaction|External` 通过。Web 部分已在 build `71bb496ba70152fb` 中。
- 2026-11-06 16:55：真实浏览器复核（scratch 栈 `verify1106`：dev 库副本 + 当前工作区构建，集成关闭；只在副本里重置本人密码登录）：`sess_1793895611867661522` 右侧 Context 为「390K / 1M · 39%」，无“上下文已满”。截图 `.foundry/attachments/verify1106/ctx-light.png`（仓库外）。

- 2026-11-07 01:05 UTC+8：已合入 main，PR #215（squash `c51ea1bd`），即本节“后续”；合入前已部署 dev（Server、Web，Worker `0.5.7-dev.303.g1837af21.local.1793959952` 已更新到全部在线设备，macbook 于 2026-11-07 00:00 UTC+8 前后更新），合入后未重新部署。
