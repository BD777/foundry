# DEV-217 CanWendeMac-mini 静默离线且不再重连

## 状态

已合入 main（PR #267）。

根因已用 Mac 本机日志确认（见「确认的根因」）。修复 1–4 已上线：Server `61f14d85234f4fb5…`（12:28Z），Worker `0.5.7-dev.357.g8f394c91.local.1794572421`。Mac mini 12:18Z 自己恢复，12:29Z 已更新到新 Worker。2026-11-13 08:57:32Z 起 CanWendeMac-mini（`dev_d783b240-…`）离线，30 分钟以上没有任何重连尝试；没有远程通路，无法远程恢复。

## 证据时间线（UTC）

| 时间              | 事件                                                                                                                                            | 来源                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 08:38:17          | sess_1794542923400736342 对 7 台设备 `update_worker`，Mac 08:38:33 以 `…1794558943` 重连正常                                                    | session events、`device_presence`                                              |
| 08:44:45          | Server handoff，Mac 08:44:50 正常重连（第 381 s 连接，server shutting down）                                                                    | pm2 `foundry-server-error.log`                                                 |
| 08:47–08:52       | DEV-203 phase 2 在 Mac 上跑 deps/check/build（sess_1794505570139550262），build 完成                                                            | `resource_operations`                                                          |
| 08:52:59–08:57:30 | 同一会话以 7000 B 一片并行 `get_file` 拉 11.7 MB `jobs/build-out.tgz`，约 1,670 次，全部 ok                                                     | `resource_operations`                                                          |
| 08:55:51          | Mac 最后一次 resources report                                                                                                                   | `resource_sources.last_report_at`                                              |
| 08:57:30–32       | 三次 `get_file` 以 `device_error` 失败（~2 s）                                                                                                  | `resource_operations`                                                          |
| 08:57:32          | Server：`daemon websocket write failed type=resource_operate … websocket: close sent`；nginx：Mac 的 `/api/daemon/ws` 结束，101，766 s，1.74 MB | pm2 日志、`/var/log/nginx/foundry-dev.access.log`（Mac 公网 IP 56.10.120.153） |
| 08:57:36          | `device_presence.last_seen`                                                                                                                     | DB                                                                             |
| 08:57:56          | Server SIGHUP handoff；其余设备都在数秒内重连，Mac 不在关闭列表里（已断）                                                                       | pm2 日志                                                                       |
| 08:57:32 之后     | 该 IP 没有任何 Worker 请求（无 ws、无 HTTP）；09:09:37Z 同 IP 有一次 Edge（Mac）浏览器 API 请求 → 该网络在线                                    | nginx                                                                          |

## 判断

- **不是 Server 断的**：Server 的每条断开路径都会记 `daemon connection … closed (…)`，唯一不记的是对端发来 1000/1001 close frame（`readLoop` 只对非 Normal/GoingAway 记日志）；`close sent` 正是 gorilla 回应对端 close frame 后的写错误。
- **不是关机/重启/睡眠/kill**：进程被 SIGTERM/SIGKILL 或机器睡眠不会发 close frame，Server 会记 1006 或 ping 超时。
- **是 Worker 主动正常关闭**：Worker 里发 1000 的只有 `watchWorkerProxy` → `socket.close(1000, "Worker proxy configuration changed")`。它在代理文件指纹变化时触发——包括 `readWorkerProxy()` 抛错（指纹变成 `"invalid"`），即一次瞬时读失败就会被当作“配置变了”。
- **之后没重连**：正常路径下 Worker 1–30 s 退避重连，KeepAlive 也会拉起退出的进程；30 分钟零请求说明 Worker 进程活着但重连循环卡住/本地连不出，或 launchd job 已不在。09:09Z 同 IP 有浏览器流量，站点网络本身是通的。凌晨的多次 `ECONNRESET before TLS` 断网（00:05、01:41、01:56、02:09Z）都自己恢复了，这次不同。
- **不是更新导致**：更新在 19 分钟前且正常工作；macbook 同版本在线。
- 无法确认的部分需要 Mac 本机 `~/.foundry/logs/daemon.{out,err}.log`。

