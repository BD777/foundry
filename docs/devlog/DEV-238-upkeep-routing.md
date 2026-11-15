# DEV-238 Upkeep 的归属、放置与停摆

状态：已部署 dev（train4-20261116、train6-20261116、train7-20261116）；Agent 代验收（2026-11-16，范围见验收记录）；已合入 main（PR #269）。

## 问题

离线维护（workspace 摘要、项目治理、记忆整理）是 workspace 自我演进的基础，本人依赖它们而不逐个照看。只读检查线上库（`file:…/foundry.db?mode=ro`）显示它们停摆：

- `workspace_digests` 50 行、38 行有摘要，最新 `summarized_at` 为 2026-11-12T19:26Z，29 行仍有 `summary_due_at`；
- `pa_maintenance` 的 governance：5 完成、18 失败、11 `review`、7 `waiting(device_offline)`；memory：1 完成、2 `waiting(device_offline)`。

## 调查与根因

1. **摘要停摆（windeng，29 条 due）**：`startDigestSummary` 固定取**默认助理**，且默认助理不 active 就推迟（原 `httpapi/workspace_digests.go:408-410`）。`asst_abe30eaf…` 自 2026-10-25T15:54Z 起是 `stopped`，而 ByteWork 是 active。29 条 dirty 且到期的摘要每 `DigestMinInterval` 被重新推迟，最新摘要停在 10-25。与 DEV-227、provider、每日上限、报错都无关。
2. **排队任务（e2e-alice）**：`RunMaintenance` 用**目标工作区所在设备**判断在线（原 `personalagent/assistant/maintenance.go:264-267`）。7 条 governance + 2 条 memory 的目标是合成设备上的项目（DEV023/DEV146/VM-4-8-debian），设备已断开；其中一个目标后来归档。默认助理 home 是已离线的 VM-4-8-debian。这些任务永远等下去。
3. **18 条失败**：2026-10-21–22 的 verifier 会话在 byte-dev / cottoncpp 上启动前失败：11 次 `requires bubblewrap (bwrap)`，7 次 `/Users/bytedance/.foundry-stacks/dev/agent` 权限错误。终态 `native_failed`，没有重试、没有通知。与 DEV-227 无关。
4. **11 条 `review`**：review 完成后等**本人**在「助理设置 → 维护」里接受或忽略（`settings-maintenance.tsx`）。没有任何通知，所以本人不知道；其中 e2e-alice 的 4 条还在归档/不会再回来的合成项目上，永远无法处理。

另一处根因：即使绕过助理状态，`checkPARunInput` 也会因为 `agent.State == stopped` 拒绝 Foundry 自己的维护会话（`sqlitestore/personal_agent_run_control.go:231-233`）。

## 设计（编排会话 2026-11-16 的决定）

**归属**：全局维护（摘要、项目治理、个人层记忆）一人一份，属于本人，归**默认助理**；其会话跑在默认助理的 home（`workspaceId`），**不看该助理的会话是否 stopped**。每个助理自己的记忆层是它自己一份。结果只存一份，读取时按权限包过滤。

**放置**：

| 维护       | 归属     | 会话运行位置                         | 目标设备依赖                                               |
| ---------- | -------- | ------------------------------------ | ---------------------------------------------------------- |
| 项目摘要   | 默认助理 | 默认助理 home workspace（home 设备） | 无（指令文件读不到时照常概括）                             |
| 项目治理   | 默认助理 | 默认助理 home workspace              | 有：通过设备通道读目标项目的指令文件；目标离线只推迟这一条 |
| 个人层记忆 | 默认助理 | 个人层 vault workspace（默认 home）  | 有                                                         |
| 助理层记忆 | 该助理   | 该助理 home/vault                    | 有                                                         |

一个离线设备只推迟依赖它的那一条；其他维护继续。默认 home 离线时全局任务等待并上报，不跳到别的助理 home。治理会话不再进目标项目：Server 通过 `ReadWorkspaceFile` 读取目标文件，随 prompt 带上带 SHA-256 的完整文件包；批准的 patch 仍走原 `ContextPatch` 在目标设备上校验哈希后写入。

**统一 runner**：新增 `internal/personalagent/upkeep`，把两个循环重复的「属主/placement、目标设备依赖、pin/check、PickDevice、CreateAndDispatch、defer/重试」收成一处；摘要与 maintenance 仍各自保留自己的到期源、claim/complete 和结果格式（adapter）。`sessions` 和 `pa_maintenance` 的存储不变。

**收尾与上报**：

