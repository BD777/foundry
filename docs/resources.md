# Resources

[Roadmap](roadmap.md) · [文档索引](README.md)

Resources 负责设备上**已有**、会话可以使用的能力：发现、登记、列出，按会话租用、操作、释放与回收，并经 Server 让一台设备上的会话使用另一台设备上的资源。它不负责执行容量（执行内核）、Agent 原生工具本身（Shell、文件读写由 Claude Code / Codex 提供）、证据判定（[Evidence & Verify](evidence-and-verify-v1.md)）、外部账号（连接器），也不替设备安装软件：Foundry 不自带、不下载资源，cua-driver 只在设备所有者点击后用其官方安装器安装。在分层图中属于“能力供给”层：依赖“设备与 Workspace”（Worker 连接、设备在线状态）和“身份与共享”（设备归属、按调用方过滤可见范围）；被“Agent 能力面”的 Foundry MCP 工具和工作流中的 Chats 使用（Issue 内的会话目前不能租用）。

## 设计

### 概念：Type × Instance × Lease

- **Type**：资源能做什么。协议的 `resourceTypeIds` 列出 10 种：`browser`、`computer_use`、`simulator`、`mobile_device`、`gpu`、`container_runtime`、`toolchain`、`account`、`disk`、`compute`。Server 的类型表 `typeSpecs` 决定哪些可租用、有哪些操作、租约计时；不在表中的类型只列出、不租用。
- **Instance**：一台设备上一个具体对象，例如“这台 Mac 的桌面”。稳定 id 由来源 + detector key 哈希得到（`res_…`），重扫、重连、Server 重启都不变。状态为 available / busy / unready / offline / gone，另有 `stale`（detector 本次失败，值是上次的）。一个 Instance 可有多个 backend，`mode` 区分 `listed`（只列出）、`native_session`（设备上的会话自己用）、`remote_ops`（任何持有租约的会话经 Foundry 远程操作）。同一块屏幕的两种 backend 属于同一个 Instance，共用一个租约。
- **Lease**：一个会话对一个 Instance 的独占，带 fencing generation。

### 关键决定

- **2026-09-28 只用设备已有资源。** 放弃“Worker 为会话挂一个自带 Chromium 的 Playwright MCP”的提案：设备上本来就有浏览器，挡住会话使用的是 Foundry 自己的默认权限与配置隔离。浏览器按会话本地租用：Worker 在会话的临时目录里生成启动器，启动器把进程号记入租约文件后 `exec` 成真正的浏览器；输入结束时 Worker 关闭租约中仍在运行的浏览器（核对可执行文件防进程号复用），绕过启动器的按会话环境变量或临时目录识别并上溯到顶层进程关闭。会话临时目录跟随会话而非 Worker 进程，闲置超过 `FOUNDRY_SESSION_SCRATCH_IDLE_MS`（默认 3 天）后清理。
- **2026-10-13 清单与对账分开。** Worker 按类型 × OS 注册 detector：被动（不弹窗、不碰屏幕、不联网、不读密钥值）、限时、失败互相隔离；变化时经 `resources_report` 上报完整快照。Server 按设备对账：消失的标 gone（保留 30 天），detector 失败的保留上次值并标 stale，设备断开时标 offline。
- **2026-10-13 租约跟持有会话的 turn 走，不按资源空闲计时。** Agent 看一眼屏幕后可能长时间思考或跑别的工具，“资源被碰过”不能近似“持有者还活着”；而 Server 本来就知道会话的输入状态。规则在 `leases.go`（默认计时）与 `lease_turns.go`（turn 判定）：
  - turn 进行中租约 active，不过期。turn 指会话的输入处于 queued / running / blocked，或 Agent 自己在跑一轮会话状态看不到的模型 turn：定时器触发的一轮，或后台工作结束后 Claude 的续写。后者由 Worker 用 `session_turn`（`{sessionId, running}`，只发给声明了 `session_turns` 的 Server）报告，Server 记在内存里，设备断开时丢弃、重连后 Worker 重报。turn 正常结束后 parked，保留 10 分钟（`holdFor` 可延长，最多 2 小时），期间有人申请且未声明 hold 时立即交出；turn 失败或取消则释放。
  - 有会话排队时进入 contended：持有方在每个 Foundry 工具结果里收到提示，抢占前 1 分钟最后警告，排队开始 15 分钟后（进行中的操作结束后）抢占；设备所有者可把一次即将发生的抢占推迟（`extend`）。
  - 每次授予都提升 Instance 的 generation，Server 和宿主 Worker 都拒绝旧 generation 的操作；租约结束再提升一次并要求宿主重置（computer_use 关闭 backend 会话；compute 停止它启动的命令，scratch 目录保留），宿主确认后才交给下一个会话，30 秒未确认则 Instance 标为未就绪。
  - 不允许“持有并等待”：持有租约的会话不能再排队等别的；多个 Instance 一次全拿或全不拿（最多 8 个）。排队先到先得，单次最多等 10 分钟。
  - 持有方设备断开 2 分钟后 active 转 parked；宿主设备离线超过 2 分钟，其上的租约被收回。租约、排队和计时都在存储里，Server 重启后保留，重启期间到期的计时顺延 2 分钟。
