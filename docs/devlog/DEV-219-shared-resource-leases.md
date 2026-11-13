# DEV-219 资源租约：共享与独占

状态：已部署 dev（Server `61f14d85`、Web `17e800313131e760`、Worker `0.5.7-dev.357.g8f394c91.local.1794572421`），实机验证通过；改动未提交。

## 问题

2026-11-13 本人的会话想在 byte-dev 上跑几条 shell 查询，却被告知"计算资源被 foundry 工作区里的另一个会话租着，排队最多 15 分钟"。本人："资源租约有点死板。只是用 shell 查一下，理论上可以并行，却去排队了；但有些资源又确实是独占的。"

当时的持有者并不空闲：编排者的两个 TokenHub 子会话先后把 Foundry 源码放到 byte-dev 上构建和测试（DEV-209 连接器修复 `sess_1794548510605916372`，DeepSeek Claude runtime `sess_1794553751611492159`，holdFor 一小时）。这本身违反了"Foundry 代码不上 byte-dev"的合规规则。已请两者清理 scratch 并释放租约，并告知编排者在简报里写明这条规则。

## 调研

完整笔记与链接见 [research/resource-lease-modes-20261113.md](../research/resource-lease-modes-20261113.md)。要点：

- **共享 / 独占锁**：PostgreSQL、SQL Server、`flock(2)` 的 `LOCK_SH`/`LOCK_EX` 都是"共享与共享兼容，独占与一切冲突"。SQL Server 的 U 锁和 flock 的非原子转换都说明不要原地从共享升级为独占，应当释放后重新排队。
- **公平**：Go `sync.RWMutex` 规定"阻塞中的 Lock 调用会挡住新的读者"。PostgreSQL 的锁队列只授予同时与持有者和之前所有排队者兼容的请求。POSIX 把这一点留给实现决定，Linux rwsem 用 handoff 防止写者饿死。结论：每个资源一条先来先得的队列，排队中的独占请求挡住后来的共享请求。
- **容量槽位**：Jenkins executors、GitLab Runner `concurrent`/`limit`、Buildkite spawn、Selenium Grid `--max-sessions` 都按槽位计数。Kubernetes 和 Nomad 按申报量调度，不按实测负载。Bazel 的 `exclusive` 标签表示"这个测试运行时不跑别的"。
- **屏幕**：Appium 一台设备一个会话；UiPath 同时只有一个前台（UI）自动化，可有多个后台自动化；Windows 同时只有一个输入桌面；Anthropic computer use demo 一次只服务一个会话。结论：屏幕永远独占。
- **租约与心跳**：Chubby、etcd、Kubernetes Lease、Consul 都用 TTL、续期和 fencing token。Foundry 已有按 turn 续期加 generation fencing，本次沿用。

## 设计