## 远程通路

都没有：sg-chaos 无 Tailscale/ZeroTier、无 ssh config；56.10.120.153:22 是 Debian OpenSSH（站点网关/NAS，不是 Mac），sg-chaos 与 limen-canada 的密钥均被拒；limen-canada 无 Tailscale；macbook 不在同一网络（142.91.102.221）。

## 需要本人/现场做的（一步，已不需要：设备 12:18Z 自行恢复）

在 Mac mini 上（屏幕共享或现场）打开终端执行：

```
launchctl kickstart -k gui/$(id -u)/dev.foundry.worker; tail -n 300 ~/.foundry/logs/daemon.err.log ~/.foundry/logs/daemon.out.log > ~/Desktop/foundry-drop.txt
```

如果屏幕停在登录窗口，先登录（Worker 是 LaunchAgent，需要用户会话）。

## 修复提案

1. **Server 记录所有断开**（`apps/server/internal/httpapi/daemon_conn.go` `readLoop`）：对端 1000/1001 也记日志并带 close code 与 reason，同时写 `disconnects.serverSide`。本次关键证据（Worker 发的 reason）被吞掉。
2. **代理监视不把读失败当变化**（`packages/worker/src/platform/server-link/server-proxy.ts` `watchWorkerProxy`）：只比较成功读出的指纹；读失败保留旧值并记一行日志；关闭前 `console.error` 原因。
3. **Watchdog 检查“连上了 Server”，不只看事件循环**（`packages/worker/scripts/watchdog.sh` + daemon heartbeat）：heartbeat 写入 `lastServerMessageAt`；超过 5 分钟未收到 Server 数据而进程仍活 → `launchctl kickstart -k`。现在一个活着但连不上的 Worker 会一直刷新 heartbeat，watchdog 永远不出手。
4. **重连循环自愈**（`packages/worker/src/daemon-connection.ts`）：连续 N 分钟重连失败后退出进程交给 launchd 重启（清掉卡住的 agent/socket 状态）。
5. **给常驻构建机一条独立的恢复通路**：Mac mini 启用远程登录并把 sg-chaos 公钥加入，或加入 tailnet；以及“自动登录”以免重启后停在登录窗口。这一条需要本人决定。
6. （次要）compute `get_file` 以 7 KB 一片拉 10+ MB 产物（每次约 1,700 个 RPC），macbook 09:27Z 正在重复同样模式；应改为大片或流式（`scripts/lib/remote-compute.sh` `download`）。与本次断开的因果未证实。

## 确认的根因（2026-11-13 12:3xZ，Mac 本机 `~/.foundry/logs`）

Mac 回来后，通过 compute lease 读了 `daemon.out.log` / `daemon.err.log`。没有重启（boot 时间 2026-11-11），launchd job 只跑过一次，也没有 watchdog 记录。

| 时间（UTC）         | Mac Worker 日志                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 08:57:32.686        | `Daemon connection closed: lasted 766s, closed by worker, code 1000, … proxy none`，即代理监视器检测到配置变化                              |
| 08:57:33 → 10:26:49 | 188 次 `Daemon connection closed: … code 1006, error Foundry server WebSocket via proxy https://127.0.0.1:60462 failed`，退避重连一直在进行 |
| ~10:27 → 12:17:42   | 221 次 `… via proxy socks5h://127.0.0.1:5555 failed`                                                                                        |
| 12:18:17            | `Connected daemon CanWendeMac-mini …`，代理文件已被删除，下一次重连直连成功                                                                 |
| 12:29:18            | 更新到 `…1794572421` 后重新连接                                                                                                             |

