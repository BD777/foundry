# 设备与 Workspace

[Roadmap](roadmap.md) · [文档索引](README.md)

本模块是分层图的基础层，负责两件事：**设备**如何加入并保持连接（配对、Daemon 出站 WebSocket、登录时启动的服务、Worker 的安装与更新），以及 **Workspace** 作为"某台设备上的一个目录"的身份、登记、改名、移除与选择。它不负责账号、角色与共享（[身份与共享](accounts-permissions-design.md)，本模块依赖它：设备凭证属于账号，Workspace 操作按角色授权），也不负责会话如何启动与隔离（[执行内核](execution-kernel.md)）或设备上的资源、模型登录与 Skill（能力供给各模块）。几乎所有上层都依赖它：执行内核经这里的通道派发会话，Resources、Skills、模型与账号按设备上报，Chats 与 Issues 在 Workspace 中工作。

## 设计

### 设备与连接

- **一个系统账号的一个状态根，在一个 Foundry 账号下是一个设备**（2026-10-15 起的新配对）：Worker 报三个哈希，从不报原始 id 或用户名——Worker 指纹（machine id + 数字 uid（Windows 为 SID）+ 本 Worker 的状态根，新设备按它识别）、系统账号指纹（machine id + uid + 该账号自己的 `~/.foundry`，同一账号下的不同状态根、开发栈算同一个账号）和机器指纹（只有 machine id）。所以同一台电脑的不同系统账号、同一账号的并行开发栈都是不同设备。此前配对的设备按旧的机器指纹（machine id + 栈后缀）识别，id 不变、不用重新配对：升级后的 Worker 连上时补报账号指纹，再配对时只有同一系统账号（或仍持有该设备 id 的 Worker）会接回它。一个状态根只运行一个 Daemon（`device-pairing.ts` 的锁）。设备可以没有 Workspace：2026-10-09 起新设备配对后不再自动登记任何目录，人在 Workspaces 页添加（#113、#114）。
- **配对**：登录的账号生成一次性配对 token（Web 上 15 分钟，`foundry-server devices pairing-token` 1 小时），`POST /api/daemon/pair` 兑换一次，得到设备自己的凭证；Server 只存哈希，Worker 存在 `~/.foundry/daemon-config.json`（仅所有者可读）。同一台机器再次配对会轮换凭证。细节见[安全边界](security.md)。
- **Daemon 主动连接 Server**（`/api/daemon/ws`），设备不需要开放入站端口。连接打开后先 `hello`，再为每个 Workspace 注册；Worker 每 25 秒发心跳，Server 70 秒收不到任何字节就断开，Worker 退避重连（上限 30 秒）。会话生命周期消息走需确认的 outbox（`transport.ts` 的 `ReliableSessionTransport`）：重连后补发未确认的消息，按 socket 缓冲水位背压、合并同一事件的旧版本（2026-10-11，#120）；大消息在 Server 支持时分片为 `reply_chunk`。协议校验的单条上限是 2 MiB，Server 读帧上限 96 MiB（容纳 Skill 包，压缩消息解压后同样受限）。
- **慢速上行**（2026-10-15）：daemon socket 协商 permessage-deflate（no context takeover，≥1 KiB 的消息才压缩；旧 Worker 的 `ws` 默认也会协商）。Server 在 upgrade 响应头 `Foundry-Daemon-Features: registration_sections` 声明它在内存里按 digest 保留设备注册的两个 section（`device`：agentProfiles + providerHealth；`workspace`：assets、agents、workspaceFiles、chats、skills）；Worker 对本进程已整份发过的 section 只发 digest（`omittedSections`），Server 缺（重启过）就回 `registration_needed`，Worker 整份重发，slim hello 被接受前其他注册先等着。`scan_skills` 带 `knownDigest`，未变的扫描结果只回 digest，Server 用保留的结果照常入库。重连报告行（Server 日志 `device … reconnected`）带上一连接前 3 分钟按消息类型的字节数、补发的 outbox 消息、outbox/socket 峰值和最长发送停滞（`send-meter.ts`）。
- **Server 不读写自己磁盘上的 Workspace 路径。** 附件上传与读取、工作区文件与目录浏览都经设备通道分块转发，路径由设备按真实路径校验（M3-1，2026-09-28；`daemon_attachments.go`、`workspace-attachments.ts`）。
- **移除设备是软删除**：设备被打上墓碑、不能再注册，它的聊天、Issue 与会话记录保留，它上报的 agent、profile、连接分配与 Skill 扫描被清除；有未结束的工作时拒绝移除。在线的 Daemon 收到关闭码 4001 `device_removed` 后停止重连、原地等待，只有重新 `pair` / `setup` 才能回来（`device_removal.go`、`device-removal.ts`）。
- **断线可诊断**：设备页显示最近一次断开的 Server 侧原因与 Worker 重连后的自述（只在内存中，Server 重启后清空，`device_disconnects.go`），以及 Diagnostics 页的诊断与修复动作（`device_diagnostics.go`）。

