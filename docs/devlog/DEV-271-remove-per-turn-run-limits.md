# DEV-271 去掉助理每一轮的 Token 与时长上限

状态：已部署 dev（2026-11-17）；待本人验收；已合入 main（PR #274）。

2026-11-17。本人问「为什么会有这种约束啊？是不是过度防御了？别这么搞啊。」Foundry 按原生 Agent 厂商的方式运行，不自行判断杀掉仍在工作的一轮。DEV-267 把预算计数修正后，本人仍决定整项去掉。

## 去掉的

- Server 运行控制：`personalagent/run_config.go` 不再给 `TokenBudget`（默认 50 万已观察 token）与 `TimeoutMinutes`（默认 30 分钟）填默认值，也不再校验它们（旧设置 JSON 仍可读、不生效）。
- `personalagent/assistant/run_control.go` 删掉按已观察 token 与已运行时长发起停止的两段；控制只保留「有人要求停止」的路径（本人的停止、停止开关、调用方），仍按精确输入取消，仍然记录停止原因。
- Server 不再读取设备上的 native 用量：删掉 `Devices.InputTokens` 端口、`observeAssistantInputTokens`、`observedTurnTokens` 及读取原生日志的客户端方法；`mcp_progress` 不再报告 token/时长预算进度；`sessionprogress.Budget`/`UsageSince` 随之删除。
- 运行快照/输入/RunControl 不再携带预算值（`ExecutionBudget` 仍以 `SnapshotID` 标记一次固定运行，供授权与停止使用；旧 JSON 字段保留可读）。
- Worker：Claude/Codex/profile-command 不再用 `executionBudget.timeoutMinutes` 收紧本轮时限；Codex 非流式传输不再因「无法执行角色 deadline」拒绝运行。
- Web：助理设置去掉预算说明与运行面板的「已观测 / 预算 / 时限」一行；DEV-267 的「这一轮用量超过上限 / 超时」文案与映射删除，停止仍显示「已停止」，失败仍是「没有完成：<原因>」，都可重试。
- 文档：`docs/personal-agent.md` §9 的每轮上限段落删除。

## 保留的

- 本人的停止与「继续」，以及 `pa_run_controls` 的停止状态机（精确输入、原生结束回执）。
- DEV-267 的真实原因：Server 的停止原因覆盖 Worker 的通用取消，界面只说「已停止」。
- §9 的其他上限不变（供本人复核）：同时在跑的助理会话 4/8；每天新派出会话 30/100；每天/每周新建项目 3/10 与 10/30；每小时助理轮次 60/120；每天概括会话 50/200；单个任务 4 小时无人过问标为「可能卡住」并告知；每月用量预算（默认关）。

## 测试

- 删除只验证预算停止的 `personal_agent_budget_test.go` 和旧的 `TestAssistantCreateSessionAppliesExecutorBudget`。
- `personal_agent_helper_session_test.go`：旧设置里的 1234/7 预算不再进入帮助会话的输入、快照或控制，但固定运行与停止控制仍在。
- 新增 `TestAssistantLongTurnIsNeverStoppedByFoundry`：一轮已用远超旧上限、观测时钟很旧、控制仍为 monitoring 时，`ReconcileRunControl` 不停止、会话仍 running。
- `run_config_test.go`：默认解析不再填 500000/30。
- 远程（CanWendeMac-mini，`scripts/remote-check.sh`，工作树）：httpapi 定向测试（`TestAssistantLongTurnIsNeverStoppedByFoundry|TestAssistantRunControlReasonWinsOverWorkerCancel|TestAssistantCreateSessionKeepsLegacyBudgetInert|TestAssistantStopOfflineWaitsForEvidence`）通过，随后 `pnpm --filter @foundry/web build` 生产构建通过（PASS，device 88s）。Worker `tsc --noEmit` 通过。
- 顺带修了工作树里的一处既有编译阻塞：`packages/protocol/src/annotations.ts` 从 `daemon-messages.js` 导入 `SessionInputAnnotation`，而后者并不导出它；改为从 `contract.gen.js` 导入。远程 `pnpm install` 会构建 protocol，若不改，生产构建在依赖安装阶段就失败。

## 限制

- 设置 JSON 里旧版本的 tokenBudget/timeoutMinutes 保留但被忽略；保存设置时不再复制它们。
- 已部署 dev（2026-11-17）；待本人验收；已合入 main（PR #274）。
