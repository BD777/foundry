# DEV-215 连接器授权跟着会话，不跟着回合

## 状态

已部署 dev，真实检查通过，待人工验收；未提交。经 DEV-219 部署车（sess_1794555762602239151）上线：Server sha256 `789843f2ffc11b24b012aed124dee5f1a0dfd27da4e3abe8d86fae10ad9b6aee`（2026-11-13 11:14 UTC），Worker `0.5.7-dev.357.g8f394c91.local.1794567381`（sg-chaos 11:19:48 UTC，以及 byte-dev、byte-dev-sg、cottoncpp、limen-canada）。foundry skill 与 DEV-219 合并为修订 38。实现工作树 `~/workspace/foundry-standing-access`（基于 `8f394c91`），完整补丁 `/tmp/dev215-vs-8f394c91.patch`。

## 问题

2026-11-13 本人再次转来：会话经 OpenLark 回复浩辉 19:39 的私信时收到 `FOUNDRY_ACCESS_ENDED`（"this session's authorization for the OpenLark connector has ended"）。本人原话：「这类问题出现了很多次了，也修了很多次了，但一直反反复复出现……Connector 这个东西它就一直授权给了某一个 Workspace 或者 Device，那它就一直持有啊，为什么会在中间有生命周期的问题呢？」

## 事故（近 7 天，只读查询 dev 库与日志）

OpenLark / Cloudflare / App Store Connect 在认证步骤被拒的调用以前不写审计；飞书的拒绝行没有会话。所以下表是从会话记录反查、再与网关审计对齐得到的下限。时间为 UTC（括号内 UTC+8）。

| #   | 时间                                   | 会话                          | 设备 · Workspace               | 连接器                            | 调用来自                                                         | 拒绝时机                                                                   | 原因类别                       |
| --- | -------------------------------------- | ----------------------------- | ------------------------------ | --------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------ |
| 1   | 11-06 06:09:14（14:09）                | 约为 sess_1793857198756096306 | byte-dev · ccm-omh-integration | 飞书                              | 回合结束时仍在途的调用                                           | 回合完成后 0.5 秒                                                          | 回合结束即结束（DEV-155 之前） |
| 2   | 11-09 15:28:38（23:28）                | sess_1794213812193775525      | byte-dev · ccm-omh-integration | 飞书                              | 后台脚本                                                         | 回合完成后 0.8 秒                                                          | 回合结束即结束（DEV-155 之前） |
| 3   | 11-09 16:38:52 起 7 次                 | sess_1794241838441358957      | sg-chaos · foundry             | 飞书                              | 分离的测试循环                                                   | 归档后                                                                     | 预期（DEV-155 E2E 归档测试）   |
| 4   | 11-11 04:07:12（12:07），33 次         | sess_1794368973341122267      | byte-dev · ccm-omh-integration | 飞书                              | 后台抓取 + Monitor，之后 Agent 自己继续                          | 回合完成后 2:00.1                                                          | 回合结束、原生工作声明未续上   |
| 5   | 11-12 约 11:11:44（19:11）             | sess_1794293125533993505      | byte-dev · ccm-omh-integration | OpenLark                          | 三个 30 秒轮询的后台 `olk` 循环                                  | 回合完成后约 2:00                                                          | 回合结束、原生工作声明未续上   |
| 6   | 11-13 07:44:22–07:46:03（15:44–15:46） | sess_1794541720567021279      | byte-dev · ccm-omh-integration | OpenLark（回复浩辉 19:39 的私信） | 后台任务 "Wait for 小C's reply" 结束、唤起 Claude 自己继续的回合 | 回合完成 07:42:30；成功调用到 07:44:18；之后拒绝（完成 + 2:00 = 07:44:30） | 回合结束、原生工作声明未续上   |

排除项（#6）：替身未过期（授权 07:40:14 签发，且过期会报 `FOUNDRY_HANDLE_EXPIRED`），授权仍在库中；05:02Z 之后 Server 没有重启；byte-dev 自 06:56:54Z 在线；账号与权限包无变化。

按原因：回合结束 / 声明未续上 3 起（#4–#6），另有约 16 段疑似静默拒绝（11-12 sess_1794293125533993505 每个回合结束后 92–120 秒调用流就停了）；DEV-155 之前同一规则 2 起；预期归档 1 起；替身过期、Worker 重启、Server 重启、授权被删、会话换位置 0 起。7 天里 byte-dev 没有任何一次连接器调用在回合结束 2 分钟后成功过。只有 sg-chaos 的 DEV-155 E2E 撑到 179 秒。

