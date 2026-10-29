# DEV-088 · 设备就绪：缺少的 Claude Code / Codex 在人操作的地方发现并安装

状态：代码完成，Agent 自验通过（scratch 栈端到端）；dev Web `5cfedf8c1085c147` 已上线；Worker 已随 DEV-084 发布的 `0.5.7-dev.139.g408e64d.local.1793273568` 发出，dev 服务器设备的 daemon 已加载；真实新设备当前离线，待其上线后安装；人工验收待确认。

## 问题

用户新加的一台 2 vCPU / 2 GiB 的 Debian 13 设备上既没有 Claude Code 也没有 Codex。给它分配了模型提供方（服务器 API 端点）后直接不可用，界面上也没有说为什么。用户的期望：Foundry 应该检查缺少的依赖，自动安装或升级，或者至少给一个按钮。

## 调查（代码现状）

- 安装能力其实已经有了：`POST /api/devices/{id}/accounts/{runtime}/install` → Worker `install_native_cli`。缺程序时跑官方 curl 安装脚本，有程序时做一次更新。但入口只在设备页 → 账号这一处，而且要 ConfirmButton 点两下；HTTP 请求要等安装结束（最长 11 分钟），没有进度，结果只显示在发起请求的那个标签页。
- Worker 对缺失的程序只上报 `cli: {installed: false}`，不带 `update`；定时更新器会写一条 `external`/"automatic updates do not install new agents"，但缺失时这条又不可见，状态前后不一致。
- **Codex 缺失时被报成 `missing_auth`（"Codex is not signed in"），不是 `unavailable`**。Server 的 `serverProfileStatus` 只在 `unavailable` 时拦自定义 API 提供方，结果 Codex 的模型提供方在没装 Codex 的设备上显示"可用"，一发消息就失败。这是用户感受到的"分配了却不能用"的直接原因之一（Claude 缺失时会显示不可用，但没有任何地方引导安装）。
- 模型提供方页的设备行、设备页的"分配模型提供方"对话框、聊天里的模型选择器、设备列表，都不显示设备上有没有对应的运行时。

## 方案与实现

一套按设备计算的就绪模型，只用 Worker 已上报的数据（设备在线、各运行时 `cli` 与 `update`、已分配的模型提供方、`system.memoryBytes`），外加本页发起的安装。每个状态最多一个动作：

| 状态                                                   | 动作                         |
| ------------------------------------------------------ | ---------------------------- |
| 未上报（离线、Worker 太旧）                            | 无                           |
| 未安装                                                 | 安装                         |
| 安装中（显示已用时间）                                 | 无                           |
| 安装失败（原因与安装输出）                             | 重新安装                     |
| Foundry 管理、低于最低版本                             | 立即更新（本来也会自动更新） |
| 用户自己装的版本有更新、Foundry 无法更新               | 改用 Foundry 管理的版本      |
| 就绪（会注明是否登录了官方账号；用模型提供方时不需要） | 无                           |

内存低于约 4 GB（Claude Code 建议值）时提示，但不阻止安装。

**Worker**

- `native-cli-install.ts`：缺少的运行时默认装成 Foundry 管理的副本，走更新器同样的路径（官方 npm 包装到 `agent-runtimes/<id>/<version>`，原生元数据握手校验后再激活描述文件），所以以后自动更新。设备上没有 npm 时退回官方用户级安装脚本。
- 安装开始时把运行时的更新状态写成 `updating`（"Installing … (Foundry-managed copy)…"）并上报设备，结束后再上报一次。失败时写 `failed`，带一句可读原因：取 npm 第一行真正的错误，去掉 key/value 行、调用栈和日志路径。这条失败状态保留到下次尝试。所有页面、所有标签页都通过现有事件流看到进度，发起请求的页面离开了也不影响。
- 同一运行时的两个安装请求合并成一次。用户自己装的副本（Homebrew、/usr/bin、应用自带）在用户明确点击后，在旁边装一份 Foundry 管理的；正在使用的副本要等会话空闲才切换。`FOUNDRY_*_BIN` 固定了路径时拒绝，并说明原因。
- `native-cli.ts`：运行时缺失时，只上报本人发起的安装的 `updating`/`failed`，不再出现更新器自己写的旁注。
- `provider-health.ts`：程序缺失一律报 `unavailable`（"Codex is not installed on this device."），Codex 也一样。
- 没有改 Server，也没有改协议：复用 `cli.update` 的 state/detail 字段。

**Web**