### 安装、登录服务与更新

- **一条命令加入**：`npx -y @bd777/foundry-worker@latest install --server <url> --token <token> [--workspace <path>]`（macOS 或 Linux，Node.js 20+）。包装到 `<状态根>/runtime/<version>`，`current` 指向在用的版本，并写出本机命令 `~/.foundry/bin/foundry-worker`（`doctor` / `update` / `status` / `uninstall`）。步骤与选项见[开发指南 · Installing a worker with npx](development.md#installing-a-worker-with-npx)。
- **登录时启动**：macOS 为 launchd `~/Library/LaunchAgents/dev.foundry.worker.plist`，由本机构建的 `Foundry Worker.app` 托管，使屏幕录制等授权显示为 Foundry 且在更新后保留（`mac-worker-app.ts`），另有一个检查心跳文件的 watchdog agent；Linux 为 systemd user `~/.config/systemd/user/foundry-worker.service`。服务名与路径都带开发栈后缀，互不覆盖（`service.ts`）。
- **Server 下发 Worker 构建**（2026-10-09，#110）：Server 以 `FOUNDRY_WORKER_PACKAGES` 指向 `scripts/pack-worker-release.mjs` 打出的目录时，`GET /api/worker/release` 列出自己的包，否则回答 `{"source":"npm"}`；Worker 的 `install` / `update` 跟随自己的 Server。
- **从 Web 更新**：设备页的 Update（或 Update all）调用 `POST /api/devices/{id}/worker/update`，Worker 在自己的服务之外启动独立的更新进程（更新会重启服务），每一步写入状态文件；Server 每 10 秒询问进度，Worker 重启后 2 分钟内没回来、更新进程退出或消失都立即显示原因、最后一步与日志尾部，可重试（2026-10-10，#118；`worker_update.go`、`worker-self-update.ts`、`self-update-status.ts`）。从源码运行的 Worker 没有本机命令，用 git 更新。

### Workspace

- **Workspace 是一台设备上的一个已有目录。** 身份写在目录里的 `.foundry/workspace.json`，与绝对路径绑定：复制到别处的目录会得到新身份（`workspaces.ts` 的 `readWorkspace`）。设备的登记表在状态根的 `workspaces.json`。一个 Workspace 只属于一台设备，另一台在线设备已登记的目录不能被接管。
- **登记**：只有设备所有者能添加（`POST /api/workspaces`，等待设备最多 60 秒），任意已有目录都可以，带目录补全；仓库的子目录也可以，Chat 照常可用，Issue 要求登记仓库根目录（`issue-environments.ts`）。
- **改名**只改显示名（Owner，`PATCH /api/workspaces/{id}`）。
- **移除从不删除文件。** Owner 才能移除；有运行中或排队中的工作时拒绝。Server 删除该 Workspace 拥有的记录（聊天、会话、Issue、成员、飞书路由等，`sqlitestore/workspace_deletions.go`），并按设备记下这次删除：仍上报它的 Worker 会被忽略并被要求忘记它（2026-10-11，#121），再次 Add 清除记录。设备只把它移出登记表、记入 forgotten 列表，目录原样保留。
- **目录被移动或删除**：Worker 上报自己服务的与丢失的目录，不再服务的 Workspace 标为不可用、保留历史并提供 "Add again"，派发到它的会话立即以明确的消息失败（2026-10-10，#118；`workspace_availability.go`）；Locate 把 Workspace 指向新位置，id 不变，聊天、会话、Issue、设置、飞书路由与连接器绑定随之保留（`workspace_relink.go`、`workspace-folders.ts`）。
- **选择规则**（[AGENTS.md](../AGENTS.md) 的 UI 原则）：Workspaces 页（`/locations`，侧边栏的位置入口）按设备分组列出 Workspace，Switch 是唯一改变当前位置的动作；浏览设备从不改变当前位置；设备与 Workspace 只在明确选择成功后一起提交，取消或失败保留原上下文。Devices 页（`/devices/<id>/<section>`：resources、agents、skills、settings、diagnostics）管理机器，链接到该设备在 `/locations/<id>` 的分组（`apps/web/src/app/navigation.ts`）。

### 多设备与跨设备会话

- 一个账号可有多台设备，一台设备可有多个 Workspace。别人只能看到托管了自己可见 Workspace 的设备，看不到它的执行设置（[安全边界 · Accounts](security.md#accounts)）。每台设备的并发上限 `maxConcurrentTasks` 默认 4、范围 1–16（`task-scheduler.ts`）。
- **设备离线时工作等待它**（2026-10-15）：发往离线设备上 Workspace 的新会话与后续消息被接受并排队，设备重连后按排队先后自动开始，超过 24 小时仍离线则以明确原因失败，期间可随时取消（[会话模型 · 设备离线时](session-model.md#设备离线时等待而不是失败2026-10-15)）。Workspace 永远不会被悄悄换到另一台设备。
- **跨设备会话经 Server 中转**（方案 A，2026-09-28）：Agent 在 `create_session` 中指定另一台设备上的 `workspaceId`，Server 按设备路由派发（`session_dispatch.go` 的 `DispatchAgentSession`），设备之间不直连。Agent 的可达范围由 `agentScope`（`access.go`）决定；2026-10-12 起（D1）只能控制它所代表的人创建的会话（[模块化架构 §5.6](architecture-modules.md#跨设备会话已定方案-a2026-09-28)）。官方账号登录留在各自设备上；Server 上的 API 连接密钥加密保存，只在一次运行时下发给目标设备，设备不落盘（[安全边界](security.md)）。在另一台设备上使用资源见 [Resources](resources.md)。

### 设备标签与检测到的事实（2026-10-15）

- **用途**：助理新建项目时按它们选电脑（[Personal Agent §4 放在哪台电脑](personal-agent.md#4-workspace-生命周期由助理驱动)）。哪台电脑在公司网络里、放着谁的文件，Foundry 自己判断不了（[放置调研](research/personal-agent-placement.md) R7），所以由所有者写下，Foundry 能查到的自己补上。
- **标签**：设备所有者在设备页 Settings 的“这台电脑有什么”里编辑，自由的 `key` 或 `key: value`（键为小写字母、数字、`.` `_` `-`，最多 40 个字符；值一行、不含 `:`、最多 60 个字符；每台最多 24 条），保存时转小写、去重。页面给出常用的：`network: corp/home/public`、`toolchain: go/node/xcode`、`files: personal/work`、`gpu`、`always-on`。存在 Server 表 `device_labels`；`PUT /api/devices/{deviceId}/labels`（所有者）、`GET /api/device-placements`（调用者自己的设备）。会话令牌与设备凭证都不能改。
- **检测到的事实**（只读，Server 每次读时由已有的上报算出，不在设备上另做探测）：Worker 上报的系统与架构（`os`、`arch`）；资源清单里就绪的工具链与容器运行时（`toolchain:<id>`）与显卡（`gpu:<厂商>`）；设备持有的连接器的网络检查（如 bytedcli 的 `cloud.bytedance.net:443`）没有失败时的 `reaches:<host>`；Server 记录的每次连接（表 `device_presence`，连接期间每 5 分钟推进，保留两周）算出的最近 7 天在线比例，≥ 90% 且观察满 24 小时记为 `always-on`。
- **系统账号与别人的设备共用的设备**，助理只在本人明确选了它时才在上面放新项目：设置“在哪里做事”里勾了“可以在这里新建项目”（默认只有助理的家，即安家时自己选的那台）或把它设为默认位置；“可以在这台电脑上做事”默认全开，不算选择。合适的电脑不止一台时，不是默认位置的共用设备排在没人共用的之后；放在共用设备上时，结果的 `place.reason` 写明与谁共用，助理要告诉本人（`mcp_personal_agent.go` 的 `assistantCreateDevice`、`sharedAccountNote`）。

### 一台电脑上的几个人（2026-10-15）

一个系统账号默认只属于一个人。在同一个系统账号下，Foundry 无法把两个人的工作分开：文件、Claude/Codex 登录、Worker 的设备凭证都在这个账号里。所以和别人共用一个系统账号是一种明确的信任，被这样标出来，从不说成隔离（为什么不在一个 Worker 内做按人隔离，见[托管执行端调研](research/hosted-environments.md)：业界只在“一人一个系统账号一个 Worker”上支持多人共机）。

- **配对时先说清楚**：要配对的 Worker 的系统账号指纹已属于另一个人的（未移除的）设备时，`POST /api/daemon/pair` 不配对、也不用掉 token，回答 409 `system_account_shared` 和对方的显示名，并在 token 上记下“等待选择”。终端与 Web 的 Add device 对话框都原样告诉这个人：“这台电脑上的这个系统账号已经被 <对方> 在 Foundry 中使用。如果继续，你们将共用它：你们会使用这个账号上相同的文件和相同的 Claude/Codex 登录；这里没有任何东西能把你们的工作分开。想要自己独立的空间，请在这台电脑上另建一个系统账号。”，给出继续 / 取消。终端里回答 `y`、Web 里点继续（`POST /api/devices/pairing-tokens/consent`）或命令带 `--share-system-account` 都算选择继续；Worker 每 3 秒重试一次，Web 选择后自动完成。取消后这个 token 作废。
- **记录与标示**：继续时记下谁、何时选择（表 `device_account_shares`，后配对的设备 → 先在的设备）。两台设备在 Devices 页与设备详情上都对各自所有者显示“与 X 共用一个系统账号”及其含义（`DeviceProjection.sharesSystemAccountWith`，只给设备所有者）；先在的那位所有者看到一次提醒，点“知道了”后消失，标示保留。Foundry 事后才发现的共用（此前配对的设备补报账号指纹后）同样标出，只是没有“谁选择的”。设备被移除后不再算共用。
- **对会话与助理的后果**：Server 把共用者告诉 Worker（`device_sharing`，Worker 声明同名能力），这台设备上的会话在设备说明里读到“这个电脑账号是共用的……不要假设隐私”（`system-account-sharing.ts`）。助理只在本人明确选了这样的设备时才把新项目放上去（见上一节与 [Personal Agent](personal-agent.md)）；“安家”卡片从不默认选中它，人仍可自己选。
- **分享项目**：把 Workspace 分享给别人（成员）时，对话框写明他们在那台电脑上以所有者的系统账号工作，用同样的文件和登录；这与共用系统账号是同一种信任。

**怎么做到“几个人、一台电脑、各自独立”**（推荐）：每个人一个自己的系统账号，各自安装、配对自己的 Worker。

1. 管理员为每个人建系统账号（macOS：系统设置 → 用户与群组；Linux：`sudo adduser <name>`）。
2. 每个人以自己的账号登录（macOS 图形登录或快速切换用户；Linux 直接登录或 `ssh`，不要用 `su`/`sudo -u`，它们没有 systemd 用户会话），在 Web 的 Devices → Add device 复制命令运行。状态根（`~/.foundry`）、`~/.foundry/bin/foundry-worker`、登录服务（Linux `~/.config/systemd/user/foundry-worker.service`；macOS `~/Library/LaunchAgents/dev.foundry.worker.plist` 与 `~/.foundry/Foundry Worker.app`）都在各自的家目录里，互不冲突；Worker 不监听固定端口（转发器与浏览器都用系统分配的端口），临时文件都用唯一名字。
3. 各自登录 Claude Code / Codex。每个账号是一台独立的设备，不会出现共用提示。
4. Linux 上用户服务在该账号退出登录后停止，要常驻需管理员执行 `sudo loginctl enable-linger <name>`（安装时检测到未开启会提示）；macOS 的 LaunchAgent 只在该用户登录（含快速切换后留在后台）时运行。

### 部署形态

- **Docker**：Compose 起 server 与 worker 两个容器，同一宿主目录挂到两边的 `/workspace`；worker 入口依次 `init` → `pair` → 前台 `daemon`，Docker 负责重启；镜像内的 Claude Code 与 Codex 版本固定。其他机器可作为额外 Worker 接入。见[部署指南](../deploy/README.md)。
- **并行开发栈**：`FOUNDRY_STACK=<name>` 把状态放到 `~/.foundry-stacks/<name>`，端口由基数推出（server = base + 982，web = base + 983）；`scripts/dev-stack.mjs` 创建、体检、修复、冒烟与拆除（[并行开发栈](dev-stacks.md)）。`scripts/scratch-stack.sh` 在 live 数据库的副本上起临时 Server，以 `FOUNDRY_INTEGRATIONS=off` 运行，不连飞书、不刷新连接器令牌。

## 实现边界

截至 2026-10-14（`3092162`）。

**已实现**：上面各节描述的行为，代码在 Worker 的 `device-pairing.ts`、`device-removal.ts`、`daemon-connection.ts`、`daemon/control-connection.ts`、`transport.ts`、`service.ts`、`mac-worker-app.ts`、`worker-install.ts`、`worker-self-update.ts`、`workspaces.ts`、`workspace-registration.ts`、`workspace-folders.ts`、`daemon/workspace-roster.ts`，Server 的 `apps/server/internal/httpapi/daemon_*.go`、`device_*.go`、`devices_http.go`、`workspaces_http.go`、`workspace_relink.go`、`workspace_availability.go`、`worker_packages.go`、`worker_update.go`、`session_device_wait.go`（离线设备的工作等待）、`device_placement.go`（标签、检测到的事实与在线比例），Web 的 `apps/web/src/features/workspaces/` 与 `features/devices/`。

**未实现 / 已知缺口**

- 设备凭证是 Bearer 式共享密钥，没有设备密钥对认证（属[身份与共享](accounts-permissions-design.md)的后续阶段）；不在沙箱里的会话能读到它（见[执行内核](execution-kernel.md)的已知缺口）。
- 容器里的 Worker 没装 bubblewrap，只适合 Chat，Issue 被拒绝；它不是经 `install` 安装的，不能从 Web 自更新，升级靠重建镜像。
- `scripts/dev-stack.mjs` 只支持 macOS（launchd）；Linux 上按[开发指南](development.md)手动为每套栈指定端口、数据库与状态根。
- 断线记录只在 Server 内存中。2026-09-28 一次回归中两台设备在同一时段各断开一次，原因未定位；此后已记录断开原因与 Worker 端关闭码（[实机回归 §3](live-regression.md)）。
- 云端 Workspace 未开始（见后续）。

**验证情况**

- 有真实运行记录：2026-09-28 起一台 Mac（macOS 26，arm64）经公网配对到 dev 服务器；设备可见性（C11）、附件经设备通道存取（C16）、跨 Workspace 编排（C18）与按资源选设备的跨设备会话（C25）最近一次通过是 2026-09-29（[实机回归](live-regression.md)）。2026-10-04 Mac 上以 0.5.2 安装运行并完成一个真实 Issue。干净环境安装以 0.5.1 复现（README 记录）。
- 只有代码与测试：Server 下发构建与 Web 更新（#110、#118）、删除后保持删除（#121）、目录移动后的不可用与 Locate、背压 outbox（#120）在仓库文档中没有带日期的实机记录；相关测试如 `packages/worker/test/worker-install.test.mjs`、`worker-self-update-status.test.mjs`、`workspace-folders.test.mjs`、`daemon-startup.test.mjs`、`device-removal.test.mjs` 与 `apps/server/internal/httpapi/workspace_deletions_test.go`。
- Docker 部署于 2026-09-23 按提交与源码记入当前状态，没有带日期的实机部署记录。

## 后续

状态、依赖与完成标准见 [Roadmap · 设备与 Workspace](roadmap.md#设备与-workspace)；本节只保留设计要点。设备密钥对认证随[身份与共享](accounts-permissions-design.md)推进，容器隔离随[执行内核](execution-kernel.md)推进。

<a id="cloud-workspace"></a>

### 探索：云端 Workspace

**目标**：托管 Workspace 本身的项目文件、内容与持久状态，让不同执行端按权限访问同一个逻辑文件系统，并以其中已接受的状态作为项目基线。

**要做的事**：定义 Workspace 身份、文件与目录访问、候选版本、接受写入和恢复的契约，验证本地或远程 Daemon 如何获取对应状态并执行读写、构建和测试。远程访问、缓存或同步必须关联正确的候选，多个任务仍经隔离、验证与 Accept 更新 Workspace。"同一个文件系统"指同一个逻辑 Workspace 和权威状态，采用挂载、文件接口还是候选快照仍待验证。范围只是 Workspace 的存储与访问；托管 Agent、供应执行机器或代管 Provider 运行环境不属于本项，也不是它的前置。

**完成标准**：更换或断开执行端不会丢失已接受的项目状态；授权执行端可取得正确版本并提交候选变更；并发与恢复不会让旧副本覆盖新的权威状态；本地和远程访问遵守相同的候选、验证与接受语义。依赖 Workspace 身份、文件与版本边界、权限及恢复契约；不预先绑定某种分布式文件系统。现在的设计（Workspace 绑定一台设备、身份与绝对路径绑定）是它要放宽的前提。

## 代码位置

- 标签与检测到的事实：`apps/server/internal/httpapi/device_placement.go`、`sqlitestore/device_placement.go`（`device_labels`、`device_presence`）、`personalagent/placement.go`（匹配与选择）；`packages/protocol/src/device-placement.ts`；`apps/web/src/features/devices/device-labels.tsx`
- 配对与设备身份：`packages/worker/src/device-pairing.ts`、`device-removal.ts`；`apps/server/internal/httpapi/device_auth.go`、`device_removal.go`
- 共用系统账号：`packages/worker/src/device-pairing.ts`（指纹）、`pairing-consent.ts`、`system-account-sharing.ts`；`apps/server/internal/httpapi/device_sharing.go`、`sqlitestore/device_sharing.go`（`device_account_shares`、`device_identities` 的指纹列、token 的 `consent`）；`packages/protocol/src/device-sharing.ts`；`apps/web/src/features/devices/pairing-progress.tsx`、`device-account-share.tsx`
- 连接：`packages/worker/src/daemon-connection.ts`、`daemon/control-connection.ts`、`transport.ts`；`apps/server/internal/httpapi/daemon_hub.go`、`daemon_conn.go`、`registration_sections.go`、`daemon_rpc.go`、`daemon_reply_chunks.go`、`daemon_outbox.go`；消息名 `packages/protocol/src/daemon-messages.ts`；符号级流程见 [Daemon 生命周期](daemon-lifecycle.md)
- 安装与更新：`packages/worker/src/worker-install.ts`、`service.ts`、`mac-worker-app.ts`、`worker-self-update.ts`、`self-update-status.ts`；`apps/server/internal/httpapi/worker_packages.go`、`worker_update.go`；`scripts/pack-worker-release.mjs`
- Workspace：`packages/worker/src/workspaces.ts`、`workspace-registration.ts`、`workspace-folders.ts`、`daemon/workspace-roster.ts`、`daemon/handlers/workspaces.ts`；`apps/server/internal/httpapi/workspaces_http.go`、`workspace_relink.go`、`workspace_availability.go`；`apps/server/internal/sqlitestore/workspace_deletions.go`
- Web：`apps/web/src/features/workspaces/`、`apps/web/src/features/devices/`、`apps/web/src/app/navigation.ts`
- 部署与开发栈：`deploy/`、`scripts/dev-stack.mjs`、`scripts/scratch-stack.sh`；数据放在哪里见[存储策略](storage-strategy.md)
