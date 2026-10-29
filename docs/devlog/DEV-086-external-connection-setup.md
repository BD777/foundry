# DEV-086 在其他设备上设置外部连接（从选择器开始）

2026-10-29，编排会话 `sess_1793063405185071529` 分派给本会话 `sess_1793266247307970791`。

## 问题

用户反馈：外部连接网关的 default 这类 profile 可以选，但要在一台从未装过的设备上使用，得手动做大约 4 步（安装网关客户端与运行时、登录、`foundry-worker connection add`、`connection check`），而且没有任何地方说明。用户的原话是：“可以复制粘贴到平台外运行，不能接受的是隐藏规则和缺失的引导。”

约定的设计（编排会话推荐，用户同意排期）：

- 选择器按设备显示连接状态，每种状态只给一个操作。
- “设置…”打开面板：给出一条命令，说明由哪台设备、哪个系统账号运行，并实时显示进度。
- 设备允许远程命令时，可点“替我设置”，由 Foundry 代为运行。
- 公开仓库保持网关中立：机制由网关登记，Foundry 不写任何具体网关产品的内容。
- 网关一侧的一键安装程序由私有网关仓库后续实现。

编排会话在设计确认时追加了四条要求：

1. 运行前显示命令的来源，“替我设置”提交命令摘要，命令已变更时返回 409。
2. 多台设备登记了不同命令时显示最新的一条，并列出其余的，不合并。
3. 远程输出只保存在内存里，只给设备所有者看。
4. 网关不上报进度时，仅凭登记和验证也要能推进步骤；20 分钟没有变化时提示“查看终端”并提供重试。

## 实现

- **协议**（`packages/protocol/src/external-connection-setup.ts`）：
  - 新增 setup 元数据、进度、远程运行、每台设备的阶段（`ready` / `not_set_up` / `in_progress` / `waiting_sign_in` / `unchecked` / `check_failed` / `setup_failed`）和 offer/detail 类型。
  - `AgentProfileProjection.externalSetup` 字段。
  - daemon 消息 `read/start/cancel_external_connection_setup`。
- **Worker**：
  - `connection add` 增加 `--setup-command`（单行、≤2000 字符、不含秘密）、`--setup-url`（https）和 `--sign-in device_code|browser|none`。元数据单独存为 `externalSetup`，不进入检查指纹，因此修改它不会让已通过的验证失效。Worker 记录登记时间；不带参数重新登记会删除元数据。
  - 新命令 `connection progress <id> --state installing|installed|waiting_sign_in|signed_in|failed [--sign-in-url] [--user-code] [--message]`。进度写入 `external-connection-setup.json`（0600），保留 1 小时，移除连接时一并清除。
  - 能力 `external_connection_setup_v1`：
    - 读：返回连接的实时登记和验证状态、进度，以及运行输出（按偏移量读取）。读到连接有变化时立即上报设备，不等心跳。
    - 启动：远程命令关闭时拒绝。以 `$SHELL -lc` 在 HOME 下运行，stdin 关闭，限时 20 分钟，独立进程组。环境只保留普通变量，加上 `FOUNDRY_WORKER`、`FOUNDRY_CONNECTION_SETUP=remote` 和 `FOUNDRY_CONNECTION_ID`，不带 Worker 自身的任何凭据。输出脱敏后在内存中保留最近 256 KiB、1 小时。
    - 取消。
  - 从源码运行的 Worker 没有 shim，会在状态目录生成一个调用自身 CLI 的小脚本作为 `FOUNDRY_WORKER`。
- **Server**（`apps/server/internal/httpapi/external_connection_setup.go`）：
  - 四条路由，均为 `deviceOwner`，会话 token 不可访问：
    - `GET /api/devices/{id}/external-connection-setups`
    - `GET …/{profileId}?runId&after`
    - `POST …/{profileId}/run`（body 只有 `digest`）
    - `DELETE …/{profileId}/run?runId`
  - offer 来自本人所有设备（含离线设备）已上报的 profile，不新增表。命令取各设备中最新登记的一条，其余不同的命令放进 `otherSetups`。
  - 运行的命令永远取自记录，请求只提供摘要，摘要不匹配返回 409。
  - 进度和运行摘要（不含输出）在内存中保留 1 小时，用于选择器显示阶段。