- **写入代理文件的是谁**：sess_1794553774406242973 在这台 Mac 上跑的 A/B 基准（compute scratch `dsh-ab`）。其中任务 T02 是修 `server-proxy.ts` 的 SOCKS 默认端口问题。被测的 agent（`runs/claude-T02-r2` 等）在 08:56–08:57Z 跑 `server-proxy` 测试和 `/tmp/fwdbg*` 下的独立复现，有的没有设 state root，就把设备真实的 `~/.foundry/worker-proxy.json` 写成了 `https://127.0.0.1:<测试代理端口>`（`server-proxy.test.mjs:224`）；10:27Z 又写成 `socks5h://127.0.0.1:<port>`（`:354`）。测试代理进程退出后，这两个端口都是死的。
- **为什么不重连**：监视器把它当成真实配置变化（这次文件是合法的），按 1000 关闭后按新代理重连；每次都连到本机一个已经没有监听的端口，Server 和 nginx 自然一个请求都看不到。进程、事件循环、heartbeat 都正常，旧 watchdog 不出手。前文推测的“读失败被当成变化”这次**没有发生**（代码路径真实存在，已用旧代码复现并修掉，但不是这次事故的原因）。
- **怎么恢复的**：12:18Z 左右文件被删除（基准测试的清理），下一次退避重连直连成功。没有人工重启。
- **处理**：A/B 会话已停掉在跑的基准，删掉 `/tmp/fwdbg-*`，并确认 `~/.foundry/worker-proxy.json` 不存在。以后每个 agent 和它跑的命令都设 `FOUNDRY_STATE_ROOT=<run>/state`，每轮跑完检查代理文件，一旦存在就删掉并停下。T02 已从基准里撤掉。
- **新 Worker 对这种情况的表现**：会记一行 `Worker proxy configuration changed (none saved -> https://127.0.0.1:… ); reconnecting.`；Server 记 `device closed the connection (… close 1000 …)`；5 分钟没收到 Server 数据就以 75 退出并被 launchd 拉起。但只要文件还指向那个死代理，重启也连不上：用户自己配的代理不能被 Worker 绕开。真正的防线是测试隔离（`run-worker-tests.mjs` 的沙箱，以及基准 kit 的 state root）。

## 实现（2026-11-13，sess_1794464313271186377 委派）

### 证据补充

- **close 帧确实来自 Worker**：gorilla 只有在已写出 close 帧后才返回 `websocket: close sent`；Server 自己写 close 的路径（`writeLoop` 的 done 分支）写完即返回，不会再写 `resource_operate`；`closePermanent` 只用于删除设备。所以是 Worker 发 close，Server 回应后写失败。`ws` 的 `close()` 不带码发空帧（Server 读成 1005，会记日志），带 1000 的只有代理监视。
- **但 Mac 08:44:50 那次重连报告写的是 `proxy=none`**：要么文件里有代理但被 NO_PROXY 绕过，要么 08:44–08:57 之间文件被创建/改动。仅凭 Server 侧证据无法区分；这次 session 事件里没有任何 `foundry-worker proxy` 调用。修复后两条路径都会留下原因（见下）。
- **“零次重连”的可复现机制**：旧代码里代理文件一旦读失败，监视器就关闭连接；之后每次重连在 `new ControlConnection` 里调用 `resolveServerProxy` → `readWorkerProxy` 再次抛错，连接在本地就失败（日志只有 `Daemon connection failed`），网络上一个请求都没有；进程和事件循环都正常，heartbeat 照常刷新，watchdog 不出手。只要文件一直读不出来，Worker 就一直离线。`packages/worker/test/daemon-server-contact.test.mjs` 复现了这个过程（旧代码：写坏文件 → 1000 关闭 → 再也没有 hello）。
- 产物分片：修复（lease command token 拿完整结果，`httpapi/mcp.go` `boundMCPResult`）**还没有上线**。在线 Server（`releases/dev023-candidate/foundry-server`，10:31Z 构建）的 `foundry-server.source-manifest` 里 `mcp.go` 是 HEAD 版（sha256 `b446bd9b…`），工作树里带修复的是 `4ebc49f4…`。（之前写“08:57Z 已上线”是错的：当时 `strings` 命中的是旧函数 `boundMCPResultContent`；`resource_operations` 里那些 4 MB `length` 其实是读日志尾的小文件，真正的大片都退回了小片。sess_1794561838479130736 直接调 `/api/mcp` 读 4 MiB，拿到的是 11,814 字节被截断、不合法的 JSON。）`scripts/lib/remote-fetch.mjs` 现在按 4 MiB → 1 MiB → 256 KiB → 64 KiB → 16 KiB → 7 KB 逐级试，修复随下一班部署上线后会自动用大片；已提醒 conductor 带上 `mcp.go`。**12:28Z 起已上线**：Server `61f14d85…` 的 source manifest 里 `mcp.go` 是 `4ebc49f4…`。

