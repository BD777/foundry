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
- 私有部分：Limen 扩展曾提交到 Limen 自己的仓库，2026-11-04 本人要求撤回（不应把 Foundry 的东西放进别人的仓库），PR 已关闭、分支已删；扩展代码回到本机私有目录，后续方向见 DEV-115。

## 自验

- 测试：Server `connectors`、`builtinskills`、`httpapi`（新增扩展安装/移除：校验远程、非所有者不能、设备的 git 失败原因原样返回、移除）；Worker 新增 `connector-extension-sources.test.mjs`（本地仓库经 URL 改写当作 https 远程：安装只复制文件夹、记录来源与提交、同提交不变、发现新提交、更新、经服务端请求移除再装、拒绝不合法来源）与 `connectors-github.test.mjs`（`gh auth status` 两种措辞、设备码、隔离、Release 包命名与 checksum 不符拒绝）；`daemon-dispatch` 计入 `extension_request`；Web `device-held-connectors` 新增两项（他机安装、更新、加入另一个 profile、移除；“从仓库安装”）；全量 Worker 测试 1057 项通过（`evidence-api-e2e` 在全量并发下一次失败，单独重跑通过）；prettier、gofmt、tsc、protocol、audit:ui/contract/modules。
- 真实私有仓库：`foundry-worker extension add <私有 GitHub 仓库> --path tools/host/foundry-extension --ref foundry/connector-extension` 在隔离状态目录装通（经 `gh` 凭据，全局 git 配置未变）；不存在的仓库返回 git 原话、退出码 5。
- scratch 栈（本分支构建，真实浏览器）：GitHub CLI 标签读到 `BD777`、2.67.0；“Add a connector → 从仓库安装”装 Limen，自动打开 Limen 标签、就绪；菜单有“加入另一个 profile”；移除后扩展目录删除、标签回到飞书；light/dark/390 截图。
- dev（e2e-alice 的合成设备，本包 Worker）：GitHub CLI 标签“Signed in as BD777”；移除 Limen 再从私有仓库安装，Limen 就绪，介绍显示“Published in github.com/<私有仓库>/tools/host/foundry-extension”；无 API/页面错误。合成设备 Worker 已停止，扩展保留（来源 `b2964c8`）。

## 部署

- 2026-11-04 02:25–02:40 UTC+8，持 `/tmp/fdy-deploy.lock`，3-way 合入 `foundry-int`（与其他会话已暂存内容只在 `daemon_inbound.go` 重叠，合并无冲突），在其上构建与定向测试通过。
- Server `7f57ce8856f10da9`（热交接，回滚副本 `dev023-candidate/foundry-server.pre-dev113`），Web `c0dc425cf475b2ba`，Worker `0.5.7-dev.241.g20491b56.local.1793731004`（原 `release.json` 存为 `release.before-dev113.json`）；7 台设备经算力租约更新，均上报新版本。sg-chaos 的执行宿主仍在旧包上（有会话在跑，等空闲自行切换，未强制）。

## 验收步骤

1. Connectors → GitHub CLI：每台设备显示 `gh` 的登录账号与版本；未装 `gh` 的设备点“Install GitHub CLI”；未登录的点“Sign in”出现验证码与 `https://github.com/login/device`，在 GitHub 上输入后显示已登录。
2. Connectors → Add a connector → “从仓库安装…”：填一个放着扩展文件夹的 git 仓库（https、ssh 或 host:path）、文件夹和分支，选一台设备 → 确认框写明拉什么、装到哪 → 安装后自动打开该连接器的标签，那台设备出现。
3. Limen 标签：没装的设备各有“Install Limen”；已装的设备菜单里有“Join another profile”与“Remove Limen from this device…”（先确认）；介绍显示“Published in …”。
4. 上游有新提交后（6 小时内或重启 Worker 后），那台设备行显示“has a newer commit”与“Update Limen”，点了更新。

