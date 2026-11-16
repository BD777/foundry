# DEV-261 执行者按限流自动切换备用成员

状态：已部署 dev（train15/16/17-20261117）；Agent 代验收（2026-11-17，范围见验收记录）；已合入 main（PR #272）。

- 2026-11-17（train 18）：MCP 工具描述中补上执行成员档位与限流域（dev261-mcp），随 train 18 部署到 dev。

## 问题与证据

- 2026-11-17 00:17（UTC+8）8 个编排子会话跑在 worker group `wgroup_c8029c91…`（deepseek-flash-1017）上，3 个同时被 "Rate limited, waiting to retry" 卡住。
- 根因（代码）：
  1. 选择只在创建时做，按声明的 TPM 排序（`httpapi/worker_groups.go` 的 `chooseWorkerGroupMember` + `modelpool.Choose`）；真实限制不是声明值，成员始终看起来有余量。
  2. 两个成员共享同一账号（`prof_2c4c55cc…`），没有限流域的概念，选谁都分不开压力。
  3. 没有 429 记忆，也没有并发上限。
  4. 重试只重试同一模型（`httpapi/session_retries.go`，最多 5 次）。
  5. 备用模型（Limen haiku）不属于组，只是执行默认里的手动备选。
  6. 运行中的会话不能换成员（`sessions/lifecycle.go` 拒绝 "a running session keeps its runtime"）。

## 设计

参考：LiteLLM Router（冷却、fallback、按 rpm/tpm 路由）、Envoy outlier detection（连续失败弹出、弹出时间递增）、resilience4j/Hystrix 半开熔断、Netflix concurrency-limits 的 AIMD、Google SRE 客户端自适应限流、AWS full-jitter 退避（`modelpool.Backoff` 已有）。

依据人（2026-11-17）的约束：**供应商限额未知，不能依赖声明值**。熔断器从 429 和成功请求中学习；`tokensPerMinute` 等声明值只是可选上限。

- **限流域**：同一账号（profile + runtime）的成员共享一个域。
- **熔断器（每域）**：closed → open（冷却）→ half-open（只放一个探测）→ closed。
  - 风暴：3 次以上限流信号、至少 2 个会话，且在 2 分钟窗口内；或单个会话限流 60 秒以上。
  - 冷却 = 2 分钟 × 2^level，上限 15 分钟；每次重新打开 level+1。
  - 半开的探测被限流 → 重新打开并加倍冷却；探测成功（成功的模型请求）→ 关闭。
  - Retry-After/重置时间是冷却下限：复用 `httpapi/pending_failures.go` 的 `parseFailureReset`（不新增正则），下限封顶为 15 分钟。
- **衰减**：每 10 分钟无信号 level-1；30 分钟无信号整体回到默认（closed、基础冷却、默认并发 4）。
- **AIMD**：风暴时并发上限 = max(1, 活跃数/2)；每个无信号的 10 分钟，只有域确实饱和（活跃数达到上限）才 +1，上限为 `ceiling`（默认 16）。
- **准入**：成员 tier（1 主力、2 备用，默认 1）。选择最低 tier 中可准入（closed 且低于上限，或唯一探测位）的成员；都不可用时排队在主力中负载最低的一个，不拒绝。
- **同 runtime 的限流重试**：只有域处于 open 时才切到更高 tier 的同 runtime 成员（且设备能跑）；孤立的一次 429 保持同模型重试。Claude ↔ Codex 不切换。切换到另一账号的重试只等约 3 秒（备用账号未被限流），不用同模型的指数退避。
- **回到主力**：设置会话的下一轮时，若主力可准入而当前在备用上，则切回（记录 event）。
- **准入/切换说明**：新会话落到备用、排队、或失败回退时，会话事件 `Worker group member` 记录原因，语言取创建者的界面语言（`zh*` 用中文），例如「备用 haiku：deepseek 账号限流中，约 6 分钟后恢复」。
- **手动切换（已按编排者确认的设计）**：
  - 限流重试等待中：同组同 runtime 的成员会改写待执行重试并立即执行。
  - 会话运行中：切换在本轮结束后的下一轮生效（不做中途切换；worker 的 steer 没有 model/profile 边界）。
  - 其它切换仍拒绝。

## 改动

- **可见性（契约优先）**：`WorkerGroup.domains`（只读）每账号一项：`profileId`、`runtime`、`state`（healthy/recovering/probing/limited）、`cooldownUntil`、`level`、`limit`、`active`、`signalsInWindow`、`failoversLastHour`。`worker_groups`（列表、保存、MCP）与 `get_execution_default`（经 `fillExecutionChoiceGroup`）都经 `workerGroupView` 返回。`failoversLastHour` 由回退时 `RecordFailover` 记录（内存）。
- 运行中切换的回执：`send_message` 带 profileId/model 时，返回多一个 `memberSwitch`：`state` 为 `retry_now`（待重试改到该成员并立即执行）或 `next_turn`（下一轮生效），`note` 为说明。消息本身的 receipt 不变。
- 重启重放：`StartBackground` 先从运行中/阻塞会话的 `Rate limited` 事件（最近 30 分钟，按时间排序）重放进熔断器，再启动后台任务。

