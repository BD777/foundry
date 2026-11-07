# DEV-145 会话里跑不了 remote-check.sh

## 问题

2026-11-05：sg-chaos 上的一个 Foundry 子会话要按 AGENTS.md 用 `scripts/remote-check.sh <device>` 在另一台设备上跑检查，脚本直接退出：`FOUNDRY_SESSION_TOKEN is not set`。

## 调查

- 脚本经 `foundry` CLI 调 Foundry 工具（`device list`、`resource acquire/operate/release`），CLI 只认 `FOUNDRY_SESSION_TOKEN`；会话里的命令（设了 `FOUNDRY_SESSION_ID`）不回退到设备凭据（`agent-surface/foundry-client.ts`）。Server 只把资源租给会话身份（`mcp_resources.go` `resourceHolder`），设备凭据本来也租不了。
- 令牌不在命令环境里是有意的（#123，2026-10-12 “session token hardening”）：Claude Code 经输入流（`setMcpServers`）拿到 Foundry MCP 和令牌，环境里去掉（`session-ambient.ts` `withoutSessionToken`）；Codex 自己读变量、用 `shell_environment_policy.exclude` 挡在 shell 外并关掉 shell snapshot。`docs/session-orchestration-design.md`、`docs/security.md` 都写明“Agent 的命令看不到”，理由是被提示注入的命令能把令牌发到任何地方。
- `remote-check.sh` 是第二天（#125，2026-10-13）加的，仍假设命令环境里有令牌：只有 custom-command profile 能用，Claude Code / Codex 会话从来跑不了。本会话的环境同样没有该变量（只有 `FOUNDRY_SESSION_ID`、`FOUNDRY_SERVER_URL` 等）。
- MCP 工具本身能租用、操作 compute，但脚本要传整份 diff 和未提交文件（`put_files` 每块 768 KB base64）并轮询输出，全部经 Agent 调用会把这些内容塞进上下文，不可行。

## 取舍

| 方案                                 | 结论                                               |
| ------------------------------------ | -------------------------------------------------- |
| 把会话令牌放回命令环境               | 否：撤销 #123 的决定，命令能调用会话的全部工具     |
| 加一个 CLI 子命令取出会话令牌        | 否：等同于放回环境                                 |
| 让 Agent 用 MCP 工具逐步完成脚本的事 | 否：diff 与输出进上下文，几十次调用                |
| 会话把一份 compute 租约显式交给命令  | 采用：命令只能操作这份租约，Agent 本来就能做这些事 |

## 修复

- `acquire_resource` 新增 `forCommands`（只限单个 compute 实例）：回答里多一个 `commandToken`。Server 在 `session_tokens` 里铸一个带 `lease_id` 的令牌（新列，`setupSessionTokenLeases` 迁移；防御性上限 24 小时）。
- 这种令牌解析出的身份带 `LeaseID`，只能：经 `POST /api/mcp`（其他路由 403，`policy.go`）；调用 `operate_resource`、`resource_status`、`release_resource`（`tools/list` 也只列这三个，`mcp.go`）；`leaseId` 必须是它的租约，且租约仍由该会话持有（active / parked），租约结束即 401（`mcp_resources.go` `checkCommandLease`）。会话自己的令牌照旧不进命令环境。
- `foundry` CLI 在没有 `FOUNDRY_SESSION_TOKEN` 时读 `FOUNDRY_LEASE_TOKEN`，会话内无凭据时的报错说明这条路（`foundry-client.ts`、`foundry-cli.ts` 帮助）。
- `remote-check.sh` 接受 `<leaseId>`：用 `FOUNDRY_LEASE_TOKEN` 先查租约状态，跳过租用，结束时释放；`<device>` 写法保留给持有会话令牌的环境，没有令牌时报错说明改用租约。AGENTS.md 的用法改为先 `acquire_resource`（`forCommands: true`、`holdFor: 3600`）再在后台运行脚本。
- 文档：`docs/security.md` Agent Credentials、`docs/session-orchestration-design.md` §3 身份环境变量与 §4.2、`docs/resources.md`。Foundry skill 不变（工具说明里已写 `forCommands`；skill 只教 MCP 工具，不教 CLI）。

## 验证

