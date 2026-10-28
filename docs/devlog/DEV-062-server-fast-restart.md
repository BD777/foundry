# DEV-062 Server 重启快速恢复（启动提速、就绪门、无中断交接）

状态：已部署 dev，2026-10-28 15:39 起以无中断交接（supervisor）模式运行；待人工验收。

## 问题

每次部署 `pm2 restart foundry-server`，用户会看到 1–2 分钟 “Failed to fetch”，随后设备和浏览器同时重连。nginx 记录：2026-10-28 00:47–00:48 有 239 个 502，10:44–10:45 有 208 个 502。10:44:27–10:45:30 这 63 s 里 Server 没有在监听：进程启动后先在约 1 GB 的 SQLite 上跑完全部迁移和维护，然后才 `Listen`。

## 调查（DB 副本：sqlite backup API 复制到 tmpfs，`FOUNDRY_INTEGRATIONS=off`、独立端口）

| 阶段（已是最新 schema 的库，每次启动都做）                   | tmpfs 副本 | 说明                                                                              |
| ------------------------------------------------------------ | ---------- | --------------------------------------------------------------------------------- |
| `backfillSessionSchedules`                                   | 3.7–4.9 s  | 对每个 `agent_sessions` 行做 `json_each` 全表扫描；现有写路径已维护 `$.scheduled` |
| `pruneOrphanedRows`                                          | 3.2–4.4 s  | 单个大事务，独占写连接                                                            |
| `setupWorkspaceDigests` → `redactWorkspaceDigests`           | 0.7–1.0 s  | 每次重新脱敏全部 digest                                                           |
| `migrateNativeSessions`                                      | 0.2–0.9 s  | 已有 `checked_at` 增量机制，保留                                                  |
| `backfillAnswerRevisions`、`pruneAgentSessionInlineEvents`   | 0.15–0.3 s | 全表 JSON 扫描，写路径已不再产生                                                  |
| `accounts` 包 init（bcrypt cost 12 的 dummy hash）           | 0.8–1.9 s  | 每个进程启动都算一次，包括 `--help`                                               |
| 其余（secret store、Feishu bots、设备下线、chat queue 恢复） | < 20 ms 各 |                                                                                   |
| **启动到 `/healthz` 200**                                    | **13.6 s** | 线上磁盘冷缓存约 63 s                                                             |

## 修复

- **一次性迁移只跑一次**：`sqlitestore/migrations.go` 新增 `applied_migrations` 表和 `s.once(name, step)`。`backfillSessionSchedules`、`backfillAnswerRevisions`、`pruneAgentSessionInlineEvents` 成功后记录，之后跳过；失败不记录。修改了的一次性迁移要换新名字（`name/v2`）。耗时 ≥ 500 ms 的迁移步骤记一行日志。
- **维护移到后台**：新增 `RunMaintenance`（`maintenance.go`），在 Server 能应答后运行。孤儿清理先在只读池找出 rowid，再按每批 500 行删除，每批是一条独立的短写，删除前会再次确认 owner 仍不存在；digest 脱敏在只读池读取，用 compare-and-swap 写回，不会覆盖期间新写入的 digest。
- **bcrypt dummy hash** 改为 `sync.OnceValue`，在 init 里异步预热，进程启动从 1.9 s 降到 0.1 s。
- **先监听、再开库，加就绪门**（`cmd/foundry-server/lifecycle.go`）：端口在开库前绑定，并在占用中重试，重试时长超过上一进程的 drain 时间。启动期间到达的请求在就绪门等待，最多 30 s，然后由 API 应答；超时返回 503 和 `Retry-After`。`/healthz` 在就绪前立即返回 503，就绪后返回 200。日志写出 “ready N ms after start”。
- **停止时先停 accept 再 Shutdown**：Go `http.Server` 在 Shutdown 开始后读到的新请求会直接断开，nginx 因此给出 502。现在先关 listener，等 Serve 返回，再给刚 accept 的连接最多 1 s 把请求读进来，最后才 Shutdown。
- **无中断交接**（`handoff.go`，`FOUNDRY_RESTART_HANDOFF=1`）：pm2 管理的进程成为 supervisor，持有监听 socket，把 Server 作为子进程运行，子进程继承该 socket。收到 SIGHUP 时，supervisor 从同一路径（即新部署的二进制）启动新子进程；新子进程就绪后再 SIGTERM 旧子进程；旧子进程退出后，新子进程才启动后台任务（chat queue、Feishu、supervision 等），保证这些任务同一时间只在一个进程里运行。socket 全程不关，期间到达的连接在 backlog 里等待，不会被拒绝。子进程用 `syscall.ForkExec` 启动：os/exec 会对继承的文件调用 `Fd()`，把共享 socket 改成阻塞模式，导致旧进程的 accept 阻塞，关闭时卡住（测试中复现过）。另有 `Pdeathsig` 和孤儿检测，supervisor 消失时子进程会自行退出。
- **为什么选 socket 交接**：nginx 只有一个 upstream，`proxy_next_upstream` 失败后没有可换的目标，也不能等待后重试；pm2 fork 模式的 reload 等同于 restart，旧进程退出前不会启动新进程；SO_REUSEPORT 在关闭监听时会丢弃已排队的连接，而且两个进程的后台任务会重叠。supervisor 持有 socket 是能做到零拒绝、又不需要 sudo 或改动 nginx 的最简方案。
- **Web**（`apps/web/src/api/http.ts`，10-28 晚修正，见下）：只有当 GET 根本没有到达 Server 时才静默重试：代理自己的 502/504 错误页（HTML），或带 `X-Foundry-Starting` 头、正在启动的 Server 返回的 503。重试共 5 次，间隔 250 ms → 2 s，合计约 5 s。写请求、连接失败、API 自己的 502–504/503/409 都立即返回。没有另加 “Reconnecting…” 界面：交接模式下读请求不会出错；SSE 原本就会自动重连。
- **Worker**（`daemon-connection.ts`）：重连等待改为 `reconnectDelayMs`，即 backoff × 0.5–1.5 的随机值，避免所有设备在同一瞬间重连。已随 DEV-061 的联合 Worker `0.5.7-dev.104.g4d184b2.local.1793172116` 发布。

