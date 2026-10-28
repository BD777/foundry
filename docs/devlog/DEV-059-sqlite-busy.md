# DEV-059 Timers 面板 “database is locked (SQLITE_BUSY)”

状态：根因已查明；修复已实现、测试通过并部署到 dev（与 DEV-055/060 合并部署），Agent 自验完成；人工验收待确认。来源：协调会话 `sess_1793063405185071529` 转达的用户反馈（2026-10-28）。实施会话：`sess_1793121633693972645`。本会话不写 Git 历史，提交由协调会话负责。 2026-10-29：已关闭（Agent 委托验收，用户 2026-10-28 授权），范围与保留限制见文末。

合并：2026-10-28 夜间窗口经 PR #154 合并到 main（分支 `release/dev054-068`，本事项单独提交，共用文件在 shared wiring 提交）。

| 环节          | 状态   | 说明                                                                                         |
| ------------- | ------ | -------------------------------------------------------------------------------------------- |
| 问题理解/调研 | 已完成 | 延迟事务读后写的升级不走 busy handler；admin CLI 在线上库跑完整迁移与清理                    |
| 代码          | 已完成 | 写事务 IMMEDIATE；无变化的保存走读池；CLI admin 模式；busy → 503；Web 重试一次；设备轮询减负 |
| dev 部署      | 已完成 | Server `61e2c75f0adfb0d6`（与 DEV-055/060 合并，10-28 10:45）；Web `5581a718c528ce0b`        |
| Worker 更新   | 不涉及 | —                                                                                            |
| Agent 自验    | 已完成 | Go 全量、Web 95 个测试与审计、scratch 栈真实浏览器锁窗口、线上 nginx 前后对比                |
| 人工验收      | 已关闭 | 2026-10-29 Agent 委托验收（用户 2026-10-28 授权），见文末                                    |

## 问题

截图 `.foundry/attachments/20261027/att_dmfsjau7ahad_0_image.png`：在会话侧栏的 Timers 中短暂出现 “Work inventory unavailable — database is locked (5) (SQLITE_BUSY)”。

## 根因

1. **触发**：10-28 01:17:55–01:18:55，协调会话对线上库运行 `foundry-server users reset-password`。该 CLI 和 server 一样完整打开 store，跑全部 migration 和维护，`pruneOrphanedRows` 持有写锁 4.711 s（日志 `slow database transaction`）。nginx 当前日志中这一分钟内有 15 个 500，例如 `GET /api/agent-sessions/<id>/work` 用时 16 ms 即返回 500，另有 `POST /api/daemon/session-work`。
2. **为什么 busy_timeout(5000) 没起作用**：`withTx` 用 `BeginTx(ctx, nil)`，即 `BEGIN DEFERRED`。事务先读后写：`GET …/work` 每次都会经 `importSessionWork` → `SaveSessionWork` 写入导入结果。读之后升级为写时，若别的进程持有写锁，SQLite 不调用 busy handler（btree 只在 TRANS_NONE 时重试），直接返回 `SQLITE_BUSY`。若对方已提交，则返回 `SQLITE_BUSY_SNAPSHOT`，同样是立即失败。测试 `TestWriteTransactionWaitsForAnotherProcessWriteLock` 在旧代码上 0.3 ms 内复现 “database is locked (5) (SQLITE_BUSY)”。
3. **GET 会写**：`SaveSessionWork` 合并已有行时，`evidence` 与 `item` 共享 `Native` 指针，原生条目的 `changed` 每次都为 true，所以每次读 Timers 都会写库并占用写锁。设备轮询中，每个已结束的 foundry 子会话（dev_cd7e38ee 上有 50 个）每 3 s 被重新 `ObserveSessionWork` 一次，只是把时间戳刷新。
4. **附带隐患**：写连接的 `busy_timeout`/`foreign_keys` 只在 `Open` 后对当时的连接执行 `PRAGMA`。database/sql 重开连接后，这两项会丢失。

## 修复（分层）

- **Store**（`sqlitestore/sqlitestore.go`）：写连接 DSN 改为 `_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_txlock=immediate`。每个新连接都带这些 pragma，所有写事务以 `BEGIN IMMEDIATE` 开始，外部锁会按 busy_timeout 等待，不会立即失败。读池不变（`query_only`）。
- **读路径不写**（`sqlitestore/session_work.go`）：`SaveSessionWork` 拆出 `mergeSavedWork`，`ObserveSessionWork` 拆出 `applyWorkObservation`。先在读池上判断：若结果与已存 JSON 完全相同，直接返回，不取写锁。需要写时，在事务内对当前行重新判断。写之前也比较序列化结果，相同则不写。
- **GET 容忍 busy**（`httpapi/session_work.go`）：`sessionWorkList` 的导入若因锁超时失败，只记日志，照常返回已有清单。
- **busy → 503**（`store/busy.go`、`httpapi/http_responses.go`）：`store.IsBusy` 识别 SQLITE_BUSY/LOCKED，含扩展码和被 `%v` 包裹的消息。`writeResult` 和直接写 500 的 `writeError` 统一返回 `503 {"code":"database_busy"}` 并带 `Retry-After: 2`。
- **Admin CLI**（`cmd/foundry-server/users.go`、`devices.go`、`sqlitestore.OpenAdmin`）：库已存在时只打开连接，不跑 migration 和维护，写入都是短事务，并等待 server 的锁。只有还没有 schema 的新库（首次启动前 bootstrap，不可能有 server 在用）才走完整 `Open`。`keys rotate/reinitialize` 会改 server 内存中的 key，帮助文本注明需先停 server。选这个方案而不是“检测到在线 server 就拒绝”，是因为找回密码正是在 server 运行时最需要；也没有走在线 server 的 API，因为忘记密码时没有可用凭据。说明见 `docs/development.md` 和 CLI `--help`。
- **Web**（`features/chat/use-session-work.ts`、`chat-context-work.tsx`、`api/http.ts`）：读到 `database_busy` 时显示信息色的“Refreshing timers / The server was busy for a moment. Retrying…”（`Alert tone="info"`）。2 s 后自动重试一次，期间轮询等待；已有清单保留不清空。重试仍失败才显示原来的红色错误卡片。中英文案均已提供。