- Go：`TestLeaseCommandTokenActsOnItsLeaseOnly`（真实 Server handler + 假设备 WebSocket）：不带 `forCommands` 不发令牌；命令令牌只列三个工具，能 run / status / release 自己的租约；`list_sessions`、`acquire_resource`、按 `resourceId` 查状态、操作另一份租约都被拒；`GET /api/chats` 403 且同一路由会话令牌 200；`forCommands` 用于屏幕被拒；释放后再 run 报 “has ended”。把 `policy.go` 的限制改成 `false` 后该测试失败（返回 200），说明断言有效。`TestLeaseCommandTokenNamesItsLease`：解析出 `LeaseID`、会话令牌不带、空租约拒铸、迁移可重复执行。`TestSessionRunsCommandsOnAnotherDevicesCompute`、`TestSessionLeases*` 仍通过。
- Worker：`foundry-cli.test.mjs` 8/8，新增“会话内用租约命令令牌操作”（Bearer 为租约令牌、不带设备凭据）与无凭据报错提到 `FOUNDRY_LEASE_TOKEN`。
- 脚本：在本会话环境（无 `FOUNDRY_SESSION_TOKEN`）里，对一个本机假 `/api/mcp`（只认该租约令牌和租约 id，`run` / `put_files` / `get_file` / `git_sync` 在临时目录真实执行，`pnpm`、`go` 用桩）运行 `FOUNDRY_LEASE_TOKEN=… scripts/remote-check.sh lease_fake1 --list`：状态检查、git_sync、上传 diff、应用改动、依赖与检查两个后台任务、释放全部经 worktree 构建的 CLI 发出，退出 0，远端 `check-changed.sh --list` 列出的正是本次改动的文件。
- `scripts/check-changed.sh --files <本次 21 个文件>`：gofmt、worker build、worker tests（4 个文件）、httpapi 34 个相关测试、sqlitestore、store、audit:contract 通过；prettier 两处格式已修正。另跑 `go test ./internal/httpapi -run 'Agent|Auth|Polic|Route|Token|MCP|Resource|Lease'` 通过。

## 局限

- 未在真实 Server 与另一台设备上端到端运行：需要部署 Server（新列迁移、工具参数）后才能做；Worker 更新只影响设备上全局安装的 `foundry` CLI，脚本默认用本仓库构建的 `packages/worker/dist/foundry-cli.js`。
- 命令令牌明文出现在 Agent 的工具结果里，Agent 传给命令时写在命令行上（transcript 里 `*_TOKEN=` 形状会被 Worker 脱敏）。在租约结束前，读到它的人或会话能操作这份租约；租约结束即失效。
- 会话轮次结束后租约会 park（默认 10 分钟），脚本跑得久需要 `holdFor`；超过 2 小时的 park 上限仍会被收回。

## 验收步骤

1. 部署 Server 与本仓库 Worker 构建后，在一个 foundry 工作区的会话里：`list_resources`（type compute）找到另一台设备的 compute；`acquire_resource` `{resourceId, reason, holdFor: 3600, forCommands: true}`。预期：回答里有 `leaseId`、`commandToken` 和说明用法的 `next`。
2. 在后台运行 `FOUNDRY_LEASE_TOKEN=<commandToken> scripts/remote-check.sh <leaseId> --files <几个改动文件>`。预期：打印 `using the session's lease …`、checkout、依赖与检查输出，结束后 Resources 页上该租约已释放。
3. 用同一个令牌调用别的工具（如 `foundry session list`）。预期：被拒，说明命令令牌只能操作它的租约。

## 部署与端到端验证（2026-11-06 18:10–18:30 UTC+8，编排）

- Server：为避开另一会话在 dev 工作区里未完成的改动，从干净树（`origin/main` + DEV-132..145 各分支 diff，与 dev 工作区逐文件比对一致）构建；在线备份 `backups/foundry-20261106-1807-pre-dev144-145.db`（integrity ok），旧二进制留作 `foundry-server.pre-dev144-145`，`pm2 restart`；healthz 200，迁移后 `session_tokens` 有 `lease_id` 列。Worker `0.5.7-dev.303.g1837af21.local.1793959952`（回滚 `worker-packages-rollback/before-dev144`）已更新到 6 台在线设备；macbook 当时离线。
- 线上令牌边界（本会话 `acquire_resource {forCommands: true}` 拿到的 commandToken）：`GET /api/chats` 403；`tools/list` 只有 `operate_resource`、`release_resource`、`resource_status`；调用 `list_sessions` 被拒；指向别的租约被拒；自己的租约正常运行。
- 端到端：第一次在 byte-dev 上失败在 `pnpm: not found`——计算资源用最小 PATH 跑命令，byte-dev 的 pnpm、go 只在登录 shell 的 PATH（`~/.local/bin`、`/usr/local/go/bin`）。`remote-check.sh` 的后台 job 现在先取设备用户登录 shell 的 PATH（没有 bash 或取不到时保持原样）再执行。修正后从本会话（环境里没有 `FOUNDRY_SESSION_TOKEN`）`FOUNDRY_LEASE_TOKEN=… scripts/remote-check.sh <lease> --files apps/server/internal/sessions/recovery.go apps/server/internal/sessions/recovery_test.go`：上传 diff、安装依赖、gofmt PASS、go test sessions PASS，退出码 0，结束时释放租约。

- 2026-11-07 合入前审查修正：`MintLeaseCommandToken` 从 `store.Store` 移到新的 `store.LeaseCommandTokenStore` 接口（`apps/server/internal/store/lease_command_tokens.go`，`httpapi` 的 Server 存储组合里单独嵌入），因为模块边界审计不允许 `store.Store` 再增加方法；行为不变。
- 2026-11-07 08:48 UTC+8：已合入 main，PR #221（squash `ec721cf9`），含上述审查修正；合入前已部署 dev（Server、Web，Worker `0.5.7-dev.303.g1837af21.local.1793959952` 已更新到全部在线设备，macbook 于 2026-11-07 00:00 UTC+8 前后更新），合入后未重新部署。