- `lib/device-readiness.ts`：纯函数的就绪模型。`lib/runtime-installs.ts`：本页发起的安装（所有界面共用同一次运行，答复比上报先到时以答复为准）。
- `components/ui/setup-checklist.tsx`：通用的状态清单原语，图标加文字，不只靠颜色。它和 DEV-086 的外部连接设置面板约定共用一个组件。
- `components/devices/runtime-readiness.tsx`：就绪清单、单个动作按钮、"全部安装"、分配行里的运行时说明。
- 生效的界面：
  - 设备页 → 账号：一键"安装"，单击即装，不再需要确认；同一运行时只出现一次。安装中显示进度，失败显示原因、输出和"重新安装"。两个都缺时有"全部安装"；内存不足时提示；用户自己装的副本显示"改用 Foundry 管理的版本"。
  - 添加设备对话框：配对成功后显示新设备的就绪清单，"全部安装"为主按钮，不点不装。
  - 模型提供方页 → 设备访问：设备行内说明运行时状态。缺运行时的在线设备，按钮变成"分配并安装 Claude Code"，保存后立即安装，进度显示在该行；离线时说明上线后再装，共享设备提示找所有者安装。
  - 设备页 → 分配模型提供方对话框：同样的行内说明，保存后安装新分配项所需的运行时。
  - 聊天模型选择器：用 DEV-086 的 `SelectMenu actions`，显示"在 <设备> 上安装 Codex"，单击安装，安装中显示进度，失败显示"重新安装"。只给设备所有者显示。
  - 设备列表：显示"需要设置"或"正在安装…"标记。

## 自验

- Worker 单测 `runtime-install-missing.test.mjs`（新，6 项）：
  - 缺失运行时装成托管副本，进度依次上报 `updating`、`current`；
  - 失败时状态和原因保留；
  - 并发的两个请求合并成一次；
  - 固定路径时拒绝；
  - npm 失败原因只取一句；
  - Codex 缺失报 `unavailable`。
    `native-cli`、`agent-runtime-install/update`、`provider-check-state` 均通过。
- Worker 全量：1036 项，1024 通过、2 失败、10 跳过；第三个失败（超时）也在同一次运行里出现。三个失败都不在本项文件里：
  - `daemon-dispatch` 是 DEV-086 新增的消息类型还没加进期望列表；
  - `browser-tool-environment` 的代理断言涉及 session-ambient / server-proxy，非本项；
  - `evidence-api-e2e` 在负载 15–25 时超时，单独重跑通过。
- Web 单测 `device-readiness.test.mjs`（新，8 项）、`device-cli-install.test.mjs`（改为单击安装：先显示进度，完成后显示托管版本；离线时不给安装按钮）通过。`tsc --noEmit` 通过，`scripts/audit-*.mjs` 全部通过。
- 真实浏览器，scratch 栈：服务器用 dev 库副本、关闭集成；配对的 Worker 用临时 HOME，`PATH=/usr/bin:/bin`，没有 claude/codex。
  - 设备列表显示"需要设置"。
  - 失败路径：Worker 的 npm 出口指向死代理。设备页用键盘（聚焦后回车）安装 Codex，先显示"Installing on …… 1s"，随后显示"Could not install it on …"，原因是 `FetchError: request to https://registry.npmjs.org/@openai%2fcodex failed, reason: connect ECONNREFUSED …`，按钮变成"重新安装"。重载后失败状态仍在。
  - 成功路径：恢复出口。在模型提供方页新建一个 Claude 网关，设备行显示"Claude Code isn’t installed on …; assigning installs it."，按钮为"分配并安装 Claude Code"。用键盘回车后，行内显示"Claude Code: Installing on …… 4s"，约 2 分钟后托管的 Claude Code 2.1.308 激活，`agent-updates/claude.json` 为 `current`。
  - 聊天选择器：在该设备的工作区新建对话，选择器里有"Retry installing Codex on …"行，带失败原因。回车后变成"Installing Codex on …… 5s"（转圈、行不可点）。完成后 Codex 0.165.0 托管副本就绪，Codex 选项可选。End 键能把焦点移到动作行。
  - 添加设备：从对话框取配对令牌，在第二个空设备上配对。对话框里依次出现"Device paired"、就绪清单（Worker 已连接，Claude Code、Codex 未安装）和"全部安装"。
  - 浅色/深色、1280/420 宽度截图已检查。截图含主机名、账户名，留在本机，不入库。
- 限制：
  - 420 宽度下聊天页只显示对话列表，选择器的窄屏外观没有单独截到（SelectMenu 本身已有窄屏规则）；
  - "改用 Foundry 管理的版本"只有单测和代码路径覆盖，没有在真实外部安装上点过；
  - 添加设备对话框里那段介绍的字号修正，以及选择器说明文案的最后一次修改，在 scratch 构建之后才做，要在 dev 部署后复看。

