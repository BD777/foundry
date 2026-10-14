# 连接器

[项目 Roadmap](../README.md#roadmap) · [文档索引](README.md)

连接器负责 Agent 在会话里使用的外部应用和账号：Server 保管外部应用的密钥和个人登录，账号绑定到 Workspace 后，会话经 Server 的网关以本人或应用 Bot 的身份调用外部服务，设备上不留任何真实凭据。目前只接了飞书：Agent 用 `feishu-cli`，配合 Workspace 的 `feishu-cli-*` Skill。它不负责人从飞书找到 Foundry（那是[渠道](channels.md)，渠道的 Bot 运行在这里的一个飞书应用上），也不负责 Claude / Codex 的登录与模型服务（属于“模型与账号”）。在分层图中属于“能力供给”层：依赖“身份与共享”（账号归属、Workspace 角色）和“设备与 Workspace”（设备凭证、会话所在设备）；被 Agent 能力面（`feishu_events` 工具，以及会话启动时下发的账号）和渠道使用。Web 里的位置有两处：全局的 Connectors 页（`/connectors/feishu`，每种连接器一个 Tab，目前只有飞书）管理自己的应用和账号；Workspace 的 Connectors 页（`/workspace/connectors`）选择这个 Workspace 的会话可以使用自己的哪些账号，并显示其他成员绑定的账号。

## 设计

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

- **2026-10-11 Server 持有登录、集中刷新**（#122 Server 端，#123 页面与 Worker）。原因是 refresh token 一次性使用，设备之间无法共享一份登录。
- **2026-10-12 网关取代下发 token**（#124）。#123 时设备还会拿到应用密钥和短期 access token；改为设备只持有 App ID 和可撤销的替身。同时决定：一次切换，旧 Worker 在更新前拿不到飞书账号；在已授予的 scope 内透传加黑名单，不做逐接口白名单；Agent 默认可以以应用 Bot 身份调用，不设开关；事件同时提供 MCP 工具和 `event consume`。迁移把以前存在设备上的密钥标为需要轮换，Connectors 和 Channels 页会提示本人在飞书重置密钥后粘贴到这里。
- **2026-10-13 “外部账号”改名为 Connectors，Workspace 的“账号”页改名为 Connectors**（#125），旧 URL 重定向。

## 实现边界

截至 2026-10-14（`3092162`）。

**已实现**

- 账号、应用、登录、刷新、保持登录、吊销、会话授权：`apps/server/internal/externalaccounts`（`service.go`、`logins.go`、`tokens.go`、`sessions.go`、`apps.go`、`feishu.go`、`feishu_scopes.go`）。
- 网关：`apps/server/internal/feishugateway`（`gateway.go`、`policy.go`、`ratelimit.go`、`events.go`），HTTP 入口在 `httpapi/external_accounts_gateway.go`。
- HTTP：`httpapi/external_accounts.go`（页面数据、应用、连接与扫码、刷新、停用、移除、Workspace 绑定，以及 `run_session` 下发的账号）。
- 事件：`apps/server/internal/feishuevents`（`subscriptions.go`、`apps.go`），MCP 工具在 `httpapi/feishu_events.go`。
- Worker：`packages/worker/src/external-accounts.ts`（profile 生成与回收、会话说明），`feishu-gateway-forwarder.ts`。
- Web：`apps/web/src/features/external-accounts`（Connectors 页、Workspace 的 Connectors 页、连接与授权对话框）。每个应用的行会列出运行在它上面的 Workspace Bot、打开的 Agent 订阅和连接状态（`GET /api/feishu/app-uses`）。
- `FOUNDRY_INTEGRATIONS=off` 时登录、刷新、吊销、保持登录和网关转发都不出站（`internal/integrations`）。

**未实现 / 已知缺口**

- 只有飞书一个提供方。存储里有 `device_local` 凭据模式，但目前没有提供方使用。
- 网关经替身无法完成的命令：`feishu-cli auth token --as bot`、`doctor` 的 token 检查、`markdown fetch --as bot`。它们直接向飞书账号服务器要 Bot token，替身过不了（会话说明里写明了）。只针对 `feishu-cli` 1.41.0 验证过；其他版本会提示会话。
- 以 Bot 身份调用时，不限于路由到该 Workspace 的群。设计稿里的“只能发到本 Workspace 的群”没有实现。
- 网关审计只有 API，Web 上没有查看入口。
- 防的是“设备上没有真实凭据、会话结束即失效”，不是对 Agent 隐藏访问能力：未沙箱的会话能读到设备凭证，会话存活期间它能做的事与 `feishu-cli` 一样（见 [security.md](security.md) 中关于设备凭证的已知风险）。

**与[账号与权限设计](accounts-permissions-design.md) P3 的关系**

- 已经交付的（只覆盖飞书外部账号）：个人连接归属到人，本人把它绑定到 Workspace；会话按“本人发起、本人设备、已绑定”使用；每次网关调用都记录账号和身份。
- 仍属于 P3、未做的：把自己的连接授权给其他成员的会话使用（协作者执行时按 §3.1 的顺序解析凭证，并把来源记入 Session）；Claude / Codex 等模型连接的 Workspace 授权；飞书用户与 Foundry 账号的身份绑定（见[渠道](channels.md#后续)）。

**验证情况**

- 2026-10-13 在 dev 上真实使用：一个会话经网关使用同一个人在两个不同租户下的两个飞书账号，分别以用户和 Bot 身份执行只读调用；设备上只有替身，审计记录与调用一致（#125）。
- 2026-10-12：用真实 `feishu-cli` 1.41.0，经过真实的 Worker 转发器和网关，对假飞书跑合同测试，覆盖用户调用、Bot 调用、21 MiB 分片上传、Range 下载和 `event consume`；假飞书只见到真实 token（`httpapi/external_accounts_cli_contract_test.go`，没有 `feishu-cli` 或 node 时跳过）。
- 网关鉴权、吊销、黑名单、限流、审计：`httpapi/external_accounts_gateway_test.go`、`feishugateway/gateway_test.go`；服务层：`externalaccounts/service_test.go`；Worker：`packages/worker/test/external-accounts.test.mjs`。
- 扫码新建应用在真实飞书上的检查：到 2026-10-13 仍列为待本人确认，这次整理没有找到运行记录。

## 后续

Roadmap 没有为连接器列出下一步。已知可做的方向，都还没有排期：

- 第二种提供方，需要时再按 `externalaccounts.Provider` 接入；设备绑定型的 CLI 走 `device_local` 模式。
- 把账号授权给协作者的会话使用（P3）。
- 在 Web 上查看网关审计。

## 代码位置

- 服务与提供方：`apps/server/internal/externalaccounts/`
- 网关：`apps/server/internal/feishugateway/`
- 事件订阅与应用凭据读取：`apps/server/internal/feishuevents/`（与[渠道](channels.md)共用）
- 集成开关：`apps/server/internal/integrations/`
- HTTP：`apps/server/internal/httpapi/external_accounts.go`、`external_accounts_gateway.go`、`feishu_events.go`；访问规则 `routes.go`；MCP 工具定义 `httpapi/mcp_tools.json`（`feishu_events`）
- 存储：`apps/server/internal/store/external_accounts.go`、`feishu_gateway.go`；`apps/server/internal/sqlitestore/external_accounts.go`、`feishu_gateway.go`
- 协议类型：`packages/protocol/src/external-accounts.ts`
- Worker：`packages/worker/src/external-accounts.ts`、`feishu-gateway-forwarder.ts`
- Web：`apps/web/src/features/external-accounts/`、`apps/web/src/api/connectors.ts`、`apps/web/src/lib/connector-types.ts`；文案 `apps/web/src/i18n/locales/{en,zh-CN}/externalAccounts.ts`