## 验收

2026-11-04 11:00 UTC+8 本人回复“Acceptance: 这个一份约束文档？按你建议来”，按 Agent 建议由 Agent 准出；只关闭下面已有证据的范围，其余保持开放。

| 步骤                   | 结论   | 证据                                                                                                   |
| ---------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| 1 GitHub CLI 读登录    | 通过   | dev 上 e2e-alice 的合成设备显示 “Signed in as BD777”、gh 2.67.0（2026-11-04 02:40 UTC+8）              |
| 1 安装 gh              | 未关闭 | 仅 Worker 测试（伪造 Release 包与 checksum）；没有真实设备装过                                         |
| 1 登录（验证码）       | 未关闭 | 本机探测到 `gh auth login --web` 给出验证码与页面；页面上的完整登录需要人在 GitHub 输入验证码          |
| 2 从仓库安装           | 通过   | dev 真实浏览器：Add a connector → 从私有仓库装 Limen，自动打开 Limen 标签、就绪、显示 “Published in …” |
| 3 菜单与移除           | 通过   | scratch 与 dev：菜单有 “Join another profile”；移除先确认，设备上扩展目录删除，标签回到第一个          |
| 3 他机 “Install Limen” | 未关闭 | Web 测试覆盖；e2e-alice 只有一台在线设备，真实点击未做                                                 |
| 4 更新                 | 未关闭 | Worker 与 Web 测试覆盖；Limen 撤出其仓库后没有可推新提交的来源，真实浏览器未验                         |

## 限制

- Limen 扩展不再放进 Limen 的仓库（本人 2026-11-04 决定），所以它没有 `source`；它的连接与会话供给方式另见 DEV-115。
- bytedcli 扩展还没有 `source`：它是公司内部代码，不应放到个人 GitHub；需要你给一个公司内网 git 仓库地址后再加。
- GitHub 登录流程只自验到出现验证码（真实批准需要人），已登录的读取在真实设备上验证。
- 执行宿主切到新包之前，那台设备上不能用 GitHub 登录的会话还拿不到 `gh` 的隔离变量。

## 后续：byte-dev 上 GitHub CLI 显示“Could not read”（2026-11-04）

- 现象：Connectors → GitHub CLI 中 byte-dev、byte-dev-sg 两行显示“Could not read the sign-in: Could not read the GitHub CLI version.”。
- 根因：两台机器的 `/usr/local/bin/gh` 不是 GitHub CLI，而是公司内部的主机查询工具（`gh system.devops.machine --idc …`，配置 `/etc/gh.yaml`），它不认 `--version`（`Error: unknown flag: --version`，退出码 1）。Worker 在 PATH 上找到这个同名程序，读版本失败，只能报 error，页面因此没有安装按钮。
- 修复（Worker）：`github.ts` 的 `readVersion` 遇到输出里完全不提 GitHub 的同名程序时，抛 `ForeignToolError`；`device-held.ts` 把它读成 `not_installed`（不再算作设备自带，附说明“The gh on this device is another program, not GitHub CLI.”），页面因此出现“Install GitHub CLI”。装到 `~/.foundry-tools/bin` 的 Foundry 副本优先于设备上的同名程序，会话用的是 GitHub CLI。`gh-install.ts` 增加一条：PATH 上已有别的 `gh` 时，不再链接 `~/.local/bin/gh`，以免盖住本人终端里的公司 `gh`。真正的 GitHub CLI 读版本失败、又没有任何输出时，仍然报 error。
- 自验：`connectors-github.test.mjs` 新增两项（同名程序读成未安装，空输出仍报 error，正常的 2.67.0；PATH 上有别的 `gh` 时只链接 Foundry 工具目录），连同 aws、扩展的 connector 测试共 30 项通过；`check-changed`（worker build、9 个 worker 测试文件、audit:modules）通过，prettier 已修正。
- 部署：Worker `0.5.7-dev.250.g30a4f4c8.local.1793798468`（原 `release.json` 存为 `release.before-dev118-gh.json`），经算力租约以 `systemd-run --user` 更新 byte-dev、byte-dev-sg，两台 daemon 均为新版本；byte-dev-sg 的执行宿主已切换，byte-dev 的执行宿主有会话在跑，等空闲后自行切换（未强停）。在 byte-dev-sg 上用已部署的 Worker 包对真实 `/usr/local/bin/gh` 读状态，得到 `not_installed` 和上述说明（只读，没有源码或测试进入这两台机器）。
- 验收：Connectors → GitHub CLI → Check again：byte-dev、byte-dev-sg 显示“Not installed”和“Install GitHub CLI”；点安装后显示 GitHub CLI 版本与“Sign in”；那台机器终端里的 `gh` 仍是公司工具。
- 限制：安装后，那台设备上 Foundry 会话里的 `gh` 是 GitHub CLI，公司 `gh` 要在会话中用 `/usr/local/bin/gh` 全路径调用。未用本人账号在浏览器里点过（自验账号不拥有这两台设备）。

