# DEV-155 连接器访问只跟着 Foundry 回合：后台命令和被唤起的回合拿不到飞书

## 状态

状态：已部署 dev（Server、Worker，7 台设备），dev 上真实飞书端到端通过（sg-chaos），待人工验收。2026-11-10 00:50（UTC+8）经 PR #239 squash 合入 main（`b1f6eb4f`），CI（verify / web / packages / go）通过；合入后 dev 主仓库复位到该提交，部署的 Server 与 Worker 与之代码一致，未重新部署。

## 问题

2026-11-09 本人转来会话 `sess_1794213812193775525`（byte-dev，ccm-omh-integration，飞书连接器）：凡是不在本人发起的回合里运行的 `feishu-cli` 写入都失败，前台运行都成功。该会话自己整理的表（thread 第 94 条）：

| 运行方式                                  | 结果                                                            |
| ----------------------------------------- | --------------------------------------------------------------- |
| 超过 2 分钟被 Claude 自动转到后台的长脚本 | 中途报 “this session's Feishu access through Foundry has ended” |
| 回合结束前刚放到后台的命令                | “profile does not exist”                                        |
| 后台任务结束通知唤起的回合                | 同样没有 profile                                                |
| 本人发消息后的前台运行                    | 成功                                                            |

该会话因此记下了“飞书写入只在你发消息后的这轮回复里有效，以后都在前台跑完，不放后台”的变通做法。

## 调查

- 事件（15:28–15:39 UTC）：每个本人回合都是 “Reused active Claude Agent SDK”，同一个 Claude 进程跨回合存活；15:28:37 “Claude Agent SDK finished” 时后台脚本仍在跑，15:29:16 它报告授权中途失效；15:38:46 后台启动的脚本 4 秒后以 exit 1 结束（profile 已删），15:39:22 的 “Background task continued” 是 Claude 自己的回合，不经过 `run_session`。
- Server：网关流水线第 2 步 `Pipeline.Live` 要求 `store.IsActiveSessionStatus`（queued / running / blocked）。回合结束后会话是 `completed`，`authenticate` 返回 `ErrSessionEnded` 并**删除授权**；`PruneFeishuGatewayGrants` 每小时也删掉所有非活跃会话的授权。Cloudflare 走同一条流水线，其替身续期（`/session-handle`）也要求活跃状态。
- Worker：`runAgentSession` 的 `finally` 在每次运行结束时调用 `prepareSessionConnectors(...).release()`，删掉 `~/.feishu-cli/profiles/foundry-<账号>-<会话摘要>`、关掉 Cloudflare 转发器、删 session-bin 与工具版本目录。Claude 进程的环境里 `FEISHU_PROFILE` 仍指向这个名字，后台命令和 Claude 自己的回合就找不到 profile。
- 这与“原生优先”冲突：Claude 的后台 Bash / Monitor / ScheduleWakeup / CronCreate、Codex 的目标与后台终端在回合之后合法地继续工作。DEV-148 为此保留 Codex app-server，DEV-144 让 Worker 心跳声明仍持有的会话。

## 修复

规则：连接器授权和设备上的 profile 跟着“会话的 Agent 是否还在设备上工作”，而不只是 Foundry 回合。飞书与 Cloudflare 同一规则，没有飞书特例。

- **Worker**
  - `sessionsWithNativeWork`（`session/runner/active-runtimes.ts`）：Claude 进程有运行中的后台任务、定时或它自己继续的回合；常驻 Codex app-server 在忙。
  - `holdUntilNativeWorkEnds`：回合结束时若会话仍有原生工作，运行环境（连接器 profile 与转发器、设备持有型 bin 目录、工具版本目录）保留，Agent 停下 30 秒后（给任务通知唤起回合留出间隙）释放；否则照旧立即释放。
  - 同一会话的新回合接管同名 profile、变量与目录：`feishu.ts`、`connectors/index.ts`、`skills/session-tools.ts` 记录最后一次写入者，旧回合的释放不再删除新回合的东西。崩溃后按清单回收不变。
  - 声明：`session_completed` 在 Agent 继续工作时带 `nativeWork: true`；执行宿主快照新增 `nativeWork`，守护进程每次心跳带 `nativeWorkSessionIds`，注册成功后立即补发一次心跳（重启后的 Server 尽快知道）。
