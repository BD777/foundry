# DEV-060 归档检查与归档请求过慢

状态：已部署 dev，待人工验收。 2026-10-29：Agent 委托验收未关闭（设备在线时归档检查 0.4–1.4 s，未达“约 0.3 s”，待用户决定），见文末。

合并：2026-10-28 夜间窗口经 PR #154 合并到 main（分支 `release/dev054-068`，本事项单独提交，共用文件在 shared wiring 提交）。

| 环节                | 状态   | 说明                                                                                                                          |
| ------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 问题理解/调研       | 已完成 | 本页“根因”                                                                                                                    |
| 代码                | 已完成 | Server 4 个文件 + 1 个测试文件，Web 1 个文件（见“改动”）                                                                      |
| dev Server/Web 部署 | 已完成 | 与 DEV-055/059 合并：Server sha256 `61e2c75f…`（healthz startedAt 2026-10-28 10:45:31，约 67 s 恢复），Web `5581a718c528ce0b` |
| Worker 更新         | 不涉及 | 设备侧 dry-run 处理本就只读，可并发                                                                                           |
| Agent 自验          | 已完成 | DB 副本计时、Go 全量测试、真实浏览器归档/Undo 与 nginx rt                                                                     |
| 人工验收            | 未关闭 | 2026-10-29 Agent 委托验收（用户 2026-10-28 授权），见文末                                                                     |

## 问题

用户（2026-10-28）：“The archive check and archive request are so slow. Find out the root cause, and try to optimize it.”

证据：nginx `POST /api/chats/archive` 在 01:42–01:44 为 2.1–5.5 s，随后一串 0.34–1.9 s；02:03:28 有一次 55.98 s。凌晨 0–2 点共 26 次，均值 2.1 s，最大 8.5 s。确认对话框的“检查”（`dryRun: true`）和真正归档走同一接口。

## 根因

在 1 GB dev DB 副本（Python backup API 复制到 scratch 路径，未对线上库运行 `foundry-server`）上按阶段计时并做 CPU profile：

1. **工作列表查询全表扫描（主因，约占 86% CPU）。** `listSessionWork` 的 `thread_id=? OR session_id IN (…) OR EXISTS (json_each(payload_json,'$.relatedSessionIds') …)` 中，带 `json_each` 的 OR 分支让 SQLite 无法用索引：每次调用都扫描全部 5,661 行 `session_work`，并把 7.2 MB payload 逐行解析成 JSON（实际没有任何一行含 `relatedSessionIds`），约 87 ms/次。归档对每个会话要调用好几次（导入工作、导入子会话、预检），10 个会话就是数秒。`GET /work` 也走这条查询。
2. **预检后丢弃的完整工作列表。** 归档前“导入工作”调用的是 `sessionWorkList`，它在导入之后还会构建完整列表，并对每个相关会话做 N+1 的 `GetAgentSessionSummary`，结果被直接丢弃。恢复（unarchive）不检查工作，却也执行了导入。
3. **检查也排队等写锁和 `workMu`。** dry-run 原本在写事务（`withTx`）里执行，并持有 `workMu`（与定时派发、设备 session-work 轮询共用）；日志中 `ArchiveChats held the connection for 1.1–2.8s`，期间所有写入都在等待。
4. **设备预览串行。** dry-run 对每个 Codex 原生目标依次向设备请求，每个最多 15 s；一台设备迟迟不回就把对话框卡住（55.98 s 那次与此一致）。
5. **背景负载：归档列表轮询。** 每个打开的聊天标签页（包括后台标签页）每 15 s 拉一次 `?archived=only`，3 小时约 2,500 次；而 `ListArchivedSessions` 对每一行做 4–5 次查询（N+1）。均值 0.39 s，其中 298 次超过 1 s，与归档请求争抢只有 2 核的机器。

Web 调用方式本身没有问题：只有 `chat-archive-dialog.tsx` 发起检查，每次打开对话框请求一次（按 workspace/folder/ids/重试键控），不需要防抖。

## 改动

