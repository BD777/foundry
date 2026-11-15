# DEV-230 定时回合删掉自己的 schedule 后卡死 20 小时；设备心跳被 Server 整条丢弃

状态：已部署 dev（Server `7d655b8c…`，2026-11-14T18:21:10Z 起运行；Worker `0.5.7-dev.358.g602765a0.local.1794679961`），线上复现场景已由 Agent 验证；待本人验收。已合入 main（PR #268）。

2026-11-16 Agent 代验收：**通过**（范围：步骤 1、4 只读线上库/设备心跳；步骤 2、3 在当前部署上于 e2e-alice 合成账号新跑）。未覆盖：无（使用的是合成账号，未改本人状态）。

## Agent 代验收（2026-11-16）

来源：编排会话 `sess_1794464313271186377` 转述本人委托。

| 步骤             | 结果         | 证据                                                                                                                                                                                                                       |
| ---------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 卡住的会话     | 通过         | `sess_1794585610941166654` 状态 `canceled`（2026-11-14T17:58:46Z）；schedule `work_9b47…` `desiredState=removed`；run `wrun_242c…` `stopped`（endedAt 17:58:46Z）。                                                        |
| 2 定时回合删自己 | 通过（新跑） | e2e-alice 合成账号：定时任务 16:52:14 触发，回合在 16:52:32 `control_session_work remove` 删除自己，16:52:35 回复 `DEV230-ACCEPT-OK`；session `completed`，work `desiredState=removed`，run `completed`，无警告/取消事件。 |
| 3 外部停止       | 通过（新跑） | e2e-alice：定时回合 16:54:35 开始跑 `sleep 400`，16:55:29 从助理页停止（54 s 内）；session `canceled`、run `stopped`，事件 `Session canceled                                                                               | Canceled by user`。之后用一条消息删除该定时任务（`desiredState=removed`）。 |
| 4 设备负载样本   | 通过         | 6 台在线设备（含合成设备）的 `runtimeState.estimates[].typicalRssBytes` 均为整数，`capturedAt` 持续刷新。                                                                                                                  |

清理：合成的两个定时任务均已 `desiredState=removed`，e2e-alice 的合成设备 Worker 已停止。

来源：本人问"`sess_1794585610941166654` 卡了十几个小时？"，随后要求"从根本上修复"。

## 现象

`sess_1794585610941166654`（DEV-227 的收尾会话）从 2026-11-13T22:00:55Z 起一直显示 `running`，持续约 20 小时；它的 schedule `work_9b47…` 的删除操作 `wop_8141…` 一直 `pending`，当前 run `wrun_242c…` 一直 `running`。它本该在最后发给 orchestrator `sess_1794464313271186377` 的两行结果没有送到。

## 根因（三处，缺一处都不会卡这么久）

1. **回合把自己取消了。** 这一轮由 30 分钟一次的 schedule 触发（`continue_thread`）。按 prompt，它在轮内用 `control_session_work remove` 删除驱动自己这一轮的 schedule。Worker supervisor 处理"删除一个正在跑的 schedule"时调用 `stopScheduledRun` → `cancelActiveSession`，取消的正是当前这一轮（事件 "Session canceled | Canceled by user"，与 remove 同一秒）。正在进行的 `send_message` 随之丢失。
2. **Worker 自己发起的取消不上报终态。** `executeAgentSession` 的取消分支只发一条 "Session canceled" 事件，除 Issue 角色外不发 `session_completed`：设计上只考虑了 Server 发起的取消（Server 先 `CancelAgentSession` 再通知设备）。Worker 本地发起的取消（停止定时 run、`stopChild` 停子会话）因此永远到不了 Server：session 停在 `running`，run 不结算，删除操作等"session 确认退出"，形成死锁。Claude 进程其实在 22:00:57 就已退出（journal：`closed … Session was canceled.` / `ended`）。
3. **兜底的 stale sweep 失效：心跳整条被丢弃。** Server 本该在 30 分钟没有设备 claim 后把它标 failed。但 Worker 心跳里 `runtimeState.estimates[].typicalRssBytes` 是 EWMA 小数（本机 `turn-usage-estimates.json` 里 `262288354.266…`），Go 侧是 `int64`，`json.Unmarshal` 整体失败；`noteHeartbeat` 把整条心跳当空的：`activeSessionIds` 为 nil → 不替换连接持有的 session 集合，却照常 `confirmActiveSessions` 给旧集合续期。于是 22:00 这一轮的 claim 被永久续命。旁证：sg-chaos、byte-dev 等设备在 DB 里从未有过 `runtimeState`，只有估计值恰好是整数的 byte-dev-sg 有。新 Server 上线后日志直接记录到 limen-canada、cottoncpp、sg-chaos、byte-dev、macbook 的旧 Worker 心跳都是 `cannot unmarshal number …. into … typicalRssBytes of type int64`。影响面不止这次：这些设备的负载样本、outbox 延迟一直被丢，任何丢了终态的 session 都不会被回收。