| 项                     | 决定                                                                                                                                                                                                                                                                                      | 理由                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 模式                   | `shared` / `exclusive`。computer_use 只有 exclusive（申请 shared 会被拒绝）。compute 默认 shared，可申请 exclusive                                                                                                                                                                        | 一块屏幕只有一个指针和一个焦点；shell 查询可以并行；基准测试或需要整机的工作要独占                                        |
| 容量                   | compute 每台设备有槽位数。自动值 = min(CPU 数/2, 内存 GiB/4)，限制在 1–16；设备所有者可在 Resources 页设 1–64                                                                                                                                                                             | 一个共享租约大约跑一个构建或测试套件。CanWendeMac-mini 自动 4，byte-dev-sg 3，byte-dev 16，sg-chaos 1（编排者给的目标值） |
| 计数                   | 只数活跃（active）的共享租约，停放（parked）的不占槽位                                                                                                                                                                                                                                    | 停放的租约属于 turn 已结束的会话                                                                                          |
| 公平                   | 一条 FIFO 队列，不区分模式：排在前面且放不下的等待会挡住后面所有等待。所以排队中的独占请求挡住新的共享请求，独占不会饿死；共享请求也不会插到更早的独占请求前面                                                                                                                            | Go RWMutex / PostgreSQL 的规则                                                                                            |
| 冲突与抢占             | 独占等待：所有其他租约都是阻碍者。共享等待：独占持有者是阻碍者；槽位满时，最早的活跃共享租约也算。阻碍者沿用原有的 contended 机制：提示，1 分钟前最后警告，15 分钟后抢占                                                                                                                  | 沿用"等待者 15 分钟后拿到"的既有承诺，不新增参数                                                                          |
| 停放的租约遇到独占请求 | 没有 hold 的停放租约在没有其他硬阻碍时立即让出；有 hold 的按 contended 规则 15 分钟后抢占                                                                                                                                                                                                 | 与独占对独占的既有规则一致，不新增参数                                                                                    |
| 升级                   | 持有 shared 的会话再申请 exclusive 会被拒绝，提示先释放再申请                                                                                                                                                                                                                             | 两个会话同时升级会互相等待（SQL Server U 锁的教训）                                                                       |
| fencing                | 每个租约都有唯一的 generation。实例上的第一个租约照旧抬高设备侧的 fence；之后加入的共享租约不抬高。共享租约在其他租约还在时结束，只发 `leaseOnly` reset，只停它自己的进程；Server 记 `reset_since`，独占请求要等这些 reset 确认，超时则实例变为未就绪。最后一个租约结束时照旧整实例 reset | 防止新的共享租约把旧的共享租约当成过期租约                                                                                |
| 隔离                   | 没有指定 scratch 或 workspace 的 compute 操作，由 Server 指定会话自己的 scratch（`sess_…`），闲置 3 天后由 Worker 清理。每个租约的命令有自己的 `TMPDIR`，租约结束时删除。命名 scratch 仍可跨会话共享                                                                                      | 并行的会话不会互相覆盖文件；需要共享时显式命名                                                                            |
| 兼容                   | Worker 声明 `shared_leases` 能力后才会被授予并行租约；旧 Worker 一次一个租约（容量 1）                                                                                                                                                                                                    | 旧 Worker 收到更新的 generation 会抬高 fence，杀掉其他租约的进程                                                          |
| API                    | `acquire_resource.mode`。`list_resources`/`resource_status` 返回 `slots {capacity, inUse, auto}`，有多个持有者时返回 `holders[]`（含 mode）。`holder` 保留为第一个。人的 release / let-finish 接受 `?leaseId=` 只作用于一个租约。settings PUT 改为部分更新，新增 `computeSlots`           | 工具描述只写事实（DEV-201）                                                                                               |

`scripts/remote-check.sh` / `remote-build.sh`：runner 脚本会话（`sess_1794561838479130736`）已改为每次调用一个独立 checkout（`foundry-remote/jobs/<job-id>/repo`），工具缓存共享，并按 CPU 和内存计槽位。DEV-219 上线后，它通过 `REMOTE_LEASE_MODE=shared` 使用 `--mode shared`。

## 改动

- Server：`internal/resources`（`lease_state.go` 一个实例多个 live 租约、capacity / modeOf；`lease_acquire.go` conflicts / grantWaiting / contention；`lease_release.go` 单租约 reset；`lease_devices.go` 重连时只 fence 到最老的 live 租约以下、`ResetDone` 与 Sweep 处理 pending；`lease_views.go` holders / slots；`types.go` `Shared`、`AutoSlots`）。`internal/store`、`internal/sqlitestore`：列 `mode`、`reset_since`、`compute_slots`，唯一索引改为（resource, session），见下方迁移说明。`internal/httpapi`：mode 参数、会话 scratch、`Shared` 标志、holders/slots、按租约 revoke、settings 部分更新、能力门控。`mcp_tools.json`。
- Worker：`resources/operations.ts`（每个租约一个 provider session 和串行队列，`leaseOnly` reset，`shared` 请求不抬高 fence），`providers/compute.ts`（每租约 TMPDIR，会话 scratch 闲置清理），能力 `shared_leases`。
- Protocol：`resources.ts` 中的 mode / slots / holders / leaseOnly / shared / computeSlots。
- Web：Resources 页列出每个持有者及其模式，显示槽位，可按租约释放或延后抢占，并可设置"并行共享租约数"。
- Foundry skill：`references/device-and-accounts.md` 新增 "Compute on another device" 一节。

迁移：`resource_leases`、`resource_waits` 新增 `mode`（旧行默认 `exclusive`），`resource_leases` 新增 `reset_since`，`resource_source_settings` 新增 `compute_slots`；删除 `idx_resource_leases_live`，改为 `(resource_id, holder_session_id)` 的部分唯一索引。都是加列和建索引，无需回填。