## 第 5 项：设备 `POST /api/daemon/session-work` 常态 1–2.5 s

nginx 按客户端统计（10-28 00:00–01:22）：只有 一台远程设备慢（POST p50 1.36 s、GET p50 1.25 s，每次响应 662 KB gzip），其它设备 p50 只有 30–200 ms，p90 却都有 0.5–1.1 s。

原因不是 SQLite 锁，而是应用层：

- 设备清单返回该设备历史上全部条目（dev_cd7e38ee 有 2,811 条、3.6 MB JSON，全部在同一个 workspace），每条都单独 `GetWorkspace`。这一步约占 handler CPU 的 49%，并且在 `workMu` 内执行。`workMu` 串行化所有设备轮询和 Timers 控制，所以一台设备慢，其它设备都要排队（这就是它们 p90 偏高的原因）。
- 已结束的 foundry 子会话每次轮询都写一次（见根因 3）。
- Worker 每 3 s 一次 GET 和一次 POST，两者都会构建完整清单，而 Worker 并不读取 POST 的响应。

修复：workspace 路径在锁外每次请求只查一次（2,811 次 → 1 次），`workMu` 只包住真正的 settle；已结束子会话的观测没有变化时不写。DB 副本上同负载（load≈6.7）实测，32 个请求的 handler CPU 从 13.5 s 降到 5.9 s：

| 请求（DB 副本）   | 修复前 p50 | 修复后 p50 |
| ----------------- | ---------- | ---------- |
| dev_cd7e38ee GET  | 1.45 s     | 0.52 s     |
| dev_cd7e38ee POST | 1.34 s     | 0.68 s     |
| dev_ca742456 GET  | 1.02 s     | 0.45 s     |
| dev_ca742456 POST | 0.61 s     | 0.49 s     |

剩余耗时主要是解码和编码 2–3 千条历史条目。根治需要协议变更：POST 不返回清单，或者清单不返回已确认结束的条目。这需要 Worker 配合发版，列为后续项。线程维度查询（`GET …/work`、归档）对 `relatedSessionIds` 的 `json_each` 会全表扫描，由 DEV-060 加索引修复，数据见 DEV-060。

## 测试

- `sqlitestore/busy_lock_test.go`：另一进程持写锁时写入会等待并成功（旧代码立即 SQLITE_BUSY）；无变化的保存或过期观测在锁内立即返回；写事务是 IMMEDIATE，重开的写连接保留 busy_timeout 与 foreign_keys。
- `httpapi/database_busy_test.go`：busy/busy_snapshot/locked、被 statusError 包裹的错误以及仅有消息的 500 都映射为 503 + Retry-After；另一进程持锁 1.5 s 时 `GET …/work` 立即 200，设备 POST 等锁后 200。
- `cmd/foundry-server/users_live_test.go`：server 持写锁时 `users reset-password` 等待后成功，且不跑 migration（删掉的索引不会被重建）。
- Web `test/session-work-controls.test.mjs`：busy → retrying，一次重试后出清单；重试仍 busy 时显示错误，并保留已有清单。
- Go 全量：`sqlitestore` ok (378 s)、`httpapi` ok (1183 s)、`store`、`cmd/foundry-server` ok。

## 部署与自验流水

- 10-28 02:30–02:40：在 scratch 栈（`scripts/scratch-stack.sh`，DB 为线上库的部分副本，`FOUNDRY_INTEGRATIONS=off`）上用 Chromium headless 检查 Timers 面板。
  - 真实锁窗口：另一进程 `BEGIN IMMEDIATE` 持写锁 8 s（超过 5 s busy timeout）。期间 `/work` 全部返回 200，每 0.5 s 查一次，红卡出现 0 次。其中一个请求等锁约 3.8–4.8 s（`slow request` 日志），等到释放后返回，没有报错。
  - 注入一次 `503 database_busy`：light/dark × 1280 和 light × 390 三种组合下，都先显示蓝色 “Refreshing timers / Retrying…”，约 2 s 后恢复清单，红卡 0 次。截图：`.foundry/attachments/20261028/dev059/2-retrying-*.png`、`3-after-retry-*.png`。