- **附带修复（DEV-045 遗留）**：Server 的 `inboundHandlers` 里没有 `external_connection_checked` / `external_connection_removed`。真实 Worker 的回答因此被当作未知消息丢弃，设备页的“验证 / 移除”只会超时（之前的测试绕过了路由）。现已加上路由，并补充回归测试。
- **Web**：
  - `SelectMenu` 新增公开 API `actions`（`SelectMenuAction`：label / detail / actionLabel / prefix / disabled / busy / onSelect）。行渲染在选项之后，是可用键盘到达的 `DropdownMenu.Item`；DEV-088 复用同一 API。`AgentComposer.agentPickerActions` 负责透传。
  - 聊天选择器每个未就绪的连接一行，只有一个操作：设置… / 查看进度… / 完成登录… / 验证… / 重试…（失败原因原文显示）。
  - 设置面板 `features/chat/external-connection-setup-dialog.tsx`：
    - 设备、账号、命令和来源（设备、时间、连接 id），以及复制、网关说明链接、“替我设置”或不可用原因。
    - 进度使用 DEV-088 的共享 `SetupChecklist`。登录步骤带登录页链接和验证码。
    - 失败时显示原因、重试和日志。20 分钟无变化时提示停滞。
    - 登记后自动验证一次；就绪后自动为本聊天选中。
  - 文案：中英文 `connectionSetup` 命名空间。
- **文档**：在 [external-connections.md](../external-connections.md) 新增 “Setup on another device”：登记参数、选择器状态表、面板、“替我设置”的约束、`connection progress`，以及网关安装程序契约。

## 验证

证据目录 `.foundry/attachments/20261029/dev086/`（工作区本地，不入库）。

- Server：`go test ./internal/httpapi -run ExternalConnection` 全部通过。新增 7 项，覆盖：
  - 只取本人设备的 offer、本机就绪、最新命令与其余命令。
  - 离线与在线实时读取，以及选择器记住阶段但不记输出。
  - 阶段规则（无进度时仅凭登记和验证推进）。
  - 摘要不符返回 409 且不下发、请求体不能自带命令、旧 Worker 和离线返回 409。
  - 设备错误码映射、非所有者 404、应答消息已路由。
- Worker：`external-connection-setup.test.mjs` 6 项与 `external-connection-registry.test.mjs` 8 项全部通过，覆盖：
  - 元数据登记与幂等、登记时间、不影响指纹、校验。
  - progress CLI 的 JSON、退出码、0600、过期与随移除清除。
  - 远程运行：远程命令关闭时拒绝；环境不含会话 token 和 provider 密钥；`$FOUNDRY_WORKER` 调用自身 CLI；输出偏移；busy、取消、超时、退出码。
  - daemon 读取、启动、取消的消息往返，以及连接变化时立即上报。
- Web：`external-connection-setup.test.mjs` 4 项（选择器行、阶段到步骤的映射）通过，tsc 无错误。我修改的文件 `audit:ui` 全部通过；唯一失败来自 DEV-088 的 `device-accounts.tsx`。`audit:modules` 通过。
- 真实浏览器端到端：scratch stack，空数据库，两个 scratch Worker 模拟设备 A（laptop-a，已登记连接和元数据）与设备 B（server-b，ws-b 工作区）。假网关安装程序实现了契约：上报进度、模拟设备码登录（批准由测试脚本写入文件代替人的确认）、调用 `connection add`。
  - 选择器显示 `Fake gateway · default — Set up… / Not set up on this device`。键盘 ↓ 到该行、Enter 打开面板。
  - 点“替我设置”后，步骤依次推进：命令已开始 → 已安装 → 等待登录（链接 `https://gateway.example/device`，验证码）→ 写入批准约 5 秒后已登录 → 已登记 → 自动验证。
  - 假 helper 没有凭据，验证按预期失败，原因原文显示（“Not logged in · Please run /login”），没有发生推理。选择器同步变为 `Retry… / Check failed: …`。
  - 失败路径：共享 dist 被其他会话重建期间运行失败，面板显示“Setup failed / 退出码 1”、重试和日志。
- 后续场景（同一 scratch stack）：
  - **就绪并自动选中**：面板打开期间写入模拟的验证通过结果，面板随即显示“已就绪，并已为本聊天选中”，关闭后输入框选择器为 `Fake gateway · default`。
  - **命令冲突**：设备 A 改登记 `--channel beta` 后，面板显示最新命令，并提示“其他设备登记了不同的设置命令”，可展开查看。
  - **远程命令关闭**：“替我设置”禁用并说明原因；`POST …/run` 带正确摘要和错误摘要都返回 409。
  - 英文亮色 1440、英文深色 1440、中文深色 390 下均无横向溢出（`scrollWidth` 等于视口宽度）。
- 复验中发现并修复的问题：
  - 打开面板前的旧失败运行与新运行竞态，导致误报“设置失败”：用读取代次丢弃过期应答，并且失败提示只在登记前显示。
  - 日志长行把对话框撑宽：网格子项加上 `min-width: 0`；不再覆盖 TerminalBlock 的内部样式。
  - 验证失败一行的标题仍写“验证通过”：步骤标题改为随状态变化。
  - 远程运行状态排版错位：改用 LoadingState。
  - 选择器的阶段依赖 1 小时内存缓存，设备移除连接后仍显示进行中：列表接口改为向在线设备逐个读取实时状态，离线时才用缓存。
