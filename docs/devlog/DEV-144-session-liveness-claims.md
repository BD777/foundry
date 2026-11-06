# DEV-144 等后台任务的会话被当成“失联”判失败

## 问题

2026-11-06 02:34（北京时间）会话 `sess_1793898194021119799`（sg-chaos，AsterGate · kiro/claude-opus-5-5）被标为失败：“Local daemon stopped reporting session activity for 31m0s; marked failed to clear a stale running session.”。它没有卡住：02:03 它在后台启动 `scratch-stack.sh up`（VM 负载约 30、在用 swap），回合以“Waiting for background tasks”挂起等待；后台构建 02:58 结束后，同一个 Claude Code 进程接着工作，说明 Worker 一直持有它。同一时间 byte-dev 上的 `sess_1793796382703541001`（后台 watch.sh 跑 2 小时）也以“1h34m”被判失败，之后它的后台任务在 03:00 才到时结束。

## 调查

- 判失败的位置：`apps/server/internal/sessions/recovery.go` 的 `staleMessage`。规则是：当前设备连接声明持有该会话（`DaemonHub.HasActiveSession`）就保留；否则距最后一个会话事件（`LastActivityAt`）超过 30 分钟（`defaultAgentSessionStaleAfter`）就判失败。每 30 s 一次的清扫（`ReconcileStaleSessions`）和每次读会话列表/详情都会走这条判断。
- 设计上已有“持有声明”：Worker 在 hello/workspace_ready 注册里带 `activeSessionIds`（执行宿主的 claims 经 `ExecutionHostClient.adopt` 同步到守护进程的 `SessionExecutionRegistry`），Server 存在连接对象上。但这个声明只在**有连接的那一刻**有效，30 分钟则从**最后一个事件**算起。会话静默 30 分钟后，唯一保护它的就是“清扫那一刻设备恰好连着并已注册”。
- 当晚的断线（`~/.foundry/logs/daemon.out.log`，UTC）：18:32:46 Server 重启（“server shutting down”），18:32:59 重连；18:34:13 因“device did not answer a ping within 15s”被断开（VM 过载，事件循环延迟 9.6 s），18:34:26 重连。会话最后一个事件是 18:03:42，断开的 13 s 内静默时长为 30m31s–30m44s，正好显示为“31m0s”；父会话 18:34:49 收到失败报告。byte-dev 的会话也在同一次 Server 重启后的重连窗口里失败。
- Worker 的心跳每 25 s 一次，原来只带 outbox 积压情况，不说明自己还在跑哪些会话；Server 也不记录设备上一次声明持有某会话的时间。所以“Worker 一直持有”这个事实在断线的几秒里完全丢失。
- 结论：失败与否取决于“最后一个事件”而不是“最后一次被持有”。长时间静默的工具调用 / 后台任务 / 慢模型请求，只要碰上一次重连或 Server 重启，就会被误判。

## 修复

- Worker（`packages/worker/src/daemon/control-connection.ts`）：心跳增加 `activeSessionIds`，内容与注册里的相同（`daemonHeartbeat`），即本守护进程当前持有的会话；会话结束、或执行宿主快照里不再有它时自然从列表消失。
- Server：
  - `httpapi/session_claims.go`：`DaemonHub` 记录每台设备上一次声明持有每个会话的时间。注册、`session_started`、每次心跳都会刷新；会话结束时删除。心跳带 `activeSessionIds` 时以它替换连接上的持有集合（与注册同义）；老 Worker 的心跳不带该字段，仍刷新连接已有的持有声明。
  - `sessions/recovery.go`：判失败改为“当前连接不持有，且距最后一个事件和最后一次持有声明都已超过 30 分钟”。当前连接持有时照旧直接保留。
  - Server 重启后内存里没有声明时间，以本进程开始接收设备的时间为下限：给每台设备 30 分钟重连并重新声明，不会在重启后立刻把静默会话判死。
- 仍会被清理的情况：Worker 停掉或设备一直不回来（30 分钟没有声明）；Worker 重启后新进程不持有它（新注册不含它，重连时 `recover_session` 立即询问设备，30 分钟后清扫兜底）；执行宿主丢了它（快照不再含它，心跳随之不再声明）。
- 协议：心跳负载不是 contracts 生成的类型（Go 端 `wsHeartbeatPayload` 手写），字段为可选，新旧 Worker / Server 互相兼容，无需 `pnpm generate:contracts`。

## 验证

