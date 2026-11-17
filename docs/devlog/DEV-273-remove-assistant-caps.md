# DEV-273 去掉助理 §9 的用量上限，只留「可能卡住」提醒

状态：已部署 dev（2026-11-17）；待本人验收；已合入 main（PR #**PR**）。

2026-11-17。本人决定去掉 §9 中除「可能卡住」提醒外的全部上限：同时在跑的派出会话、每天派出的会话、每天/每周新建的项目、每小时助理轮次、每天概括会话、每月 token 预算。Foundry 按原生 Agent 厂商的方式运行，不因配额替它们拒绝工作。基于 DEV-271（已去掉每轮 token 与时长上限）；patch 只含 DEV-273。

## 去掉的

- Server：`personalagent/limits.go` 删除 `LimitError`、`Windows`、`CheckNewWorkspace` / `CheckDelegate` / `CheckTurn` / `CheckDigest`。
- 助理会话准入：`assistant.go` 的 `AdmitSession` 只剩停止与设备许可；`AdmitTurn` 整个删除；`sessions` 的 `AdmitAssistantTurn` 端口（新轮次与 steer 两处调用）和 `httpapi` 适配器删除。
- 新建项目：`assistant/workspaces.go` 不再检查每天/每周数量。
- 概括：`httpapi/workspace_digests.go` 删除每天上限与 `startOfDay`；§14 的每小时速率（`DigestMigrationRate`）保留。
- 存储：`store.PersonalAgentUsage` / `PersonalAgentWindows` 类型、接口方法、sqlite 查询，以及概览的 `usage` 字段删除。
- 设置：`PersonalAgentLimits` 只剩 `stuckAfterMinutes`。旧 JSON 字段（`concurrentSessions`、`dailySessions`、`dailyWorkspaces`、`weeklyWorkspaces`、`hourlyTurns`、`dailyDigestSessions`、`monthlyTokenBudget`）仍可读、被忽略，保存时不再写回。
- Protocol：`PersonalAgentLimits` 只剩 `stuckAfterMinutes`；`PersonalAgentUsage` 与概览 `usage` 删除。
- Web：「用量与上限」一节改为「卡住提醒」，只剩一个分钟数字段与说明；计数、上限、用量说明及对应 i18n 键删除；`assistant-model.ts` 的校验只针对 `stuckAfterMinutes`。
- 工具说明（`mcp_tools.json`）：`create_workspace` 的每天/每周上限一行删除；`start_session` 去掉「助理的工作计入本人的上限」分句。
- 评测：`scripts/pa-eval-run.mjs` 不再把每人上限提高到硬上限，也不再为 “limit reached” 等待；`cases/personal-agent/a10-daily-creation-limit` 换成 `a10-daily-creation-no-limit`（断言第四个项目照常创建）。

## 保留的

- 「可能卡住」：任务 4 小时无人过问标为可能卡住并告知，只提醒、不停止；面板可调分钟数。
- 平台级会话限制（不属于 §9，代码未改）：同一父会话的活动子会话上限 20（`sqlitestore/session_lineage.go` 的 `maxActiveAgentChildrenPerParent`，`ErrAgentFanOutLimit`）；嵌套深度 4（`maxAgentSessionLineageDepth`）。
- §14 的每小时概括速率 `DigestMigrationRate`（10），不是 §9。
- 消息渠道的每小时/每天/并发限制（`channels/runner.go`，渠道设置），不是 §9。
- 审计拒绝类型常量 `store.PersonalAgentRefusalLimit` 与 Web 标签：历史审计行仍可读。
- 系统提示词 `prompt/system.md` 中“a limit”的泛指拒绝类型未改（平台限制仍可能产生拒绝）；golden 未改。

## 修正（非 §9，同一工具说明）

- `start_session` 的说明写“At most 8 sessions it started queued, running or blocked at once”，但代码执行的是 20（见上）。已改为 20，并同步 `TestFoundryToolLimitsNameTheEnforcedNumbers`。

## 测试

- 新增 `TestAssistantPastFormerCapsStillRuns`（httpapi）：四个新项目（原每天 3 个）、五个帮手（原同时在跑 4 个）、61 个会话轮次（原每小时 60 轮）都照常执行，无上限错误。
- 改写 `TestLimitsKeepOnlyTheStuckNotice`：旧设置 JSON 可读、上限字段被忽略，保存只写 `stuckAfterMinutes`；`TestNormalizeSettingsRefusesInvalidSettings` 去掉上限项，只保留负数。
- 删除 `TestAssistantLimits`（断言旧上限）、`TestAssistantRefusalsKeepTheirStatus` 中的限制分支、`personal_agent_helper_session_test.go` 中的用量计数断言、sqlite 审计测试中的用量断言。
- `personal-agent.test.mjs`：设置问题只针对 `stuckAfterMinutes`；导航提示文案更新。

## 验证（remote-check，CanWendeMac-mini，租约 lease_07c339aa141b0948e9f9；工作树 = live 快照 + DEV-271 + DEV-273）

- `go test` 定向：`./internal/personalagent`、`./internal/personalagent/assistant`、`./internal/sqlitestore`、`./internal/sessions`（编译）：PASS。
- `go test ./internal/httpapi` 定向 6 项（含新测试）：PASS。
- `--web typecheck`：PASS。
- `--web test test/personal-agent.test.mjs`：PASS。
- `pnpm --filter @foundry/web build`（生产构建门）：PASS。
- `gofmt -l` 对所有改动的 Go 文件：clean。
- `node --check scripts/pa-eval-run.mjs`：通过；a10 case JSON 可解析。

## 验收步骤

1. 打开 `/assistant/settings` 的“卡住提醒”：只有一个“多久没动静算可能卡住（分钟）”输入框，默认 240，没有用量计数、上限数字或“用量说明”。
2. 同一天让助理新建第 4 个项目：照常创建，回复为普通确认，不含“上限”或提高上限的链接。
3. 让助理同时派出 5 个帮手：不因“同时在跑”被拒。
4. `GET /api/personal-agent` 返回不含 `usage` 字段。

## 限制

- 已部署 dev（2026-11-17）；已合入 main（PR #**PR**）；dev 上的浏览器验收待本人完成。
- live 快照中 `packages/worker/src/session/runner/codex-stream.ts` 当时缺少 `SessionInputAnnotation` 导入，远程 Worker `tsc` 失败；验证时临时补了一行导入，已还原，patch 不含它（live 之后已由他人修复）。
- `docs/refactor/code-map/*` 是快照，仍提到 `LimitCaps`，未改。
- `mcp_tools.json` 进度标记 `budget (80% and 95% …)` 是 DEV-271 留下的，预算已去掉，未在本项改。
- Go 只跑了定向包，未做全量测试；`a10` 为 manual 评测。
