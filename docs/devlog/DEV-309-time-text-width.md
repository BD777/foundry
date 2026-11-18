# DEV-309 时间文本定宽，按时间选取边界行

状态：实现完成，检查进行中。未提交、未部署。补丁基于 DEV-308（`/tmp/flakes.patch`）之上生成，DEV-308 先于本项部署（train 94）。

## 问题

存储的时间是 RFC3339 文本，SQL 按文本排序和比较。`formatTime` 用 `RFC3339Nano`，它会去掉小数末尾的 0。因此文本序不等于时间序：`…05.59147Z` 时间上早于 `…05.591471Z`，文本上却排在后面（`Z` 大于 `1`）。

影响范围：凡是按这类文本排序并取第一条或最后一条的查询，同一秒内可能取错。DEV-308 只修了会话最早事件的游标，其余取值仍是文本序。

## 证据

只读打开 `~/.foundry/server/foundry.db`（WAL，SQLite 3.40.1），未写库、未复制。

- `agent_session_events.created_at` 约 107 万行，去尾值 107,487 行（约 10%）。
- 同一会话同一秒相邻事件 466,811 对，文本序与时间序反向的 0 对。
- 对含去尾值的 99,007 个（会话，秒），逐对比较 64,680 个多事件秒，反向的 0 对。按 ns 时钟计算，碰撞需另一事件的小数位与去尾值前缀一致，概率约 10⁻ᵏ（k 为去尾后的位数），在这批数据中没有实际出现。
- 全库 109 个时间列共 143,587 个去尾值，集中在 `agent_session_events`、`resource_operations.started_at`、`usage_requests.at`、`feishu_gateway_requests.at`。
- 小数位 ≤3 位（毫秒精度）的行只有 2 条，库中不存在毫秒精度来源。

结论：缺陷在代码层面真实存在，但当前数据中没有观察到错序。修复目标是让新写入的数据不再依赖文本序，并让残留的文本序取值改为按时间判断。

## 修复

1. `formatTime` 改为九位小数（UTC）。共享常量 `timeLayout`，`nativeHistoryTimeLayout` 并入它（两者布局相同）。存量行不改写。
2. 新增 `timeEdgeRowID`（`time_edge.go`）：先按文本找出最早或最新的那一秒（前缀 19 位可按时间排序），再在该秒内按解析后的时间比较（同时间取更大或更小的 rowid）。复用 `session_event_window_order.go` 中的 `secondPrefixLayout` 模式。
3. 转换的取值查询（均改为 `timeEdgeRowID` + 按 rowid 读取）：
   - `session_event_compaction.go`：会话首个事件 `firstRowID`
   - `usage_stats.go`：最新的上下文模型
   - `pending_items.go`：`latestPendingItem`（最新的待办，优先 open）、`pendingItemAt`（合并时最早的 open 待办）
   - `ownership.go`：`earliestAdmin`
   - `personal_agent_inbox.go`：`PersonalAgentInboxSession`
   - `session_inbox.go`：去重时的重复消息
   - `personal_agent.go`：`latestTaskForSession`
   - `feishu.go`：按群与客户端取机器人路由；按 Issue 取飞书线程
   - `daemon.go`：认领最早的已确认待办 Issue
   - `sqlitestore.go`：`getAgent` 中同工作区、同运行时的最新 Agent
4. Web `channel-chat-groups.ts`：`lastAt` 与会话排序改为按时间比较（整秒用 `Date.parse`，小数按九位补齐比较）。Safari 的 `Date.parse` 不接受超过三位的小数，因此小数不传入 `Date.parse`。
5. API 字段：仍是 RFC3339 字符串、UTC，只有小数位宽度变化。字段含义不变。
6. 直播事件：`sessions.Events.Recorded` 推送前把 `at` 规范化为存储宽度（`store.CanonicalTime`，与 `store.EventTimeLayout` 同一来源）。`AppendAgentSessionEvent` 的注释承诺直播与之后读取显示同一时间，定宽后必须由推送端保证，否则直播文本与读取文本不同。

## 未转换（有意保留）

- 相关子查询：`latestTimerSnapshotSQL`（`session_schedule.go`）、`workspace_files.go` 中的 sha 检查。改它们需要重写为 Go 侧取值，本项不做。
- 列表排序（不是取一条）：`AgentSessionFrames`、`PendingSessionInboxItems`、`SessionInboxItems`、各类 `ListXxx`。同秒内的顺序只受存量去尾行影响。
- 游标比较：`message_channels` 的 `MAX(created_at)` 游标与 `agent_sessions` 的 `activity_at` 游标，自身一致（文本比较与排序一致），不会跳过行。
- 工作区回退（`defaultWorkspaceID`、`workspaceIDForDevice`）：次序键是 `name`，改成 rowid 会改变同时间的并列结果，留待单独处理。
- `oldestSessionEvent` / `ImportNativeHistory`：属于 DEV-308，本项不改。

## 检查

远端 CanWendeMac-mini（`lease_7bc5f099766d20a91294`），最终树（DEV-308 为基线，含本项全部改动）：

- gofmt：本地通过。
- `go test ./internal/sqlitestore/...`：PASS。
- `go test ./internal/store/... ./internal/sessions/...`：PASS（新增 `store.CanonicalTime` 测试）。
- `go test ./internal/httpapi/ -timeout 35m`：PASS（约 480 s）。
- web：`test/channel-chats.test.mjs` 4/4 PASS（含新增的按时间排序用例）；`--web typecheck` PASS。
- 首轮检查的失败及修复：
  - `CreatePersonalAgentTask`：任务未找到时 `latestTaskForSession` 须返回 `store.ErrNotFound`（调用方按此判断），否则 6 个 personal_agent_items 用例失败。已修。
  - 按宽度变化的精确字符串断言：`session_schedule_backfill_test.go` 字面量改为九位小数；`device_backlog_test.go`、`read_pool_test.go` 改为比较时刻（`sameInstant`），语义不变。
  - 直播事件 `at` 与读取不一致（httpapi 两个用例）：推送前规范化，见修复第 6 条。

## 限制

- 存量去尾行与新行仍混排，文本序在同秒前缀碰撞时可能错。已通过按时间选取的边界查询覆盖主要路径，但列表排序未覆盖。
- 未做数据迁移。迁移的时间与 WAL 大小未测（需要副本，当前磁盘余量不足以安全复制）。
- DEV-308 的回归测试在定宽后不再依赖 DEV-308 的游标修复即可通过（新写入的文本已是时间序），因此它不能单独证明存量去尾行的最早事件游标正确；`oldestSessionEvent` 对存量行仍必要。
- `usagestats.formatTime`（`RFC3339Nano`，查询 `usage_requests.at` 的上下界）与 `workspacedigest.formatTime`（只到秒，写入 `summary_due_at` 等）未改，二者与库中定宽值比较时仍有同类问题。见 open 项。
- 测试调整仅限宽度：`session_schedule_backfill_test.go` 的 4 处字面量改为九位小数；`device_backlog_test.go`、`read_pool_test.go` 改为比较时刻。没有删除或放宽断言。

## 验收

- 会话事件时间线、频道会话列表的顺序与之前一致；新写入的时间字段为九位小数。
- 频道会话列表按时间（不是按文本）排序，两种宽度混合的时间顺序正确。
