# DEV-100 · SIGHUP 交接时旧进程 15 s 才退出，长请求被 nginx 502

状态：已部署 dev：Server `95e6f102…`（SIGHUP 两次，第二次是验证）。Agent 自验通过。人工验收待确认。未提交。来源：编排会话反馈（dev Server 连续几次 SIGHUP 交接，旧进程都在 15.0 s 后以 status 1 退出，期间打开的 `wait_session` 长请求得到 502）。

## 问题

DEV-062 的零中断交接要求旧进程在新进程就绪后很快退出。最近几次交接日志是：

| 时间（UTC+8）               | 旧进程退出耗时 | 状态            |
| --------------------------- | -------------- | --------------- |
| 10-30 01:40–12:01（前五次） | 0.37–3.3 s     | `<nil>`         |
| 10-30 13:41                 | 15.033 s       | `exit status 1` |
| 10-30 14:57                 | 15.022 s       | `exit status 1` |

15 s 是 `shutdownTimeout`（`cmd/foundry-server/config.go`）；`status 1` 是 `http.Server.Shutdown` 返回 `context deadline exceeded`，随后 `Close()` 掐断剩余连接，nginx 对这些连接回 502。

## 调查

- `lifecycle.go` 的 `stop` 先关监听，再调 `api.Shutdown`（结束 SSE、WebSocket、服务隧道），最后 `http.Server.Shutdown`。两次慢交接的日志里没有 “protocol shutdown incomplete”，所以 SSE 和 WebSocket 都已按时结束，剩下的是 `http.Server` 自己跟踪的普通请求。
- 没有哪个 handler 会听“正在关闭”。Server 里持续很久的普通请求是 MCP 的 `wait_session`（以及 `create_session`/`handoff_session`/`send_message` 带 `wait`），最长 10 分钟（`maxMCPWaitMs`），`waitMCPStatuses` 只听 `ctx.Done()` 和 1.5 s 的定时器。设备 RPC 类请求（`daemonRequest`）在 `hub.Shutdown` 关闭设备连接时立即失败，不会拖住。
- 为什么是“最近”：这条长轮询是旧代码（2026-10-14），交接机制是 DEV-062（10-28）。只要交接时刻有一个 `wait_session` 在跑，就会拖满 15 s；编排会话一直在对子会话 `wait_session`，所以几次交接都撞上；前面快的几次交接时大概没有打开的等待（旧日志不记进行中的请求，这是推断，不是记录）。DEV-095 的 chat_queue 和 DEV-096 的 daemon_liveness 改动不涉及 HTTP 长请求（后者只让 `daemonRequest` 在等待中检查链路，且设备连接关闭时立即返回），不是原因。
- 复现：基线版本上，开着一个 600 s 的 `wait_session` 再 `Shutdown`，`http.Server.Shutdown` 到期报 `context deadline exceeded`，剩余连接正是这个 `POST /api/mcp`（用下面新增的“未结束请求”记录核对）。

## 修复

- `internal/httpapi/drain.go`（新）：
  - `drainState`：`Server.Shutdown` 一开始就 `begin()`，关闭 `Draining()` 信号；零值可用。
  - 在 `Routes()` 最外层记录进行中的请求（方法、路径、起始时间；不含 query；Upgrade 请求不记，它们已脱离 `http.Server` 的计数）。`OpenRequests()` 返回尚未结束的请求，由老到新。
- `mcp_sessions.go`：`waitMCPStatuses` 增加 `case <-draining`，返回 503 状态错误，文本为 “the Foundry server is restarting, so waiting on `<id>` ended early; the session is `<status>`. Wait again: the next call reaches the new server”。MCP 层把失败的工具调用作为 `isError` 结果交还（HTTP 200），和已有的 “timed out waiting” 同一类，工具描述本来就让 agent 在这种情况下再次 `wait_session`。一个在服务器已开始关闭后才到达（走的是关监听前已接受的连接）的等待，第一次检查状态后立即得到同样的回答。
- `cmd/foundry-server/lifecycle.go`：`serving.openRequests`（由 `run` 设为 `api.OpenRequests`）；`Shutdown` 超时时记一行 “shutdown: N request(s) still open after 15s: POST /api/mcp open for …”，下次再慢能直接看到是谁。超时仍返回错误（status 1），干净排空返回 nil（status 0）。
- SSE 与 WebSocket 沿用原有路径（`stream.Shutdown()`：流以正常结束收尾，Web 的 `event-source-feed.ts` 自己重连；`hub.Shutdown()`：WebSocket 收到 1001 “server shutting down”，设备重连）。

## 测试

新增（Go）：