查询方法（只读，`file:…/foundry.db?mode=ro`）：`agent_session_events` 中搜 `ACCESS_ENDED` / `99991668` / `access through Foundry has ended`；`feishu_gateway_requests` 的非 forwarded 行；`external_account_events` 中 OpenLark 账号在事故前后的成功行；`agent_sessions.payload_json.completedAt`；`feishu_gateway_grants`；`device_presence`；pm2 日志中的 "foundry server listening"；`~/.foundry/server/wire-record/wire.jsonl` 中心跳的 `nativeWorkSessionIds`。

## 修改前的生命周期（代码现状）

签发：

- 每个回合派发时 `sessionConnectors`（httpapi）→ `externalaccounts.Service` → 各连接器的 `IssueHandles` 为每个可用账号写一行 `feishu_gateway_grants`（只存替身哈希）。签发前先过 `gateway.SessionLive`。
- Worker `runAgentSession`（`daemon/session-run.ts`）→ `prepareSessionConnectors`：飞书写 `foundry-<账号>-<会话>` profile；服务器持有型扩展（OpenLark）、Cloudflare、ASC 各起一个本机转发器，把 `{gatewayBase}` / `{standIn}` 写进 Agent 进程的环境。Claude 进程跨回合复用（"Reused active Claude Agent SDK"），环境停留在启动它的那一轮。
- 扩展、Cloudflare、ASC 的替身 30 分钟过期（`Scheme.Lifetime`），转发器到期前经 `/session-handle` 续期，续期同样过 `SessionLive`。
- Foundry 工具的会话 token：每次派发签发一个；会话活跃时有效，否则 24 小时未用即失效（`sqlitestore/session_tokens.go`）。

每次调用（`gateway.Pipeline.authenticate` → `Live` → `SessionLive`）：

```
            run_session                   session_completed
 (queued) ───────────► [running] ───────────────────────────► [completed]
                          │                                       │
                          │ failed / canceled                     │ 设备在 2 分钟内声明原生工作
                          ▼                                       │ （nativeWork / 心跳 nativeWorkSessionIds，只在 Server 内存）
                   ErrSessionEnded                                 ├── 有声明且 completedAt < 24h ─► 放行
                   授权被删除                                       └── 无声明 / 超过 2 分钟 ─► ErrSessionIdle
                   Worker 立即释放 profile/转发器                        → FOUNDRY_ACCESS_ENDED（授权保留）
 archived / deleted ─► ErrSessionEnded，授权被删除
 completedAt 超过 24 小时 ─► ErrSessionEnded；每小时 Prune 删除
```

也就是说，访问权被绑在“Foundry 是否认为 Agent 此刻在干活”上：回合进行中，或设备在内存里的 2 分钟窗口内声明过。声明链很长：Worker 的 `sessionsWithNativeWork` → 执行宿主快照 → 守护进程心跳（25 秒）→ Server `session_claims.go` 的内存表。任何一环没覆盖到（Claude 自己继续的回合、`Monitor` 结束到下一个心跳之间、执行宿主轮换、Server 重启或 SIGHUP 交接、Worker 版本差异）就是 2 分钟后的 `ACCESS_ENDED`。

### 为什么反复出现

每次修复都在扩“什么算 Agent 还活着”的清单：DEV-155 加后台任务、定时、自己继续的回合和忙的 Codex；DEV-144 加心跳声明；DEV-186 加多宿主。规则本身没变：授权的寿命 = Foundry 对 Agent 进程活动的推测。Claude Code 和 Codex 会不断出现新的原生方式（Monitor、子 Agent、新的唤醒方式），推测永远追不上，每出现一种新方式就再坏一次。这和本人的模型相反：授权是常设的（实例 ↔ Workspace / 设备 / 助手权限包），会话存在就持有。

## 修改：按会话和授权本身判断（Server）

`gateway.SessionLive(session)`：会话存在、未归档，就放行。状态、原生工作声明、距上一轮多久都不再参与。每次调用照旧检查：设备是会话的设备且出示设备凭证，本人是设备主人，会话仍在授权的 Workspace，账号属于这个连接器、仍可用、仍绑定到该 Workspace、权限包仍允许（`Pipeline.Live` → `externalaccounts.EligibleFor` / `ResolvePolicy`）。

```
 会话存在且未归档 ──────────────────────────────────────────► 放行（每次调用复查授权）
   （queued / running / completed / failed / canceled，无论设备声明什么、过了多久）
 归档 / 删除 / 换设备 ──────────────────────────────────────► FOUNDRY_ACCESS_ENDED，授权删除
 账号停用 / 移除 / 解绑、权限包不允许、会话换 Workspace ────────► FOUNDRY_ACCESS_ENDED（授权保留，恢复绑定即可用）
 扩展 / Cloudflare / ASC 替身满 30 分钟 ─────────────────────► HANDLE_EXPIRED，转发器经 /session-handle 续期（同一规则）
```

