# DEV-239 助理使用通用会话机制：create_session 与 dispatch_item

状态：已部署 dev（train3-20261116）；Agent 代验收（2026-11-16，范围见验收记录）；已合入 main（PR #269）。

2026-11-16 E2E（`sess_1794776456356919583`，第 2 轮）：helper 提问经助理回答后继续，走的是通用会话与 `send_message` 路径。

## 问题

设计研究（`sess_1794765448749632375`）的结论是：助理就是范围更大的 Foundry Orchestrator，应该复用同一套原语，由四个参数 specialization：scope、executor 默认、report target、budget subject。但代码里助理仍被 `create_session` 拒绝（`errAssistantStartsByDispatch`），所有派工只能走 `dispatch_item`；`dispatch_item` 自己固定 executor、拼 brief 前导、单独选会话，是与通用 `create_session` 并行的一份实现。技能还明确要求“新工作必须走 dispatch_item，不能用 create_session”。

## 调查

- 拒绝点：`session_service.go` 的 `resolveNewSession`（REST `POST /api/agent-sessions` 与 MCP `create_session` 共用）最先按 `paScope` 拒绝助理；REST 的 `POST /api/agent-sessions/{id}/messages` 也有同样的拒绝。MCP `send_message` 的拒绝已由 DEV-236 删除。
- 通用准入已经具备大部分参数：`agentScope` 对助理会话按权限包收窄（`permission.Resolve`）；`sessions.Service.CreateAndDispatch` 调用 `Policy.AdmitAssistantSession`，父会话是助理对话时按人计 §9 限额（`CheckDelegate`）并 `RecordAssistantTask`；`ParentSessionID` 天然就是助理对话，也就是 report target。
- 缺的两块：`resolveNewSession` 没有用 `assistant.ScopeFor` 做起始准入；会话不带账号时没有应用 `executor` 角色的默认模型（`RunPreference` → `ResolveExecutor`）。
- 完成信号：`child_reports.go` 的 `childReportTarget` 对“助理任务”直接跳过，完成由 `supervision.go` 另行通知。这与“turn_end 是唯一完成信号”的方向相反，DEV-239 的测试要求 turn_end 能到助理。
- `dispatch_item` 的投递（`assistant/operations.go`）自己拼 “Personal Agent item … Saved goal … Proposed step” 前导；新会话用 `run.SessionInput(snapshot, …)` 而不是通用 `create_session` 的准入路径。

## 修复

**第一步：create_session**

- `resolveNewSession` 不再拒绝助理；它按 caller 是否为助理对话选择参数：助理用 `assistant.ScopeFor` 的 `CanStart`（权限包 ∩ Member）准入，其他 agent 仍走 `workspaceRefusal(..., Member)`。
- `assistant.Scope` 的 `owner` 改为 `role`，新增 `Role` / `Reaches` / `CanStart` / `StartRefusal`；越界时的拒绝文案与 `dispatch_item` 一致（“permissions do not include project …”）。
- `assistant.Service.ApplyHelperDefaults(ctx, input, pinned)`：父会话是助理对话且请求未点名账号（provider / profile / model / agent / workerGroup）时，用 `RunPreference("executor")` → `ResolveExecutor` 或调用方给出的 durable run 填 provider、profile、model、agent 和 effort；点名账号时保留调用方的选择。`resolveNewSession` 对助理跳过“runLikeParent 沿用父会话账号”，改为应用这个默认。
- budget subject：create_session 走 `CreateAndDispatch`，`AdmitSession` 看到父会话是助理对话，按人计 §9 并发/每日/月度 token，并 `RecordAssistantTask` 生成 `pa_tasks`；不再需要单独的计数器。
- report target：`childReportTarget` 不再因“助理任务”跳过；`personal_agent` 角色的父会话不再被当成 Issue 控制的父会话。helper 的 turn_end 直接进助理对话收件箱。
- `create_session` 工具描述写明助理用法、executor 默认与 §9 限额；REST 的消息入口也删掉了同样的拒绝。

**第二步：dispatch_item 走同一路径**