## 测试

- Go `internal/resources/shared_leases_test.go`：
  - 共享租约在槽位内并行，后来的不发 reset；槽位满时拒绝，持有者 turn 结束后（停放不占槽）授予；
  - 独占请求等待共享持有者，排队时挡住新的共享请求，不能原地升级；
  - 停放的共享租约让给独占请求，独占请求还要等单租约 reset 确认；
  - 单租约结束不影响其他租约，reset 未确认则实例变为未就绪；
  - computer_use 只能独占；
  - 混合模式等待保持 FIFO；
  - 旧 Worker 容量为 1；
  - 重连时 fence 不越过 live 的共享租约；
  - AutoSlots。
- Worker `compute.test.mjs`：两个共享租约并行执行，新的不 fence 旧的；结束一个租约只停它的进程、删它的 TMPDIR；闲置会话 scratch 清理。

结果（targeted，macbook）：Server `go build`、`go vet`、resources / sqlitestore 相关测试、httpapi 6 个租约与 compute 测试及工具描述检查通过；Worker compute / resource-operations / foundry-cli 58 个用例通过 57 个。唯一失败的 `put_files … unpacks a tar.gz` 在 macOS 上得到 7 个文件、预期 2 个，未改动的 HEAD 上同样失败（多出的 5 个对应 5 个路径，像是 macOS tar 写入的 `._` 扩展属性条目），与本改动无关；Linux CI 上通过。

## 进展

| 时间（UTC+8）    | 变化与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 剩余动作                                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-11-13 16:00 | 查明 byte-dev 被两个违规子会话占用，已通知它们清理并释放，也已告知编排者。完成调研、设计和实现（worktree `~/workspace/foundry-shared-leases`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | CanWendeMac-mini 远程检查 → 部署 → 两会话并行加一个独占请求的端到端验证                                                                                                                                                              |
| 2026-11-13 19:25 | 作为合并部署列车的一部分上线（同车：DEV-203 第二阶段、DEV-209/216、DEV-210、DEV-211、DEV-212、DEV-213、DEV-215、DEV-218、DEV-221、DEV-222），Server `789843f2ffc11b24…`、Web `fbb6b42c7eb3e557`、Worker `…1794567381`；byte-dev、byte-dev-sg、sg-chaos、cottoncpp、limen-canada 已更新，macbook 与 Mac mini 离线未更新。实机：byte-dev 自动 16 槽位；两个会话同时持有共享租约（inUse 2，`holders` 两条），各自的 scratch 是 `compute/sess_…`、`TMPDIR` 是 `compute/.tmp/<lease>`；另一会话在两个共享租约存在时申请 exclusive 被拒绝（busy）。迁移在启动时完成（旧租约显示 `mode: exclusive`）。没有给 byte-dev 设 workspace 策略（本人已允许 Foundry 构建使用 byte-dev） | 本人验收 Resources 页（持有者、槽位、并行数设置、workspace 策略）；runner 脚本改用 `--mode shared`（`sess_1794561838479130736`）；macOS 上 `put_files` 测试与 Linux 上 `native-archive` 一个用例在未改动的 HEAD 上同样失败，另行处理 |
| 2026-11-13 20:30 | 上线后发现缺陷：byte-dev 的 Worker 常在 30 秒内答不上 reset（共享租约之前的 375–401 代也一样）。共享租约 422 的单租约 reset 未确认 → Sweep 把整台实例标为 unconfirmed（不可租）→ 12:14 Server 重启后重连时按 fence 423 重发整实例 reset → Worker 把仍在用的共享租约 413 判为 stale_lease。修复：未确认的单租约 reset 只重发，不再升级；实例上有 live 租约时不发整实例 reset；Worker 杀完进程即回答 reset，TMPDIR 在后台删除。`TestSharedLeaseEndsAlone` 覆盖超时重发与重连不 fence。随第二班列车上线：Server `61f14d85234f4fb5…`、Web `17e800313131e760`、Worker `…1794572421`，6 台在线设备已更新（含 Mac mini）                                                        | 观察 byte-dev reset 的确认延迟（旧问题，单独排查）                                                                                                                                                                                   |