### 修改

| #   | 位置                                                                                 | 改动                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `apps/server/internal/httpapi/daemon_conn.go` `readLoop`                             | 设备先发起的正常关闭（1000/1001，cause = `closeByDevice`）也记日志并写入 `disconnects.serverSide`，内容带 close code 和 reason（如 `device closed the connection (websocket: close 1000 (normal): Worker proxy configuration changed)`）。设备页「诊断 → 上次断开」直接显示这一行。回应 Server 自己关闭（被替换、关停）的 1001 仍不记。                                                                  |
| 2   | `packages/worker/src/platform/server-link/server-proxy.ts`                           | `watchWorkerProxy` 只比较完整读出的配置；读失败或内容不合法记一行（只有分类，如 `(malformed JSON)` / `(EACCES)`，不打出文件内容）且不算变化。真正变化时回调带上“旧 → 新”（不含凭据），`control-connection.ts` 在关闭前打出 `Worker proxy configuration changed (…); reconnecting.`。                                                                                                                     |
| 4   | 同上 `savedWorkerProxy`                                                              | 根因修复：daemon 用的代理配置在本进程读成功过一次后，后续读失败就沿用最后一次读到的配置并记一行（同一错误只记一次），不再让每次重连在本地失败。从没读成功过时仍报错（没有安全的默认值）。CLI `proxy show/check` 是新进程，仍严格报错。                                                                                                                                                                   |
| 3   | `packages/worker/src/daemon-connection.ts`、`platform/server-link/server-contact.ts` | 记录最后一次收到 Server 的消息/ping/pong/open。独立于重连循环的定时检查：超过 5 分钟（`FOUNDRY_SERVER_CONTACT_LIMIT_MS`）没收到 Server 数据，就记一行并以 75 退出，由服务管理器重启。重连循环卡住（零次尝试）或一直失败都会被这条覆盖。没有 execution host、本进程还在跑 turn 时不退出；`--once` 和设备被删除后停放时不启用。heartbeat 文件增加 `serverContactAt` / `serverContactEpoch`（停放时不写）。 |
| 3   | `packages/worker/scripts/watchdog.sh`                                                | 兜底：heartbeat 新鲜但 `serverContactEpoch` 超过 15 分钟 → 按原来的 pid+启动时间校验停掉该进程（`nothing from the server for Ns, stopped pid …`）。                                                                                                                                                                                                                                                      |
| 3   | 服务定义（已核对，未改）                                                             | macOS plist `KeepAlive=true`（任意退出码都重启，`install/service.ts`）；Linux unit `Restart=always`、`RestartSec=5`。Mac app 包装器（`mac-worker-app.ts`）吞掉 `do shell script` 错误后退出，同样由 KeepAlive 拉起。                                                                                                                                                                                     |

### 测试