- 10-28 10:30–10:40：`scripts/check-changed.sh`（本项 Web/文档文件）：prettier、tsc、95 个 Web 测试通过。`audit:ui` 只有 DEV-055 的 `chat-device-file.tsx:156` 报错，不属本项文件。DEV-060 在共享树上跑的 Go 全量 `sqlitestore`（374 s）和 `httpapi`（857 s）均 ok，其中包含本项的全部测试。
- 10-28 10:44–10:45：DEV-055 合并部署 Server，sha256 `61e2c75f0adfb0d6…`，pm2 PID 2101145，从重启到健康约 67 s。回滚包：`~/.foundry/server/releases/dev055-059-060-combined/previous/foundry-server`。核对部署的二进制含 `_txlock=immediate`、`database_busy` 和导入降级日志字符串。Web `5581a718c528ce0b` 经 `scripts/deploy-web-dev.sh` 发布，线上 bundle 含 “Refreshing timers” 与 `database_busy`。
- 线上 nginx 对比：修复前取 10-28 01:22–02:42，修复后取 10:45:40 起约 10 分钟。重启期间 10:44–10:45 有 208 个 502（启动窗口），此后没有 500、502 或 503。

  | 请求                                | 修复前 p50 / p90 / p99 | 修复后 p50 / p90 / p99 |
  | ----------------------------------- | ---------------------- | ---------------------- |
  | GET `/api/agent-sessions/<id>/work` | 0.48 / 1.88 / 3.03 s   | 0.03 / 0.28 / 0.71 s   |
  | GET `/api/daemon/session-work`      | 0.21 / 1.29 / 2.46 s   | 0.04 / 0.56 / 0.95 s   |
  | POST `/api/daemon/session-work`     | 0.14 / 1.37 / 2.88 s   | 0.07 / 0.70 / 1.31 s   |

  线程维度的改善包含 DEV-060 的索引（单次查询从 87 ms 降到 1 ms）。设备维度主要来自本项：workspace 查询移出 `workMu`、取消无变化的写入、读改走读池。

## 验收步骤

1. 打开任一有定时任务的会话，在侧栏打开 Timers，应正常显示清单。
2. 管理员在服务器上对线上库运行 `foundry-server users list`（或 `reset-password`）时，Timers 面板不出现红色 “Work inventory unavailable”。nginx 中该时段没有 `/work` 或 `daemon/session-work` 的 500。
3. （可选）锁持续超过 5 s 时，面板短暂显示蓝色 “Refreshing timers… Retrying…”，随后恢复清单，不出现红卡。
4. 服务器日志里 `slow request: POST /api/daemon/session-work` 明显减少。

## 限制与后续

- 外部进程持锁时，写请求会等待（最多 5 s，超时返回 503 而不是 500）。在此期间，经单一写连接的读也要排队等待（scratch 实测一次 `/work` 等了约 4 s）。
- Server 启动约 67 s（每次启动都跑完整 migration，包括 `pruneOrphanedRows`），重启窗口内 nginx 返回 502。这不在本项范围内，建议另立项处理。
- 设备工作清单仍随历史条目线性增长，需要协议层面的分页或增量，并配合 Worker 发版。
- `keys rotate/reinitialize` 仍以完整模式打开，需要先停 server。

## 2026-10-29 Agent 委托验收（用户 2026-10-28 授权）

- 委托：用户 2026-10-28 约 23:35 在编排会话 `sess_1793063405185071529` 中把发布验收委托给 Agent（“验收这块，你先做到你自己去端到端验收，没问题的话，大概率就OK了……”）。以下是独立验收 Agent `sess_1793201829998538711` 在 2026-10-28 23:37 至 2026-10-29 00:40 取得的证据，不代表用户本人测试；只关闭已验证的范围。
- 环境：真实 dev（Web `b0ba3d5929f1811e`，Server `51c00263…`），e2e-alice 登录（密码只由脚本从仓库外文件读取）。DEV-048 合成设备临时用已发布的 Worker `.1793191889` 运行，验后停止；合成工作区 `ws_d4da0f57-…`。一条合成 Codex 会话 `sess_1793202140770104457`（gpt-6.1-sol，8 个短回合）同时用于 DEV-051/054/055/057/063/064/065，验后已归档。截图在 `.foundry/attachments/20261028/acceptance/<item>/`，不入库。
- 合成会话的 Timers 面板打开期间，在服务器上对线上库运行 3 次 `foundry-server users list`（admin 模式，113/148/118 ms）；25 s 内 10 次 `/work` 全部 200，没有红卡。nginx 在 10-28 23:30 至 10-29 00:05 没有 5xx。
- `slow request: POST /api/daemon/session-work`：10-28 北京时间 01:00–12:00 每小时约 760–2430 条；13:00 起每小时 1–369 条，最近两小时 46 与 81 条。
- 未覆盖：步骤 3（锁超过 5 s 时显示蓝色 “Retrying”）沿用实现方 scratch 证据。
- 结论：已关闭（Agent 委托验收）。