## 修复

- **心跳（Worker）** `concurrency/admission-controller.ts`：合约里的字节数（`typicalRssBytes`、`peakRssBytes`、`memoryAvailableBytes`、`memoryTotalBytes`、`swapFreeBytes`）在边界取整。
- **心跳（Server）** `httpapi/daemon_outbox.go`：`decodeHeartbeat` 整体解析失败时逐段解析（`activeSessionIds`、`outbox`、`runtimeState`），一段坏只丢那一段；坏段按连接每 5 分钟最多记一次日志（`heartbeat has unreadable sections, ignored: …`），不再静默。
- **取消上报（Worker）** `daemon/session-execution.ts`：每个以取消结束的输入都发 `session_completed`（`error: "Session was canceled."`，Issue 角色仍发它自己的 `stopped` 报告）。Server 已有约定：`SettleAgentSessionInput` 把含 "session was canceled" 的失败结算为 `canceled`；Server 已取消过的，走已结算分支只确认。
- **取消上报（Server）** `httpapi/daemon_session_inbound.go`：取消报告不进自动重试/失败提醒；已结算分支给助理记录的终态为 `canceled`。判断统一到 `store.IsCanceledTurnFailure`（原来散在 `sqlitestore/session_completion.go`、`httpapi/pending_failures.go` 两处）。
- **回合不取消自己（Server + Worker + 协议）**：`controlWork` 从调用者 token 记下发起的 agent session（`WorkControlInput.RequestedBySessionID`，`json:"-"`，不能由请求体伪造）；stop/remove（含 stop_all）一个正在跑的 schedule、且发起者就是这个 run 的执行 session 时，Store 在工作项上记 `finishRunId = <run>`；其他人的控制会清掉它。Worker supervisor 遇到 `finishRunId === observation.runId` 不取消这一轮，等 Server 结算这一轮结束后再确认控制。人或其他 session 的停止仍立即取消该 run。`control_session_work` 的工具描述写明这一语义。

## 处置

2026-11-14T17:58Z 从 Server 侧 `cancel_session` 了卡住的会话：session `canceled`，run `stopped`，`wop_8141…` `verified`。DEV-227 中撤下 Codex TokenHub provider 和更新 DEV-227 文档两步在卡住前已完成；给 orchestrator 的两行结果未补发。

## 验证

- 测试（新增 / 扩展）：
  - Go `TestHeartbeatClaimsSurviveAnUnreadableRuntimeState`（小数字节数的心跳仍替换 claims，outbox 段保留）
  - Go `TestDeviceCanceledTurnReportEndsTheSessionCanceled`（设备上报取消 → `canceled`，不进重试）
  - Go `TestWorkControlFromTheRunningTurnLetsItFinish`（本轮自删记 `finishRunId`，他人停止不记）
  - Worker `a scheduled turn that removes its own schedule is not canceled; another remover's stop is`
  - Worker `runtime state reports whole byte counts`
  - Worker `a session canceled during Skill download…` 增加断言：取消的输入上报 `session_completed`
