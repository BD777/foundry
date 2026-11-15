# DEV-232 Cloudflare Tunnel 被拒且说错原因；内置连接器的访问级别改为声明文件

状态：已部署 dev，待本人验收；已合入 main（PR #268）。

## 问题

2026-11-15 `sess_1794748572690000429`（排查极空间 Vault 经 Cloudflare Tunnel 无法访问）在工作区 `workspace`（`ws_0fde4df9…`）里读 Tunnel 被拒了 7 次，最后对本人说“Foundry 不让我改 Tunnel 配置”，没有说怎么放开。本人随后问：各连接器的权限选项是不是配置驱动的，能否把选项补全，并把说明写清楚。

## 调查

- 账号事件（`external_account_events`，账号 `xacc_68a4…`）：本人 13:18:20 给该工作区绑定了 4 个 zone，级别是 `dns_edit`。会话的 `GET /zones` 和 `GET /zones/:id/dns_records` 都被放行；`/accounts/…/cfd_tunnel`、`…/cfd_tunnel/<id>`、`…/connections`、`…/configurations` 共 7 次被拒，审计行只写了 `GET unsupported_path refused`，看不出原因。
- Tunnel 和 Access 接口需要 `zero_trust` 级别，OAuth 授权里已经有 `argotunnel.read/write` 等 scope，所以拦它的是 Foundry 的工作区级别，Cloudflare 那边没有拒。
- 拒绝原因说错了：低于 `zero_trust` 时，Holdings 不会列出 zone 所属的账号，网关先判“资源未绑定”，回的是“that zone is not bound to this workspace”。会话收到的是这句，而不是“需要 Zero Trust 级别”。
- `GET cfd_tunnel/<id>/connections`（Tunnel 连接状态，排查 Error 1033 最需要的接口）在任何级别都不放行。
- 内置连接器的级别写死在两个地方：Go（`CloudflareAccessLevels`、`AppStoreConnectAccessLevels`、Cloudflare 网关里的路径白名单）和 Web（`level === "zero_trust" ? t(...)` 这类分支，App Store Connect 连级别列表都写死了）。扩展型连接器（OpenLark）本来就由描述符驱动，固定为 `read`/`write` 两档。

## 修复

- 每个内置的服务器持有型连接器有一份声明文件 `apps/server/internal/externalaccounts/access/<kind>.json`：级别名、所需 scope、中英文名称、说明（这一档比上一档多了什么、还不能做什么、什么时候选）、重新授权提示。Cloudflare 的文件还列出每个级别放行的路由（方法、路径模板、动作、读请求可带的查询参数）。加载时会校验：级别必须存在，读请求不能带动作而写请求必须带，标识符和方法必须是已知的，同一路由不能出现两次，有 scope 的级别必须带重新授权提示。
- Cloudflare 网关按文件判定：zone 读取、DNS 写入和账号级 Zero Trust 路由都从同一张表来。新增一个只读端点只需改这个文件；写操作的 `action` 对应网关里的请求体检查（Bypass 拒绝、服务令牌 secret 脱敏等），新的写操作仍需要代码。
- 新放开 `GET /accounts/<account>/cfd_tunnel/<id>/connections`，级别 `zero_trust`。
- 低于 `zero_trust` 时，账号级请求按级别拒绝：返回 `access_level`、所需级别和当前级别的名称（如 `"Read + DNS edit + Zero Trust" (zero_trust)`），以及去哪里改。路径不在表里时，拒绝信息会列出该类别下放行的路由和各自需要的级别。
- 审计行写明路由模板和原因，例如 `GET /accounts/:id/cfd_tunnel/:id/connections refused access_level needs zero_trust, has dns_edit`。
- Web 的 Cloudflare 和 App Store Connect 级别单选、Cloudflare 活动里的级别名，都改为显示 Server 下发的文字；缺少 scope 时的提示用该级别自己的重新授权说明。删除了写死的级别文案。
- Foundry skill（revision 40）：说明 DNS edit 和 Zero Trust 各自放开什么；被拒时要告诉本人需要的级别名称和修改位置。
- 文档：`docs/connectors.md` Cloudflare 一节。

## 没有新增级别

这次没有新增级别。级别是线性的，每一档包含之前各档。如果加一个“Zero Trust 只读”，它只能排在 DNS edit 之后，选它就必须连带 DNS 写入，不符合最小权限。所以这次只把现有三档写清楚，并补上排查 Tunnel 缺的那个只读接口。以后需要新级别或新端点，改声明文件即可。Cloudflare 的完整 API 有几百个 scope，这里列的是 Foundry 已放行的子集，不是全集。

