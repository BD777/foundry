# DEV-114 · 扩展从仓库一键安装，GitHub CLI 内置

状态：实现、自验与 dev 部署完成（2026-11-04 UTC+8），待人工验收。前置：[DEV-111](DEV-111-connector-extensions.md)。

## 问题

DEV-111 验收时本人指出：

- Limen、bytedcli 的描述符里有那么多字段，页面上却改不了配置，也没法给机器装扩展，显得古怪。
- 私有连接器应能留一个仓库地址（即便对别人是 404），有权限的人在页面上一点就装；先支持 GitHub，以后有 GitHub 连接器（`gh`）后，用它的授权装私有仓库。

DEV-111 的“只能在本机用命令装扩展”的限制，本人按第一性原理（先易用，后安全）判断没有必要：页面上的安装和 Install bytedcli 一样，是设备所有者明确点击、在自己设备上以自己身份运行的代码。

## 决定（本人批准，2026-11-04）

- 取消“只能在本机装”。边界改为：只有设备所有者、只装到自己的设备；代码由设备自己用它的 git 凭据拉取，Server 不经手；会话、Workspace、Server 不能自行安装。
- 来源是 git 文件夹（`source: {git, path, ref}`），不是 Release 包：Limen 扩展只用 Node 内置模块、bun 直接跑 `.ts`，不需要构建；同一机制覆盖 GitHub 和公司内网 git（bytedcli 那类不能放 GitHub 的）。
- GitHub CLI 作为公开工具内置为设备持有型连接器；私有 GitHub 仓库靠它的登录拉取。
- 描述符加 `signIn.repeat`：再次登录是新增一份登录（另一个 Limen profile）。

## 实现

- 协议（`packages/protocol/src/connectors.ts`、`connector-extensions.ts`、`daemon-messages.ts`）：`ConnectorExtensionRepository`；`ConnectorExtensionSource` 加 `source`/`commit`/`latestCommit`；manifest 的 `source`；注册表记录来源与提交；`extension_request`/`extension_reply`；`DeviceConnectorDevice.extensions`；`ConnectorSignIn.repeat`。
- Worker：
  - `connectors/extensions/sources.ts`：从 git 文件夹安装、更新、每 6 小时看一次上游提交；`skills/skill-repository-fetch.ts` 导出 `withRepositoryFolder`、`remoteCommit`（复用技能的浅克隆缓存）。GitHub https 远程在设备有 `gh` 时，单次命令以 `credential.https://github.com.helper=!gh auth git-credential` 拉取，不改全局 git 配置。
  - `registry.ts` 记录 `source`/`commit`/`latestCommit`；`manifest.ts` 校验 `source`。
  - CLI：`extension add <folder|git remote> [--path] [--ref]`、`extension update <id>`（退出码 5：仓库拉取失败）。
  - `daemon/handlers/extensions.ts`：安装/移除后立即上报设备。
  - GitHub CLI：`connectors/github.ts`（读 `gh auth status`，新旧两种措辞、旧版无 `--active` 时退回；设备码登录转达验证码与页面，完成后 `gh auth setup-git`；登出；隔离给空的 `GH_CONFIG_DIR` 并清空令牌变量）、`gh-install.ts`（官方 Release 包，按 checksums 校验 SHA-256，装到 `~/.local/share/gh-cli/<版本>`，链接到 Foundry 工具目录与空闲的 `~/.local/bin/gh`）；下载逻辑从 AWS 安装器抽成 `connectors/download.ts` 共用。
- Server：`httpapi/connector_extensions.go`：`POST /api/devices/{deviceId}/extensions`（`{source}`）、`DELETE …/extensions/{id}`，只限设备所有者、设备在线；`connectors.CheckExtensionRepository` 校验远程（https 不能带用户/令牌）、文件夹、ref；设备上报的 `extension.source`/提交一并校验；`ExtensionsOn` 给连接器视图每台设备的扩展；目录加 `github`。
- Web：
  - `extension-install-dialog.tsx`：一个确认对话框，写明拉什么（仓库、文件夹、分支）、装到哪台设备、以你的身份运行；目标设备 GitHub CLI 未登录且仓库在 GitHub 时提示并可跳到 GitHub CLI 标签。
  - 扩展连接器标签：没装的设备各有“Install <扩展>”；设备行在上游有新提交时显示提示与“Update”；菜单里“从这台设备移除”（先确认）与 `signIn.repeat` 的“加入另一个 profile”；介绍里写明“发布在 <仓库>”。
  - “Add a connector”的“自己的工具”一段加“从仓库安装…”；装好后自动打开新标签；扩展移走后标签回到第一个。