- 删除 Server 侧的原生工作声明（`session_claims.go` 的 native 表、`NativeWorkClaimedAt`、`UseNativeWork`、`HeldSessionMaxIdle`、`NativeWorkClaimWindow`、`ErrSessionIdle`）。Worker 仍发送 `nativeWork` 和 `nativeWorkSessionIds`：执行宿主轮换要用，旧 Server 也认；新 Server 忽略这两个字段。
- 授权清理（`PruneFeishuGatewayGrants(supersededBefore)`）：删除已归档或已删除会话的授权；被同一会话、同一账号的更新授权取代超过 24 小时的旧授权也删除（`gateway.SupersededGrantKeep`），长会话不再堆积。失败或取消的回合不再删授权。
- Foundry 工具的会话 token：会话存在且未归档期间有效，去掉 24 小时闲置失效；30 天硬过期不变（复用进程在 20 小时内就会换到新 token）。
- 审计：替身已对上本设备的授权、却在认证步骤被拒的调用，也记到该会话和账号名下（扩展的 detail 带 `reason: message`；飞书的请求行带会话）。以前这类拒绝不留痕，这次只能从会话记录反查。

## 修改：Worker

`runAgentSession` 无论这一轮结果如何，都把运行环境（profile、转发器、启动器、工具目录）交给 `holdWhileAgentRuns`，跟着用它启动的 Agent 进程走，进程退出即释放。取消会关闭 Claude 进程，因此立即释放。以前一轮失败或取消时立即释放，连同早先几轮为同一个仍存活的进程保留的环境（例如常驻的 Codex app-server 及其后台终端）。

## 安全性质（保留的）

- 立即撤销：归档或删除会话，停用、移除或解绑账号，权限包关闭，移除设备，会话换设备，下一次调用即拒绝。
- 隔离：替身只有哈希在 Server；必须由会话所在设备出示设备凭证；其他用户和会话用不了。
- 每次调用都有审计，包括被拒的调用。
- 威胁模型更新在 `docs/security.md#connector-access-is-the-sessions`；连接器文档 `docs/connectors.md#授权跟着会话不跟着回合dev-215`；foundry skill `references/device-and-accounts.md`（修订 37）。

## 检查

每个事故类别都有一个复现测试：同一个替身在回合之间使用（Agent 进程跨回合复用），回合结束后的后台工作，失败或取消的回合之后，一周后，以及没有任何设备声明的情况（等同 Worker 或 Server 重启、交接）。撤销类别同样各有测试：归档、删除、换设备、换 Workspace、账号停用或解绑。

- Go（sg-chaos，`/tmp/fdy-heavy.lock`，Mac mini 离线）通过：`gateway`（`TestASessionHoldsItsConnectorGrantWhateverItsTurnsDo`、`TestAnEndedSessionSpendsItsGrant`、`TestLiveAnswersTheSameRecheck…`、`TestStandInsExpire…`）、`connectors`（`TestExtensionGatewayInjectsFieldsAndEnforcesRouteDirectory` 新增 OpenLark 事故复现：会话 completed / failed / canceled 且回合结束 26 小时后调用与续期都成功；解绑后 `FOUNDRY_ACCESS_ENDED`，并以 `access_ended` 原因记入该会话的审计；归档后拒绝且不再续期；`TestCloudflare…`、`TestAppStoreConnect…`）、`sqlitestore`（`TestSessionTokenFollowsTheSessionNotItsTurns`、`TestPruneFeishuGatewayGrantsKeepsEverySessionNotArchived`）、`builtinskills`。`go vet ./internal/httpapi` 通过（编译测试）。
- Worker：tsc 通过；`session-environment-agent-lifetime`、`connectors-native-work-lifetime`、`server-held-extension` 共 16 项通过。新增的两项：取消的回合进程仍在时保留环境、进程退出后释放；进程已关闭时立即释放。
- 未跑、交部署车检查：`go test ./internal/httpapi -run 'TestFeishuGatewayServesASessionWhateverItsTurnsDo|TestFeishuGatewayAccessEndsImmediately|TestFeishuGatewaySwapsHandlesForRealTokens|TestHeartbeat|TestRestartedServerWaitsForDevicesToClaimAgain|TestAppStoreConnect|TestFeishuGatewayDelegatesEventConnections|TestFeishuGatewayAnswersUserRefreshWithStandIns|TestServerHeldExtension|TestConnectorExtension'`。

部署车检查（macbook，`/tmp/fdy-train`）：上面的 Go 与 Worker 定向测试通过；httpapi 中 `TestFeishuGatewayDelegatesEventConnections` 和 `TestFeishuGatewayAnswersUserRefreshWithStandIns` 起初失败，原因是测试仍把回合完成当作会话结束。已改为回合之间仍可用、归档后拒绝（`/tmp/dev215-train-fix.patch`），部署前在 byte-dev 上通过。

