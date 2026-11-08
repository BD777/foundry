# DEV-149 GitHub CI：偶发失败的根因、每个 PR 只跑一次、并行 job

状态：已修复（PR #226）。共 8 个偶发失败测试：5 个找到根因并修复，1 个已在上游修好，1 个确认是 runner 磁盘卡顿后放宽了挂起保护；连同第三种失败形态（同一测试的另一种表现）一起在 GitHub runner 上压测通过。每个 PR 只触发一次 verify；verify 拆成三个并行 job，单次墙钟时间从约 13.5 分钟降到约 7 分钟。产品代码改了两处 Server 竞态（会话派发、聊天队列），已部署 dev Server。

## 问题

本人在 GitHub 上看到大量红色 run。10-28 以来约 330 次 run 中失败 47 次，main 当时也是红的（docs-only 的 #222，run 42381032205）。每个 PR 分支各跑两遍（`push` 与 `pull_request`）；成功 run 中位数约 13 分钟，p90 约 30 分钟。

## 调查

按失败签名把 47 次失败分类（`gh api repos/BD777/foundry/actions/jobs/<id>/logs`；`gh run view --log-failed` 对这些 run 无输出）：

- 大多数是分支上的真实回归，合入前已修好：skill revision、i18n key、skill 工具名、模块边界审计、格式、协议覆盖等。这部分属于 CI 正常工作。
- 已在上游修复：ubuntu 26.04 引起的浏览器租约测试和 Codex 判定测试（DEV-141）、`PopStateEvent`（e5674887）、腾讯云 OAuth 伪 CLI 读到写了一半的状态文件（#216，b29141f5）、重连退避的上界（4184d2e6）、Skill 下载测试（c376c171）、`TestRequestOnADeadLinkFailsOnceAPingGoesUnanswered` 的空指针（ec659841，两次失败都早于它）。
- 仍会复现的偶发失败共 7 个，在本地用注入延迟/时钟条件稳定复现了 CI 里一模一样的断言（自然条件下在 2 核 VM 上饿死 CPU 也难以触发）：

| 测试                                                                                                                                                   | 根因                                                                                                                                                                                                                                                                                                                     | 修在         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| worker `real Server HTTP + Worker: fixed API evidence…`（main 红）                                                                                     | 设备的工作区先写进库、出现在 `/api/workspaces`，连接稍后才发布（`daemon_hub.go` `syncRegistration`）。测试以“工作区可见”为已连接，这个窗口里创建的 Issue 发现设备离线（`worker_offline`），澄清会话不再发出，`clarification` 一直为空，45 s 超时。注入 500 ms 延迟后 4/4 失败                                            | 测试         |
| `TestSetupPrimesEveryProjectAFewAtATime`                                                                                                               | 设备 hello 时扫一遍排队会话（`dispatchQueuedAgentSessions`）。会话一创建就是 queued，但 `BeforeDispatch`（摘要会话认领 digest）还没跑；扫描晚到时，设备先收到会话，`WorkspaceDigestForSummarySession` 报 not found。违反了 `StartOptions.BeforeDispatch`“设备知道之前”的约定，MCP 会话、助手维护/收件箱、`Send` 也依赖它 | 产品         |
| `TestChatQueueCoversSessionsAnotherSessionStarted`                                                                                                     | 推入运行中回合的消息在设备确认前是“发送中”；若回合在确认记下之前结束，回合结束的检查看到队首是发送中就什么都不发，确认落地后也没有人再看队列，队列卡住。真实用户也会遇到。确认前注入 300 ms 延迟后 3/3 失败                                                                                                              | 产品         |
| `TestAssistantAcceptanceAndPauseBindBeforeDeviceDispatch`（3 次，含 run 42491584165 的 `write websocket file_read: use of closed network connection`） | 伪设备 hello 触发的后台工作（刷新 digest、读取说明文件）无人等待；测试清理关 socket 时，后台对 `read_file` 的回复写失败，在 goroutine 里 `t.Fatalf`                                                                                                                                                                      | 测试         |
| `TestGovernanceActivityDoesNotScheduleAnotherReview`                                                                                                   | 同上：hello 的 digest 刷新晚到，覆盖了测试刚写入的假 revision，新的复核没有排上                                                                                                                                                                                                                                          | 测试         |
| `TestSessionEventCompactionKeepsTranscript`                                                                                                            | 事件时间以 RFC3339Nano 文本存储，会去掉末尾的 0，按文本排序时 `.89292Z` 排在 `.892929Z` 之后。测试以输入时间为基准按 1 µs 递增造事件；CI 那次输入时间恰好以 000 ns 结尾，事件乱序。强制该时钟条件后 80/80 失败                                                                                                           | 测试         |
| `TestReconnectCoversEveryWorkspaceOfTheDevice`                                                                                                         | 没有逻辑竞态。失败 run 41869178083 是 48 份日志里唯一打印 `slow migration step` 的：同一分钟内 `createCoreSchema` 3.6 s、`setupExternalAccounts` 5.2 s，hello 的各步骤约 1 s 一步。3 s 读超时短于观测到的存储卡顿                                                                                                        | 测试（超时） |

## 修复

CI：

- `.github/workflows/verify.yml`：`push` 只针对 `main`，PR 只在 `pull_request` 上跑一次，其他分支可在 Actions 页手动运行（`workflow_dispatch`）。PR 上新的 push 取消旧 run；main 不取消，每次合入都有自己的结果。`release.yml` 由 tag 触发，不受影响。
- `pnpm verify` 拆成 `verify:web`、`verify:packages`、`verify:go`（`verify` = 三者依次执行，本地用法不变），CI 作为三个并行 job 运行；必需检查 `verify` 改为汇总 job，三者都成功才通过，所以分支保护不用改。公共安装步骤在 `.github/actions/setup`；每个 job 有自己的 Go 缓存 key，避免三个 job 抢存同一个 key。`docs/development.md` 已更新。

