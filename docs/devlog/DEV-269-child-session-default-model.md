# DEV-269 编排者的子会话不指定模型时，运行在目标工作区的 execution default 上

状态：已部署 dev（2026-11-17）；Agent 代验收（2026-11-17，范围见各自验收记录）；已合入 main（PR #274）。

2026-11-17。本人在 `sess_1794903494975054964`（ccm-omh-integration）指出 foundry-orchestrator 仍有 bug，要求先查清犯错路径、从机制上堵住，不要过度注入 prompt 或过度引导。

## 1. 事件与犯错路径（证据）

该会话跑在 hell-tw / claude-opus-5-5，使用 `/foundry-orchestration`。`read_context scope=progress`（22 次工具调用）里的关键顺序：

| 时间 (UTC) | 调用                                                                                                        | 结果                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 08:19:09   | `get_execution_default {workspaceId: ws_56c549f3…}`                                                         | 拿到工作区默认 codex `flux/GPT-6.1-Sol`（high）                    |
| 08:19:23   | `create_session` 显式 `profileId: prof_e1d4…`, `model: claude-opus-5-5`, `claudeEffort: high`               | 子会话 `sess_1794903590195723161`，hell-tw（照抄前几个会话的配置） |
| 08:21:50   | 本人提出后 `cancel_session`                                                                                 | 该子会话取消                                                       |
| 08:21:54   | `create_session` **不带任何模型参数**（正确的补救写法）                                                     | 子会话 `sess_1794903734506878786` **仍在 hell-tw**                 |
| 08:22:25   | `create_session` 显式 `provider: codex`, `profileId: codex_provider_llm_gateway`, `model: flux/GPT-6.1-Sol` | 子会话 `sess_1794903766920178431` 落在工作区默认                   |

根因在机制，不在 prompt：`resolveNewSession` 的 `runLikeParent` 分支只判断 `ProfileID == "" && Provider == ""`，在同一 Workspace 内直接复制父会话的 provider/profile（`session_service.go`）。目标工作区的 execution default 从未被查询；只有助理的 helper 走 `ApplyHelperDefaults` 才会用默认。于是「省略模型参数」这个最自然的正确写法恰好得到错误模型，agent 才得出「必须永远显式传模型」——错误的学习结论。

## 2. 设计选择（为什么这样改）

- **唯一解析器**：`run.Resolver.ResolveExecutionModels(ctx, userID, assistantModels, workspaceID)`（`internal/personalagent/run/resolve.go`）。优先级：助理自己的 execution models → Workspace 存储默认 → 全局默认。`get_execution_default` 与 `create_session` 都调用它；原来的 `executorModels` 变成它的薄封装，助理 `ApplyHelperDefaults` → `ResolveExecutor` 路径行为不变。
- `resolveNewSession` 只在原来的「复制父会话」位置调用它：agent 子会话、没有指名 provider/profile/model/workerGroupId、不是 fork、不是助理。组默认由 `selectWorkerGroup` 选成员（DEV-261 failover 继续生效）；单模型默认填入 provider、profile、model、effort。默认在目标电脑不可用、或工作区没有设置默认时，退回原有的 `chooseSessionAccount`，并在结果里说明原因。
- **显式选择原样保留**：调用方指名了任何一项，Foundry 不改写；结果行只在它不属于该工作区 execution models 时陈述事实。
- **其他路径不变**：REST（runLikeParent=false）、fork（沿用源会话的 agent）、助理 helper（ApplyHelperDefaults）、`send_message` 切换账号。
- **只加一行事实**：`create_session` 结果新增 `runsOn`，说明启动所用的模型和原因。没有向 prompt 或输入注入任何内容，没有新增指令。

## 3. 改动