- 运行：Worker `admission-controller` / `session-work` / `skill-package-fetch` / `queued-cancel` / `session-work-sync` 共 63 例在 sg-chaos 通过；Go `internal/sqlitestore` 定向用例本机通过，`internal/httpapi` 定向用例（含心跳、完成结算、MCP 工具、SessionWork）在 CanWendeMac-mini 通过（`/tmp/remote-check-20261114T131230-1345833.log`）。
- 部署：`remote-build` 于 Mac mini（build-info base `602765a0`，source manifest `fa787dd4…`）；`deploy-dev.sh --label dev230`。lineage 检查列出的与线上不同的文件中，产品代码只有本项改动，其余是 `docs/`、`scripts/`，故以 `--replaces 36e580b1…` 确认替换。`update_worker`：sg-chaos、byte-dev、byte-dev-sg、cottoncpp、limen-canada、macbook 均已到 `…358…1794679961`。
- 心跳：Worker 更新后 6 台在线设备的 `runtimeState` 均按整数持续写入（例如 sg-chaos `estimates.typicalRssBytes = 212706468`）。
- 线上复现（e2e，合成会话，已归档）。sg-chaos 旧执行宿主退休、`schedulerVersion = …358` 之后：
  - **A2** `sess_1794681632040976685`：定时回合 18:42:36 删除自己的 schedule，然后又跑 45 s 才回复 → 回合 `completed`、回复 `DEV230-A2-DONE`、无警告/错误事件；工作项 `finishRunId = wrun_00ea…`，删除操作 `verified`。事故中同样的删除在 1 秒内取消了回合。
  - **B2** `sess_1794681634585461231`：定时回合在跑 400 s 的命令时，由父会话 18:42:44 `stop` 它的 schedule → 回合 `canceled`（错误 `Session was canceled.`，即 Worker 的新上报），停止操作 `verified`，约 40 s 内完成。修复前这正是会永久停在 `running` 的路径。
  - 第一次尝试（A/B，`sess_179468082…`）不计入：其时设备级 supervisor 仍在旧宿主上，且 B 的前台 `sleep` 被 Claude Code 的 Bash 拦截。

## 验收步骤（本人）

1. 打开 `sess_1794585610941166654`：状态为已取消，其定时任务显示已删除。
2. 在任一会话里让 agent 建一个一分钟后的定时任务，内容是"删除这个定时任务，然后回复 OK"：到点后这一轮应正常回复 OK、显示完成，定时任务显示已删除。
3. 让 agent 建一个一分钟后的定时任务去跑很长的命令，跑起来后在侧栏或让另一个会话停止它：这一轮应在一分钟内显示已取消，而不是一直运行。
4. 设备页：各设备的负载/并发样本应在刷新（以前多数设备没有）。

## 限制与遗留

- **CanWendeMac-mini 离线未恢复**：它在本次 Server 重启（18:21:09Z）时断开，之后没有任何重连请求到达 Server（前两次 train17/18 重启都在约 10 s 内重连）。离线期间 Foundry 无法对它执行任何操作，原因未查明；它仍是旧 Worker（`…357`），重连后需 `update_worker`；它上面本次 `remote-build`/`remote-check` 的 job 目录未清理（`scripts/remote-clean.sh --device mac`）。
- Server 发起的取消与设备的取消报告可能交错：若设备报告先到，session 的错误文本是 `Session was canceled.` 而不是 "Canceled by user"，状态同为 `canceled`。
- Issue 执行角色的取消报告文本是 "Issue execution canceled; …"，不含 "session was canceled"，若由设备本地取消会被结算为 `failed`。这是既有行为，本项未改。
- 一个 run 自己发起的停止要等这一轮结束；若这一轮自己卡住，本人仍可直接停止该会话。