- 文档：`docs/connector-extensions.md`（边界、来源、CLI、`signIn.repeat`）、`docs/connectors.md`（决定记录、GitHub CLI）；foundry skill revision 22（设备 CLI 含 GitHub CLI）。
- 私有部分：Limen 扩展提交到 Limen 仓库 [wasd96040501/limen#331](https://github.com/wasd96040501/limen/pull/331)：`foundry-extension.json`（`source`、`signIn.repeat`、入口直接跑 `connector.ts`），删掉构建脚本；并修复 shutdown 时丢掉仍在处理的请求的应答（一次发多条请求再 shutdown，前面的应答会丢）。

## 自验

- 测试：Server `connectors`、`builtinskills`、`httpapi`（新增扩展安装/移除：校验远程、非所有者不能、设备的 git 失败原因原样返回、移除）；Worker 新增 `connector-extension-sources.test.mjs`（本地仓库经 URL 改写当作 https 远程：安装只复制文件夹、记录来源与提交、同提交不变、发现新提交、更新、经服务端请求移除再装、拒绝不合法来源）与 `connectors-github.test.mjs`（`gh auth status` 两种措辞、设备码、隔离、Release 包命名与 checksum 不符拒绝）；`daemon-dispatch` 计入 `extension_request`；Web `device-held-connectors` 新增两项（他机安装、更新、加入另一个 profile、移除；“从仓库安装”）；全量 Worker 测试 1057 项通过（`evidence-api-e2e` 在全量并发下一次失败，单独重跑通过）；prettier、gofmt、tsc、protocol、audit:ui/contract/modules。
- 真实私有仓库：`foundry-worker extension add https://github.com/wasd96040501/limen.git --path tools/host/foundry-extension --ref foundry/connector-extension` 在隔离状态目录装通（经 `gh` 凭据，全局 git 配置未变）；不存在的仓库返回 git 原话、退出码 5。
- scratch 栈（本分支构建，真实浏览器）：GitHub CLI 标签读到 `BD777`、2.67.0；“Add a connector → 从仓库安装”装 Limen，自动打开 Limen 标签、就绪；菜单有“加入另一个 profile”；移除后扩展目录删除、标签回到飞书；light/dark/390 截图。
- dev（e2e-alice 的合成设备，本包 Worker）：GitHub CLI 标签“Signed in as BD777”；移除 Limen 再从私有仓库安装，Limen 就绪，介绍显示“Published in github.com/wasd96040501/limen/tools/host/foundry-extension”；无 API/页面错误。合成设备 Worker 已停止，扩展保留（来源 `b2964c8`）。

## 部署

- 2026-11-04 02:25–02:40 UTC+8，持 `/tmp/fdy-deploy.lock`，3-way 合入 `foundry-int`（与其他会话已暂存内容只在 `daemon_inbound.go` 重叠，合并无冲突），在其上构建与定向测试通过。
- Server `7f57ce8856f10da9`（热交接，回滚副本 `dev023-candidate/foundry-server.pre-dev113`），Web `c0dc425cf475b2ba`，Worker `0.5.7-dev.241.g20491b56.local.1793731004`（原 `release.json` 存为 `release.before-dev113.json`）；7 台设备经算力租约更新，均上报新版本。sg-chaos 的执行宿主仍在旧包上（有会话在跑，等空闲自行切换，未强制）。

## 验收步骤

1. Connectors → GitHub CLI：每台设备显示 `gh` 的登录账号与版本；未装 `gh` 的设备点“Install GitHub CLI”；未登录的点“Sign in”出现验证码与 `https://github.com/login/device`，在 GitHub 上输入后显示已登录。
2. Connectors → Add a connector → “从仓库安装…”：填 `https://github.com/wasd96040501/limen.git`、文件夹 `tools/host/foundry-extension`、分支 `foundry/connector-extension`（#331 合并后可留空），选一台没装 Limen 的设备 → 确认框写明拉什么、装到哪 → 安装后自动打开 Limen 标签，那台设备出现。
3. Limen 标签：没装的设备各有“Install Limen”；已装的设备菜单里有“Join another profile”与“Remove Limen from this device…”（先确认）；介绍显示“Published in …”。
4. 上游有新提交后（6 小时内或重启 Worker 后），那台设备行显示“has a newer commit”与“Update Limen”，点了更新。

## 限制

- Limen 仓库的 `main` 需要一位评审批准才能合并（#331 待你或 Limen 的其他维护者批准）；合并前 Limen 的 `source` 指向的 `main` 还没有这个文件夹，页面上的“Install Limen”要等合并后才可用（从仓库安装时手填分支可用）。
- bytedcli 扩展还没有 `source`：它是公司内部代码，不应放到个人 GitHub；需要你给一个公司内网 git 仓库地址后再加。
- GitHub 登录流程只自验到出现验证码（真实批准需要人），已登录的读取在真实设备上验证。
- 执行宿主切到新包之前，那台设备上不能用 GitHub 登录的会话还拿不到 `gh` 的隔离变量。
