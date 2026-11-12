# DEV-190 MCP `update_worker`

## 状态

已合入 main（[PR #264](https://github.com/BD777/foundry/pull/264)）。

已实现、验证并部署 dev Server（2026-11-12）；初次上线验证未执行 `start`。后续首次实际使用已更新 7 台设备，并发现、清理了 `launchctl submit` 遗留更新任务。

## 问题

设备页面和 HTTP API 已能让 Worker 自己更新，但 Agent 没有对应 MCP 工具。Agent 需要能查询某台自己拥有的设备是否落后，并在明确需要时让 Worker 自己完成下载、切换、重启和重连。

## 实现

- MCP catalog 新增 `update_worker`；`deviceId` 必填，`action` 为 `start` 或 `status`，默认 `status`。
- `start` 直接调用现有 `startWorkerUpdate`，因此在线检查、单次更新检查和 Worker RPC 与设备页面完全相同。
- `status` 读取现有设备 projection、Server Worker release 和 `workerUpdates.active`，返回在线状态、两端版本、`state`、`inProgress`、开始时间、Stalled 和 Failure。
- 调用者按会话所属账号检查 `DeviceOwner`；workspace 成员、共享设备和非所有者统一得到不含版本信息的“not found among devices you own”。
- 工具描述说明更新会下载、切换、重启并重连；运行中的回合留在旧执行宿主上完成；仅设备所有者可用；更新后用 `status` 确认版本。

## 验证

`go test ./internal/httpapi/ -run '(UpdateWorker|WorkerUpdate|MCPTool|Policy|TestEveryCatalogToolHasAHandler|TestEveryFoundryToolHasASummaryAndLimits|TestFoundryToolLimitsNameTheEnforcedNumbers)'`

结果：`ok github.com/foundry-dev/foundry/apps/server/internal/httpapi 50.692s`。

测试覆盖：所有者 `start` 触发真实更新 RPC；离线拒绝；workspace 成员对 `start`/`status` 均被拒绝且不泄露版本；不存在的 deviceId；`in_progress`、`stalled`、`failed` 三态；catalog 与 handler 一致性。

## 部署

- 备份：`foundry-server.pre-update-worker-mcp`。
- dev candidate `foundry-server` 在 `fdy-deploy.lock` 内构建并原子替换。
- `pm2 restart foundry-server` 后进程 online；PID `2677126`，`restart_time=60`，`unstable_restarts=0`，复查时已稳定运行约 168 秒。
- `http://127.0.0.1:31983/healthz` 与 `https://dev.foundryapp.app/healthz` 均返回 200。
- 真实 MCP `update_worker` `status` 返回：设备 `dev_cd7e38ee-f3e8-44e7-9107-40df843469dd` 在线，Worker 与 Server 都是 `0.5.7-dev.354.geb87723d.local.1794470329`，`state=none`，`inProgress=false`。

## 限制与验收

- 本轮 Codex 的 MCP 工具目录在 Server 重启前已加载，因此真实调用由本会话所在设备 `sg-chaos` 的已配对所有者凭据通过同一 `/api/mcp` 路由完成；会话 token 的权限路径由自动化测试覆盖。
- 初次工具验证没有执行 `start`；后续 Worker `0.5.7-dev.354.geb87723d.local.1794475758` 发布时已实际使用 `start` 更新 7 台设备，并以 `status` 确认最终版本。一次 macbook 更新使用受管 `foundry-worker update` 后备路径，没有使用 `launchctl submit`。
- 验收：对自己的设备调用 `status` 应看到两端版本；对 workspace 共享设备调用 `start`/`status` 应被拒绝且响应不含版本；除非要更新设备，不要调用 `start`。

## 2026-11-12 `launchctl submit` 残留更新任务事故

| 时间（UTC+8）                | 变化与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 剩余动作                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 2026-11-12                   | Mac 设备在 15:04–16:18 反复断开/重连，不是 Worker 崩溃。CanWendeMac-mini 的 `/tmp/foundry-worker-update-envlife-CanWendeMac-mini.log` 显示残留的 update 作业在 `08:15:13Z` 完成服务激活并主动重启 Worker；新 PID `75437` 于 `08:15:17Z` 启动。五轮间隔 2 分钟的 `dev.foundry.worker` 采样 PID 始终为 `75437`。调查见 [sess_1794471198766081428](https://dev.foundryapp.app/chats/sess_1794471198766081428)。                                                                                                                                                                                                                                                                                           | 清点并移除残留 launchd job                                               |
| 2026-11-12                   | macbook 的 `launchctl list` 发现残留 label `dev.foundry.update-orch4.macbook`，已移除；移除前后及两分钟后常驻 `dev.foundry.dev.worker` PID 均为 `80490`，Worker 仍 online、compute ready。复查见 [sess_1794472135416300151](https://dev.foundryapp.app/chats/sess_1794472135416300151)。                                                                                                                                                                                                                                                                                                                                                                                                               | 后续只用受管更新路径                                                     |
| 结论                         | 以后不再用 `launchctl submit` 启动 Worker 更新；统一使用 MCP `update_worker`，必要时才使用受管 `foundry-worker update`，并在结束后检查 `launchctl list` 无 update job 残留。事故期间也没有删除运行中的 Worker 或执行宿主。                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 当前没有机制阻止人工再次提交同名 launchd job，操作规范与复查仍是必要边界 |
| 2026-11-12 21:16–21:19 UTC+8 | `update_worker` 增强：每次更新有稳定 `updateId`，status 返回 `connection`、当前步骤、开始/完成时间、耗时和最近一次完成结果；切换执行宿主时明确显示 `reconnecting` 而不是只报离线。Worker 自更新改用运行中 Node 同目录的 npm，并在失败时附带最后 40 行 npm stderr。7 个源文件三方合并无冲突，契约重新生成，Server `go build ./...` 与 `UpdateWorker\|WorkerUpdate\|MCPTool` 测试通过，Worker 的 `worker-runtime`、`foundry-cli`、`foundry-skill` 共 17 项测试通过。                                                                                                                                                                                                                                     | 本次不发布 Worker                                                        |
| 2026-11-12 21:17–21:19 UTC+8 | Server 部署证据：备份 `~/.foundry/server/releases/dev023-candidate/foundry-server.pre-update-worker-2`（SHA-256 `5521876828437bbcd95912ffc2d94934449b36ee1a44bbc2329b8c3f65c6f0cf`）；新二进制 SHA-256 `30b3e7172a9d5cc5504f92442a15cd88de6f9f9c8e18adb6482db8e582305573`。PM2 重启后 PID `3221129` 在 30 秒后保持不变，`restart_time=69`、`unstable_restarts=0`、状态 `online`；`127.0.0.1:31982/healthz` 与 `https://dev.foundryapp.app/healthz` 均为 200。真实 MCP `update_worker` `status` 经 `/api/mcp` 返回 `online=true`、`connection=online`、`workerVersion=serverVersion=0.5.7-dev.354.geb87723d.local.1794475758`、`state=none`、`inProgress=false`、`message="No recent Worker update."`。 | 仅调用了 `status`，没有调用 `start`                                      |
| 限制                         | Server 刚重启后内存中的最近完成记录为空，因此这次真实 `status` 只验证了新的连接与说明字段，没有返回 `update` 记录实例；下一次真实 Worker 更新完成后可验证 `id`、`completedAt`、`elapsedMs`。macbook 的下一次更新仍由旧 Worker 代码执行，会因旧逻辑再失败一次，需要先用后备方式更新；装上新版 Worker 后自更新不再依赖 `PATH` 中的 npm。                                                                                                                                                                                                                                                                                                                                                                 | 等 native chat sync 修复一起发布 Worker                                  |

检查限制：事故处理本身只清理本机 launchd job，没有重新执行更新，也没有制造一次新的 Worker 重启；macbook 的网络与电源原因仍由 DEV-189 的后续调查覆盖。

验收：在设备上运行 `launchctl list` 不应出现 `dev.foundry.update-*`；常驻 Worker PID 在至少 2 分钟内保持不变；设备仍显示 online/ready。对仍需更新的设备，调用 `update_worker status` 应能看到两端版本，明确需要更新时再调用 `start` 并复查最终版本。