- 目标归档 / 不可用 / 已删除 / 设备离线超过 7 天 → `superseded` 并带原因；review 状态的任务也由 5 分钟一次的清理结掉。
- 失败（`failed`）自动重试最多 2 次，5 分钟、10 分钟退避；取消不重试。
- 停摆、失败、等待超过 30 分钟、以及有 patch 等本人确认的 review，按状态签名合并成一条事实通知发给能看到的 active 助理（如 ByteWork），重复状态只通知一次。Foundry **不**创建 `needs_you` 条目：那是助理的输出。设置 → 维护页显示同样状态。

## 实现

- 新包 `apps/server/internal/personalagent/upkeep/upkeep.go`：`Runner.Start`（目标设备检查、`Pin`/`CheckPinned`、`PickDevice`、`CreateAndDispatch`、`Defer`/`Abort`）、`Owner`、`DeferError`。
- `httpapi/workspace_digests.go`：摘要用 `upkeep.Owner`（默认助理，忽略 stopped）；dispatch 失败时释放 claim（`Abort`）并推迟，避免摘要被一个没跑起来的会话永久占住。
- maintenance 的并发/每日预算 claim 放在 `Pin` 之后、建会话之前（`Runner.Request.Claim`）；撞到 `maintenance_busy` / `daily_maintenance_limit` 时只把任务置为等待，不再先建一个注定失败的会话。
- 治理文件包最多读 48 个文件（`governancePacketMaxFiles`），超出部分记在 `omittedFiles`；避免大仓库逐文件走设备通道超出 20 秒任务时限。
- 20 秒任务上下文已取消时，写等待/失败状态改用 5 秒的独立上下文，保证超时也留下原因，不静默停在原状态。
- `personalagent/assistant/maintenance.go`：
  - 全局任务不再要求默认助理 active；按助理层仍要求 active；
  - governance 在 home workspace 运行，指令文件包由 `governanceReviewPacket` 经设备通道读取（根指令文件 + `docs/**/*.md`、子目录 `AGENTS.md`、skill 文件，最多 64 KiB；超一 patch 上限或截断的文件只给 finding，不给 patch）；
  - `placeMaintenance` 决定运行/目标设备；`FinalizeGoneTargets`、重试、`AnnounceUpkeep`（签名存 `pa_upkeep_notices`）。
- `store/session_classes.go` 的 `IsFoundryOwnedSource`（utility + verification）：摘要在 stopped 的默认助理上仍能创建和派发（`checkPARunInput`、`EnsurePersonalAgentRunControl`、`AuthorizePersonalAgentDispatch` 三处一致）；助理自己的对话、派活与操作仍按停止开关拒绝。
- 摘要 dispatch 在 claim 之后失败时用 `Abort` 释放 `summary_session_id` 并重新排期，不让一个没送达的会话永久占住摘要。
- `sqlitestore/personal_agent_maintenance.go`：按 user 列出任务、通知签名表、用户索引；`WaitingSince` 记录等待起点。
- Web：维护页新增原因文案（中英）。

## 检查

CanWendeMac-mini（compute lease，`scripts/remote-check.sh`）：

```text
FOUNDRY_LEASE_TOKEN=… scripts/remote-check.sh <lease> --tree ~/workspace/foundry-dev238 \
  --go ./internal/httpapi -run 'TestGovernance|TestMaintenance|TestWorkspaceDigest|TestDigestSummaries|TestAnOffline|TestArchived|TestFailedReviews|TestUpkeepState'

ok  	github.com/foundry-dev/foundry/apps/server/internal/httpapi	7.068s
remote-check: PASS — go in 31s on the device, 115s total
```

claim 顺序回归修复后复跑同一组加 `TestBusyMaintenance`：

```text
ok  	github.com/foundry-dev/foundry/apps/server/internal/httpapi	（PASS）
remote-check: PASS — go in 32s on the device, 70s total
```

再加 `TestGovernancePacket`（packet 读取上限）与超时保存加固后复跑：

```text
remote-check: PASS — go in 24s on the device, 40s total
```

Web `--web typecheck`（`tsc -p tsconfig.json`）在同一 runner 通过。`./internal/sqlitestore -run 'TestPersonalAgent|TestAssistant|TestRunControl|TestMaintenance'` 也通过：

```text
ok  	github.com/foundry-dev/foundry/apps/server/internal/sqlitestore	1.319s
remote-check: PASS — go in 12s on the device, 51s total
```

新表与删除路径的定向检查也通过：

```text
./internal/sqlitestore -run 'TestSecondAssistantStartsWithNoWorkspacesAndCanBeDeleted|TestEveryTableNamingAnOwnerIsOwned|TestEveryDeviceOrPathColumnIsClassifiedForMigration'
ok  	github.com/foundry-dev/foundry/apps/server/internal/sqlitestore	0.583s
./internal/httpapi -run 'TestAssistantsListCreateAndDelete'
PASS — go in 20s on the device, 49s total
```