## 后续：byte-dev 安装 GitHub CLI 失败（2026-11-04）

- 现象：byte-dev 点“Install GitHub CLI”后显示 `could not download https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_checksums.txt: Connect Timeout Error (attempted address: github.com:443, timeout: 10000ms)`。
- 调查：byte-dev 没有设置代理，直连 GitHub。事后用 curl 和 Worker 自己的 undici 重试同一下载，3/3 成功（约 1 秒），所以那次是到 github.com 的连接偶发超时。同时发现第二个问题：安装第一步用 `api.github.com` 查最新版本，这台机器的出口地址的未登录配额（60 次/小时）已经用完（`rate_limit` core remaining 0，22:20 UTC+8 重置），这时重试会在查版本这一步得到 HTTP 403。
- 修复（Worker）：查最新版本改为读 `https://github.com/cli/cli/releases/latest` 的跳转地址（`/releases/tag/vX.Y.Z`），不再经过有配额的 API；`download.ts` 新增 `fetchRetrying`，连接在收到任何应答之前失败时最多试 3 次（间隔 1 秒、2 秒），HTTP 应答原样返回。AWS CLI 安装共用这个下载路径，也会重试。
- 自验：`connectors-github.test.mjs` 新增跳转地址解析与“第一次连接被拒、后续重试成功、302 不自动跟随”；与 aws-install 一起 16 项通过；`check-changed` 通过。在 byte-dev 上用已部署的 Worker 包装到临时目录（不动 `~/.local/bin`、`~/.foundry-tools`）：API 仍为 403 时成功装上 `gh version 2.103.3`，用时 268 秒（这台机器到 GitHub 下载地址很慢，在 8 分钟限制内），临时目录已删除。
- 部署：Worker `0.5.7-dev.250.g30a4f4c8.local.1793799277`（原 `release.json` 存为 `release.before-gh-download.json`），byte-dev、byte-dev-sg 已更新。
- 验收：byte-dev 行点 Retry，几分钟内显示下载进度，完成后显示 GitHub CLI 2.103.3 与“Sign in”。

## 后续：修复一度被覆盖（2026-11-04）

- 本人反馈 byte-dev 又显示 “Could not read”：DEV-116 从 `foundry-int` 打包的 Worker `…1793805296` 不含本修复（当时本修复只在 `main` 工作区、未提交），设备更新后修复被覆盖，代码本身没有问题。
- 处理：补丁交给持有部署锁的 DEV-116 会话，暂存进 `foundry-int`（与其 `github.ts` 改动无冲突，它的 Worker 测试 42 项通过），打包为 `…1793805731`，之后的 `…1793806150` 也包含。byte-dev、byte-dev-sg 已在含修复的版本上；byte-dev、limen-canada 由本会话更新到 `…1793806150`。
