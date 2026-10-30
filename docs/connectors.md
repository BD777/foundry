# 连接器

[Roadmap](roadmap.md) · [文档索引](README.md)

连接器负责 Agent 在会话里以某个人的身份使用的外部服务和它们的命令行工具。目前有四种：**Server 持有型**的飞书（`feishu-cli`）与 Cloudflare（`cf`），由 Server 保管密钥与个人登录，会话经 Server 的网关调用，设备上只有可撤销的替身；**设备持有型**的 bytedcli 与 AWS CLI，登录由 CLI 自己保存在那台设备上，从不离开设备，Foundry 只负责检测、安装、登录入口、状态与到期提醒，以及哪些会话可以使用。统一的抽象见下文[连接器抽象](#连接器抽象)。它不负责人从飞书找到 Foundry（那是[渠道](channels.md)，渠道的 Bot 运行在这里的一个飞书应用上），也不负责 Claude / Codex 的登录与模型服务（属于[模型与账号](models-and-accounts.md)）。在分层图中属于“能力供给”层：依赖“身份与共享”（账号归属、Workspace 角色）和“设备与 Workspace”（设备凭证、设备归属、会话所在设备）；被执行内核（会话启动时下发的连接器）、Agent 能力面（`feishu_events` 工具）和渠道使用。Web 里的位置有两处：全局的 Connectors 页（`/connectors/<kind>`，每种连接器一个 Tab）；Workspace 的 Connectors 页（`/workspace/connectors`）选择这个 Workspace 的会话可以使用自己的哪些账号、哪台设备上的登录，并显示其他成员的绑定。待办统一在 [Roadmap · 连接器](roadmap.md#连接器)。

## 设计

### 连接器抽象

所有连接器都按同一组概念描述；新连接器只回答这几个问题，不新增一套流程。“已实现”指 main 上的代码，不代表每种连接器都经过真实第三方账号验收。

| 概念                                  | 含义                                                                                                                                                        | 现状                                                                                                                                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 连接器类型（kind）                    | 一种外部服务及其 CLI，一条 `catalog.json` 描述数据加一个小适配器                                                                                            | 已实现：feishu、cloudflare、bytedcli、aws                                                                                                                                                                |
| 持有方式（holding）                   | 凭据在哪里：`server_held`（Server secret store，会话经网关）或 `device_held`（只在设备上，CLI 自己保存）                                                    | 已实现两种                                                                                                                                                                                               |
| 身份（account / login）               | 一个人在该服务上的一份登录：Server 持有型是 `external_accounts` 中的账号，设备持有型是某台设备上的一份原生登录                                              | 已实现；同一类型可以有多个账号（例如同一个人在两个飞书租户下的两个账号）                                                                                                                                 |
| 登录方式（authentication）            | 经 Foundry 发起（设备码、OAuth、CLI 的 `--begin/--complete`），或 `local`：在设备终端自行管理，Foundry 只检查状态                                           | 已实现；AWS 为 `local`                                                                                                                                                                                   |
| Profile（同一账号下的多个身份或范围） | 一份登录下可选的子身份或资源范围：AWS 命名 profile、bytedcli 站点、Cloudflare 账号下的 zone                                                                 | **部分实现**：Cloudflare 的 Workspace 只能用自己选定的 zone（`connectors/cloudflare_gateway.go`）；AWS profile 只能经 Worker 的 `AWS_PROFILE` 整体选择；bytedcli 只读默认站点。按 profile 单独绑定是待办 |
| 附加授权组（authorization group）     | 同一账号下某个子系统需要的另一份凭据或授权，单独发起、单独显示状态：例如 bytedcli 的 Meego 网页会话（`authorizationGroups`，凭据类型 `native_web_session`） | 已实现框架与 bytedcli 的一组；真实授权完成待本人验证（[DEV-029](devlog/DEV-029-connector-authorization.md)）                                                                                             |
| Workspace 绑定                        | Server 持有型本人绑定自己的账号；设备持有型本人会话自动使用设备有效登录，绑定只显式共享给其他成员                                                           | 已实现：`external_account_bindings`、`device_connector_bindings`                                                                                                                                         |
| 会话使用                              | 会话启动时按资格规则下发工具配置与说明；不可用的会话得到隔离变量                                                                                            | 已实现：`externalaccounts.Eligible`、`connectors.DeviceEligible`                                                                                                                                         |

几条约束对所有连接器成立：

- **凭据不跟着会话走。** Server 持有型只给会话可撤销的替身；设备持有型的凭据只在那台设备上。会话说明告诉 Agent 不要自己登录、登出或导出凭据。
- **资格每次重新检查。** 会话在可用的设备上、不是沙箱角色。Server 持有型要求本人账号已绑定；设备持有型的有效登录自动供设备所有者本人会话使用，其他成员仍需该 Workspace 的共享绑定；网关对每个请求重新检查。
- **隔离变量只防误用。** 未沙箱的会话以设备用户运行，能自己去掉隔离变量；这不是安全边界（见[安全边界](security.md#known-risk-the-device-credential-is-readable-by-unsandboxed-agents)）。
- **附加授权与 profile 不扩大基础登录的范围。** 它们是同一账号下显式、可单独撤销的部分，状态与到期分别显示。

### 模块边界

连接器是一个封闭模块：Foundry 其他部分只经下面几处入口使用它，不直接调用飞书或 bytedcli 的代码。

| 层     | 入口（其他模块只用这些）                                                                                                                                                                                                          | 内部（只在模块内）                                                                                                                            |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Server | `internal/connectors`：`Module`（目录 `Catalog`、会话派发时的 `SessionConnectors`、设备持有型服务 `Devices`、Server 持有型服务 `ServerHeld`）；HTTP 只在 `httpapi/connectors*.go`、`external_accounts*.go`、`feishu_events.go` 中 | `internal/externalaccounts`（Server 持有型引擎与飞书适配器）、`internal/feishugateway`、`internal/feishuevents`                               |
| Worker | `packages/worker/src/connectors/index.ts`：会话准备与释放（`prepareSessionConnectors`）、会话环境与说明、启动时回收、设备持有型请求（`handleConnectorRequest`）                                                                   | `connectors/feishu.ts` 与 `feishu-gateway-forwarder.ts`（飞书 profile 与本机转发器）、`device-held.ts`（检测、安装、要求检查）、`bytedcli.ts` |
| Web    | `features/external-accounts` 的 `ConnectorsFeature`、`WorkspaceConnectorsFeature`                                                                                                                                                 | 每种连接器自己的组件（`feishu-connector.tsx`、`bytedcli-connector.tsx`）                                                                      |

`scripts/audit-module-boundaries.mjs` 检查这条边界：Server 上只有连接器自己的包、渠道（`internal/feishu`，Bot 运行在飞书应用上）和上表中的 HTTP 文件可以引用内部包；Worker 上只有 `connectors/` 自己引用飞书与 bytedcli 的实现。

### 连接器如何声明自己

每种连接器先是一条**描述数据**（`internal/connectors/catalog.json`，经 API 发给 Web，经请求发给 Worker）：`kind`、名称、持有方式（`server_held` / `device_held`）、会话使用的工具（命令名，设备持有型还有 npm 包与来源 registry）、可用条件（`requires`）、到期提醒提前天数、会话隔离方式。标准的部分只靠数据；平台差异用小的代码适配器处理，按 `adapter` 名选择：Server 持有型在 `externalaccounts.Provider`（飞书的设备流、刷新、网关），设备持有型在 Worker 的 `DeviceHeldAdapter`（读状态、发起与完成登录、登出各自的命令与输出解析）。不用 Go plugin 或动态加载代码：新连接器是一次代码改动加一条目录数据。

- **可用条件**：连接器可以声明要求，例如 bytedcli 的 `tcp_reachable cloud.bytedance.net:443`（ByteDance 内网）。Worker 每次读状态时检查（3 秒超时、缓存 5 分钟），不满足的设备上不提供登录与安装，只显示原因。

### 两种持有方式

- **Server 持有型（飞书）**：行为不变，见下文“对象”到“账号生命周期”。
- **设备持有型（bytedcli）**：凭据只在设备上（bytedcli 的数据目录，ByteCloud Auth 设备码登录，约 30 天，按站点）。理由：Server 在内网之外用不了它；多台设备共用一份登录会互相抢刷新；把公司 SSO 凭据导出到外部 Server 有合规风险。Foundry 做的事：
  - **检测**：Worker 找到会话 PATH 上的 `bytedcli`（Foundry 管理的工具目录优先），读版本和来源（Foundry 安装 / 设备自带）。
  - **安装与升级**：设备所有者点击后经已有的 managed-tools 路径安装 npm 包 `@bytedance-dev/bytedcli`，来源用设备自己的 npm 设置（内网 registry），不运行 install 脚本；最新版本由 Worker 用设备的 npm 查询。设备自带的 bytedcli 由它自己更新，Foundry 只显示版本。
  - **登录**：设备所有者在 Connectors 页点击登录，Worker 运行 `bytedcli --json auth login --begin --no-terminal-qr --qr-image <临时文件>`，只把验证链接回传，Web 自己画二维码；Web 每隔几秒请求一次，Worker 运行 `auth login --complete`（不带 token，续用同一个挑战）直到成功、过期或被拒。complete token 和登录凭据都不离开设备。登出只在本人确认后运行 `auth logout`。
  - **状态**：`bytedcli --json auth status`，只取已登录与否、CLI 显示的用户名（不取邮箱）、站点、登录到期时间；从不读取或发送 token。Server 只存这些元数据（设备、连接器、身份标签、站点、到期、检查时间、版本），以及到期提醒状态（进入提醒窗口的时间，重新登录后清除）。
  - **哪些会话能用**：设备报告已登录且状态为 ready / expiring 时，设备所有者本人在该设备上的非沙箱会话自动获得使用说明，无须逐 Workspace 授权。Workspace 的 Maintainer 可以把**自己设备**上的登录显式共享给其他成员（`device_connector_bindings`：Workspace、连接器、设备、`members=true`）；其他成员仍必须在绑定的 Workspace 和设备上运行。已过期、已退出、未安装、不可用或读取失败的状态不下发 `device_login`；沙箱角色和 verification 会话不获得连接器。能用的会话收到会话说明（用设备的默认登录，不要运行 `auth login` / `logout` / `clear` / `export` / `import`，过期时请本人在 Connectors 重新登录）；不能用、且不是设备所有者发起的会话，Worker 用 CLI 公开的隔离方式（`BYTEDCLI_PROFILE` 指向一个空 profile）让它看不到设备所有者的登录。这是防误用，不是安全边界：未沙箱的会话以设备用户运行，能自己去掉这个变量（与[设备凭证的已知风险](security.md#known-risk-the-device-credential-is-readable-by-unsandboxed-agents)相同）。

### 对象

- **外部应用**（`external_provider_apps`）：一个飞书自建应用。密钥封存在 Server 的 secret store（`external-app:<id>`），设备拿不到。来源有两种：粘贴已有应用的 App ID 和密钥；或者扫码时由飞书为确认的人新建一个 PersonalAgent 应用，再接着授权（新应用扫两次，已有应用扫一次，飞书与 Lark 都支持）。可见范围分为个人应用和实例级应用，实例级应用需要 Admin 创建。应用名和所属组织名从飞书读取，每天刷新。
- **外部账号**（`external_accounts`）：一个人在某个应用下的飞书登录，账号 = (应用, 用户)。只有本人能查看、修改、绑定和断开自己的账号。登录由 Server 发起 RFC 8628 设备流，授权凭据（含 refresh token）封存在 `external-account:<id>`，Server 是唯一的刷新方：飞书的 refresh token 一次性使用、每次轮换，两个地方不能共用一份登录。
- **Workspace 绑定**（`external_account_bindings`）：Maintainer 在 Workspace 的 Connectors 页绑定或解绑**自己的**账号；Viewer 能看到绑定了哪些账号，其他人的账号只显示类型，不显示其飞书身份和到期时间。
- **会话授权**（`feishu_gateway_grants`）：会话启动时为每个可用账号签发一组替身凭据，只存哈希，会话结束即失效。

### 谁的会话能用哪个账号

规则在 `externalaccounts.Eligible`，网关对每个请求都重新检查一遍：本人发起、本人设备、账号已绑定到会话所在的 Workspace、账号可用（完整条件见[安全边界 · External Accounts](security.md#external-accounts-connectors)）。沙箱中的角色（Issue 执行、澄清、判定）拿不到账号，因为 Worker 不为它们的私有 HOME 写工具配置。Worker 需要声明 `feishu_gateway` 能力，旧 Worker 一个账号也拿不到，会话记录里会提示一次。

### 设备侧：替身凭据 + 本机转发

Worker 为每个会话、每个账号写一份 Foundry 管理的 `feishu-cli` profile（`foundry-<账号>-<会话摘要>`），用的是 `feishu-cli` 公开的配置方式（`config.yaml` 的 `app_id` / `app_secret` / `base_url`、`token.json`、`FEISHU_PROFILE`）：

- `app_secret` 写 `fsg_` 替身，`token.json` 写用户 token 替身 `fsu_` 和 refresh 替身 `fsr_`；`fst_`（Bot token 替身）由网关在 `feishu-cli` 请求 tenant token 时下发。后三种都由 `fsg_` 派生，网关只存哈希。
- `base_url` 指向 Worker 的本机转发器（只监听 127.0.0.1）。转发器原样转发请求，包括事件 WebSocket，并加上设备凭证；没有设备凭证，偷走的替身也用不了。
- 第一个账号由 `FEISHU_PROFILE` 选中，其余账号用 `--profile` 选择；会话说明会告诉 Agent 不要运行 `auth login` / `logout`，缺权限时请本人在 Connectors 重新授权。运行结束时删除 profile，Worker 崩溃留下的 profile 在下次启动时按清单回收。

### Server 侧：飞书网关（`/api/feishu-gw/*`）

网关对每个请求重新鉴权，自己应答 tenant token 请求与用户 token 刷新（真实登录只由 Server 刷新，距离过期不足 30 分钟时），把替身换成真实 token 后流式转给飞书（分片上传、Range 下载原样透传），在飞书已授予的 scope 内透传、只拒绝一小组签发凭据与租户管理的路径，并按会话和应用限流、逐请求审计。鉴权条件、黑名单、限流数值与审计字段是安全边界，只写在[安全边界 · Feishu Gateway](security.md#feishu-gateway)。审计经 `GET /api/feishu-gateway/requests` 读取（默认自己会话的记录，Admin 加 `?all=1` 看所有人的）。

- **事件**：Agent 可以用 MCP `feishu_events` 订阅自己有账号的飞书应用的事件，按游标读取；`feishu-cli event consume` 经网关拿到同样的事件。事件来自 Server 对每个应用唯一的那条长连接（`internal/feishuevents`，与渠道的 Bot 共用），每个会话最多 8 个订阅，每个订阅最多缓存 500 条未读事件。

### 账号生命周期

- **授权范围**：不指定 scope 时使用预设 `feishu-cli-recommended`，即 `feishu-cli` v1.41.0 `auth login --recommend` 的推荐清单，加上 Skill 显式申请的 `im:chat:create`。来源写在 `feishu_scopes.go`，这是 `feishu-cli` 的清单，不是飞书全部 scope 的目录。每次登录都会附加 `offline_access` 和 `auth:user.id:read`。可能需要租户管理员审批的 scope 只在本人勾选后申请，也可以填一份清单替换预设。授权后报告未获授予的 scope；没有 refresh token 的授权直接拒绝。
- **状态**：ready / expiring / needs_reauth / revoked。refresh token 7 天不用就失效；打开“保持登录”后，每小时巡检一次，refresh token 剩余不足 24 小时就刷新；授权本身最长一年。
- **重新授权**：在原账号上重新扫码，账号 id、名称、保持登录设置和 Workspace 绑定都不变；登录成另一个飞书用户会被拒绝，需要作为新账号连接。
- **立即停用**（revoke）：在飞书侧吊销登录并删除 Server 上的授权，账号标为 revoked 保留在列表中；网关从下一个请求起拒绝。**移除**：吊销后删除账号及其所有绑定。
- **应用密钥**：可以在 Connectors 替换。集成开启时，新密钥要先经飞书验证通过才保存。还有账号或 Workspace Bot 在用的应用不能删除。

### 关键决定

- **2026-10-27 本人设备登录自动可用（DEV-052）**：用户反馈 bytedcli 在 linux-dev 已登录，仍每个 Workspace 需要点击授权。编排会话依据该请求决定：设备所有者本人非沙箱会话直接使用设备报告的有效登录；Workspace 绑定仅用于显式共享给其他成员。该决定由编排会话在用户请求范围内作出，用户可调整。Workspace 页面显示本人自动可用、身份与到期，基础登录只在缺失或过期时提供登录入口；共享开关独立。附加授权组随会话携带本地检查元数据，Agent 区分 Meego 网页会话 ready、missing / expired 和未验证。既有本人专用绑定可保留，不再控制本人可用性；本次新增 `device_connector_states.authorizations` JSON 元数据列，修复此前附加授权状态未持久化的问题；部署前在线备份数据库。按 Workspace 对本人的显式停用需要新增存储语义，留作后续，不用“移除绑定”假装撤销本地权限。

- **2026-10-11 Server 持有登录、集中刷新**（#122 Server 端，#123 页面与 Worker）。原因是 refresh token 一次性使用，设备之间无法共享一份登录。
- **2026-10-12 网关取代下发 token**（#124）。#123 时设备还会拿到应用密钥和短期 access token；改为设备只持有 App ID 和可撤销的替身。同时决定：一次切换，旧 Worker 在更新前拿不到飞书账号；在已授予的 scope 内透传加黑名单，不做逐接口白名单；Agent 默认可以以应用 Bot 身份调用，不设开关；事件同时提供 MCP 工具和 `event consume`。迁移把以前存在设备上的密钥标为需要轮换，Connectors 和 Channels 页会提示本人在飞书重置密钥后粘贴到这里。
- **2026-10-13 “外部账号”改名为 Connectors，Workspace 的“账号”页改名为 Connectors**（#125），旧 URL 重定向。
- **2026-10-15 连接器成为封闭模块，分 Server 持有型与设备持有型；bytedcli 是第一个设备持有型**（本人批准）。bytedcli 的登录不放 Server：Server 在 ByteDance 内网之外用不了；多台设备共用一份登录会互相抢刷新；公司 SSO 凭据导出到外部 Server 有合规风险。同时决定：连接器用描述数据声明、平台差异用小的代码适配器，不用 Go plugin 或动态加载；登录经 CLI 自己的非阻塞设备码流程（`--begin` / `--complete`）由 Web 中转验证页面，complete token 不离开设备；Foundry 自己运行 bytedcli 时设 `BYTEDCLI_NO_AUTO_UPGRADE=1`（读状态不顺带升级本人的 CLI）；不能使用设备登录的他人会话用 `BYTEDCLI_PROFILE` 指向空 profile，只防误用。

## 实现边界

截至 2026-10-15（`3e3cb2b` 加未提交的工作区改动：模块边界与 bytedcli）。

**已实现**

- DEV-052（2026-10-27）：`connectors/deviceheld.go` 按设备登录状态自动供本人非沙箱会话使用；`DeviceConnectorUse.state` 只携带已检查身份、到期与附加授权元数据，解决执行宿主与 daemon 不共享缓存。Worker 会话说明准确标出 Meego 独立网页会话状态；Workspace Connectors 只管理登录与成员共享。验证和部署状态见 [DEV-052](devlog/DEV-052-device-connector-auto.md)。

- 账号、应用、登录、刷新、保持登录、吊销、会话授权：`apps/server/internal/externalaccounts`（`service.go`、`logins.go`、`tokens.go`、`sessions.go`、`apps.go`、`feishu.go`、`feishu_scopes.go`）。
- 网关：`apps/server/internal/feishugateway`（`gateway.go`、`policy.go`、`ratelimit.go`、`events.go`），HTTP 入口在 `httpapi/external_accounts_gateway.go`。
- HTTP：`httpapi/external_accounts.go`（页面数据、应用、连接与扫码、刷新、停用、移除、Workspace 绑定，以及 `run_session` 下发的账号）。
- 事件：`apps/server/internal/feishuevents`（`subscriptions.go`、`apps.go`），MCP 工具在 `httpapi/feishu_events.go`。
- Worker：`packages/worker/src/external-accounts.ts`（profile 生成与回收、会话说明），`feishu-gateway-forwarder.ts`。
- Web：`apps/web/src/features/external-accounts`（Connectors 页、Workspace 的 Connectors 页、连接与授权对话框）。每个应用的行会列出运行在它上面的 Workspace Bot、打开的 Agent 订阅和连接状态（`GET /api/feishu/app-uses`）。
- `FOUNDRY_INTEGRATIONS=off` 时登录、刷新、吊销、保持登录和网关转发都不出站（`internal/integrations`）。
- 模块入口（未提交，2026-10-15）：`apps/server/internal/connectors`（`catalog.json` 与 `catalog.go` 目录，`module.go` 的 `Module` 与 `SessionConnectors`，`deviceheld.go` 设备持有型服务与 `DeviceEligible`）；会话派发只调用 `httpapi/external_accounts.go` 的 `sessionConnectors`。Worker `packages/worker/src/connectors/index.ts`；Web 每种连接器一个 Tab，`connector-types.ts` 标明持有方式。边界由 `scripts/audit-module-boundaries.mjs` 规则 6、7 检查。
- bytedcli（未提交，2026-10-15）：Worker `connectors/device-held.ts`（检测：Foundry 管理的副本优先，再找 PATH 与常见安装目录；可用条件 TCP 检查；经 managed-tools 安装 npm 包，来源用设备的 npm 设置，版本由设备的 `npm view` 决定；动作逐连接器串行）、`connectors/bytedcli.ts`（`auth status` / `auth login --begin|--complete` / `auth logout` 的输出解析与会话说明），daemon 消息 `connector_request` / `connector_reply`（Worker 声明 `device_connectors` 能力）。Server `httpapi/connectors.go`：`GET /api/connectors/devices[?refresh=1]`（只列本人设备，读取超过 2 分钟的在线设备），`POST /api/devices/{deviceId}/connectors/{kind}/check|install|sign-in|sign-in/poll|sign-out`（只限设备所有者；同一登录 2 秒内的轮询共用一次答复），`GET|PUT /api/workspaces/{id}/device-connectors`；存储 `sqlitestore/device_connectors.go`（表 `device_connector_states`、`device_connector_bindings`，删除 Workspace 或移除设备时一并删除）。到期提醒：登录进入提醒窗口（3 天）的首次检查时间记为 `expiringSince`，重新登录后清除；Connectors 页在列表上方提醒。Web `features/external-accounts/device-held-connector.tsx`、`device-sign-in-dialog.tsx`、`workspace-device-connectors.tsx`。

**未实现 / 已知缺口**

- Server 持有型有飞书与 Cloudflare（Cloudflare 见下文）。存储里旧的 `device_local` 凭据模式仍无人使用；设备持有型不走 `external_accounts`，而是 `internal/connectors`。
- bytedcli 只读默认站点（`BYTEDCLI_CLOUD_SITE` 或 cn）的登录，其他站点（i18n-*、us-ttp、eu-ttp）的登录 Foundry 不显示，也不提供按站点登录；`--session` 浏览器会话类登录也不经 Foundry。
- 设备持有型的“不能用”只防误用：未沙箱的会话以设备用户身份运行，能自己去掉 `BYTEDCLI_PROFILE` 读到设备所有者的登录（与设备凭证的已知风险相同）；旧 Worker 不认识 `device_connectors`，它上面的他人会话不受隔离。
- 设备绑定的增删没有审计记录（飞书账号的绑定有）；没有后台定时检查，状态只在打开页面、手动检查或操作后更新，到期提醒只在 Connectors 页显示。
- 页面在 2 分钟内不会重新读同一台设备：设备网络刚变化时要点“重新检查”。
- Foundry 安装的 bytedcli 约 400 MB（npm 依赖），不运行 install 脚本，`--version` 与 `auth status` 在 0.170.0 上实测可用；设备自带的副本由 CLI 自己更新，Foundry 不提供升级。
- 网关经替身无法完成的命令：`feishu-cli auth token --as bot`、`doctor` 的 token 检查、`markdown fetch --as bot`。它们直接向飞书账号服务器要 Bot token，替身过不了（会话说明里写明了）。只针对 `feishu-cli` 1.41.0 验证过；其他版本会提示会话。
- 以 Bot 身份调用时，不限于路由到该 Workspace 的群。设计稿里的“只能发到本 Workspace 的群”没有实现。
- 网关审计只有 API，Web 上没有查看入口。
- 防的是“设备上没有真实凭据、会话结束即失效”，不是对 Agent 隐藏访问能力：未沙箱的会话能读到设备凭证，会话存活期间它能做的事与 `feishu-cli` 一样（见 [security.md](security.md) 中关于设备凭证的已知风险）。

**与[账号与权限设计](accounts-permissions-design.md) P3 的关系**

- 已经交付的：个人连接归属到人，本人把它绑定到 Workspace；会话按“本人发起、本人设备、已绑定”使用；每次网关调用都记录账号和身份。设备持有型的绑定可以显式允许其他成员在那台设备上的会话使用设备所有者的登录（默认关闭）。
- 仍属于 P3、未做的：把自己的连接授权给其他成员的会话使用（协作者执行时按 §3.1 的顺序解析凭证，并把来源记入 Session）；Claude / Codex 等模型连接的 Workspace 授权；飞书用户与 Foundry 账号的身份绑定（见[渠道](channels.md#后续)）。

**验证情况**

- 2026-10-13 在 dev 上真实使用：一个会话经网关使用同一个人在两个不同租户下的两个飞书账号，分别以用户和 Bot 身份执行只读调用；设备上只有替身，审计记录与调用一致（#125）。
- 2026-10-12：用真实 `feishu-cli` 1.41.0，经过真实的 Worker 转发器和网关，对假飞书跑合同测试，覆盖用户调用、Bot 调用、21 MiB 分片上传、Range 下载和 `event consume`；假飞书只见到真实 token（`httpapi/external_accounts_cli_contract_test.go`，没有 `feishu-cli` 或 node 时跳过）。
- 网关鉴权、吊销、黑名单、限流、审计：`httpapi/external_accounts_gateway_test.go`、`feishugateway/gateway_test.go`；服务层：`externalaccounts/service_test.go`；Worker：`packages/worker/test/external-accounts.test.mjs`。
- 扫码新建应用在真实飞书上的检查：到 2026-10-13 仍列为待本人确认，这次整理没有找到运行记录。
- 模块重构后（2026-10-15）飞书的既有测试不改断言全部通过，包括用真实 `feishu-cli` 跑的合同测试（只改了被移动文件的路径与会话派发的调用方式）。
- bytedcli（2026-10-15）：状态与登录输出的形状取自 mac-laptop 上真实的 bytedcli 0.170.0（经计算租约只读运行 `auth status --json`；一次性 `--profile foundry-test-1` 上的 `--begin`，未完成，用后删除），整理为 `packages/worker/test/fixtures/bytedcli-outputs.json`（姓名与邮箱已替换）；用假 bytedcli 测试 Worker 的状态、登录、拒绝、过期、登出、安装与会话说明（`connectors-device-held.test.mjs`），Server 测试经假 Worker 的整条链路与权限（`httpapi/connectors_test.go`）、目录与资格规则（`connectors/connectors_test.go`），Web 测试 `device-held-connectors.test.mjs`。在 scratch stack 上用假 bytedcli 实测：网络不通的设备显示“不提供”；用只换掉 `/etc/hosts` 的 bwrap 让 Worker 的网络检查通过后，Connectors 页键盘发起登录、二维码与链接、批准后完成，亮色、暗色、窄屏都检查过；Workspace 绑定后真实 Claude 会话的说明里出现 bytedcli 那一行。真实 bytedcli 的完整登录没有经 Foundry 跑过（规定不在本人的默认 profile 上登录）。

## Cloudflare（#141）

Cloudflare 是第二个 Server 持有型连接器，入口为 `/connectors/cloudflare`。Server 经 Cloudflare 官方 MCP 授权服务器的 OAuth（Authorization Code + PKCE，动态注册的公开客户端；第三方不支持设备码）取得授权，范围默认只读（`account:read`、`zone.read`、`dns.read`、`ssl-and-certificates.read`，见 `externalaccounts/cloudflare.go`）；凭据封存在 Server。授权后在 Connectors 中为该账号选择可用的 zone 与 Workspace，会话经 Server 的 Cloudflare 网关或 Foundry MCP 的 Cloudflare 工具（`connectors/cloudflare_gateway.go`）只能读到选定的 zone，Worker 侧适配器为 `packages/worker/src/connectors/cloudflare.ts`。写权限按具体计划增量申请，尚未开放。本人的真实批准与真实资源核验待完成，见 [DEV-035](devlog/DEV-035-cloudflare-connector.md)。

## AWS CLI（2026-10-23）

AWS CLI 是设备持有型连接器，入口为 `/connectors/aws`；设备有效登录自动向设备所有者本人非沙箱会话下发使用说明，Workspace Connectors 的共享绑定用于其他成员。Foundry 检测已有 `aws`，用限时 STS GetCallerIdentity 核验身份，沿用 Worker 原生凭据链；密钥与 SSO 缓存不离开设备。安装由设备所有者在设备行点击“安装 AWS CLI”（DEV-093），过程中显示下载进度（DEV-099）。登录优先走浏览器（DEV-099）：控制台登录在设备上运行 `aws login --remote`，本人把 AWS 页面显示的授权码粘贴回 Foundry；IAM Identity Center 先写入 staging profile，用 `aws sso login --use-device-code` 登录，成功后才写入 default。两种方式都需要 Worker 能力 `connector_browser_sign_in_v1`。终端命令（`aws configure sso --profile default`、`aws configure`、`aws sso login`）折叠为最后手段；退出仍在终端进行；命名 profile 通过 Worker 的 `AWS_PROFILE` 选择。设备所有者无须绑定；其他成员未获共享授权或登录不可用时，会话覆盖 AWS 凭据链环境变量。未沙箱进程可主动绕过环境变量，因此这不是系统安全边界。

目录支持 `tool.source: "device"`（外部安装）、`"installer"`（厂商官方的当前用户安装程序，由 Worker 适配器运行）、`tool.minimumVersion`（更旧的副本显示为过旧并提供安装）和 `authentication: "local"`（终端管理）；适配器为 `packages/worker/src/connectors/aws.ts`，安装在 `aws-install.ts`：不用 sudo，布局与 AWS 官方用户级安装脚本一致（程序在 `~/.local/share/aws-cli`，`aws`、`aws_completer` 链接在 `~/.local/bin`），Linux 运行 zip 内的 `install --install-dir --bin-dir`（已有则 `--update`），macOS 以 `CurrentUserHomeDirectory` 和 customLocation 选择安装 pkg 后按文档建链接；设备有 gpg 时用 AWS 公布的密钥（FB5D…475C）校验 zip 签名，pkg 必须带 Amazon 的 Apple 签名；下载走设备的 HTTP(S)_PROXY；最后用 `aws --version` 确认是 v2，并在 Foundry 工具目录链接一份让会话优先使用。`~/.local/bin/aws` 若是别的副本（如 pip 装的 v1）不会被覆盖，失败原因会说明。Worker 以 `connector_installer_v1` 能力声明支持，旧 Worker 的行提示先更新 Worker。错误输出只映射为固定说明，不回传原始 stderr；网络失败不会当作退出登录。STS 成功不代表拥有业务权限，不推断凭据到期时间。网页 SSO、多个 profile 的单独绑定尚未实现。验证与部署见 [DEV-037](devlog/DEV-037-aws-cli-connector.md)。

## 后续

待办、依赖与完成标准统一维护在 [Roadmap · 连接器](roadmap.md#连接器)，本页不再单独列清单。

## 代码位置

- 模块入口与设备持有型：`apps/server/internal/connectors/`（`catalog.json`、`catalog.go`、`module.go`、`deviceheld.go`）
- Server 持有型服务与提供方：`apps/server/internal/externalaccounts/`
- 网关：`apps/server/internal/feishugateway/`
- 事件订阅与应用凭据读取：`apps/server/internal/feishuevents/`（与[渠道](channels.md)共用）
- 集成开关：`apps/server/internal/integrations/`
- HTTP：`apps/server/internal/httpapi/connectors.go`、`external_accounts.go`、`external_accounts_gateway.go`、`feishu_events.go`；访问规则 `routes.go`；MCP 工具定义 `httpapi/mcp_tools.json`（`feishu_events`）
- 存储：`apps/server/internal/store/external_accounts.go`、`feishu_gateway.go`、`device_connectors.go`；`apps/server/internal/sqlitestore/external_accounts.go`、`feishu_gateway.go`、`device_connectors.go`
- 协议类型：`packages/protocol/src/external-accounts.ts`、`connectors.ts`
- Worker：`packages/worker/src/connectors/`（`index.ts` 入口，`feishu.ts`、`feishu-gateway-forwarder.ts`、`device-held.ts`、`bytedcli.ts`），daemon 处理 `packages/worker/src/daemon/handlers/connectors.ts`
- Web：`apps/web/src/features/external-accounts/`、`apps/web/src/api/connectors.ts`、`apps/web/src/lib/connector-types.ts`；文案 `apps/web/src/i18n/locales/{en,zh-CN}/externalAccounts.ts`