新增/更新的定向测试：

- `TestGovernanceRunsInTheAssistantHomeAndReadsTheTargetOverTheChannel`：治理会话在 `ws_pa`（home），prompt 带目标 `ws_budget` 的文件包；
- `TestDigestSummariesRunOnAStoppedDefaultAssistantsHome`：默认助理 stopped，摘要仍在 home 设备运行，且状态保持 stopped；
- `TestAnOfflineTargetDefersOnlyItsOwnReview`：目标离线的一条 `waiting/target_device_offline`，同批在线目标照常 `running`；
- `TestArchivedTargetsAndWaitingReviewsAreSuperseded`：归档目标（含已在 review 的）→ `superseded/workspace_archived`；
- `TestFailedReviewsRetryWithBackoff`：失败 → `pending/retry_scheduled`（attempt 1、2）→ 第三次 `failed`；
- `TestBusyMaintenanceDoesNotCreateASession`：一条治理 review 在跑时，第二条只 `waiting/maintenance_busy`，不新增任何 verification 会话；
- `TestGovernancePacketIsBounded`：60 个 docs 文件时只读 47 个 + 根文件，包内 `omittedFiles:13`；
- `TestUpkeepStateIsAnnouncedOnceToTheActiveAssistant`：有 patch 的 review 合并成一条通知给 active 助理，同状态不重复；
- 原有 `TestMaintenanceNativeReceiptAndSandboxBoundary` 等随新放置更新。

## 部署后核对（2026-11-16，只读）

train4-20261116，Server `08b7ad04…`，2026-11-15T20:07:26Z 启动。

1. **摘要恢复**：部署后出现 `source=digest` 会话 `sess_1794773266…`（workspace `ws_240d283d…`，设备 `dev_d783b240…` = CanWendeMac-mini，model opus），20:08:12 完成；随后 `sess_1794773410…` 20:10:10 开始跑。`max(summarized_at)` 20:07 前为 10-25，20:10 已到 `2026-11-15T20:10:23Z`；due 29 → 27，summarized 23 → 24。默认助理仍是 `stopped`。
2. **e2e-alice 的等待任务**：`waiting device_offline` 消失；新增 `superseded device_offline_too_long` 12 条（7 governance + 2 memory + 3 旧 review），其余为原先的 `source_changed` / `role_configuration_unavailable`。只剩 1 条 `review`：`ws_68dbe9ca…` 在 VM-4-8-debian 上，设备 3 小时前才断开（未到 7 天），按规则继续等。
3. **ByteWork 收到通知**：20:09:56 的回答：「你的几个项目有 7 条修改建议在等你确认，另外有 18 项维护没做成，可以重试。两件事都在设置里的“维护”下面处理：[打开维护设置](…/assistants/asst_abe30eaf…/settings)。」`pa_upkeep_notices` 中 ByteWork 与 e2e 默认助理各有一行签名。
4. **发现并修复一个回归**：并发/每日预算 claim 被移到建会话之后，导致 13 条排队中的治理任务每次尝试都先建一个 verification 会话再以 `maintenance_busy` / `daily_maintenance_limit` 失败（会话列表里可见 7 条这样的失败记录）。修复：新增 `Runner.Request.Claim`，在 `Pin` 后、建会话前做事务性 claim；撞限制时只置等待。新增 `TestBusyMaintenanceDoesNotCreateASession` 覆盖。该修复在部署后补丁里，待下一次 train。
5. 治理确实恢复：部署后 review 数 7 → 8（有一条治理审阅完成），其余受每日 4 次预算限制排队。
6. **train6 复核（Server `a034c37c…`，20:57:59Z 启动）**：此前 7 条 `maintenance_busy` 与 6 条 `device_offline` 在 21:01 前被处理为 13 条 `waiting/daily_maintenance_limit`（下一次 21:59），**没有新增任何 verification 会话**；另有 1 条新 `pending`。claim 顺序回归确认修复。治理的每日 4 次预算仍按 §9 保留。

## 限制

- 治理文件包上限 64 KiB、单个 patch 32 KiB；超过或读取被截断的文件只出 finding。
- 目标设备离线超过 7 天会结掉那次 review（`device_offline_too_long`）；项目指令文件再变化时会按新 event key 重新排队。
- 通知按状态签名去重，Server 重启后可能重复一次同样状态。
- `review` 仍需本人（或由其助理转达后本人）确认 patch；Foundry 不替本人接受。
