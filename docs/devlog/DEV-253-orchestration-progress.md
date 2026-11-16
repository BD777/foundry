# DEV-253 编排者按需拉取子会话进度

状态：已部署 dev（train13-20261116）；Agent 代验收（2026-11-16，范围见验收记录）；已合入 main（PR #271）。本项仅以定向测试与事件夹具验证，未做真实检查。只实现研究答案的切片 1、2、5；切片 3（重复失败/静默的推送通道）与切片 4（预算推送）按要求暂缓，没有投递路径。

本人的约束原话（2026-11-16）：

> 很担心你不得不注入过度的 prompt 给到 agent 导致他的行为扭曲

因此本次没有任何注入：不向 worker 会话写 prompt，也不向编排者或助理会话新增每轮提示。所有事实都从 Foundry 已经存储的事件日志计算，编排者需要时用工具拉取。

## 1. 进度事实（pull）

`get_session`（与 `read_context scope=summary` 同一份 digest）新增紧凑的 `progress`：

- `status`；
- `lastEventAt` / `lastEvent`：最近一条可见事件；token 报告和 tool frame 这类只给查看器的记录不算；
- `lastError`：最近一条 error 级事件，压成一行、截到 200 字；
- `planStep`：运行时上报的 `Updated plan` 中第一个未完成项；
- `question`：仍在等待回答的问题标题（沿用 `waitingQuestion` 的判断）；
- `backgroundTasks`：最新后台任务快照里 `running` 的任务；
- `flags`：见第 2 节。

`read_context` 新增 `scope=progress`：同一 `progress` 加上最近的工具调用，每条有 `tool`、`detail`（去掉工具名和代码围栏后的一行）、`status`（`completed`/`failed`/`running`）、`startedAt`、`durationMs`。默认最新 10 条、最多 50 条，用 `offset`/`limit` 分页，返回 `totalToolCalls` 与 `earlier`/`later`。输出同样受 `maxBytes` 限制（默认 12 KB）。

工具调用从 `Using tool`/`Used tool`/`Tool failed` 配对，也覆盖 Codex 的 `Running command`/`Ran command`、`Searching`/`Searched`、`Editing file`/`Edited file`。有 call id 时按 id 配对，没有时按工具名先进先出；时长由开始和结束事件的时间差算出。

`list_sessions` 的 running/blocked 行带一个更小的 `progress`，只有 `lastEventAt`、`lastEvent` 和 `flags`，多个子会话一次调用即可扫一遍；queued 行不带（还没有工作可看）。

## 2. 确定性检测器（只拉取，不投递）

新增纯函数包 `apps/server/internal/sessionprogress`，输入是 `[]store.AgentSessionEvent`，不读设备、不写会话：

| flag              | 条件                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `repeatedFailure` | 当前回合内至少 3 条 `Tool failed`，工具名与归一化后的 detail 相同                                                          |
| `rateLimitStorm`  | 10 分钟内至少 5 条 `Rate limited, waiting to retry`                                                                        |
| `quiet`           | `running` 且最近一条非等待事件超过 25 分钟；排除 `Waiting for background tasks`、`Waiting for a slot`、`Waited for a slot` |
| `budget`          | 当前输入的用量达到 `ExecutionBudget` 的 80% 或 95%（token 与 `TimeoutMinutes` 分别计算）                                   |

当前回合从最近一条 `User message`、`Background task continued`、`Scheduled task fired` 开始，或从最近一条回合结束事件之后开始。token 用量把当前输入之后的 `RequestUsage`（输入 + 输出）相加；时间从 `StartedAt` 到 `CompletedAt`（未完成为当前时间）。检测器只出现在 `progress.flags`，没有 inbox 投递。

## 3. 编排指引（只写一次）

`apps/server/internal/builtinskills/foundry-orchestration/SKILL.md` 在 “Stay out of the work” 之后新增 “Watch a running child” 四条：

- 下一步 briefing 前、收到 alert 后、子会话异常久时看；多个子会话时一次 `list_sessions` 就带着每个 running 子会话的 `progress`；
- 先读 `progress`，再看过滤后的事件尾部；
- 只在有决策或阻塞时要 steer，默认用 `boundary`；
- 不要对子会话自己能解决的信号作出反应，也不要微观管理。

`assistant-handoff/SKILL.md` 只指向这一节，不重复内容。`get_session`、`read_context`、`list_sessions` 的 MCP 工具描述改为陈述新字段和上限（不写工作流指令）。foundry-orchestration revision 6→7，assistant prompt `2026-11-16.5`→`2026-11-16.6`（对应的 checksum/digest 已记录在测试里）。

## 4. 验证

- `go test ./internal/sessionprogress/`：事件夹具覆盖四个检测器、工具调用配对与时长、计划步骤、用量累加（本机通过）。
- `go test ./internal/builtinskills/ ./internal/personalagent/prompt/`：revision 与 digest 记录（本机通过）。
- 远程定向测试在 CanWendeMac-mini 通过：`TestGetSessionCarriesPullableProgress`、`TestReadProgressPagesToolCalls`、`TestListSessionsCarriesCheapProgress`，以及既有的 `TestGetSessionIsACompactSummary`、`TestReadEventsOverMCP`、`TestListSessionsPagesSlimSummaries`。

## 5. 限制

- 切片 3（把重复失败和静默推进 inbox）与切片 4（预算信号的推送）没有实现；本项的 flags 只能被拉取。
- `list_sessions` 行只计算事件日志能看出的 flags；`budget` 需要整个当前输入，只在 `get_session` 和 `scope=progress` 里给出。
- 原生 chat 没有 Foundry 的工具调用日志，`scope=progress` 对它只给状态、最近一条消息和错误。
- 列表进度读最近 200 条事件；若一个回合跨过这个窗口，`repeatedFailure` 的“当前回合”边界只能按窗口内最近的回合起点判断。