- **Server**
  - `gateway.SessionLive`：活跃状态；或 `completed`、未归档、会话所在设备 2 分钟内（`NativeWorkClaimWindow`）声明过原生工作、最后一个回合结束不到 24 小时（`HeldSessionMaxIdle`）。失败、取消、归档、删除返回 `ErrSessionEnded` 并删除授权；只是 Agent 停了返回 `ErrSessionIdle`：拒绝但保留授权（重连或 Server 重启后的声明可恢复）。设备、本人、Workspace、账号检查照旧逐请求生效。
  - `DaemonHub` 在内存记录每台设备对每个会话的最后一次原生工作声明（`session_claims.go`）；`session_completed` 的 `nativeWork` 在会话结算之前记录，不留空档。
  - Cloudflare 的 `sessionBinding`（发放与续期）使用同一判断。
  - `PruneFeishuGatewayGrants(heldSince)`：只删永远不会再活的授权（会话已不存在 / 失败 / 取消 / 归档，或完成超过 24 小时）。
- **文档**：威胁模型写入 [安全边界 · Connector access past a turn](../security.md#connector-access-past-a-turn)，连接器文档新增[回合之后的访问](../connectors.md#回合之后的访问dev-155)；foundry skill 的 `references/device-and-accounts.md` 改为替身在回合之后的工作期间仍可用（修订 28）。

## 部署 / 版本

2026-11-10 00:2x（UTC+8）在 `/tmp/fdy-deploy.lock` 下把本分支（基于 `origin/main` `f675148e`，dev 主仓库当时是干净的 main）的 diff 以 `git apply` 应用到 dev 主仓库；diff 存于 `~/.foundry/server/releases/dev155/branch.diff`。

- Server：binary sha256 `1580f84605ceaf34…`；旧 binary `releases/dev023-candidate/foundry-server.pre-dev155`；`pm2 restart foundry-server`（无 `--update-env`），dev healthz 200，7 台设备重新在线。无迁移。重启前的备份**没有做成**：脚本用的 `sqlite3` 命令行在 sg-chaos 上不存在，失败后仍继续重启；重启后立即用 python3 `sqlite3` 在线备份 `backups/foundry-20261110-0026-post-dev155.db`（integrity ok）。之后的部署改用 `~/.local/bin/fdy-db-backup`（python3 在线备份 + integrity_check，失败即非零退出，`B=$(fdy-db-backup pre-x) && pm2 restart …`）。
- Worker：`0.5.7-dev.330.gf675148e.local.1794241642`（上一版 `release.json` 与包在 `worker-packages-rollback/before-dev155/`）。打包前核对包内 `active-runtimes.js` 含 `holdUntilNativeWorkEnds`、`control-connection.js` 含 `nativeWorkSessionIds`。byte-dev、byte-dev-sg、cottoncpp、limen-canada 经 compute 租约以 `systemd-run --user` 更新，macbook 用 `~/.foundry-stacks/dev/bin/foundry-worker update`，CanWendeMac-mini 用 `nohup`，sg-chaos 用本机 systemd 单元；7 台 `daemon-health.json` 均为新版本。sg-chaos 的执行宿主在 00:29 本会话回合结束时切换，`identity.json` 的入口为新版本目录（已核对其 dist 含本项改动）。
- 部署前清理磁盘（9.1 → 17 GiB 可用）：`go clean -cache`、一小时前的 `/tmp/fwt-*` 测试残留。

## 检查

- Go：`gateway`（`TestACompletedSessionActsWhileItsDeviceClaimsItsNativeWork`：声明 30 秒前 → 放行；无声明 / 超过 2 分钟 / 别的设备的声明 → 拒绝且保留授权、再声明即恢复；归档、失败、取消、删除、回合结束超过 24 小时 → 拒绝并删除授权；账号吊销、解绑、会话换 Workspace → 拒绝）、`TestAnEndedSessionSpendsItsGrant` 改为失败 / 取消 / 归档；`httpapi`：`TestCompletedTurnAndHeartbeatsClaimTheAgentsNativeWork`（真实 WebSocket：`session_completed` 带 `nativeWork` 在结算前记录声明、不带的会话为 idle；心跳 `nativeWorkSessionIds` 续上；不再声明后超过窗口即 idle）、`TestFeishuGatewayServesACompletedSessionWhileItsAgentWorks`（经真实网关路由：完成后有声明 200、声明过期 401、恢复 200；新回合签发新授权可用；账号停用 401；归档 401 且授权被删）；`connectors` 的 Cloudflare 测试加完成后调用与续期两种情况；`sqlitestore` 的清理规则（运行中、最近完成保留；失败、取消、归档、完成超过一天、不存在删除）；`builtinskills` 记录修订 28。
- Worker：`connectors-native-work-lifetime.test.mjs` 8 项——回合结束后真实后台 `sh` 循环 15 次读 profile 全部成功、工作结束 30 秒后删除；无原生工作立即释放；定时与 Claude 自己的回合期间保留；新回合接管后旧回合释放不删新 profile；启动回收不动保留中的 profile；Codex 忙时算原生工作；心跳合并执行宿主与本进程的会话；工具目录被新回合接管。`external-accounts`、`session-execution-registry`、`connectors-session-prepare`、`connectors-cloudflare` 通过。
- `scripts/check-changed.sh`（37 个文件）：prettier、Worker 构建、Go（builtinskills / connectors / feishugateway / gateway / httpapi 全包 / store，sqlitestore 相关 5 项）、`audit:contract`、`audit:modules` 通过；gofmt 报一个测试文件，已格式化；Worker 测试 869 项中 12 项失败，均为 `connectors-tencentcloud.test.mjs` 的本机前置条件（与 DEV-154 记录相同，与本项无关）。

## E2E（dev，sg-chaos，本人的飞书连接器，只读）

在 foundry 工作区开子会话 `sess_1794241838441358957`（agent 来源，hell-tw · claude-opus-5-5），只调用 `feishu-cli api GET /open-apis/authen/v1/user_info --as user`，只写 `/tmp/dev155-e2e/`。时间均为 UTC。

1. 第一回合用 Bash `run_in_background` 起 7 次、间隔 30 秒的读取循环，并设 300 秒 ScheduleWakeup。agent 来源的回合会等待后台任务（`waitsForBackgroundWork`），所以循环期间会话仍在运行：16:30:47–16:33:49 7 次全部成功。回合 16:34:24 完成。
2. **定时唤起的回合（修复前会失败的路径）**：会话已 completed，16:35:00 Claude 进程内的定时触发自己的回合，16:35:03 读取成功（`wake.log`）。
3. **回合结束后仍在运行的命令**：第二条消息让它在前台 `nohup` 起一个分离的 14 次循环并设 900 秒唤醒后立即结束（不等待后台任务）。会话 16:35:23 completed；之后 16:35:50、16:36:21、16:36:51、16:37:21、16:37:51、16:38:22 六次读取全部成功（约 3 分钟）。修复前：回合结束即删除 profile、网关拒绝 completed 会话。
4. **归档后立即拒绝**：16:38:2x 归档该会话（定时仍在、设备仍声明原生工作），16:38:52 与 16:39:22 的读取均返回 `code=99991668 … Foundry gateway: this session's Feishu access through Foundry has ended`；所用授权被删除，其余授权由每小时的清理删除。
5. 审计：`feishu_gateway_requests` 中该会话 15 行，全部 `GET /open-apis/authen/v1/user_info 200 forwarded user`（16:30:47–16:38:22）；两次拒绝记为 `401 refused`、`session_ref` 为空（认证步骤就被拒，没有租约，原有行为）。

未单独在 dev 上演示：person 来源（chat）会话里被 Claude 自动转后台的命令。chat 回合不等待后台任务，这正是事故路径；它与第 3 步走同一套声明与保留逻辑，Worker 测试用真实后台进程覆盖，但 agent 无法以本人身份开 chat 会话。

## 限制

- 声明只在 Server 内存：Server 重启后到设备重新注册（注册后立即补一次心跳）之间，回合已结束的会话的调用会被拒绝一次（授权保留，声明回来即恢复）。
- 分离的进程（`nohup … &`，不是 Claude 的后台任务）本身不算原生工作；只有 Claude / Codex 自己还在工作（后台任务、定时、自己的回合、忙的 Codex）时会话才算存活。
- 在认证步骤被拒的请求，审计行没有会话（原有行为）。
- 一个会话连续多个回合都带着原生工作时，旧回合的 Cloudflare 转发器要等原生工作结束才关闭（每回合一个回环端口）。

## 验收步骤

1. 在绑定了飞书的工作区（例如 byte-dev 的 ccm-omh-integration）里，在 chat 中让 Agent 运行一个超过 2 分钟、每 30 秒做一次只读飞书调用的脚本，并让它转到后台或允许 Claude 自动转后台，然后让回合结束。预期：回合结束后后台脚本的每次调用都成功；后台任务结束通知唤起的回合里，飞书调用也成功。
2. 让 Agent 设一个 5 分钟的 ScheduleWakeup，唤醒时读一次飞书。预期：唤醒的回合读取成功。
3. 后台脚本还在跑时归档该会话。预期：下一次调用报 “Foundry gateway: this session's Feishu access through Foundry has ended”。
4. 后台任务全部结束、没有定时的会话，约 2 分钟后 `~/.feishu-cli/profiles/` 下该会话的 `foundry-…` profile 已删除，之后的调用被拒绝；本人再发一条消息，新回合正常可用。