- **2026-10-13 第一个远程 computer-use 后端用 cua-driver**（MIT，标准 stdio MCP）。Worker 作为 MCP 客户端驱动它，每个租约一个进程；macOS 授权属于 CuaDriver.app，不属于 Worker。Codex 自带的 computer use 不桥接给其他会话；需要把整段 GUI 任务交给那台设备时，在它的工作区开会话（`create_session`）。
- **2026-10-13 compute 作为可租用资源**：每台设备一个 `compute` 实例（CPU、内存、OS/架构、负载），持有方可在该设备上以 Worker 用户身份运行命令，工作目录限于 Worker 状态根下的 `compute/<scratch>/` 或会话可工作的、位于该设备上的工作区。“Allow remote commands from my sessions”2026-10-13（#126）改为默认开：设备所有者自己的会话本就能在其设备上运行任意命令，默认关只增加摩擦；显式关闭保持关闭，Worker 本地也执行这项设置。
- **审计不存输出。** 每次操作记录参数摘要：输入文字只记长度，命令行完整记录（有长度上限），环境变量只记名字；截图不保存。结束的租约和审计保留 30 天。

### Tool Use 与证据契约

Tool Use 指 Agent 操作工具并采集真实材料；资源调度管多个会话如何分配和复用工具背后的环境。下列契约仍是设计要求，资源层目前只满足其中的操作与占用部分：

- 工具接入与最小 Evidence 契约一起设计：从 Issue、完成条件与候选身份出发，保留实际调用、参数、来源、环境/构建、结果或错误及材料引用，再由 Verify 判断。不做只有展示、无法关联候选的工具记录。
- 先选一种可复现的真实工具链；目标承诺 Web 交互验证时，同一条链就要有浏览器操作和截图。Computer Use、模拟器按具体交付场景接入，不因类型列在清单里就一次完成所有适配。
- 首次接入交互工具就要有对应环境的身份、授权、必要隔离、占用保护与清理。成功、失败和超时都保留结果并对应到正确的 Issue、候选与环境；工具原始输出保持事实，Agent 的解释单独呈现。

### 共享资源调度

资源身份包含所属设备、实际实例与持有者。超时或租约过期不能证明旧 Agent 已停止操作，所以回收后重新分配前要确认旧占用失效（fencing）、环境已重置。先做简单队列与明确独占；跨 Workspace 公平性、配额和复杂多资源协同按实际瓶颈扩展。单纯资源排队不进入等待人介入的 Blocked。资源形态差别大（浏览器可以放进容器，Computer Use 往往需要一台具体的机器），因此只统一“申请 → 使用 → 释放 → 清理”这条生命周期，各类资源怎么提供、怎么隔离由各自的 provider 决定。