## 部署与验证

- Server：`releases/dev062-fast-restart/foundry-server`（sha256 `aa09f6b2ee80fb36…`，包含 DEV-057 的 inbox/delivery/inputId 改动和 chat steer `delivery`）复制到 `releases/dev023-candidate/foundry-server`。回滚二进制：`foundry-server.pre-dev062`（sha256 `61e2c75f…`）。
- 第一次重启（2026-10-28 15:20:31 北京时间）：一次性迁移首次在线上库运行（`backfillSessionSchedules` 58.7 s），59.5 s 后就绪。nginx：8 个 502（旧进程退出到新进程绑定端口之间）、18 个 503（就绪门 30 s 超时）。之前同类重启约 200 个 5xx。
- 第二次重启（15:22:12，稳态）：**进程启动后 328 ms 就绪**，`pm2 restart` 到 `/healthz` 200 共 2.3 s。nginx：**3 个 502**（15:22:13–14，都是 Worker 的 daemon 请求），其余 256×200、53×304，没有 503。后台维护：孤儿清理 4.1 s、脱敏 0.9 s，期间照常服务。
- DB 副本（tmpfs）：启动到 healthy 从 13.6 s 降到 0.4–1.1 s。supervisor 模式下 4 路并发压测，期间两次 SIGHUP 交接：1290 个请求全部 200/401，**0 个 5xx 或连接错误**，最大延迟 107 ms；旧进程在新进程就绪后 14–26 ms 内退出。
- 测试：`go test ./cmd/foundry-server`（新增：就绪门持有请求、端口先于开库绑定、supervisor 交接 0 失败、后继失败时保留旧进程；交接测试连续 6 次通过），`./internal/sqlitestore`（新增 `TestOnceRunsAOneTimeMigrationUntilItCompletes`，更新孤儿清理和 inline events 相关测试），Web `test/api-restart-retry.test.mjs`，Worker `test/daemon-reconnect-delay.test.mjs`，`pnpm typecheck`。
- `send_message` 发往运行中会话的回执为 `delivery=boundary state=delivered`。发往 queued 会话的情况，本次部署后没有遇到 queued 状态的会话可测，由 DEV-057 负责线上验证。
- Web：从共享树构建 `b3d2617e4d7a847c`，经 `scripts/deploy-web-dev.sh` 发布；入口资源一致，API 返回 JSON。

## 限制与后续

- dev 仍是普通 `pm2 restart` 模式：每次部署约 1–2 s 拒绝连接，约 3 个 502。要切到零中断，需要以 `FOUNDRY_RESTART_HANDOFF=1` 重建 pm2 app。`pm2 restart --update-env` 会用调用方的整个环境替换 app 环境（pm2 `API.js` 中的 `Object.assign({}, process.env)`），在 session shell 里执行会丢掉 `FOUNDRY_DB_PATH` 等变量，也会带进 session 自己的变量。建议用只列出 Server 所需变量的 ecosystem 文件执行一次 `pm2 delete` + `pm2 start`，期间约 2 s 中断。之后部署改用 `pm2 sendSignal SIGHUP foundry-server`。另外，当前 pm2 app 环境里残留了某个 session 的 `FOUNDRY_SESSION_*`/`FOUNDRY_AGENT_*` 变量，重建时应一并去掉。
- 新增一次性迁移的二进制，第一次启动仍会在开库时运行该迁移；耗时长的迁移应设计成后台的批量迁移。
- 就绪门最长 30 s；启动超过 30 s 时，仍在等待的请求会收到 503。

## 人工验收步骤

