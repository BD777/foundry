# DEV-240 一份编排指引、一个完成信号、create_session 的预算

状态：已部署 dev（train6-20261116）；Agent 代验收（2026-11-16，范围见验收记录）；已合入 main（PR #269）。

2026-11-16 E2E（`sess_1794776456356919583` 第 2 轮、`sess_1794778276586307621` 第 3 轮）：每个 helper 回合只有 `turn_end` 一个完成信号；needs_you 卡片创建后保持到本人回复。

## 问题

DEV-239 之后，助理已用通用的 `create_session` / `send_message` / turn_end，但还有三处遗留：

1. **编排指引有两份。** `foundry` 技能（所有会话都有）里是简短的协调规则，`assistant-handoff` 又重复了 brief 写法、派工与跟进；两者会漂移。
2. **完成有两个信号。** helper 的回合结束已经有通用子会话 turn_end 报告（`Foundry report:`）进助理对话，`supervision.go` 的 `followTask` 又发一条 `[Foundry] Finished:/Failed:` 通知。失败通知还带着 Foundry 自己判断的原因类别与“换哪个账号”的建议（设计研究要求把判断还给 agent）。
3. **直接 `create_session` 没有预算。** DEV-239 的已知限制：新 helper 只应用了 executor 的账号/模型/effort；token/时间预算只存在于 `dispatch_item` 的 `pa_run_snapshots` + `ExecutionBudget` 路径。
4. **E2E 反馈**：本人说“这个需要我拍板”时，助理只在 IM 回复、没有记 needs_you，「等你处理」里什么都看不到。这是判断，不能由 Foundry 强制，只能写进技能。

## 修复

**一份编排指引（foundry 技能）**

- `builtinskills/foundry/SKILL.md` 的“Coordinate with other sessions”改为完整的编排指引：brief 作为工作区文件（`$FOUNDRY_WORKSPACE/.foundry/briefs/<name>.md`）、executor 默认账号/模型/effort 与预算、一个孩子一个目标与一组文件、**一棵树一个写者**（被拒绝的第二个写者会指出持有工作区的会话）、turn_end 作为完成信号、自己读证据（`read_context` / `get_session`）、判断留在编排者、自排的定时唤醒（`create_scheduled_work`，不轮询）、`send_message` 的三种投递与回执。
- `assistant-handoff/SKILL.md` 只保留助理特有部分：本人的清单与 `dispatch_item` 的绑定、needs_you（“需要本人拍板的事要 `hand_over` 记进「等你处理」，频道里再简短说明已转交；进行中的一句 yes/no 可以直接在会话里问”）、权限包、频道（别人的话不算本人的话）。brief/派工/跟进细节指向 foundry 技能。
- 服务端与 Worker 的两份 foundry 技能保持字节一致；`builtinskills.go` 的 revision 40→41，`builtinskills_test` 记录新校验和。prompt 版本 2026-11-16.4→.5（含 E2E 那条），`promptVersions` 记录摘要。

**一个完成信号**

- `supervision.go` 的 `followTask` 在回合结束时只更新 `pa_tasks` 状态；完成与失败都不再另发通知。失败仍保留 `noteHelperFailedOffline`（电脑离线期间失败、待电脑回来时的事实）。
- 删除只有该通知使用的 `failedTaskLine`、`helperFailureReason`、`helperAccount`、相关原因常量/正则与文案；静默、卡住、连不上模型服务（带 `[reason=unreachable …]` 与可用账号观察）仍是事实通知。
- 同步更新 `docs/personal-agent.md` §6/通知/已建成与 `docs/assistant-orchestration.md` 的监督表。

**create_session 的预算**

- `run.Resolver.PinHelperInput`：按 input id 记录一份 `pa_run_snapshots`，角色 `executor`，预算取 `RunPreference(settings,"executor")` 的 `TokenBudget`/`TimeoutMinutes`，账号字段取 input 已经填好的值。
- `assistant.ApplyHelperDefaults`：父会话是助理对话时，除了填 executor 默认，还给 input 挂上 `ExecutionBudget`；`dispatch_item` 传入已 pin 的快照时不重复记录。直接 `create_session` 因而与派工走同一个快照 + `pa_run_controls` 机制，超时/超额会被 `ReconcileRunControl` 停止。
- `resolveNewSession` 在助理路径上先生成 input id（UUIDv7），让预算快照与 input 一一对应；同时显式写入 `CreatedByUserID`（agent 调用时 store 原本会从父会话补）。
- `sqlitestore.checkPARunInput` 的权限检查改用 `WorkspaceRoleAtLeast(Member)`，与通用准入一致（原先只认 owner/member 字面值，Maintainer 会被误拒）。

## 检查

- 新增 `TestAssistantCreateSessionAppliesExecutorBudget`：executor 覆盖为 1234 tokens / 7 分钟时，`create_session` 的 helper 带同一快照与 `pa_run_control`（monitoring）。
- `TestHandedOffWorkReportsBackToTheAssistant` 改为断言完成只到达一次：对话收到的是 `Foundry report:`（turn_end），没有 `[Foundry]` 完成通知；同一 helper 的报告只有一条；静默仍是一条事实通知。
- `TestFailedHelperTurnReachesTheAssistant`（原 `TestFailedHelperNoticeCarriesItsReason`）：失败经 turn_end 报告带状态与 error；不再断言原因类别/换账号建议。
- `TestAssistantHearsWhenAComputerIsBack`、`TestRuntimeSwitchRunsUnderAnAccountThatWorks`、`TestBlockedHelper…`、`TestRetryingHelper…` 按新契约调整；`personal_agent_wiring_test` 的助手改为用 `PumpInbox` 放置 turn_end（测试不跑后台泵）。
- 定向 Go 测试（CanWendeMac-mini，`scripts/remote-check.sh`，`-run`）：
  - `./internal/httpapi` 助理/turn_end/预算集：PASS；
  - `./internal/builtinskills`、`./internal/personalagent/prompt`、`./internal/personalagent/assistant`：PASS。
- 未部署、未提交。

## 限制

- `dispatch_item` 的 `pa_operations` outbox、item/plan 授权仍保留；一棵树一个写者的强制检查仍在派发路径（`checkPAOperationInput`），直接 `create_session` 只受技能指引约束，不在通用路径强制。
- 失败的结构化原因类别与“换哪个账号”建议不再由 Foundry 生成；助理读 turn_end 报告的 error 自行判断。电脑离线导致的失败仍会进入“电脑回来后”的事实通知。
- 预算快照让直接 `create_session` 的 helper 同样受助理停止开关与 `ReconcileRunControl` 约束（与派工一致）；历史 helper 没有预算快照，行为不变。

## 验收

1. helper 完成一个回合：助理对话只收到一条 `Foundry report:`，没有第二条 `[Foundry] Finished:`；失败同理，报告带 error。
2. 在助理设置里把 executor 的预算设为较小值，用 `create_session` 建 helper：会话的 input 带 `ExecutionBudget`，`pa_run_controls` 出现 monitoring 记录；超时或超 token 后运行被停止。
3. 说“这个需要我拍板”：助理用 needs_you `hand_over` 建卡（选项 + 推荐 + 沉默默认），「等你处理」可见；若来自频道，频道里另有一句已转交的简短回复。
4. 助手所在工作区已有写者时派第二步：收到指出持有会话的拒绝/排队事实，而不是静默等待。
