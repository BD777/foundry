# 模型与账号

[项目 Roadmap](../README.md#roadmap) · [文档索引](README.md)

模型与账号负责 Agent 用**什么模型、以谁的身份**运行：设备上 Claude Code / Codex 的官方登录、缺少程序时按官方方式安装、Server 上保存的“模型服务”（远程 API 或网关的端点与密钥）、每台设备能用哪些模型服务，以及模型目录。它不负责会话怎么启动和运行（执行内核的 Session Runtime 接收选定的 profile），也不负责 Agent 使用的外部账号（飞书等属于连接器，见[连接器](connectors.md)）。Foundry 从不直接调用模型推理接口：所有推理都经 Agent 自己的 SDK / CLI（[AGENTS.md](../AGENTS.md) “Agent provider access”）。在分层图中属于“能力供给”层：依赖“设备与 Workspace”（登录、安装、目录读取都发生在设备上）和“身份与共享”（模型服务归属到人、设备归属决定谁能管理登录）；被执行内核（启动会话时带上完整 profile）和“Agent 能力面”（MCP `list_profiles` / `list_models`）使用。

## 设计

### 概念

- **设备账号（官方登录）**：Claude Code 或 Codex 在某台设备上自己的登录，凭据由 CLI 保存在钥匙串或本地文件中。OAuth 凭据不经 Server 搬运，Foundry 也不保存；登录只对那台设备有效，每台设备各自登录。Worker 运行设备自己的程序，不自带副本（快速开始中的 “worker 使用设备自己的 Claude Code / Codex”）。
- **模型服务（server profile）**：Server 上的一条记录（表 `profiles`），保存运行时、端点（base URL）、模型列表、每个模型的上下文窗口与运行默认值；`authMode` 只有 `official` 与 `custom` 两种。`custom` 的密钥只经 sealed secret store 保存（`agent-profile:<profileID>`），只写不读，只在派发会话时解密交给设备，设备不落盘；`official` 不能存密钥，使用所选设备的本地登录。模型服务归创建者所有，只有所有者能列出、编辑、删除；设备所有者显式把它分配给设备（表 `device_profiles`）后才能在该设备上运行。
- **设备 profile**：Worker 在设备上发现的配置，留在设备上：本地登录、环境变量、自定义命令、Foundry 本地 profiles 文件，以及 Claude Code settings / Codex `config.toml` 中配置的端点（`native-agent-config.ts`，只读，从不改写原生配置）。本地登录、环境变量、自定义命令类不能提升为模型服务；端点类可以（见下文“提升”）。
- **提升（promote）**：设备所有者在设备的“模型与账号”页把通过检查的端点提升为自己的模型服务，复制名称、运行时、base URL、模型与默认值；再次提升同一个端点时更新原来那条模型服务（来源记在 `profile_promotions`），只合并模型列表、保留人在 Server 上改过的设置。密钥只在人勾选后复制：Server 已封存的旧设备级密钥直接改封，否则经 `read_provider_key` 向设备要该端点自己配置里点名的那一个密钥；不勾选不读密钥。base URL 是回环地址的模型服务只能在提升它的设备上启用。密钥与回环规则的完整边界见[安全边界](security.md#server-profiles-versus-device-profiles)。
- **上下文窗口**：只对带 base URL 的兼容端点模型服务（Anthropic / OpenAI 兼容）生效，官方登录和设备 profile 沿用 CLI 自己的窗口。按模型解析，先到先用：人在模型服务里填的值 → 端点 `/models` 返回的窗口（`context_length`、`max_input_tokens` 等字段，不用 `max_tokens`）→ 官方 Claude / GPT 模型的窗口（从 Claude Code 内置模型表与 Codex 自带 `models.json` 抄录的静态表）→ 默认 1M（`packages/protocol/src/model-context.ts` `resolveContextWindow`）。运行时 Worker 告诉 CLI（`context-window.ts`）：Claude 设 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`（比 Claude Code 已知的窗口小时另设 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`），1M 需要显式开启的模型解析到 1M 时以 `<model>[1m]` 启动，由 Claude Code 发送 beta 头 `context-1m-2025-08-07`，Foundry 显示与记录的仍是不带后缀的模型名；Codex 以 `-c model_context_window` 传入（只在按 base URL 运行时，按名字运行的端点由 Codex 套用自己的定义）。会话状态行显示窗口及来源，运行时自报的窗口不同时两者都显示。
- **Codex 传输方式**：兼容端点的 Codex 模型服务以自己的 `[model_providers.foundry_<profileId>]` 运行，是否让 Codex 走 Responses WebSocket（`supports_websockets`）按端点决定。模型服务上的选择 `codexTransport`：`auto`（默认）、`websocket`、`https`，人指定的优先。`auto` 时按学到的结果：没有学到（新模型服务、base URL 变了、保存过模型服务、结果超过 7 天）时打开 WebSocket 并把单次握手限制为 5 s（`websocket_connect_timeout_ms`），由 Codex 自己尝试、失败五次后自己回退 HTTPS；Worker 从这一轮的 Codex 事件判断结果：出现 `Falling back from WebSockets to HTTPS transport.` 条目即不支持（理由取 Codex 给出的原因），一轮 `turn.completed` 完成且没有回退即支持。结果作为会话事件元数据 `codexTransport` 上报，Server 按 profile + base URL 记下时间（表 `profile_codex_transports`），之后的会话按它决定；学到 WebSocket 的端点若再回退，会改记为 HTTPS。Foundry 自己从不探测端点。设备 profile 与旧 Server 派发的定义不带 `codexTransport`，保持 HTTPS。
- **模型目录**：某个 profile 可选的模型列表，总是由设备读取：
  - Claude 官方登录：Claude Agent SDK 的 `supportedModels()`（开一个不发提示的 SDK 会话读取）。
  - Codex 官方登录：Codex app-server 的 `model/list`；不支持时用 CLI 自带目录 `codex debug models --bundled`。配置了网关自定义目录（`model_catalog_json`）时不把它当官方选项。
  - 兼容端点：只请求该端点的 `/models`（兼容 base URL 带或不带 `/v1`），使用该 profile 运行时会用的密钥；不记录密钥和响应。
  - 没有端点的 Codex 设备配置：`codex debug models`。

### 关键决定

- **2026-09-16 兼容端点的目录只经 `/models` 读取。** 原生 CLI 都不能列出兼容端点的目录，这是唯一获准的 provider HTTP 请求：它只读元数据，从不发 completion；由设备执行，密钥留在本来就持有它的机器上。本地登录从不经 HTTP 询问。
- **从不凭缓存的身份声称在线有效。** Claude：`claude auth status --json` 只说明本地有 OAuth 凭据，SDK 没有额度读取，状态最多是 `local_login`（“在线有效性未验证”）；登录临近续期时不运行任何会让 CLI 续期的命令（避免刷新令牌轮换到一半被中断而登出设备），只从凭据文件读到期时间和套餐。Codex：`account/read` 找到 ChatGPT 登录为 `local_login`，`account/rateLimits/read` 成功才是 `verified`，这是 Codex 原生的额度读取，不是模型请求。来源配置消失时如实报告，不悄悄换成另一份配置（`native-inspection.ts`）。
- **官方模型选择器只做选择。** 设备默认模型只能从官方目录中选，或用原生默认值；已保存的模型不在目录中时提示重新选择。官方模型与模型服务共用同一套选择控件。
- **2026-10-04（#100）用设备自己的程序，按官方方式安装。** Worker 不再随包下载 SDK 自带的 Agent 程序（npx 安装从 703 MB 降到 130 MB）；SDK 是可选 peer 依赖，`pnpm audit:footprint`（在 `pnpm verify` 中，CI 运行）在包超过 150 MB 或带有 Agent 程序 / SDK 时失败。程序缺失时，设备所有者点击后由 Worker 运行官方安装脚本（`curl -fsSL https://claude.ai/install.sh | bash`、`curl -fsSL https://chatgpt.com/codex/install.sh | sh`，装到当前用户目录，不需 root）。最低版本：Claude Code 取 Agent SDK 声明的 `claudeCodeVersion` 与会话定时器所需的 2.1.291 中较新者，Codex 取 Codex SDK 的 major.minor；旧版本仍能运行，但会标记并给出按安装方式区分的更新命令（`native-cli.ts`）。
- **2026-10-09（#110）登录由人在设备上完成，设备配置里的端点验证后才算可用。** Web 端发起登录已移除：未登录时提示在那台设备的终端运行 `claude` 后 `/login`，或 `codex login`，再点“Check again”。设备配置中发现的端点要经 Agent 自己的 SDK 跑通一轮对话后才列为可用（`provider-check.ts`，结果保留到配置或登录变化，失败一小时后重试）；Codex 端点按名字运行，由 Codex 套用它自己的定义。
- **2026-10-10（#118）在 ChatGPT 桌面应用中找到 Codex。** 查找顺序包含 `/Applications` 与 `~/Applications` 下 `ChatGPT.app`、`Codex.app` 的 `Contents/Resources/codex-cli/bin/codex`；这类安装的更新方式是更新应用本身。
- **2026-10-14（#127）缓存模型目录。** 冷启动的 CLI 目录读取较慢（访问日志中 p95 12.9 s）。Server 在内存中按 profile 与“决定目录的一切”（端点、连接、凭据）的指纹缓存：10 分钟内直接返回；24 小时内先返回旧值并在后台重读；超出或带 `refresh` 时等待设备，单次最长 90 s；同一目录的并发读取合并，失败不缓存。Worker 另对 Codex 本地目录缓存 5 分钟。
- **2026-10-14 Codex 的 Responses 传输方式从 Codex 自己的尝试中学习。** 此前所有兼容端点一律 `supports_websockets=false`，支持 WebSocket 的端点也只走 HTTPS；而 AGENTS.md 禁止 Foundry 自己向 `/responses` 发探测，所以只能让真实会话里的 Codex 去试并读它的事件。代价是不支持的端点每 7 天（或每次编辑后）有一个会话多花几秒（拒绝升级时约 6 s；握手无响应时每次等 5 s，共约七次）。判定支持的依据是“开着 WebSocket、一轮完成且没有回退”，Codex 的 JSON 事件里没有正面的 WebSocket 信号（Codex 0.153.4 实测）。Issue 判定等沙箱内会话不试探，只在已知支持时打开 WebSocket。
- **2026-10-15 会话不指定账号时，选那台设备上能用的账号。** dev 上助理派到 byte-dev 的会话不带 profile，沿用了自己的运行时，落在那台设备没登录的 Claude Local 上立刻失败；改用 Codex 后又落在 Codex Local 上连不上服务、挂了 7 分钟。现在经 MCP 不指定 profile、任何入口只指定运行时、以及飞书消息启动的会话，由 Server 在目标 Workspace 的设备上选账号（人经 REST 什么都不指定仍被拒绝，Web 总会指定）（`httpapi/session_accounts.go`）：本人在该 Workspace 最近一次完成的会话用的账号 → 本人助理的账号（`assistantProfileId`）→ 第一个可用的（已报告可用的优先）。设备报告未登录（`missing_auth`）或端点检查未通过 / 不可用（`unavailable`）的账号从不被选；没有可用账号时拒绝并返回 `no_usable_account` 和该设备上的全部账号，而不是启动注定失败的会话。模型服务按设备在线时的状态判断（设备离线时会话照常排队等它）。`send_message` 只给运行时时同样选择，给的是会话自己的运行时则保持原账号；`handoff_session` 只在来源账号仍可用时沿用它。人或 Agent 明确指定的 profile 照用，从不悄悄换掉。助理的 `get_workspace` 返回这些账号（`accounts`）。
- **沙箱内只拿访问令牌。** Issue 执行、澄清、判定等沙箱会话拿到设备的 Claude / Codex 访问令牌，从不拿刷新令牌；设备用自己的 CLI 续期（[安全边界 · Agent Credentials](security.md#agent-credentials)）。

## 实现边界

截至 2026-10-14（`3092162` 加未提交的工作区改动：每模型上下文窗口、提升设备端点）。

**已实现**

- 程序检测、安装与最低版本：`packages/worker/src/native-cli.ts`、`native-cli-install.ts`；`POST /api/devices/{deviceId}/accounts/{runtime}/install`（设备所有者，设备须在线），`apps/server/internal/httpapi/device_accounts.go`。
- 登录检查：`POST /api/devices/{deviceId}/accounts/{runtime}/inspect`；Worker `native-inspection.ts`（`inspectNativeAccount`）、`native-login.ts`、`native-account.ts`（只读身份，不读令牌）、`native-homes.ts`（`CLAUDE_CONFIG_DIR` / `CODEX_HOME`）、`native-login-environment.ts`（官方账号操作清空端点与密钥变量）。运行时健康随注册上报（`provider-health.ts`，`GET /api/provider-health`）。
- 模型服务：`/api/profiles*`（`apps/server/internal/httpapi/profiles.go`），设备分配 `PUT /api/devices/{deviceId}/profiles`，存储 `apps/server/internal/sqlitestore/profiles.go`、类型 `apps/server/internal/store/profiles.go`。Web：模型服务页（`/model-providers`，`apps/web/src/features/profiles`，设备分配在 `connection-devices.tsx`），设备的“模型与账号”页（`device-access.tsx` 官方账号与安装，`device-providers.tsx` 设备自己配置里的端点及提升入口，`device-account-defaults.tsx` 官方默认模型）。
- 上下文窗口（未提交，2026-10-14）：解析 `packages/protocol/src/model-context.ts`，存储 `profiles.context_windows`，应用 `packages/worker/src/context-window.ts`、`runner/claude-launch.ts`、`runner/codex-options.ts`，显示 `context-usage.ts`、Web `features/profiles/context-window-fields.tsx`、`features/chat/chat-session-status.tsx`。
- 提升（未提交，2026-10-14）：`POST /api/profiles/promote`（设备所有者，在处理函数中检查），`httpapi/profiles.go` `handlePromoteProfile`，`sqlitestore/profile_promotions.go`，Worker `profiles.ts` `configuredProviderKey`（回答 `read_provider_key`，取代 `read_profile_credential`），Web `features/devices/promote-provider-dialog.tsx`。
- Codex 传输方式（未提交，2026-10-14）：Worker `runner/codex-transport.ts`（`codexTransportPlan`、`CodexTransportLearner`，接在 `codex-stream.ts` 的事件处理上），`codex-options.ts` `codexEndpointConfig`；Server `httpapi/codex_transport.go`（从会话事件学习，只认这个设备上该会话所跑的 server profile 与其当前 base URL），存储 `sqlitestore/profile_codex_transports.go`（列 `profiles.codex_transport`、表 `profile_codex_transports`，7 天有效，保存或删除模型服务时清除）；Web 模型服务卡片与编辑器的“Responses 传输方式”（`features/profiles/codex-transport.ts`）。
- 模型目录：Worker `models.ts`（`listAgentModelsConfig`）与 `native-inspection.ts`（`readClaudeCatalog`、`readOfficialCodexCatalog`）；Server `POST /api/agent-profiles/models` 与 MCP `list_models` 共用 `readAgentModels`（`agent_profiles_http.go`），缓存在 `agent_model_catalog.go`。
- Worker 侧 profile 解析：`profiles.ts`（派发的 server profile 是权威定义，不查本地 profiles 文件，运行时、端点、模型不会静默回退到另一个本地 profile）。

**未实现 / 已知缺口**

- Claude 官方登录没有在线有效性或额度检查（SDK 不提供）；Codex 的在线检查是尽力而为，额度读取失败时退回 `local_login`。
- 官方登录必须由人在设备上完成，Foundry 不能远程代为登录。
- 模型目录缓存只在 Server 内存中，重启后第一次读取要等设备；兼容端点不提供 `/models` 时只能手填模型。
- 最低版本只提示不阻止；Codex SDK 不在时（npx 引导阶段）不知道 Codex 的最低版本。
- Codex 传输方式：同一时间多个会话都可能处在试探中，各自上报，以最后一个为准。判定依赖 Codex 回退提示的英文原文，Codex 改了措辞就会把不支持误记为支持（之后每轮仍会回退，直到 7 天后重学或人改为 HTTPS）。

**验证情况**

- 有真实运行记录：Claude 与 Codex 会话经各自 SDK 使用设备登录运行（[实机回归](live-regression.md)，2026-09-28，早于 #100 改用设备自己的程序）；模型目录缓存的动机来自 dev 访问日志（#127）。安装、登录检查、ChatGPT 应用中的 Codex 在本次整理中没有找到带日期的实机记录，只能确认代码存在。
- 上下文窗口与提升：已实现，在测试中验证，尚未实机验证。`packages/protocol/test/model-context.test.mjs`、`packages/worker/test/context-window.test.mjs`、`provider-key.test.mjs`，`httpapi/profiles_test.go`（`TestProfileContextWindowsPerModel`、`TestPromote*`、`TestLoopbackPromotionStaysOnItsDevice`），`sqlitestore/profiles_test.go`，Web `chat-session-status.test.mjs`、`profiles-feature.test.mjs`、`model-connections.test.mjs`。
- Codex 传输方式：Worker `codex-transport.test.mjs`，Server `sqlitestore/profile_codex_transports_test.go`、`httpapi/codex_transport_test.go`，Web `profiles-feature.test.mjs`；另在 scratch stack 上用真实 Codex 0.153.4 对两个本地假 Responses 端点（一个对 WebSocket 升级回 404、只走 HTTPS，一个接受 Responses WebSocket）做了端到端验证（2026-10-14）：前者第一个会话回退并学到 HTTPS，之后的会话和同一会话的下一轮都没有 WebSocket 尝试；后者第一个会话学到 WebSocket，之后的会话仍只走 WebSocket；指定 HTTPS / WebSocket 分别强制两种方式且不学习。
- 只有单元 / 接口测试：`apps/server/internal/httpapi/device_accounts_test.go`、`profiles_test.go`、`agent_model_catalog_test.go`、`promoted_profile_projection_test.go`、`session_profile_resolution_test.go`，`apps/server/internal/sqlitestore/profiles_test.go`，Worker `packages/worker/test/native-login.test.mjs` 等，Web `apps/web/test/model-connections.test.mjs`（用例 `cases/web/device-connections.case.json`）。本次整理未重新运行。

## 后续

Roadmap 暂无排期的下一步。已知缺口中的 Claude 在线有效性取决于官方 SDK 是否提供读取方式，在此之前保持“本地登录，在线有效性未验证”的表述。

## 代码位置

- 协议类型：`packages/protocol/src/profiles.ts`、`model-context.ts`。
- Worker：`packages/worker/src/profiles.ts`、`native-*.ts`（`native-chat*`、`native-session.ts`、`native-usage.ts` 属于会话与对话，不在本模块）、`models.ts`、`provider-health.ts`、`provider-check.ts`、`context-window.ts`，daemon 处理 `packages/worker/src/daemon/handlers/agents.ts`。
- Server：`apps/server/internal/httpapi/profiles.go`、`device_accounts.go`、`agent_profiles_http.go`、`agent_model_catalog.go`；路由 `routes.go`。
- 存储：`apps/server/internal/store/profiles.go`、`apps/server/internal/sqlitestore/profiles.go`、`profile_promotions.go`、`profile_codex_transports.go`；密钥在 sealed secret store（[安全边界 · Secret Store](security.md#secret-store)）。
- Web：`apps/web/src/features/profiles/`、`apps/web/src/features/devices/device-access.tsx`、`device-providers.tsx`、`promote-provider-dialog.tsx`、`device-account-defaults.tsx`。
- 安装体积检查：`scripts/audit-install-footprint.mjs`。