- `go test ./internal/sessions`：新增“20 s 前刚被声明持有、事件已静默 31 分钟 → 不失败”“31 分钟没有声明 → 失败且时长按最后一次声明计”“别的设备的声明不算数”，原有用例改为新的声明查询，全部通过。
- `go test ./internal/httpapi`（`session_claims_test.go`）：真实 WebSocket 上 hello 声明会话 A、不声明 B，静默超过时限后心跳继续声明 A，再断开连接执行清扫：A 保持 running，B 判失败；把 A 的声明改成超时之前再清扫，A 判失败。另测心跳替换/保留持有集合、会话结束后删除记录、Server 重启后的时间下限。原有的 Reconnect / Stale 用例通过。
- Worker：`node scripts/run-worker-tests.mjs -- session-execution-registry.test.mjs` 6/6，新增“心跳在没有任何会话事件时持续声明正在跑的会话，结束后不再声明”。
- 回归确认：临时去掉“按最后一次声明计时”这一条，上面两条新用例都失败（会话在重连空档里被判 “stopped reporting session activity for 2s”），恢复后通过。
- 更大范围：`go test ./internal/httpapi ./internal/sessions -run 'Stale|Heartbeat|Outbox|ActiveSession|Daemon|Reconnect|SessionStarted|Orphan|Claim|Recover|Liveness|Ping'` 通过；`go vet` 无输出。
- `scripts/check-changed.sh --files …`（10 个文件）：prettier、gofmt、worker build、go test（httpapi 9 项、sessions 全包）、audit:contract、audit:modules 通过；worker tests 25 个文件中只有 `issue-execution.test.mjs` 3 项失败（沙箱执行器退出码 1、“Execution ended before steer was acknowledged”）。把 `control-connection.ts` 换回 `origin/main` 重新构建后同样 3 项失败，与本改动无关，判断是该 worktree 用符号链接复用主树 `node_modules` 导致的嵌套沙箱环境问题，未进一步排查。

## 限制

- 声明时间只在 Server 内存里；Server 重启后以重启时间为下限，所以重启前已经失联的会话，要到重启后 30 分钟才会被清理（以前可能立即清理）。
- Worker 未更新前：Server 端修复已经能覆盖本次事故（老 Worker 的心跳仍会刷新连接已有的持有声明），但 Worker 侧“丢了会话后心跳不再声明”的自我纠正要等 Worker 更新。
- 若 Worker 的会话 outbox 积压超过 30 分钟，会话结束消息晚于心跳到达，期间会话可能先被判 stale；结束消息到达后仍按“已结算会话”的路径交付结果（原有行为）。
- 未在 dev 上做真实长时间等待的端到端复现（需部署后观察）。

## 验收步骤

1. 部署 Server 后，在 sg-chaos 开一个会话，让它在后台跑 `sleep 2400` 并等待它完成（“Waiting for background tasks”）。预期：40 分钟内会话一直是运行中，不出现 “stopped reporting session activity”；sleep 结束后会话继续回答。
2. 在上一步等待期间重启 dev Server 一次。预期：会话仍是运行中，Worker 重连后照常继续。
3. （可选，会中断该设备上所有会话，只在测试设备上做）会话等待后台任务时停止该设备的 Worker 且不再启动。预期：约 30 分钟后会话被标为失败，错误仍是 “Local daemon stopped reporting session activity …”；之后重新启动 Worker。

## 部署与线上验证（2026-11-06，编排）

- Server 从干净树构建（另一会话当时在 dev 工作区里有未完成、无法编译的改动，没有带进来），18:07 在线备份 `backups/foundry-20261106-1807-pre-dev144-145.db`（integrity ok），旧二进制 `foundry-server.pre-dev144-145`，`pm2 restart`，healthz 200。Worker `0.5.7-dev.303.g1837af21.local.1793959952` 更新到 6 台在线设备（macbook 当时离线）。合并后的树上 `go test ./internal/sessions`、`./internal/httpapi -run Stale|Heartbeat|Outbox|ActiveSession|Daemon|Reconnect|SessionStarted|Orphan|Claim|Recover|Liveness|Ping|…`、worker `session-execution-registry` 6/6 通过。
- 线上复现原场景：sg-chaos 上新建会话 `sess_1793960134707319522`（hell-tw · claude-haiku-5-5），只在后台跑 `sleep 2100`。最后一条事件 18:15:45「Waiting for background tasks」，之后 34 分 58 秒没有任何事件（超过旧逻辑约 31 分钟的判定线），18:50:43 后台任务完成，会话正常结束为 completed，回复「dev144 background finished」。修复前同样情形会被标成「Local daemon stopped reporting session activity for 31m0s」。
- 未单独验证：Worker 真正丢失会话（进程被杀、Worker 换新进程）时 30 分钟后仍会被清理——由 `sessions`/`httpapi` 测试覆盖（无认领或认领过期即失败），线上没有故意制造这种情况。
