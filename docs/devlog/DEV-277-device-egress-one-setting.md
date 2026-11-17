# DEV-277 设备出网代理只有一处：Worker 的代理设置交给它启动的连接程序

2026-11-17。本人（sess_1794918542102960894 之后）：「limen-client 在 worker 端的 proxy 成为了孤儿配置，这是个糟糕的设计……给出根本的优雅的解决方案，修复他」。

状态：已部署 dev（2026-11-17）；Agent 代验收（2026-11-17，范围见各自验收记录）；已合入 main（PR #274）。Worker `0.5.7-dev.364.gc8c8a35e.local.1794921082`（train 38 / 39），byte-dev 已更新并实测；孤儿配置已删除。

## 事实与根因

- byte-dev 上 Limen 本机适配器（`io.limen.client.service`）的出网代理写在一个手写的 systemd drop-in：`~/.config/systemd/user/io.limen.client.service.d/egress-proxy.conf`（11/4 安装 Limen 时照着 Worker 的代理设置抄了一份，注释写着 "same proxy as the Foundry Worker"）。没有任何工具拥有或展示它：Foundry 不知道，`limen status` 只显示 `auto`。
- 今天 byte-dev-sg（代理 10.251.248.226:17890）卡死时，本人 `foundry-worker proxy clear` 只修好了 Worker 自己连服务器；Limen 仍走那份抄来的代理，持续 `client_preflight_timeout`。恢复与切回都靠手改这个文件、留 `.bak`。
- Foundry 这边的缺口：
  - `foundry-worker proxy` 的设置只用于 Worker 自己的请求（以及 skill 的 npm/git 下载，`workerProxyEnvironment`，其注释早已写着 "and extension processes"，但从未接上）。
  - 模型连接 helper（`external-connection.ts`）只拿到 PATH/HOME/USER… 白名单，**没有任何代理变量**。
  - 扩展命令（`extensionBaseEnvironment`）与「帮我设置」命令（`setupEnvironment`）只透传 Worker **进程环境**里的代理变量，不认已保存的代理设置。
- Limen 侧早已支持正确的做法：每次 run 记录**启动者的代理变量**（`captureProxyEnvironment(process.env)` → run note），适配器按 run 的变量出网。所以只要 Foundry 把代理交给 helper，适配器就不需要自己的代理配置。

## 修复（packages/worker）

- `platform/server-link/server-proxy.ts`：`workerEgressVariables()`——Worker 有效代理（已保存设置优先，否则 Worker 环境）的标准变量 `HTTP(S)_PROXY` / `ALL_PROXY` / `NO_PROXY`（含小写）。不含 `FOUNDRY_PROXY`。
- 用在 Worker 为本人启动、需要出网的三处：连接 helper（`harness/external-connection.ts`）、扩展进程与声明式扩展命令（`connectors/extensions/process-environment.ts`）、连接「帮我设置」命令（`harness/external-connection-setup.ts`）。
- 补丁 b（部署后在 byte-dev 实测发现）：Limen 的 helper 不读自己进程的代理，而是把 Foundry 请求里的 `environment`（原生进程的启动环境）记为 run 的出网变量，所以 run note 仍是 `env: {}`。现在请求的 `environment` 里的代理变量同样取设备出网代理（已保存设置优先，否则环境），原生进程自己的环境不变。
- Agent 会话（原生 Claude/Codex 进程）的环境不变；helper 的变量只影响 helper 自己（它返回给原生进程的仍只是它显式设置的变量）。
- 文档：`docs/devices-and-workspaces.md`「设备的出网代理」、`docs/external-connections.md` 兼容义务。

## 检查

- CanWendeMac-mini，`scripts/run-worker-tests.mjs`：新增 `test/worker-egress.test.mjs`（已保存代理优先于环境；清除后回落环境；helper 进程启动时就带着 Worker 代理），`external-connection`（23/23）、`external-connection-setup`、`connectors-download` 通过；worker `tsc --noEmit` 通过。

## 部署后（byte-dev）

1. 更新 byte-dev Worker（`update_worker`），确认加载的版本。
2. 备份并删除孤儿 drop-in，`systemctl --user daemon-reload && systemctl --user restart io.limen.client.service`。
3. `foundry-worker connection check limen_default` 通过；用 Limen profile 跑一轮真实会话。
4. 验收：`foundry-worker proxy set/clear` 一处切换，Limen 会话随之走新代理（下一个会话生效），byte-dev 上不再有 Limen 的代理文件。

## 部署与 byte-dev 实测（2026-11-17）

- train 38（DEV-277）后在 byte-dev 实测：新启动的 Limen helper 进程环境里已有 Worker 代理，但 Limen 的 run note 仍是 `env: {}`——Limen 记录的是请求里的 `environment`，不是 helper 自己的环境。于是补丁 b（train 39）把设备出网代理放进请求的 `environment`。
- byte-dev Worker 由编排者用 `update_worker` 更新到 `…1794921082`（13:22Z）。`foundry-worker connection check limen_default` 通过；最新 run note 的 `env` 为 Worker 代理（`https_proxy` / `http_proxy` / `all_proxy` = byte-dev-sg 代理，`no_proxy` = Worker 的绕过列表）。
- 删除孤儿 drop-in `~/.config/systemd/user/io.limen.client.service.d/egress-proxy.conf`（内容与 `~/egress-proxy.conf.byte-dev-sg.bak` 逐字节相同），`daemon-reload`；`DropInPaths` 为空。**没有重启** Limen 服务：当时有两个 Limen 会话在跑，它们的 helper 是 13:22Z 之前起的（run note 为空），重启后它们的出网会落到无代理的服务环境。
- 遗留：两份 `.bak`（byte-dev-sg / relay）在 Limen 服务下一次干净重启后可删；切换出网只需 `foundry-worker proxy set/clear`。