- `contracts/models/profiles.yaml`：`WorkerGroupMember.tier`；生成的 Go/TS/JSON Schema 已更新。
- `apps/server/internal/modelpool/health.go`、`health_test.go`：纯函数的熔断器、AIMD、准入、回退、回主力。
- `apps/server/internal/httpapi/worker_group_health.go`：内存中的熔断器（`memberHealth`）、事件输入（`DaemonHub.observeMemberSignal`）、准入候选、回退、回主力、运行中手动切换。
- `httpapi/worker_groups.go`：`chooseWorkerGroupMember` 先过准入。
- `httpapi/session_retries.go`：失败时观察信号；熔断器 open 时切换到备用。
- `httpapi/daemon_session_inbound.go`、`daemon_hub.go`、`server.go`：接入事件与熔断器。
- `httpapi/session_accounts.go`、`session_ports.go`：设置会话下一轮成员；运行中切换的策略入口。
- `sessions/lifecycle.go`、`sessions/service.go`：运行中切换的策略钩子（切换被接受时，空消息也成功返回）。
- `store/worker_groups.go`、`store/store.go`：重试的 `NextProfileID`；`SetSessionRetryNextMember`；`PendingSessionMember` 接口。
- `sqlitestore/session_retries.go`：`next_profile_id` 列（迁移，ALTER）、`SetSessionRetryNextMember`，认领重试时同时换账号。
- `sqlitestore/session_member_switches.go`：新表 `session_member_switches`（待下一轮生效的切换）。
- `sqlitestore/agent_sessions.go`：切换到同组成员的模型时保留组（原来任何模型切换都会清空组）。

## 验证（服务端）

- 目标测试：`modelpool` 全部；`httpapi` 集成测试（`worker_group_failover_test.go`）：回退到 tier 2（熔断器 open）、孤立 429 保持同模型、待重试被手动切换改写并立即到期、运行中切换延后到下一轮、恢复后回主力（熔断器恢复后）、准入选 tier 2、组视图的域状态、重启重放风暴。

## 验证（早前）

- `go vet`（httpapi、sqlitestore、sessions、store、modelpool）通过。
- `go test ./internal/modelpool/`：熔断器各转移（开路、半开单探测、探测成功关闭、探测失败加倍、衰减、30 分钟清零、Retry-After 下限、冷却上限、AIMD 仅饱和增长）、准入与回退、回主力。
- `go test ./internal/sqlitestore/` 的 worker group / retry 相关测试通过。
- `go test ./internal/httpapi/ -run 'WorkerGroup|Retry|RateLimit|Pool'` 通过（既有的 "same model, never switches" 测试仍通过，因为其组内都是同 tier）。
- 未在 CanWendeMac-mini 上跑 remote-check；未部署 dev。

## Web：执行组编辑器（DEV-262，2026-11-17 上线）

- 每个成员可设「主力」（tier 1）或「备用」（tier 2），无 tier 视为主力；组内简介与档位提示两种语言重写：账号限流期间会话转到备用成员，账号恢复后回到主力；配额/权重提示不变。
- 每个成员下面一行状态，来自 `WorkerGroup.domains`：限流中（CircleAlert，警示色）带「约 N 分钟后恢复」、正常（CircleCheck，成功色）「N/M 个会话」、试探中（虚线圆，muted）、恢复中（RefreshCw，muted）；图标与文字区分状态，颜色只是附加；另示「1 小时内转备用 N 次」。
- `apps/web/src/features/profiles/worker-group-domain.ts` 的纯函数（`memberTier`、`domainForMember`、`domainStatus`）与 `test/worker-group-domain.test.mjs`；两语言的状态文案齐全由测试断言。
- 验证（CanWendeMac-mini）：typecheck、`audit:ui`、prettier 通过；42 个定向 Web 测试通过；浅色/深色 1280 宽截图各一张（`/tmp/dev262-editor-light-1280.png`、`/tmp/dev262-editor-dark-1280.png`，不入库）。

## 未完成（须跟进）

1. 熔断器状态只在内存中。重启后只从运行中或阻塞会话的最近 30 分钟事件重放；已结束会话的事件与超过窗口的状态不会恢复（例如较早的冷却）。
   `failoversLastHour` 也只在内存中，重启后归零（编排者确认可接受）。
2. 运行中切换的回执 `memberSwitch` 只在 MCP `send_message` 的 profileId/model 路径；经 inbox 的消息没有这个字段。
3. 备用模型（Limen haiku，tier 2）尚未加入个人的默认组；部署后通过 API/MCP 添加并记录。

## 验收步骤（部署后，待人工或代验收）

1. 创建组：deepseek 主力（tier 1）+ haiku（tier 2）。确认 API 返回 `tier`。
2. 制造限流风暴（同账号 3 次以上 429、2 个会话）：新会话应落到 haiku，事件里有 "Worker group member"。
3. 限流重试中给会话发 `send_message` 指定同组 haiku：待重试应改为 haiku 并立即执行。
4. 运行中会话发同组成员切换：切换事件应显示 "applies after this turn settles"，下一轮起用新成员。
5. 冷却到期后，主力应有一个探测；探测成功后主力恢复准入。