- `TestShutdownDrainsAnOpenStreamAndAnOpenWait`（`httpapi/drain_test.go`）：真实 `httptest.Server`，一个 `/api/events` 流 + 一个 600 s 的 `wait_session`；`Shutdown` + `http.Server.Shutdown` 在 1 s 内完成；流是干净 EOF；等待得到 HTTP 200 的 `isError` 结果，含 “restarting”、会话 id 和 “Wait again”；结束后没有未结束请求。去掉 `draining` 分支时该测试失败：`http.Server.Shutdown: context deadline exceeded after 5s, open: [POST /api/mcp open for 5.01s]`，正是线上症状。
- `TestWaitOnADrainingServerAnswersAtOnce`：服务器已在排空时到达的等待立即得到回答。
- `TestOpenRequestsNameWhatIsStillRunning`：记录只含方法和路径，不含 query，结束后清除。
- `cmd/foundry-server/drain_test.go`：`TestStopDrainsLongRequestsWithoutAnError`（长请求在 `drainProtocols` 后得到回答，`stop` 返回 nil、不到 1 s）；`TestStopNamesTheRequestsThatOutlastedTheBudget`（超时时日志点名未结束请求，仍返回错误）。

结果：新增三项 httpapi 测试和 `cmd/foundry-server` 全包通过；`internal/eventstream` 通过。`internal/httpapi` 全包（含他人未提交的改动）也通过（735 s）。

## 部署与验证

- 构建自共享工作树现状（含未提交的 DEV-085 r4、DEV-095、DEV-096、DEV-099）；Server `95e6f102…`。回滚副本 `~/.foundry/server/releases/dev023-candidate/foundry-server.pre-dev100`（`349362f9…`，部署前线上的二进制）。
- 经 nginx（公网入口）用 `e2e-alice` 的临时 cookie 保持：一个 `wait_session`（`until:["blocked"]`，timeout 600 s，等待一个已结束的合成会话，所以不会自行完成）、一个 `/api/events` SSE 流、一个每 0.15 s 的 `/healthz` 探测，另有一个浏览器页里的 `EventSource`（无头 Chromium，临时 cookie）。验后登出、删除 cookie 与临时文件、关闭浏览器。
- 交接 1（旧二进制 → 新二进制，部署时必经；也是修复前的基线）15:22:40：旧进程 `exited after 15.035s (exit status 1)`；等待在 22.1 s 后得到 nginx 502（nginx 访问日志 15:22:57 `POST /api/mcp 502 rt=21.924`）；SSE 约 7 s 时干净结束；浏览器 `EventSource` 报错后 1.2 s 内重新 open。
- 交接 2（新 → 新，验证修复）15:23:34：`previous pid … exited after 657ms (<nil>)`；等待在 6.1 s 时得到 HTTP 200 的 “restarting … Wait again”；SSE 6.2 s 时干净结束；浏览器 `EventSource` 1.1 s 内重新 open；218 次 `/healthz` 探测全部 200。
- nginx 访问日志 15:22–15:25 约 1000 个请求中唯一的 5xx 是交接 1 里那个被旧进程掐断的等待（15:22:57）；交接 2 窗口（15:23:34）没有 5xx。
- 交接 2 的日志里没有 “shutdown: … still open”（这行只在超时时出现）。

## 限制

- 只对**新**二进制的下一次交接生效：被替换的进程是旧二进制，它的排空行为不变，所以部署本次修复的那一次交接仍会让当时打开的 `wait_session` 吃 502（交接 1 里的基线就是这样）。之后的交接不会。
- 其他可能持续很久的普通请求（设备 RPC、安装类请求，最长 11 分钟）在 `hub.Shutdown` 关闭设备连接时因 “daemon disconnected” 立即失败，调用方得到一个错误而不是 502；它们没有改成“重试答案”。如果以后发现这类请求被掐断，`shutdown:` 日志会点名。
- 回答里的 “the session is …” 是被等待的会话当前的状态（可能已不是 `until` 里的状态，也可能还在运行）；agent 应再次 `wait_session`。
- Web 与 Worker 不涉及；没有改协议。

## 验收步骤（人工）

1. 在编排会话里对一个运行中的子会话 `wait_session`（或 `create_session` 带 `wait=true`），保持等待。
2. 按 `docs/development.md` 的 “Deploying the dev Server” 部署任意新二进制并 `pm2 sendSignal SIGHUP foundry-server`（本项的二进制已在线，所以这是第一次用新进程排空旧进程）。
3. 预期：pm2 日志出现 `previous pid … exited after <1–2 s> (<nil>)`；等待几乎立即返回一条 “the Foundry server is restarting … Wait again” 的错误结果，再次 `wait_session` 即可继续；`/var/log/nginx/foundry-dev.access.log` 该时刻没有 502。

## 流水

| 时间（UTC+8）    | 变化与证据                                                                                                                    | 剩余动作                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 2026-10-30 15:25 | 定位、修复、两次 SIGHUP 验证（见上）；Server `95e6f102…` 已部署，回滚副本 `foundry-server.pre-dev100`；Agent 自验通过。未提交 | 人工验收；编排会话于 22:00–09:00 提交 |
