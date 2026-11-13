# DEV-208 GitHub CLI 隔离环境仍能从钥匙串拿到 github.com 凭据

## 状态

已修复并部署 dev，未提交。Worker `0.5.7-dev.357.g8f394c91.local.1794551762` 已更新 7 台设备；在 CanWendeMac-mini 上用已部署 Worker 的 `deviceHeldConnectors.handle({action:"status", fresh:true})` 复跑自检：`usable: true, isolationHolds: true`。设备重连后 Server 自动重读，存档的卡片状态已刷新为隔离成立。macbook（`dev_ca742456`）此前存着同样的红字，同一根因，同一版本修复。

## 问题

CanWendeMac-mini 上本人（BD777）在 Connectors 登录 GitHub CLI 后，设备卡片的隔离自检显示红字：

> A session without access still gets this login: gh's git credential helper still hands out a github.com credential under the isolation environment

即没有授权的会话（其他成员的会话）仍能拿到本人的 GitHub token。

## 复现与根因

在 CanWendeMac-mini 上按自检的方式复现（只判断有没有 token，不打印）：

| 探测                                                                        | 结果                                                                          |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `~/.gitconfig` 里的 credential 项                                           | 无（Foundry 登录没有运行 `gh auth setup-git`）                                |
| 系统配置 `/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig` | `credential.helper=osxkeychain`；钥匙串里没有 github.com 的 internet password |
| `~/.config/gh/hosts.yml`                                                    | 只有 `user: BD777`，不含 `oauth_token`；token 在登录钥匙串 `gh:github.com`    |
| 空 `GH_CONFIG_DIR` 下 `gh auth status`                                      | “You are not logged into any GitHub hosts”                                    |
| 空 `GH_CONFIG_DIR` 下 `gh auth token`                                       | **退出 0，返回 40 字符 token**                                                |
| 自检同款 `git credential fill`（gh 助手，空 `GH_CONFIG_DIR`）               | **拿到 `password=`**                                                          |

根因：gh 2.40+ 的 `ActiveToken` 先看环境变量和配置；配置里没有当前用户时会回退读钥匙串里不带账号的 `gh:github.com` 项。Foundry 的隔离只把 `GH_CONFIG_DIR` 指向空目录、把 `GH_TOKEN` 设为空字符串（gh 视为未设），所以 `gh auth status` 看起来已退出，`gh auth token`、`gh api` 和 `gh auth git-credential` 仍用钥匙串里的 token。macOS 的这条回退在 Linux（hosts.yml 存 token 时）不出现，所以 DEV-128 的测试没覆盖到。

另一条潜在路线：git 在会话里读本人的全局和系统配置，`osxkeychain` 或本人自己跑过的 `gh auth setup-git` 都会给 github.com 交出凭据；旧的隔离对 git 没有任何设置，自检又用 `GIT_CONFIG_GLOBAL=/dev/null` 看不到这一路。

## 修复（Worker，`packages/worker/src/connectors/github.ts`）

- 隔离环境 `GH_TOKEN=foundry-no-access`（`isolatedGhToken`）：gh 没有关掉钥匙串的开关，环境里有 token 时它只用这个，GitHub 拒绝它；`gh auth status` 显示 token 无效，`gh auth login` 在这种会话里也会拒绝写登录。
- 隔离环境加 `GIT_CONFIG_COUNT=1`、`credential.https://github.com.helper=`（空值）：git 最后读环境里的配置，空 helper 清空此前为 github.com 收集的全部 helper（系统 osxkeychain、全局 gh 助手、Git Credential Manager）。
- 通用运行时 `setupFor` 用 `mergeEnvironment` 合并描述符的 `isolationEnv` 与适配器的隔离变量，git 设置按序号接上，不互相覆盖。
- 自检（`sessionCheck("isolated")`）改为测真实路径：先在隔离环境里跑 `gh auth token`（除占位符外有输出即泄漏）；再按会话实际的样子跑 `git credential fill`：读本人全局与系统配置，并把 gh 助手放在隔离之前（当作本人做过 `setup-git`），不提示。能用的会话的检查不变。