## 验收步骤（给用户）

1. 新设备上线后，打开 设备：该设备行显示"需要设置"。点进去 → 账号：Claude Code、Codex 都是"未安装"，有"全部安装"；2 GiB 内存会有提示。
2. 点"全部安装"（或单个"安装"）：行内显示"正在 <设备> 上安装… 用时"，1–3 分钟后变为"<版本>，由 Foundry 管理，自动更新"。失败时显示一句原因和"重新安装"。
3. 模型提供方 → 打开一个 Claude 或 Codex 提供方 → 设备访问：缺运行时的设备行写着"分配时会一并安装"，按钮是"分配并安装 …"。点了之后安装进度出现在这一行。
4. 在该设备的工作区新建对话：如果运行时还没装，模型选择器底部有"在 <设备> 上安装 …"，点它就装；装好后对应的提供方可选。

## 流水

| 时间（UTC+8）          | 变化与证据                                                                                                                                                                                                                                                                                                                                                                                                                         | 剩余动作                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 2026-10-29 17:55       | 调查完成；设计说明发给编排会话；与 DEV-086 约定共用 SetupChecklist，`SelectMenu actions` 由 DEV-086 负责                                                                                                                                                                                                                                                                                                                           | 实现                                                                    |
| 2026-10-29 18:30–19:00 | Worker、Web 实现完成；scratch 栈端到端：失败路径、托管 Claude Code 2.1.308 安装、聊天选择器装 Codex 0.165.0                                                                                                                                                                                                                                                                                                                        | 修 Codex 缺失状态、失败原因                                             |
| 2026-10-29 19:00–19:45 | Codex 缺失改报 unavailable；npm 失败原因只取一句；feedback 审计修正；添加设备配对后的清单端到端                                                                                                                                                                                                                                                                                                                                    | dev 部署、Worker 发布、真实设备                                         |
| 2026-10-29 20:00       | dev Web `5cfedf8c1085c147`（DEV-082 从共享树统一构建，含本项全部 Web 改动）上线。用 e2e-alice 只读复看设备列表、设备账号页、模型提供方页，浅色和深色均无页面错误；在线的合成设备两个运行时都已安装，不显示"需要设置"，符合预期。`check-changed`：prettier、web tests（85 个文件）、worker build/tests（20 个文件）、audit:ui、audit:modules 全部通过；其中 tsc 失败只因 DEV-086 文件里一个未使用的 import，之后单独重跑 tsc 已通过 | 新设备当前离线；上线后先更新 Worker，再用"全部安装"装上两个运行时并复验 |
| 2026-10-29 20:20       | 核对 DEV-084 发布的 Worker `.1793273568`：安装包里有托管安装、npm 失败原因提取、Codex 缺失报 unavailable；dev 服务器设备的 daemon 和执行宿主都在运行该版本                                                                                                                                                                                                                                                                         | 同上                                                                    |

## 第二轮：设备掉线的隐藏规则（2026-10-29 晚）

**起因：** 那台 2 GiB 的新设备两次掉线（UTC 09:37、10:01，设备一侧 "close 1006 unexpected EOF"），之后再没回来，用户不知道原因，也不知道怎么让它回来。可能的原因有两个，都是现在看不到的规则：

- systemd 用户服务在账户退出登录时会被停掉，除非开启了 linger。安装时只提示过一次。
- 2 GiB 内存被 OOM 杀掉。

**Worker**（新文件 `service-health.ts`，每次上报设备时附带，都不需要 sudo）：

- `system.service`：
  - 服务管理器（systemd / launchd / none）和实际安装的 unit 名（会带 stack 后缀）；
  - `loginctl` 读出的 Linger；
  - 日志目录，写成 `~/…` 形式；
  - 近 7 天自己进程被 OOM 停掉的次数和最近一次时间。来源优先用户 journal 里 systemd 写的 "killed by the OOM killer"，读不到时用本 unit cgroup 的 `memory.events` 里的 oom_kill。首次读取同步进行（最多 3 秒），保证连接时的那次上报带上结果；之后在后台刷新。
- `system.swapBytes`：从 /proc/meminfo 读取。

**Server**（只加字段，需要部署）：

- Go `DeviceSystem` 增加上述字段。
- `ListDevices` 从行的 `updated_at` 投影出 `lastSeenAt`，离线设备就是它掉线的时间；断线原因本来只存在内存里，Server 重启后就没了，有了这个字段重启后也能显示。

**Web：**