1. 部署时按 `docs/development.md` 的 “Deploying the dev Server” 替换二进制，然后执行 `pm2 sendSignal SIGHUP foundry-server`，同时在浏览器停留在会话页。预期：没有错误 toast，页面不停顿；pm2 日志出现 “restart handoff: new server pid … took over”。
2. 执行 `sudo awk '$7>=500' /var/log/nginx/foundry-dev.access.log | tail`。预期：交接那一分钟没有 5xx。
3. 在 pm2 日志中查看 “ready N ms after start”。预期：几百毫秒（第一次运行新的一次性迁移时除外，此时旧进程继续服务）。
4. 执行 `tr '\0' '\n' < /proc/$(pm2 pid foundry-server)/environ | cut -d= -f1`（只看变量名）。预期：没有 `ANTHROPIC_*`、`CLAUDE_*`、`FOUNDRY_SESSION_*` 等会话变量。

## 2026-10-28 15:37–15:41 切换到无中断交接模式（编排会话批准）

- 备份：`pm2 save`；`~/.pm2/dump.pm2` 复制到 `releases/dev062-pm2-backup/dump.pm2`（0600），同目录另存一份按原 env 生成的回滚 ecosystem（0600）。
- 新 ecosystem `~/.foundry/server/foundry-server.ecosystem.config.cjs`（0600，仓库外）。变量清单来自代码实际读取的变量（`Getenv`、Go 的 proxy 变量、`git` 子进程），值取自原 env，不打印。保留：`FOUNDRY_DB_PATH`、`FOUNDRY_PREVIEW_SAME_SITE`、`FOUNDRY_STATE_ROOT`、`FOUNDRY_WEB_ORIGIN`、`FOUNDRY_WORKER_PACKAGES`、新增的 `FOUNDRY_RESTART_HANDOFF`，以及 `HOME`、`PATH`、`USER`、`LOGNAME`、`LANG`、`LANGUAGE`、`LC_ALL`、`TZ`、`HTTP(S)_PROXY`、`NO_PROXY`/`no_proxy`。去掉原 env 中 79 个会话变量，包括 `ANTHROPIC_*`（含 token）、`CLAUDE_CODE_*`、`FOUNDRY_SESSION_*`、`FOUNDRY_AGENT_*`、`FOUNDRY_NATIVE_*`、`TMPDIR` 等。`kill_timeout` 设为 5 s。
- 发现：第一次 `pm2 start`（15:39:02）时，pm2 把执行命令的 shell 环境并入 app，`filter_env` 不起作用，本 session 的变量又被带了进去；这正是原来泄漏的来源。15:39:33 用 `env -i HOME PATH` 的干净环境重建，从 `/proc/<pid>/environ` 核对，supervisor 和子进程都只剩上述变量，外加 pm2 自带的 `PM2_*`/`NODE_*`。随后 `pm2 save`。
- 两次重建期间 nginx 共 14 个 502（12 + 2），属预期的一次性中断。
- SIGHUP 交接（15:40:08，轻负载：每 0.1 s 经 nginx 发一个 GET，外加真实流量）：新进程 411 ms 就绪，旧进程 1.24 s 后退出；15:40:00–15:40:45 nginx 共约 390 个请求，**0 个 5xx**。`/healthz` 200；Feishu bot 15:40:12 重新连上；交接后 6 次设备重连，没有一次遇到 502；日志中没有 connector/refresh 错误。

## 2026-10-28 晚 修正 Web 重试范围（DEV-066/068 报告 Web 测试失败）

- 现象：worker-commands、accounts-gate、local-image、file-delivery、foundry-skill-page、session-work-controls、workspace-services 共 11 个用例失败，workspace-services 卡住约 15 min。
- 根因：第一版在 `apiFetch` 里对所有 GET 的 502/503/504 和连接失败（TypeError）都重试约 8 s，用的是真实计时器。这些状态码其实多数是 API 自己的回答：设备超时的 504、“Response lost” 的 503、database_busy 和设备忙的 503（带 Retry-After），各页面已有自己的处理（重试按钮、离线提示、use-session-work 的 busy 重试）。连接失败则表示浏览器离线：有 nginx 在前时，重启不会让浏览器的连接被拒，只会出现 502。所以第一版：shared read 的请求次数被放大（8 次）；离线、超时提示被推迟到约 8 s 后（local-image 停在 “Loading image from device…”）；离线用例累计等待真实计时器，直到卡住。用例的断言是对的，错的是产品代码的重试范围。
- 修复：只在请求确实没有到达 Server 时重试，即代理的 HTML 502/504，或正在启动的 Server 的 503（Server 在就绪门的 503 上新加 `X-Foundry-Starting: 1`，见 `lifecycle.go` 的 `notReady`）。重试次数有上限，间隔可注入；读取失败的响应体会取消；连接失败不重试。没有改动任何已有用例的断言。`test/api-restart-retry.test.mjs` 改为覆盖以下情况：代理错误和启动中的 503 会重试；API 的 JSON 502、纯文本 504、带 Retry-After 的 busy 503、409、500 各只请求 1 次；离线立即失败；等待期间被取消的请求不再重发。
- 说明：Server 的 `X-Foundry-Starting` 头已在共享树中，会随下次 Server 部署上线。在此之前，dev 上启动中返回的 503 不会被 Web 重试；交接模式下本来也不会出现这种 503。