## 实现边界

截至 2026-10-14（`3092162` 加未提交的工作区改动：租约跟随 Agent 自己的 turn、会话浏览器选择说明）。

**已实现**

- 清单：Worker 的 detector 注册表 `packages/worker/src/resources/detectors/index.ts` 注册 13 个 detector，覆盖上述 10 种类型（浏览器与 Android 模拟器三平台，iOS 模拟器仅 macOS；Android 设备只在 adb server 已运行时探测，不主动启动它）。Server 对账在 `apps/server/internal/resources/resources.go`。
- 租约跟随 Agent 自己的每一轮模型 turn（未提交，2026-10-14）：Worker `session-state.ts` `reportClaudeOwnTurn`（只有 Claude 发送），Server `daemon_session_inbound.go` `onSessionTurn` → `Leases.AgentTurn`（`lease_turns.go`）。这样的 turn 中输入完成不 park 租约，turn 结束才 park 或交给排队者；失败或取消仍释放。
- 会话说明里的浏览器选择（未提交，2026-10-14，`resource-pool.ts` `browserChoiceNote`）：无头任务优先用不会自更新的 Playwright / Chrome for Testing 构建；日常浏览器启动时可能自更新，被 macOS 的 App Management 拦截；新的 `--user-data-dir` 没有本人的登录态，需要时经屏幕控制用本人正在运行的浏览器，或问本人。
- 列出：`GET /api/resources`（按调用方过滤）、MCP `list_resources`（`instances` 带持有者、排队数与可执行的操作；旧的 per-device `resources` 仍保留）、全局 Resources 页（Manage 区，按设备分组，变化经 `resources_changed` 推送）、设备页的资源摘要，链接到筛选后的 Resources 页。
- 可租用类型只有 `computer_use`（需要 ready 的 `remote_ops` backend，目前即 cua-driver，仅 macOS）和 `compute`（`apps/server/internal/resources/types.go`）。浏览器不经 Server 租约，只在会话本地按启动器租用和回收（`packages/worker/src/resource-pool.ts`，Windows 上不生成启动器）。
- MCP 工具：`acquire_resource`、`operate_resource`（computer_use 18 个操作，一一对应 cua-driver v0.34.1 的工具，截图以 MCP image 返回；compute 为 `run` / `put_files` / `get_file` / `git_sync` / `cleanup`）、`release_resource`、`resource_status`；限额写在 `apps/server/internal/httpapi/mcp_tools.json` 各工具的 `limits`。
- 访问边界：只能租用会话所代表的人自己拥有的设备上的资源；Issue 内的会话被拒绝（`mcp_resources.go` `resourceHolder`）。
- 设备所有者的操作：释放任一租约、推迟即将发生的抢占（`extend`）、查看审计、“Stop all”、安装 cua-driver 并按项引导 macOS 授权、按设备关闭远程命令（`routes.go` 中 `/api/resources/*` 与 `/api/devices/{deviceId}/resources/*`）。授予与结束租约时，宿主 Mac 显示系统通知。
- 跨设备使用：Agent 用 `list_resources` 找到有所需资源的设备，在其工作区开子会话（C25），或直接租用并远程操作该设备的屏幕或 compute。`scripts/remote-check.sh <device>` 用 compute 把当前改动放到另一台设备上跑 `check-changed.sh`。

**未实现 / 已知缺口**

- `simulator`、`mobile_device`、`gpu`、`container_runtime`、`toolchain`、`account`、`disk` 只列出，不能租用或操作；浏览器没有远程操作 backend，带登录态的浏览器资料、预览端口不在租约内。
- 操作结果不进入 Evidence：审计不存输出、截图不保存，没有与 Issue / 候选 / 构建关联的材料；Issue 内的会话不能租用资源，Evidence 判定会话仍关闭浏览器与 Computer 能力。上面的证据契约尚未落地。
- 只支持 macOS 屏幕控制；Windows、Linux 桌面没有 computer_use backend。
- 会话本地的浏览器启动器与 Worker 自身的 macOS 屏幕控制（`native_session`）仍走旧的 `DeviceResource` 路径（随注册上报，写进会话说明），尚未迁到清单上。
- 聊天页不显示会话持有的租约，只在 Resources 页可见。
- 跨设备验证（构建与验证分在两台设备、证据可追溯到候选与验证环境）不存在。