- `sqlitestore/session_work.go`：新增索引 `session_work_session(session_id)` 和部分索引 `session_work_related … WHERE instr(payload_json,'"relatedSessionIds"')>0`；线程查询改为三路 `UNION` 的索引查找（常量 `sessionWorkThreadSQL`）。在 80 个随机线程/会话上与旧查询结果逐行一致，87 ms → 1.0 ms。（与 DEV-059 协商后修改；DEV-059 随后把该函数的读取移到只读连接池。）
- `httpapi/session_work.go`：把导入循环抽成 `importThreadWork`（原样搬移），归档只导入、不再构建并丢弃完整列表。
- `httpapi/chat_archive.go`：dry-run 不再获取 `workMu`；恢复跳过工作导入；按阶段计时，超过 300 ms 记 `slow archive: … authorize/work/preview/lock/store/after`。
- `sqlitestore/chat_archives.go`：dry-run 在只读池的一个快照事务里执行（不占写锁，误写会被 `query_only` 拒绝）；归档列表改为按 workspace 批量读取归档标记和原生目标，用户/会话/设备标签各查一次（`archiveInfoBatch`）。
- `httpapi/daemon_native_archive.go`：设备预览并发请求，共用 3 s 截止；未回复的设备按离线处理（与原来的离线语义一致）。
- Web `features/chat/use-chat-archive.ts`：标签页隐藏时不轮询归档列表，重新可见时立即读一次。
- 测试 `sqlitestore/chat_archive_perf_test.go`：`EXPLAIN QUERY PLAN` 断言线程查询的每一路都走索引（性能回归防护）；写锁被另一事务占住时 dry-run 仍能完成；归档列表的批量结果与逐条 `archiveInfo` 一致（另在 DB 副本 519 行上逐行比对通过）。

## 前后对比（1 GB DB 副本，服务端计时）

| 场景                        | 改前                   | 改后 p50 / p95       |
| --------------------------- | ---------------------- | -------------------- |
| 检查 1 个会话               | 0.22–0.50 s            | 5 ms / 10 ms         |
| 检查 4 个会话               | 1.8–3.0 s              | 20 ms / 42 ms        |
| 检查 10 个会话              | 4.4–5.1 s              | 166 ms / 223 ms      |
| 检查 1 个 61k 事件的长会话  | 0.47–1.0 s             | 125 ms / 226 ms      |
| 归档 1 / 4 / 10 个会话      | 0.68 s / 2.3 s / 4.9 s | p95 90 / 83 / 323 ms |
| 恢复 10 个会话              | 3.3 s                  | p95 115 ms           |
| 归档列表（53 个已归档会话） | 50–164 ms              | 13–17 ms             |

改后数据在机器负载 6–10 时测得（其它会话在构建）。

## 局限

- 目标“检查 p95 < 150 ms、归档 1–10 个 p95 < 300 ms”：1–4 个会话达到；10 个会话的检查（223 ms）与归档（323 ms）、以及单个超长会话的检查（226 ms）仍略高。剩余时间主要是导入工作时读取会话状态事件（`AgentSessionStateEvents`）。要进一步缩短，需要把工作导入从请求路径移到事件写入时（增量导入），属于独立改动，未在本项实施。
- 设备侧原生归档本来就在请求之后异步执行（`reconcileNativeArchives`），本项未改。

## 时间线

- 2026-10-28 01:42–02:41：接手；复制 DB、计时、profile；定位全表扫描与其余 4 个因素；实现索引/查询、只读快照 dry-run、跳过 `workMu`、并发预览、计时日志。与 DEV-059 协调 `sqlitestore/session_work.go` 的归属。会话在 02:41 因模型额度中断。
- 2026-10-28 10:17：恢复；补 `importThreadWork`、批量归档列表、Web 后台标签页不轮询与测试；在 DB 副本上测得上表改后数据；删除 1 GB 副本（磁盘 6.8 → 7.2 GB 可用）。