## 真实检查（dev，sg-chaos，foundry Workspace 的飞书连接器，只读）

会话 `sess_1794568666859900218`（agent 来源，claude-sonnet），只调用 `feishu-cli api GET /open-apis/authen/v1/user_info --as user`，只写 `/tmp/dev215-e2e/`（证据副本 `/tmp/dev215-e2e-evidence/`）。时间均为 UTC。

| 时间                | 发生了什么                                                                                                                       | 结果                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 11:18:04            | 第 1 回合在旧执行宿主（`…1794566569`）上前台调用；起分离循环 1 和一个 150 秒的 Claude 后台任务                                   | 成功                                                                                                                            |
| 11:19:48            | sg-chaos 的 Worker 更新到 `…1794567381`                                                                                          | —                                                                                                                               |
| 11:20:35 / 11:20:38 | 后台任务的调用，以及它的通知唤起的调用（agent 来源的回合会等后台任务，所以仍在回合内）                                           | 均成功                                                                                                                          |
| 11:21:13            | 第 1 回合完成（11:20:41）后，分离循环 1 的调用                                                                                   | 失败：`profile 不存在`。这一轮的 Claude 进程已退出，Worker 随之删除 profile（见限制）；请求没有到网关                           |
| 11:22:35            | 第 2 回合在新执行宿主 `300e0f1cc416`（`…1794567381`，含 DEV-215）上调用；起分离循环 2（70 × 30 秒）和 1200 秒的 `ScheduleWakeup` | 成功；回合 11:22:37 完成                                                                                                        |
| 11:23:05–11:43:29   | 会话一直是 completed，Claude 进程空闲、只挂着定时；分离循环 2 共 41 次调用                                                       | 全部成功。旧规则下 11:24:37 之后的都会被拒                                                                                      |
| 11:43:05            | 定时唤起 Claude 自己的回合并调用（会话仍是 completed，completedAt 11:22:37，也就是 20 分钟后）；这正是 #6 事故的形态             | 成功                                                                                                                            |
| 11:43:42            | 第 3 回合                                                                                                                        | 成功                                                                                                                            |
| 11:44:0x            | 归档会话                                                                                                                         | —                                                                                                                               |
| 11:44:30、11:45:00  | 分离循环 2 的下两次调用                                                                                                          | `code=99991668 … Foundry gateway: this session's Feishu access through Foundry has ended: the session was archived or deleted…` |

审计（`feishu_gateway_requests`，`session_ref = sess_1794568666859900218`）：55 行 `200 forwarded`，1 行 `401 refused`（11:44:30，带会话：新增的认证拒绝审计）。11:45:00 那次拒绝没有会话，因为第一次拒绝时那份授权已经删除，替身对不上任何授权。会话其余几轮的授权（5 份）由每小时清理删除。

## 限制

- OpenLark 只绑定在 byte-dev 的 Workspace（设备网络），真实检查改用 sg-chaos 上 foundry Workspace 的飞书连接器，走的是同一条 `SessionLive` / `Pipeline.Live`。
- Worker 仍上报 `nativeWork` 声明：执行宿主轮换要用，Server 不再用于授权。byte-dev 回合结束后不续这项声明的原因没有查（可能是 Worker 版本问题），它只影响宿主轮换的时机。
- 设备上的连接器环境（飞书 profile、本机转发器）跟着用它启动的 Agent 进程，不跟着会话：Agent 进程退出后，它留下的分离进程（`nohup … &`，不是 Claude 或 Codex 自己的后台工作）就找不到 profile。真实检查第 1 回合就是这样（agent 来源的会话回合结束后进程退出）。Claude 或 Codex 自己的后台任务、Monitor、定时和子 Agent 让进程活着，环境随之保留。要让脱离 Agent 的进程也持有，就得让环境跟着会话常驻（每个未归档的会话一个转发器），这次没做。
- 一个会话的授权现在一直有效，直到归档或删除；从未归档的旧会话，其替身只存在于设备上已删除的 profile 或已退出的进程里，而且离不开设备凭证。

## 验收

1. 在绑定 OpenLark 或飞书的 Workspace 里，让 Agent 起一个每 30 秒调用一次连接器、持续 10 分钟以上的后台循环，然后结束回合。预期：回合结束后每次调用都成功；后台任务结束后唤起的回合里，回复发送成功。
2. 期间更新该设备的 Worker（`update_worker`）。预期：调用不中断，不出现 `FOUNDRY_ACCESS_ENDED`。
3. 归档该会话。预期：下一次调用即报 `FOUNDRY_ACCESS_ENDED`。