**验证情况**

- 有真实运行记录：浏览器清单、会话浏览器回收和“按资源选设备”（[实机回归](live-regression.md) C23–C25，2026-09-28，dev 与真实 Mac）；Linux 上的 Claude 经 Foundry 租用 MacBook 屏幕、读取显示器与窗口、截图后释放（2026-10-13，#125）；dev 上各设备的 compute 实例变为可用、Mac mini 重启 cua-driver daemon 后授权与截屏通过、两台 Mac 的 computer_use 就绪（2026-10-13，#126）。
- 只有单元 / 接口测试：排队、park / hold、抢占与警告、fencing 与重置确认、设备断线、Server 重启恢复（`apps/server/internal/resources/leases_test.go`、`apps/server/internal/httpapi/resource_leases_test.go`、`compute_resources_test.go`），以及 compute 各操作。没有两个会话真实争用同一资源的运行记录。
- 租约跟随 Agent 自己的 turn：已实现，在测试中验证（`leases_test.go` `TestAgentTurnKeepsLeasesActive`、`TestAgentTurnParksWhenItEnds`，`resource_leases_test.go` `TestAgentTurnKeepsLeaseActive` 经假设备端到端），尚未实机验证；`reportClaudeOwnTurn` 与浏览器选择说明没有测试。

## 后续

状态、依赖与完成标准见 [Roadmap · Resources](roadmap.md#resources)（RES-1–RES-3）；本节只保留设计要点。

- 模拟器、真机接入同一生命周期（申请 → 使用 → 释放 → 清理）：在类型表中加 spec、在 Worker 加 provider（`packages/worker/src/resources/provider.ts` 头部写明扩展方式），沿用 fencing 与重置确认。
- 资源操作接上证据契约：选定场景的操作结果能对应到 Issue、候选与环境，供 Evidence / Verify 引用。
- **多台机器共享执行与验证资源，支持异地验证（Build here, verify there）。** 在一台机器构建，在另一台具备所需环境的机器验证。compute 租约与 `remote-check.sh` 已能把改动放到另一台设备上运行检查；可信的异地验证还缺跨设备的构建或材料传输、环境身份与版本关联、断线恢复。完成标准：证据可追溯到正确的候选、构建和验证环境，旧构建或错误环境不会被当作有效成功；断线不造成重复占用或未经授权的操作。先选一个真实场景验证，不一次抽象所有设备。

## 代码位置

- 协议类型：`packages/protocol/src/resources.ts`（类型 id、操作名、backend mode）。
- Server 清单与租约：`apps/server/internal/resources/`（`resources.go` 对账，`types.go` 类型表，`leases.go` 规则与默认计时，`lease_*.go` 申请 / 释放 / turn / 设备 / 操作）。
- Server 接口：`apps/server/internal/httpapi/resources.go`、`resource_leases.go`、`mcp_resources.go`，工具说明 `mcp_tools.json`，路由 `routes.go`。
- 存储：`apps/server/internal/store/resources.go`，`apps/server/internal/sqlitestore/resources.go`、`resource_leases.go`。
- Worker：`packages/worker/src/resources/`（`detector.ts`、`scanner.ts`、`detectors/`、`operations.ts` 设备侧 fencing、`providers/`、`install.ts`、`compute-settings.ts`），`packages/worker/src/daemon/handlers/resources.ts`，会话本地浏览器租约 `packages/worker/src/resource-pool.ts`。
- Web：`apps/web/src/features/resources/`，设备页摘要 `apps/web/src/features/devices/device-resources.tsx`。
- 脚本：`scripts/remote-check.sh`。