- Server：`TestDaemonDeviceNormalCloseRecordsCodeAndReason`（设备发 1000 + reason → 记录含 code 与 reason；被替换连接回应的 1001 不记录）及其余 `TestDaemon*`。
- Worker `daemon-server-contact.test.mjs`：真实 daemon 对本地假 Server：代理文件写坏 → 不关闭、不重连、记“Not a change”；随后真实变化 → 1000 关闭并打出旧→新，紧接着再写坏文件，daemon 仍然重新 hello；Server 拒绝 WebSocket 时，3 s 限制下 daemon 以 75 退出。`shouldRestartForServerSilence` 单测。
- `watchdog.test.mjs` 新增 macOS 用例（Mac 离线，未在本批跑；Linux 上跳过）。
- 结果（2026-11-13 10:3x–10:55Z）：byte-dev-sg `go test ./internal/httpapi -run TestDaemon` PASS（含 Worker `tsc`）；sg-chaos `run-worker-tests.mjs` 跑 `daemon-server-contact`、`server-proxy`、`daemon-reconnect-delay`、`connection-reports` 全部通过。byte-dev 当时连不上 proxy.golang.org / github.com，byte-dev-sg 没有 bwrap，Worker 测试只能在 sg-chaos 跑。
- 旧代码复现：把 HEAD 版的三个 Worker 文件放进一份副本，跑同样的场景：写坏代理文件 → 1000 `Worker proxy configuration changed` → 之后 12 s 内只有 `Daemon connection failed: Worker proxy configuration is unreadable or invalid…`（每次退避一行），Server 一次 hello 都没收到。和 Mac 的表现一致（进程活着、heartbeat 新鲜、nginx 零请求）。

### 限制

- 一个合法但指向死代理的 `worker-proxy.json` 仍会让 Worker 连不上（5 分钟自重启也无济于事），这是用户自己的设置，Worker 不绕开；防线是测试和基准的 state root 隔离（见「确认的根因」）。
- Server 本身宕机超过 5 分钟时，所有 Worker 每 5 分钟重启一次（有 execution host 的 turn 不受影响）。
- 第 5 条（独立恢复通路、自动登录）仍需本人决定。
- 部署：按 2026-11-13 新规则交给 train conductor sess_1794555762602239151 一起部署（Server + Worker，update_worker），本条目不自行部署；已于 12:28Z 随 train 2 上线，Mac mini 12:29Z 更新成功。

## 加固第二批（2026-11-13，orchestrator 委派）

目标：测试不能再把设备困在离线状态。

| 项                     | 位置                                                                                                                                                   | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 源码检出不碰真实 state | `packages/worker/src/platform/state-root.ts`                                                                                                           | Worker 代码从源码检出运行时（包根有 `src/` 和 `tsconfig.json`；发布包只带 `dist`），只要没设 `FOUNDRY_STATE_ROOT` / `FOUNDRY_STACK`，就用新建的 `$TMPDIR/foundry-checkout-state-*` 作 state root 和 tools root（写进环境，子进程共用），并在 stderr 说明一行。只有 `FOUNDRY_USE_REAL_STATE=1` 才用本机的 `~/.foundry`。原来只在 `node --test` 下拒绝（`NODE_TEST_CONTEXT`），这次的独立复现脚本正好绕过了它。已核对：线上设备都从 `~/.foundry/runtime` 运行；从源码检出运行的只有几个旧验收栈，它们都显式设了 state root；dev-stack、scratch-stack、pa-eval 和 Go 的 CLI 契约测试也都设了。 |
| 其他设备状态           | —                                                                                                                                                      | 85 处 `homedir()` 路径（`~/.claude`、`~/.codex`、LaunchAgents 等）仍由 `run-worker-tests.mjs` 的 OS 沙箱（macOS `sandbox-exec` / Linux `bwrap`）保护。不做全局 HOME 重定向，因为那会改到 agent 的原生登录。                                                                                                                                                                                                                                                                                                                                                                                 |
| 代理自愈               | `platform/server-link/server-route.ts`（新）、`server-proxy.ts`、`daemon-connection.ts`、`control-connection.ts`                                       | 配置的代理连续失败 ≥5 次且持续 ≥2 分钟（`FOUNDRY_PROXY_FALLBACK_FAILURES` / `_AFTER_MS` 可调），就先试环境变量里的代理（仅当保存的设置覆盖了另一个），再试直连。stderr 打出 `WORKER PROXY UNREACHABLE: … Connecting directly …`。状态写进 `<state>/server-route-fallback.json`，execution host 和重启后的 Worker 走同一条路。能连上的路线保持不变，备选路线也连续失败时换下一个，都不行就回到配置的代理重新计数。每 10 分钟对配置的代理做一次 TCP 探测，能连上就清掉 fallback 并重连。代理配置一变，fallback 自动作废。2 分钟的阈值早于 5 分钟的无联系自重启。                              |
| 设备页可见             | `contracts/models/devices.yaml` `DeviceWorker.proxyFallback`（生成 Go/TS）、`apps/web/src/features/devices/device-worker.tsx`、两种语言的 `devices.ts` | Worker 在注册时报告 `proxyFallback {configured, route, environmentProxy?, since, reason}`（只含 scheme、host、port，不含凭据）。设备页 Worker 区块显示警告：「代理 X 连不上：Worker 已改为直连……」。                                                                                                                                                                                                                                                                                                                                                                                        |