- `DeliverOperation` 的新帮手分支不再用 `run.SessionInput`，而是构造通用的 `CreateAgentSessionInput`（题目、input id、父会话、operation id/revision、snapshot 预算），然后 `ApplyHelperDefaults(ctx, &input, &snapshot)` → `ResolveDevice` → `CreateAndDispatch`。executor 选择、权限包、§9 计数、task 记录都走与 create_session 相同的代码。
- 续用已有会话仍是 `Send`（helper 自己的账号/模型，§f-4），前置的 `AdmitSession` 与权限包复查保持；三种投递不变。
- 去掉 Foundry 拼的 brief 前导：投递的 prompt 就是 `op.Prompt`（只保留 readOnly 的执行语义说明）。助理自己写 brief。
- `pa_operations` 仍是 durable outbox：捕获、lease、intent revision、input id、`PinExecutor`/`PinSession` 快照、投递状态与重试都未改；已捕获的 in-flight 操作按同一路径继续。
- `fillHelperRun` 是两条路径共用的字段填充（有 profile 时按 profile 选 agent，`device_default` 时固定快照里的 agent）。
- 文案：`assistant-handoff` 技能改为“像任何 orchestrator 一样用 `create_session` / `send_message`；工作属于本人清单事项时用 `dispatch_item` 把步骤绑到事项”；`dispatch_item` 工具描述/摘要改为 tie-to-item 的契约，`create_session` 说明什么工作不建事项。`docs/assistant-orchestration.md` §a 加了一段当前状态说明。

## 检查

- 新增 `personal_agent_helper_session_test.go`：
  - `TestAssistantCreatesHelperThroughCreateSession`：范围内建 helper，父会话是助理对话、Source `agent`、生成 pa_task、§9 计数 +1；
  - `TestAssistantCreateSessionRefusesOutOfScopeWorkspace`：权限包外拒绝，包内成功；
  - `TestAssistantCreateSessionAppliesExecutorDefault`：executor 覆盖为 `codex_local/cheap-model/low` 时 helper 就用它；
  - `TestAssistantHelperTurnEndReachesTheConversation`：helper 完成回合后，助理对话收到 `turn_end` 子报告并带答案；
  - `TestLegacyInFlightOperationDrainsThroughTheGenericPath`：把已捕获的操作置为 `dispatching`（模拟改动前就在途），经新路径投递出会话，投递的 prompt 与助理原文完全一致（无前导），回合完成后操作归到 `review/execution_completed_requires_evidence`。
- 既有测试按新契约更新：`personal_agent_remember_source_test.go`、`session_device_wait_test.go` 不再断言 create_session 被 `dispatch_item` 拒绝；`TestAssistantToolDescriptionsStateOnlyTheirContract` 去掉 DEV-236 已删除的 needs_you 截止文案断言。
- 定向 Go 测试（CanWendeMac-mini，`scripts/remote-check.sh`，`-run`）：
  - `./internal/httpapi -run 'TestAssistant|TestChildReport|TestHelperModel|TestExecutor|TestPermissionPackage|TestNonDefaultAssistant'`：PASS；
  - `./internal/personalagent/... ./internal/sessions ./internal/permission`：PASS。
- 未部署、未提交。

## 限制

- 直接 `create_session` 不写 `pa_run_snapshots`，因此不设置执行 token/时间预算（通用 `checkPARunInput` 需要已记录的 snapshot）；executor 的账号、模型、effort 已应用。`dispatch_item` 仍用 pin 的 snapshot 设置预算。
- `supervision.go` 仍会在完成时另发一次通知，在 DEV-240 退休前可能与 turn_end 重复。
- helper 仍受通用 per-parent 限制（同一父会话 8 个活跃子会话、4 层嵌套）。

## 验收

1. 助理在权限包允许的 Workspace 调用 `create_session`：返回会话 id，父会话是助理对话，`list` 里出现对应任务，助理的 §9 计数增加。
2. 对权限包外的 Workspace 调用：返回 403，文案说明去助理设置 → Permissions 添加。
3. 在助理设置里把 executor 换成另一个账号/模型，再建 helper：新会话用该账号/模型。
4. 通过 `dispatch_item` 派出清单事项的一步：把同一个 prompt 作为 brief 送达，没有 Foundry 的 “Saved goal / Proposed step” 前导；操作仍可重试且幂等。
5. helper 完成一个回合：助理对话收到 `turn_end`，带标题、状态和答案。