- `check-changed.sh`（41 个文件）：gofmt、protocol build/tests、web tsc、worker build、30 个 worker 测试文件、`go test ./internal/httpapi ./internal/store`、audit:contract、audit:modules 全部通过。失败的两项已修复：Prettier 格式；`i18n.test.mjs` 的一个空文案键，删除后复跑通过。复检时 Prettier 和 12 项 `audit:ui` 全部通过。日志：`check-changed.log`。
- 截图：`01-dialog-not-set-up.png`、`02-waiting-sign-in.png`、`03-after-check.png`、`04-picker-after.png`、`05-setup-failed.png`、`06-ready-selected.png`、`07-composer-selected.png`、`08-conflict-light.png`、`09-conflict-dark-zh-390(-picker).png`、`10-remote-off-dark.png`。

## 时间线

| 时间（UTC+8）    | 变化与证据                                                                                                                                                                                                                                                                    | 剩余动作                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 2026-10-29 17:34 | 设计说明发给编排会话，获批，并追加四条要求                                                                                                                                                                                                                                    | —                           |
| 2026-10-29 19:40 | 协议、Worker、Server、Web 与文档完成；单测通过；scratch 端到端                                                                                                                                                                                                                | 视觉复验、部署、Worker 发布 |
| 2026-10-29 20:55 | 复验修复（见“验证”）、check-changed；scratch 已拆除                                                                                                                                                                                                                           | 见“部署”                    |
| 2026-10-29 21:15 | 功能已验收；视觉修正：远程运行状态改为一行（转圈、正文字号、右侧“停止”）；共享 SetupChecklist 未开始步骤改为中性灰环，琥珀/红只表示失败（已告知 DEV-088）。重拍 `11-running-light.png` / `11-running-dark.png`                                                                | 随下一次共享 Web 构建发布   |
| 2026-10-29 21:18 | 征得 DEV-079/082/084/088 同意后从共享树构建并部署 dev Web `bf2b4e5fdd4d43e0`（替换 `37c8ae8f9b2b08c1`，备份在 `releases/dev086-web/previous-…`）；部署脚本校验入口资源与同源 API 通过；线上 CSS 含单行运行状态样式、无“未开始=琥珀”规则；首页真实浏览器加载无错误、无跨源请求 | 人工验收                    |

## 部署（截至 2026-10-29 20:55）

- Server：DEV-084 按编排会话安排从共享树统一部署。实际加载的二进制 `releases/dev023-candidate/foundry-server`（SHA256 前缀 `7194206839c1ba50`）已包含四条新路由和应答路由修复。之后的“选择器实时读取”改动尚未部署：Server 重启处于编排会话的暂停期，需随下一次 Server 部署上线。
- Web：DEV-079 / DEV-084 / DEV-082 的共享树构建陆续带上了本事项的 Web 改动。最后一轮视觉修复由 DEV-083 的下一次构建发布。
- Worker：DEV-084 发布的 `0.5.7-dev.139.g408e64d.local.1793273568` 已包含本事项的 Worker 代码，与本地构建逐文件比对一致。指定测试设备是否已更新，以 DEV-084 的记录为准。
- 网关一侧：私有网关仓库需按文档契约实现一键安装程序（安装运行时和客户端、设备码登录、上报 `connection progress`、带 setup 元数据调用 `connection add`）。这是后续工作，本事项未改动私有仓库。

## 验收步骤

1. 在已装好某网关的设备上，网关安装程序（或手动）运行 `connection add … --setup-command '<一键命令>' --sign-in device_code`。
2. 打开另一台本人设备上某个工作区的新聊天，打开模型选择器。预期出现“<连接名> — 设置… / 这台设备上还没有设置”。
3. 点“设置…”。预期面板显示目标设备和账号、命令、“由连接 <id> 于 <时间> 在 <来源设备> 上登记”、复制按钮和“替我设置”。
4. 手动复制运行，或点“替我设置”。预期步骤依次推进，等待登录时出现“打开登录页面”和验证码；登录后显示已登记，随后自动验证一次。通过后提示“已就绪，并已为本聊天选中”，选择器选中该连接。
5. 在“资源”页关闭该设备的远程命令后重开面板。预期“替我设置”禁用，并说明“远程命令已关闭”。

## 限制

- 设备码登录的“人确认”是用文件模拟的；真实网关安装程序在私有仓库，属于后续工作（见文档中的契约）。
- 就绪 + 自动选中路径使用模拟的验证通过结果（scratch 状态目录写入 passed），因为假 helper 无法完成真实推理。
- 20 分钟停滞提示只有单测和代码覆盖，没有在浏览器里真实等待 20 分钟。
- “替我设置”以 Worker 的系统账号运行，与远程命令同一信任边界。命令来自本人设备登记的记录，并且必须在面板里明确点击。
- 手动路径下，如果 Worker 使用非默认状态目录（例如开发 stack），粘贴的命令需要自行带上 `FOUNDRY_STATE_ROOT`。面板目前没有提示这一点。