- `apps/server/internal/personalagent/run/resolve.go`：新增 `ExecutionModels` 与 `ResolveExecutionModels`；`executorModels` 改为封装。
- `apps/server/internal/httpapi/execution_defaults.go`：`executionDefaults` 的 Effective 改由同一个解析器计算；`get_execution_default` 把助理自身的 execution models 传进去；删除 `publicAssistantExecutionModels`。
- `apps/server/internal/httpapi/session_service.go`：删除父会话复制，改为 `startOnExecutionDefault` + `namedChoiceFact`；`resolveNewSession` 返回 `startResolution{note, runsOn, fallback}`。默认解析按 `sessionUserID`（会话创建者；agent token 的 `CreatedByUserID` 为空，真实创建者由 store 从父会话补全）查询，否则会以空 owner 查找而永远「没有默认」。
- `apps/server/internal/httpapi/mcp_sessions.go`、`session_device_wait.go`、`sessions_http.go`：`create_session` 结果加 `runsOn` 字段。
- 技能（两份相同）：`apps/server/internal/builtinskills/foundry-orchestration/SKILL.md` 与 `packages/worker/skills/foundry-orchestration/SKILL.md`，把「读 `get_execution_default`、传 `workerGroupId`」的多步换成一句「省略模型参数，Foundry 起始子会话于工作区 execution default」；保留「仅当步骤命中默认模型 guide 的 `avoid`/`weaknesses` 才用 alternative」与「绝不越出默认和 alternatives」。字数比改前少。
- 文档：`docs/assistant-orchestration.md` 的接触点表更新；`resolveNewSession` 的注释更新。

## 4. 验证

新增 `apps/server/internal/httpapi/child_session_model_test.go`：

- 不指定模型、Workspace 有单模型默认 → 子会话 provider/profile/model/effort 都取默认，`runsOn` 说明来源。
- 默认是 worker group → 子会话记录 `workerGroupId`，provider/model 取所选成员。
- 默认在目标电脑不可用（模型服务未分配到该设备）→ 退回该 Workspace 可用账号，`runsOn` 说明原因。
- 显式指定的模型原样使用，并提示「不在该 Workspace 的 execution models 中」；显式选择恰好等于默认时不加任何 remark。
- fork 仍运行在源会话的 agent 上，结果不加 execution-model 行。

既有测试覆盖助理路径与 `get_execution_default`：`TestExecutorUsesAssistantWorkspaceGlobalThenLegacy`、`TestAssistantGetExecutionDefaultReturnsItsOwnOverride`、`TestHelperModelIsTheAssistantsSecondChoice`、`TestExecutionDefaultsHTTPAndMCP`（重构后行为不变）。

命令与结果：

- byte-dev 的 64 核 compute：`scripts/remote-check.sh lease_d26089781ee60db2cc5d --tree /tmp/fdy-dev269 --go ./internal/httpapi -run 'TestChildSession|TestExecutionDefaults|TestExecutorUsesAssistantWorkspaceGlobalThenLegacy|TestAssistantGetExecutionDefaultReturnsItsOwnOverride|TestHelperModelIsTheAssistantsSecondChoice'` → `ok github.com/foundry-dev/foundry/apps/server/internal/httpapi 18.319s`（PASS）。
- 首轮同一命令暴露了一个真实缺陷并已修：默认按 `input.CreatedByUserID` 查询，而 agent token 的该字段为空（真实创建者由 store 从父会话补全），导致默认永远「不存在」。改为 `sessionUserID` 后通过。
- 本地 `go test ./internal/builtinskills` → `ok`（技能 revision 8 与新 checksum 已记录）。

## 5. 限制

- 已部署 dev（2026-11-17）；Agent 代验收（2026-11-17，范围见各自验收记录）；已合入 main（PR #274）。
- 结果行里发现型 provider 没有 `profiles` 行时显示 profile id（设备报告的事实），其余显示账号 label。
- 子会话「只指定 model、不指定 provider/profile」时保留旧规则（沿用父会话的 provider/profile），本次只移除「完全未指定」时的父会话复制。
