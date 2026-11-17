# DEV-280 helpers and items stay linked

状态：已部署 dev（2026-11-18）；Agent 代验收（2026-11-18，范围见验收记录）；已合入 main（PR #277）。

## 问题

- 助理的帮手与事项的关联存在两处：`pa_tasks.item_id`（只有 `create_session(itemId)` 和 `update_list taskId` 写入）和 `plan.workRefs`。两者互不同步。
- `send_message` 无法把已有帮手挂到另一个事项。
- `update_list` 传入 plan 时整体替换（`list.go` 原 `item.Plan = spec.Item.Plan`），把 workRefs 冲掉。
- 证据：web 审查 D4（`.foundry/reports/assistant-review-20261117-web.md`）。`pat_7621…` 的 `item_id` 指向已完成的事项，新事项的 workRefs 在 `update_list` 后为空；助理为"挂上"事项开了空的 placeholder 会话。
- `update_list` 的 `taskId` 工具说明写「empty unlinks」，代码实际拒绝空值。

## 修复

- **单一来源**：`pa_tasks.item_id` 决定哪些帮手在某事项上。plan 里的 session 类 workRef 是它的派生视图，只由 `setTaskItem` / `refreshItemHelpers` 写入（`personalagent/assistant/list.go`）。
- `withHelperRefs`：每次写 plan 时，session 引用按 pa_tasks 重算；关系（executing/observing）沿用旧值，新帮手默认 observing。plan 里传入的 session 引用被忽略，其余 issue/service 引用照旧。
- 帮手移动（`setTaskItem`）：更新 pa_tasks，并刷新离开的事项与加入的事项的 plan。
- `update_list taskId` 与 `linkOperation` 都走这一个写入口。`linkOperation` 改为先挂接、再读取最新事项后写 executing/进度，避免被挂接的保存覆盖。
- `RecordTask`（create_session 带 itemId）在创建后刷新该事项的引用。
- `send_message` 新增 `itemId`（`httpapi/mcp_sessions.go`）：只允许助理自己的帮手，事项须为未归档的开放事项，经 `MoveHelper` 移动。
- 工具说明（`httpapi/mcp_tools.json`）：`update_list.taskId` 改为实际行为；`plan.workRefs` 说明帮手链接由 task 决定；`send_message.itemId` 说明移动语义。没有行为指导。

## 限制

- 已存在的不一致数据不做迁移：下次该事项的 plan 被写入或帮手被移动时，session 引用按 pa_tasks 重算，旧的孤儿引用会消失。
- plan 为空的事项没有地方保存引用；设置 plan 时由 pa_tasks 派生。
- `send_message(itemId)` 的端到端路径（真实发消息）未在真实浏览器或 e2e-alice 上验证，只有 `MoveHelper` 的 Go 测试覆盖；发消息失败时链接已先写入。
- 未部署、未提交。

## 检查

- Go 定向测试（byte-dev，remote-check）：`TestHelperLinksFollowTheItemAndSurvivePlanUpdates`（新增，`httpapi/personal_agent_helper_links_test.go`）及同包相邻的 create_session itemId、update_list、operation 测试。
- `gofmt` 与 `go vet ./internal/personalagent/assistant/` 通过。

## 验收步骤（代验收前）

1. 为一个开放事项设置 execute plan，用 create_session(itemId) 派出帮手。
2. 更新该事项的 plan（不提帮手），确认事项仍列出帮手。
3. 对帮手 send_message(itemId=另一个开放事项)，确认原事项不再列出，新事项列出。
4. 对已完成或归档的事项 send_message(itemId)，确认被拒绝并给出原因。

## 时间线

| 日期       | 事项                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-18 | Agent 代验收（编排者，e2e-alice，inbox_2600fd2e…）：`pa_tasks` pat_018ea742… 移到事项 B（pai_accee6ea…），plan 更新保留 workRefs → sess_1794938811338243155。 |