测试（sg-chaos，`run-worker-tests.mjs`）：`checkout-state-root.test.mjs`（新：普通 node 从检出写代理文件，落在临时 root，不进 `$HOME/.foundry`；`FOUNDRY_USE_REAL_STATE=1` 和显式 root 照用）；`server-route.test.mjs`（新：阈值、直连、凭据不外露、成功后保持、探测恢复、环境代理优先、全部失败回退、配置变化作废）；`daemon-server-contact.test.mjs` 新增端到端用例（真实 daemon，代理设为 `http://user:secret@127.0.0.1:1`，阈值 2 次 / 1 s：直连到达 Server，hello 里 `proxyFallback.route=direct`，不含凭据）。`server-proxy`、`connection-reports`、`daemon-reconnect-delay` 全部通过；Worker `tsc` 和 protocol `tsc` 通过。Web typecheck 和 Go `TestDaemon|TestDevice` 在 byte-dev-sg 上跑（结果见流水）。

部署（train 5，2026-11-13 13:24Z，conductor sess_1794555762602239151）：Server `298b10dbd3414e73…`，Web `41ae339dac57f691`，Worker `0.5.7-dev.357.g8f394c91.local.1794575704`。生成文件和 DEV-218 已上线的契约改动有冲突，conductor 用合并后的 models 重新生成（只增加 `DeviceProxyFallback`）。部署前 httpapi `TestDaemon|TestDevice`、web tsc + audit:ui 和上述 Worker 测试共 41/41 通过。macbook 离线，未更新。

限制：`foundry-worker update` 是单独的进程，也读 fallback 文件，所以同样会绕开坏代理；macOS 的系统代理（`scutil --proxy`）不在候选里，只看环境变量。

### 设备页浏览器检查（2026-11-13 13:3xZ）

- 用 scratch stack（空的合成 DB，不复制线上数据）配对一个测试 Worker，代理设为 `http://127.0.0.1:1`，阈值降到 2 次 / 5 s。
  - 第一次：4 次失败（6 s）后改走 shell 环境变量里的代理并连上。重启 Worker 后仍按保存的路线连上，说明 fallback 跨重启保持。
  - 删掉保存的路线文件、去掉环境变量里的代理再启动：改为直连。
  - API 里 `worker.proxyFallback` 只有 host 和 port，不含凭据。
