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