## 检查

- Go：`go test ./internal/connectors ./internal/externalaccounts ./internal/builtinskills`；`./internal/httpapi -run 'Cloudflare|AppStore|External|Provider|EdgeAccess|Connector'`。新增 `TestCloudflareTunnelConnectionsReadNeedsZeroTrustAndAuditsTheReason`（`zero_trust` 能读 connections；`dns_edit` 被拒，原因是 `access_level`，不再是 not bound，也不到上游；审计行正确；未列出的 `/token` 被拒，拒绝信息列出放行的路由）和 `TestAccessCatalog*`（声明文件能加载、双语齐全、错误声明被拒）。`TestCloudflareReadLevelRefusesChanges…` 的期望改为新的级别名称写法。
- Web：`pnpm typecheck`、`pnpm audit:ui`，`appstoreconnect` / `external-accounts` / `edge-access` / `cloudflare-scopes` / `server-held-connectors` 测试通过；`appstoreconnect` 测试新增断言：单选显示 Server 下发的名称和说明。
- Worker：`foundry-skill.test.mjs` 通过；Foundry skill revision 40 已登记。
- 部署：Mac mini 上 `remote-build.sh` 构建，`deploy-dev.sh --label dev232` 部署。Server `8a9318d07c58…`（14:10:41Z 接管，回滚副本 `foundry-server.pre-dev232`）；Web `8cdbaa33c7b83ff3`（替换 `a4e4ae93…`）。替换时用了 `--replaces`，因为当前树里还有一处未部署的改动：`chat-model.ts` 的首条消息重复显示修复（`sess_1794749742670096672`，已有测试，当时因树上 typecheck 不过而未部署），这次一起上线。
- 线上 API（e2e-alice）：`GET /api/external-accounts` 的 Cloudflare 三档和 App Store Connect 两档都带中英文名称和说明；`dns_edit`、`zero_trust` 带重新授权提示。
- 真实浏览器（e2e-alice，headless Chromium，只注入 GET：一个合成 Cloudflare 身份和绑定 `dns_edit`，未发出任何写请求）：会话权限单选显示 Server 下发的三档说明；授权里没有 Zero Trust 的 scope 时，第三档不可选，并给出需要的 scope 和重新授权时该勾选的 Cloudflare 权限；活动里的级别变化显示为“只读 → 只读 + DNS 编辑”。e2e-alice 的账号语言是中文，英文只由单元测试覆盖。截图在本机 `/tmp`，验后已删除。
- 真实网关（本人 `workspace`，当前 `dns_edit`；检查会话 `sess_1794752179875450809` 只发 GET）：`/zones/<id>` 200；`…/cfd_tunnel/<id>/connections` 403，`foundry.reason=access_level`，`needed=zero_trust`，`current=dns_edit`，消息里带级别名称和修改位置；`…/cfd_tunnel/<id>/token` 和 `/zones/<id>/analytics/dashboard` 403 `path_not_allowed`，消息列出放行的路由。审计行依次是 `GET /zones/:id forwarded`、`GET /accounts/:id/cfd_tunnel/:id/connections refused access_level needs zero_trust, has dns_edit`、`GET unsupported_path refused path_not_allowed` ×2。第一次检查用的是只读验证会话（`sess_1794751875500127957`），这类会话不注入连接器凭据，所以一个请求都没发出去，于是改用普通会话重跑。

## 限制

- 拒绝信息里的路径只把 32 位 hex id 换成 `:id`；Tunnel 的 UUID 原样显示（不是秘密）。
- App Store Connect 的网关按 App 资源树判定，规则仍在代码里；它的声明文件只有级别和说明。
- 扩展型连接器仍由描述符的 `read`/`write` 决定，这次没有改动。
- 本人的 `workspace` 仍是 `dns_edit`。是否调到 Zero Trust 由本人决定，Foundry 没有代改。

## 验收

1. 打开 Connectors → Cloudflare → 工作区访问，选 `workspace`。三档都有说明；第三档写明能读 Tunnel 连接状态、改 Public Hostname，以及不能做什么。
2. 把 `workspace` 调到“只读 + DNS 编辑 + Zero Trust”，让一个会话读 Tunnel `99734e87…` 的 connections：应返回连接列表（4 条，`protocol=http2`）。
3. 调回“只读 + DNS 编辑”再读：应返回 403，消息里写需要 Zero Trust 级别、在哪里调。身份的活动里能看到级别变化。