- 第一版有两个问题：提示只出现在「设置」页签，默认页签看不到；正文是原始 ISO 时间加 Worker 的英文原因。已改：提示放到设备页头部，每个页签都显示（只给设备所有者、设备在线时显示）；时间按本地格式显示；文案改为「无法通过代理 X 连接 Foundry，这台设备已改为直连。自 <时间> 起。X 恢复后会自动切回。如果已经不需要这个代理，在这台设备上运行 foundry-worker proxy clear；要换成别的代理，运行 foundry-worker proxy set 并填上新地址。」。
- 截图：在正常比例（1280 宽）下看过亮色和暗色，副本在 sg-chaos 的 `/tmp/dev217-patch/direct-{light,dark}.png`。byte-dev-sg 上 web typecheck 和 `audit:ui`（样式不变量、组件体系、hints）都通过。改动作为 `/tmp/dev217-patch/dev217-web-followup.diff`（4 个文件，相对第二批）交给 conductor。
- 没做：中文界面没有截图（文案已审阅）；没在真实设备上制造坏代理。

### 设备页上的两个按钮（2026-11-13，按本人“不要交给人手动操作”的规则）

- 提示正文去掉了 CLI 命令，改成两个按钮：「不再使用这个代理」和「改用别的代理…」（小对话框，填地址，先在页面上校验，再由 Worker 校验）。
- 链路：只有设备所有者能调用 `PUT /api/devices/{deviceId}/worker/proxy`（`{clear:true}` 或 `{url}`），Server 经守护连接发 `set_worker_proxy` → Worker 用 `applyWorkerProxySetting` 写入或清除 `worker-proxy.json`，原有的 no-proxy 设置保留，回复里不带凭据。之后代理监视器发现配置变化，自动重连到新路线，fallback 随之作废。旧 Worker 没有 `worker_proxy_settings` 能力时，Server 直接回 409「先更新 Worker」，不会等到超时。Server 不保存也不记录这个地址。
- 测试：Go `TestSetDeviceWorkerProxyGoesThroughTheWorker`（无能力时 409、参数不合法时 400、清除、设置时去掉首尾空格且回复不含凭据、Worker 拒绝时原因能传到页面）；Worker `worker-proxy-setting.test.mjs`；Web `devices-feature.test.mjs` 新增用例（提示出现在页面上、页面里不出现 CLI 命令、按钮发出正确的请求、不合法地址不发送并就地提示）。全部 14 个通过；web typecheck 通过；`audit:ui` 各项通过（`feature-architecture` 只因别的会话的 `server-held-connector.tsx` 超过 1000 行而失败，与本改动无关）。
- 改动以 `/tmp/dev217-patch/dev217-proxy-actions.diff`（16 个文件，相对线上）交给 conductor；上线后补中英文截图。

## 验收

1. 部署后在任一在线设备上执行 `printf '{ half' > ~/.foundry/worker-proxy.json`（事先备份原文件），1–2 s 内 `~/.foundry/logs/daemon.err.log` 出现 `… unreadable or invalid (malformed JSON) … Not a change`，设备保持在线；恢复原文件。
   2a. 在一台测试设备上 `foundry-worker proxy set http://127.0.0.1:1`（事先记下原设置），重启 Worker：约 2–3 分钟后日志出现 `WORKER PROXY UNREACHABLE`，设备回到在线，设备页头部出现「无法通过代理 http://127.0.0.1:1 连接 Foundry，这台设备已改为直连」。点「不再使用这个代理」后几秒内提示消失，设备保持在线；再点「改用别的代理…」填 `proxy:3128`（不合法）会就地提示，填一个可用地址则保存成功。
2. `foundry-worker proxy set http://127.0.0.1:9 --no-proxy '*'` → 日志出现 `Worker proxy configuration changed (none saved -> http://127.0.0.1:9 no-proxy "*"); reconnecting.`，设备几秒内重新在线；设备页「诊断 → 上次断开」显示 `device closed the connection (websocket: close 1000 (normal): Worker proxy configuration changed)`；`foundry-worker proxy clear` 恢复。
3. Server 日志 `foundry-server-error.log` 对第 2 步有一行 `daemon connection dev_… closed (device closed the connection): websocket: close 1000 (normal): Worker proxy configuration changed`。
