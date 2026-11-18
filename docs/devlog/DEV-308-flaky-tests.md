# DEV-308 两个间歇失败的测试

状态：修复与复现完成，补丁待合并（基线 `origin/main` 08a08911）。未提交、未部署。

## 问题

1. **Worker 测试** `a Codex MCP failure reconnects through the app-server protocol`（`packages/worker/test/codex-app-server.test.mjs`）。CI run 44329831028（PR #278）中事件变成 `Foundry tools unavailable → reconnected → unavailable`，第三个事件多出来。同一代码在 run 44324928944 通过，同一提交的重跑也通过。
2. **Server 测试** `TestNativeChatHistoryPagesBackThroughItsDevice`（`apps/server/internal/httpapi/native_history_test.go`）。偶发挂起约 8 分钟，无失败信息。

## 原因

### 1：测试竞态（不是产品缺陷）

- 产品代码：`startFoundryToolsSupervisor` 在 thread/start 后立即调用 `status()`；fixture 返回 `failed`，产生第一个 "unavailable"。之后 `reconnect` 发出 `config/mcpServer/reload`，fixture 置为 `connected` 并发 `ready` → "reconnected"。
- fixture 问题：thread/start 后 **25 ms 的定时器无条件**发送 `startupStatus/updated: failed`，不看服务器当前状态。如果重连已完成、而测试的 steer/drain 还没结束，这条过期的启动失败通知就会在 `connected` 之后到达，`supervisor.failed()` 在 `current === connected` 时再次发出 "unavailable"。
- 结论：真实 Codex 按顺序报告启动状态，`ready` 之后不会再发一条过期的 `failed`。如果确实出现真正的失败，产品正确地报告它。所以产品行为没问题，是测试 fixture 的过期事件导致竞态。CI 上同一提交重跑通过，也符合时序竞态的特征。

### 2：产品缺陷（会话分页游标）

- `AgentSessionOldestEventCursor` 与 `ImportNativeHistory` 用 `ORDER BY created_at`（文本序）找最早事件。`formatTime` 用 RFC3339Nano，会去掉小数末尾的 0，所以 `…25.59147Z` 文本上排在 `…25.591471Z` 之后，但时间上更早。
- 窗口读取（`readChronologicalWindow`）按解析后的时间排序。两者不一致时，游标指向的不是真正最早的事件。
- 后果：向上翻页时，`eventsBefore` 游标之前的事件已在库里，直接返回，设备上的更早历史不会被请求、不会被导入。用户滚动到会话起点时会漏掉设备上的历史，导入顺序也可能错。
- 测试侧：它在等设备请求，`answerNativeHistoryForTest` 的 `ReadJSON` 没有超时，所以挂起时没有任何失败信息，只能等 `-timeout`。
- 实测：目标时间戳的微秒位为 0 的情况约占 10%，所以挂起约 10% 的概率。

## 修复

- `apps/server/internal/sqlitestore/native_history.go`：新增 `oldestSessionEvent`。先用文本找最早的那一秒（定宽前缀，文本序正确），再在该秒内按解析后的时间（同时间取最小 rowid）选出最早的事件。`AgentSessionOldestEventCursor` 与 `ImportNativeHistory` 都改用它，去掉文本 `MIN(created_at)`。
- `apps/server/internal/sqlitestore/native_history_test.go`：新增 `TestNativeHistoryOldestCursorOrdersByTimeNotTrimmedText`，直接写入两个只差 1 µs、其中较早者被去尾 0 的事件，断言游标指向较早者。
- `packages/worker/test/codex-app-server.test.mjs`：fixture 的启动失败定时器只在服务器仍处于 `failed` 状态时发送（`if(foundryMcp==='failed')`），不改产品代码。

产品代码对 Codex 运行时的行为不变：真实的、恢复后再次出现的失败仍然报告 "unavailable"。

## 检查

| 检查                                                                                                       | 修复前                                                | 修复后                 |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------- |
| Codex 测试，空闲 Linux（byte-dev-sg），200 次                                                              | 200/200 通过（未修改的 `origin/main`）                | 200/200 通过           |
| Codex 测试，3 个并发作业各 100 次（负载下）                                                                | 295/300（5 次 "unavailable" 多出一个）                | 300/300 通过           |
| `TestNativeChatHistoryPagesBackThroughItsDevice`，单进程 `-count=200 -timeout 5m`                          | 挂起（基线作业 5 分钟超时）                           | 200/200 通过（71.6 s） |
| 同上，100 个独立进程、每个 `-timeout 15s`                                                                  | 90 通过 / 10 挂起                                     | 100 通过 / 0 挂起      |
| `go test -run 'TestNativeHistory\|TestAContinuedNativeChat\|TestAgentSessionEvent' ./internal/sqlitestore` | —                                                     | 通过                   |
| 新增回归测试 `TestNativeHistoryOldestCursorOrdersByTimeNotTrimmedText`                                     | 失败（`evt_earlier` 被当作 "before the oldest" 返回） | 通过                   |
| `gofmt -l` 两个 Go 文件                                                                                    | —                                                     | 无输出                 |

## 限制

- 没有在 CI 的 Linux 环境中用 bwrap 运行。byte-dev-sg 没有 bubblewrap，启动器拒绝运行，因此用 `FOUNDRY_WORKER_TESTS_NO_SANDBOX=1`（只去掉内核沙箱，保留应用层隔离：临时 `FOUNDRY_STATE_ROOT`、`TMPDIR`、凭据剥离）。
- CanWendeMac-mini 上 Codex 测试全部失败（200/200）：启动器沙箱下 `ps` 取不到进程身份，抛出 "Cannot identify runtime lease owner"。这是 Mac runner 的环境问题，单独记录；它也可能反映 macOS worker 在沙箱下的真实问题，未调查。
- Go 测试的挂起没有失败信息，原因是 `answerNativeHistoryForTest` 的 `ReadJSON` 无超时。本次未加超时，修复的是根因；若要让类似回归失败而不是挂起，可另加读超时。
- `-race` 未运行。
- 未运行全量 `go test ./...`、全量 worker `pnpm test`，只跑了针对性测试。