- 设备页离线时：
  - 显示"Offline since 时间（多久前）"，以及一句话原因：
    - 1006/EOF：设备意外断开（Worker 停了、关机、休眠或断网）；
    - 静默超时：网络；
    - 服务器主动断开。
  - 给所有者一个"Bring it back"区块，每条命令都能复制。Linux 依次是：查看状态、linger 修复（Linger 未开或未知时）、重启、读日志（journalctl 和 daemon.err.log）、内存小时查 OOM。macOS 用 launchctl print/kickstart 和日志。
  - 命令里用设备上报的 unit 名；旧 Worker 没上报时用默认名，并注明是默认名。
  - 共享设备只提示找所有者。
- 设备列表行显示"offline since 时间"。
- 设备在线时的提醒：
  - Linger 关闭时，提示"Stops when <用户> logs out"，附一行修复命令。这种情况也算"需要设置"，就绪清单里增加"Keeps running after you log out"一项。
  - 有 OOM 记录时，提示次数和最近一次时间。
  - 内存低于约 4 GB 且没有交换空间时，给出添加 2 GB 交换空间的三条命令；这时账号页不再重复内存提示。
- 抽出 `features/devices/device-readiness-views.tsx`，让 devices-feature 不超过 350 行。

**自验：**

- Worker：`service-health.test.mjs`（4 项：linger 解析、journal OOM 计数、cgroup/meminfo 解析、unit 名）通过，相关回归通过。
- Web：`device-recovery.test.mjs`（5 项：断线原因分类、离线时间来源、linger 计入就绪、计划里用上报的 unit 和日志目录、旧 Worker 用默认名并标注、macOS 命令）通过。`tsc` 和全部 UI 审计通过；`audit-contract` 通过（308 个接口与 Go 结构一致）。
- Go：sqlitestore 与 httpapi 的 Device/Daemon 测试通过。
- 真实浏览器，scratch 栈用本树的 Server、Web、Worker：
  - Worker 的 PATH 里放了假的 `loginctl`（输出 no）和 `journalctl`（输出两条 OOM 记录）。设备页显示"Stops when … logs out"，附 `sudo loginctl enable-linger <用户>`，用键盘复制后按钮变成"Copied"；还显示"Stopped for lack of memory… 2 times"。
  - 给设备加一个工作区后 `kill -9` 掉 Worker：设备页显示"Offline since …（this minute）"和"The device closed the connection unexpectedly…"；"Bring it back"的四步命令都用了上报的 unit 名（带 stack 后缀）。设备列表显示"offline since …"。
  - 浅色 1280、深色 420 宽度都检查过。
- 限制与发现：
  - 小内存加无交换空间的提示只有单测覆盖，本机有 16 GB swap，没法在浏览器里复现；
  - 发现一个已有的 Server 问题：没有工作区的设备掉线时不会被标记为离线，一直显示在线；新配对、还没加工作区的设备会先遇到。已修复，见下一条。

**部署：**

- Web 已随 DEV-086 从共享树的统一构建上线：dev Web `bf2b4e5fdd4d43e0`。用 e2e-alice 只读打开一台离线的合成设备：显示"Offline"，原因是"未记录"（因为当前 Server 还没有 lastSeenAt，断线又早于这次 Server 启动）；"Bring it back"的命令用的是默认 unit 名并作了标注；页面没有报错。
- Server 字段（`lastSeenAt`、`system.service` / `swapBytes`）要等北京时间 22:05 之后的那次 Server 部署。在那之前，离线时间只在本次 Server 运行期间记录过断线时才有，unit 名显示为默认名。
- Worker 部分进今晚的发布。

**补修（2026-10-29 晚，编排会话要求）：没有工作区的设备掉线后一直显示在线**

- 根因：`DaemonHub.unregister` 只对连接记下的工作区注册标记离线。没有工作区的设备只做过一次"仅设备"注册，所以掉线时什么也不写，设备行停在 connected。
- 修复：`apps/server/internal/httpapi/daemon_hub.go`，只做加法。没有工作区注册时，用连接上的仅设备注册，像工作区那条路径一样标记离线，并照常通知设备列表变化。
- 测试：新文件 `apps/server/internal/httpapi/device_offline_test.go`。
  - 一台只有设备、没有工作区的 Worker 发 hello 后断开，3 秒内变成 disconnected；`lastSeenAt` 有值，上报的服务状态（linger 关闭）保留。
  - 去掉修复后这个测试失败，恢复后通过。
  - httpapi 的 Device/Daemon/Hub/Workspace/Hello/Registration/Disconnect 测试全部通过；gofmt 无改动。
- 部署：已留在共享工作树，随今晚北京时间 22:05 的 Server 交接上线，现在不重启。