能用的会话不受影响：它们拿不到这些隔离变量，仍由 `sessionEnvironment` 的 gh 助手取凭据。

## 权限（scope）

- Foundry 的默认是“推荐”：`repo`、`read:org`、`gist`（gh 自己的最低要求）加 `workflow`、`read:packages`（catalog `permissions` 组的 `recommended`）。首次登录时选择器从推荐开始，不需要改。
- 这台设备 05:16:15Z 的变化记录是 `source: foundry`，一次加了列出的全部 34 个 scope；其他设备上同一账号只有 8–11 个，GitHub 不会把以前授权的更大范围带过来，所以这次请求本身就列了 34 个，即登录时选了“全部”（或自选全选）。
- Server 不记录请求的 scope 集合，只有设备读回的结果和 `lastChange`；本次不改。
- 没有替本人撤销 token。

## 已知限制

隔离只防误用（[security.md](../security.md#device-held-connectors)）：没有沙箱的会话与本人同一系统用户，仍可直接 `security find-generic-password -s gh:github.com -w` 读钥匙串，或 `unset GH_TOKEN` 后运行 gh。要挡住故意绕过，需要 security.md 里列的系统级会话隔离。

## 设备重连后自动重读（Server）

存下来的卡片状态只在 Server 问设备时更新（`readDeviceConnector` → `Record`），Worker 没有主动上报的路径，所以修复部署后红字仍要本人点 “Check again”。现在设备每次 hello 后（`onDeviceConnected`），Server 对该设备已有存档的设备持有型连接器逐个做一次 `status`（`fresh: true`）读取（`httpapi/device_connector_refresh.go`）：Worker 版本变了立即读；版本相同则每台设备 30 分钟内最多一次（覆盖 Worker 重启，也防止断线重连刷屏）。读取沿用 Connectors 页的 `connectorRefreshes`，与页面同时发起的读取合并，页面上显示为“检查中”；失败只记日志，保留原存档。没有存档的连接器不读（首次读取仍由页面发起）。不改协议，不需要新 Worker。

## 记录

| 时间（UTC+8）    | 变化与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 剩余动作                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-13 14:50 | 根因在 CanWendeMac-mini 复现：空 `GH_CONFIG_DIR` 下 `gh auth token` 仍返回钥匙串里的 token。修复 `github.ts` 隔离与自检，`device-held.ts` 合并隔离变量；新增回归测试（模拟钥匙串回退的 fake gh、全局 gh/钥匙串 helper），session-environment 8/8、github 20/20、其他设备持有型 52/52 通过（sg-chaos 上需去掉代理变量，并设 `FOUNDRY_STATE_ROOT`/`FOUNDRY_TOOLS_ROOT`）。真实 gh 2.103.3 在新隔离环境里：`gh auth token` 只给占位符，`gh api user` 返回 Bad credentials，`gh auth login` 被拒，`git credential fill` 没有密码；能用的会话照常拿到凭据。Worker `...1794551762` 已打包并更新 7 台设备，Mac mini 上已部署代码的自检通过。 | 本人打开 Connectors 页刷新卡片。另外：Mac mini 的 `~/.gitconfig` 有 `url."ssh://git@github.com/".insteadOf https://github.com/`，任何会话都会走本机 SSH key 访问 GitHub；那是本人自己配置的设备凭据，不归 GitHub CLI 连接器管，未改 |
| 2026-11-13 16:35 | Server 在设备重连后自动重读设备持有型连接器（`device_connector_refresh.go`，`server.go` 挂到 `onDeviceConnected`）。定向 Go 测试（新增重连重读与限频两个测试，原有连接器测试的读取次数不变）在 sg-chaos 的 heavy lock 下通过。Server 以 DEV-203 部署树加本改动构建，08:28Z 部署（`7226ff6f`）；随后 DEV-209 的部署也包含本改动（二进制含 `refreshDeviceConnectorsOnConnect`）。重启后各设备重连，存档自动刷新：CanWendeMac-mini 与 macbook 的 GitHub CLI `session_check` 均为 `isolationHolds: true`（08:29Z），红字已消失，无需本人操作。                                                                                            | 无                                                                                                                                                                                                                                  |