- 2026-10-28 10:41：`go test ./internal/sqlitestore/ ./internal/httpapi/` 在共享树上全部通过（374 s / 857 s，运行期间无 .go 变更）；`check-changed` 中 prettier、gofmt、tsc、56 个 Web 测试、相关 Go 测试均通过。`audit:ui`（`chat-device-file.tsx` 的 feedback 规则）和 `audit:modules`（Worker `device-files` 未分配模块）失败，均属 DEV-055 新文件，已告知。
- 2026-10-28 10:45：DEV-055 合并部署 Server（回滚：`~/.foundry/server/releases/dev055-059-060-combined/previous/foundry-server`，即 `afc7f429…`）与 Web `5581a718c528ce0b`。线上库只读确认 `session_work_session`、`session_work_related` 两个索引已建立。
- 2026-10-28 10:55：真实浏览器（独立 headless profile，e2e-alice，DEV-048 合成工作区 `ws_d4da0f57-…` 的合成会话“DEV048 ready 确认回复”）：右键菜单 → 归档，对话框首次轮询（约 0.17 s）即显示“Archive 1 chat”；确认后会话离开列表、Archived 计数 1→2、出现 Undo；点 Undo 后恢复、计数回到 1。nginx：检查 `rt=0.032`，归档 `rt=0.110`，恢复 `rt=0.018`（改前凌晨 26 次均值 2.1 s、最大 8.5 s，另有一次 56 s）。截图：`.foundry/attachments/20261028/dev060/01-archive-dialog.png`、`02-archived-toast.png`、`03-restored.png`。合成会话最终状态与操作前相同。

## 验收步骤

1. 打开 dev，在聊天列表多选 1–10 个已完成的会话，右键“归档”：确认对话框应在约 0.3 s 内显示结果（不再长时间“检查中”）。
2. 点“归档”：会话立刻从列表消失，Undo 提示出现；点 Undo 恢复，同样立即生效。
3. 对一个文件夹执行归档/恢复，结果同上。
4. （可选）服务端日志 `~/.pm2/logs/foundry-server-error.log` 中不应再出现针对这些操作的 `slow request: POST /api/chats/archive`；若出现 `slow archive:`，其各阶段耗时指明慢在哪里。

## 2026-10-29 Agent 委托验收（用户 2026-10-28 授权）

- 委托：用户 2026-10-28 约 23:35 在编排会话 `sess_1793063405185071529` 中把发布验收委托给 Agent（“验收这块，你先做到你自己去端到端验收，没问题的话，大概率就OK了……”）。以下是独立验收 Agent `sess_1793201829998538711` 在 2026-10-28 23:37 至 2026-10-29 00:40 取得的证据，不代表用户本人测试；只关闭已验证的范围。
- 环境：真实 dev（Web `b0ba3d5929f1811e`，Server `51c00263…`），e2e-alice 登录（密码只由脚本从仓库外文件读取）。DEV-048 合成设备临时用已发布的 Worker `.1793191889` 运行，验后停止；合成工作区 `ws_d4da0f57-…`。一条合成 Codex 会话 `sess_1793202140770104457`（gpt-6.1-sol，8 个短回合）同时用于 DEV-051/054/055/057/063/064/065，验后已归档。截图在 `.foundry/attachments/20261028/acceptance/<item>/`，不入库。
- 单个合成会话：右键 “Archive” 后确认框 89–143 ms 出现，归档请求 263 ms，Undo 70 ms 返回、199 ms 后列表恢复；已归档列表多选恢复正常。
- 设备在线时的 dry-run 检查（合成设备在线）：1 个会话 0.39–0.81 s，2 个 0.58–0.95 s，4 个 0.71–2.13 s。`slow archive:` 日志显示主要耗时在 `preview`（设备预览 0.36–1.39 s），work 与 store 各不超过 45 ms。
- 与步骤 1 的 “约 0.3 s” 不符：设备在线时检查需要 0.4–1.4 s（比原来的 4.4–5.1 s 快很多）。聊天列表没有多选入口（多选只在已归档列表）；文件夹归档本轮未测。
- 结论：未关闭。请用户决定接受设备在线时 0.4–1.4 s 的检查时间，还是继续优化设备预览。