Server（产品）：

- `sessions/starts.go`：`CreateAndDispatch`、`resume`、`Send` 交付会话期间登记“正在启动”；hello 扫描遇到正在启动的会话时等启动者结束（`AwaitStart`），再读一次，仍是同一输入的 queued 才发。启动者已发出的由现有的按连接去重跳过；启动者因设备不在而留着的，由扫描发出。扫描都在 `hub.work` 的 goroutine 里运行，不持锁，不会阻塞设备读循环。
- `chat_queue.go` `steerChatQueueItem`：认领的消息结算后再踢一次队列（`kickChatQueue`，回合在跑时什么都不做）。

测试：

- `workspace_digests_test.go`：fixture 等 hello 自己的工作做完再加测试要看的数据；伪设备在测试开始关 socket 之后写失败不再判失败，其他写失败仍判失败。
- `session_event_compaction_test.go`：事件时间统一宽度并晚于输入时间。
- `evidence-api-e2e.test.mjs`：hello 带 id，等 Server 的 `registered` 回复（发布连接之后才发）；超时信息带上最后读到的值和 Server 日志末尾 8 KB。
- `agent_session_recovery_test.go`：读超时改为本包标准的 10 s，注明是挂起保护而非延迟预算。
- `connector-declarative`、`native-sign-in` 两个伪 CLI 改为整文件替换状态文件，与 #216 修 tccli/aliyun/aws 的方式一致（同类潜在竞态，未观察到失败）。

未改：Issue 创建时设备恰好离线会把澄清失败只记在 `ClarifyError`、HTTP 仍成功，这是设计如此（下一条消息会重新开始澄清），窗口只有连接后的毫秒级。事件时间文本排序的根治需要定宽存储格式加迁移，生产中时间为纳秒精度、两事件需在约 10 ns 内才会乱序，另行决定。

## 验证

- 本地：每个修复先用注入延迟/时钟条件复现 CI 原断言，修复后同条件通过；再在 `-test.cpu 1` 加忙循环下各跑 50 次通过；`go vet`、`go test ./internal/sessions` 通过；evidence e2e 在两个忙循环下 25/25 通过。
- GitHub runner 压测（临时分支 `ci/stress-flakes`，run 42496061618，不合入）：7 个 Go 测试各 300 次（4 shard × `-count=25 -cpu 1,2,4`）全部通过；完整 Go 套件另跑 4 遍通过；evidence e2e 与两个伪 CLI 测试文件 36 轮通过（无 skip）。
- PR #226 的 verify：run 42489695679（仅 CI 改动）、42496037710 attempt 1 与 attempt 2、以及加入本 devlog 后的 run，均通过。
- 墙钟时间：拆分前成功 run 42487764237 共 13 分 34 秒（其中 Go 测试在 JS 测试之后串行 6 分 12 秒）；拆分后 42489695679 为 7 分 35 秒（Go 缓存冷启动），42496037710 为 6 分 46 秒。最长的是 go job，其中 `internal/httpapi` 一个包约 5–6 分钟。

## 部署

- dev Server：把产品改动（`chat_queue.go`、`daemon_hub.go`、`server.go`、`session_dispatch.go`、`internal/sessions/`）以 diff 方式应用到 `~/workspace/foundry`（保留其他会话已暂存的改动），`go build`、`go vet` 通过，备份 DB（`/tmp/foundry-pre-dev149.db`）后 `pm2 restart foundry-server`（2026-11-09 00:02 CST，等另一会话的 e2e 释放部署锁之后）。重启后 `https://dev.foundryapp.app/healthz` 为 200，重启前在线的 7 台设备（CanWendeMac-mini、VM-4-8-debian、byte-dev、byte-dev-sg、cottoncpp、limen-canada、sg-chaos）全部重新连上，pm2 环境里没有会话变量。Web 与 Worker 无改动，不需要更新。

## 局限

- `TestReconnectCoversEveryWorkspaceOfTheDevice` 的多秒存储卡顿无法在本机复现，结论依据 CI 日志；同样用 3 s 读超时的 `TestReconnectAsksTheDeviceAboutOrphanedInputs` 未改。
- go job 仍要 6–7 分钟，下限是 `internal/httpapi` 一个包；再要缩短需要把该包拆成多个 shard，暂不做。
- 偶发失败率原本约 0.3–0.6% 每测试每次，GitHub 上几十次通过不能证明为零，所以每个修复都以“强制条件下必现、修复后必过”为主要证据。

## 验收

1. 打开 https://github.com/BD777/foundry/actions/workflows/verify.yml ：之后的 PR 每个提交只出现一个 `pull_request` run，含 `web`、`packages`、`go`、`verify` 四个 job；`verify` 通过即可合入。预期 PR run 约 7 分钟。
2. 在 main 的后续 push run 中不再出现上表中的测试失败；如果 evidence e2e 再超时，失败信息里会带 Server 日志。
3. dev 上：在一个正在回答的聊天里排队一条消息并点“推入”，回合结束后该消息作为下一轮正常发出，不会停在“发送中”。

## 时间线

- 2026-11-08 22:15–2026-11-09 00:30 CST：分类 47 次失败；三个子 agent 并行定位各测试根因；拆分 workflow 并实测；GitHub runner 压测；00:02 部署 dev Server。
