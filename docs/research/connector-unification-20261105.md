# 方案：连接器的统一骨架与设备持有型凭据代理（2026-11-05）

[连接器](../connectors.md) · [连接器扩展](../connector-extensions.md) · [上一版方案稿](connector-architecture-20261030.md)

状态：方向经本人确认（2026-11-05，编排会话 `sess_1793855865906282308`）；分步实施，进度见文末。外部工具的行为写明实测与否。

## 1. 结论

- **原则（本人确认）**：连接器只做凭据面（身份、刷新、工作区授权、逐请求判定、审计）。工具面用工具自己的 CLI 和它自带的技能，原样使用，Foundry 只替换凭据；Foundry 自己的 MCP 工具只做 Agent 原生做不到的事（飞书事件长连接）。不在描述符里重复描述官方 skills / MCP。飞书保持社区的 `feishu-cli`，不换官方 lark-cli（本人决定）。
- **统一的形式是组合，不是继承**：一条顺序固定的流水线加几个窄接口；只统一真正相同、又属于安全边界的那部分，传输和 CLI 配置格式由各连接器自己实现。设备持有型已是这种形状（`DeviceHeldAdapter`）；Server 持有型的登录层已统一（`externalaccounts/provider.go`），网关层还是两套，本方案把它收成一条流水线。
- **设备持有型（本人确认）**：工具自己的存储仍是唯一来源、唯一刷新方，设备所有者在 Foundry 外照常使用；Foundry 只管自己会话里用哪份、怎么用，在 Foundry 里不许用错。请求在设备上完成，不经过 Server。会话里不出现真凭据：只有“替身 + 本机转发”和“只选 profile”两档，不做短期 token 注入，也不做凭据端点（Agent 能自己取到真凭据）。

## 2. 现在的分层

```
会话：环境变量（替身、选择变量、isolationEnv）+ Foundry MCP instructions + foundry skill + 技能库（工具自带的技能包）
Web   features/external-accounts：按描述数据渲染；飞书、Cloudflare 各有专用面板
契约  contracts/models/connectors.yaml → protocol（描述符、设备状态、扩展 JSON-RPC）
Server internal/connectors.Module
       Catalog（catalog.json + 设备上报的扩展描述符）· SessionConnectors（派发资格）
       ServerHeld：externalaccounts（Provider：登录、刷新、吊销、身份）· feishugateway · CloudflareGateway
       DeviceHeld：状态清洗、到期提醒、登录和授权的操作槽
Worker connectors/：prepareSessionConnectors · 转发器（飞书和 Cloudflare 共用一份）
       DeviceHeldRuntime + 适配器：内置（aws、github）· 扩展（JSON-RPC 程序或声明式）
工具自己的存储（设备上）：bytedcli 数据目录、~/.lark-cli、~/.config/gh、~/.aws …
```

## 3. Server 持有型：一条流水线

### 3.1 现状

| 层                     | 飞书                                                      | Cloudflare                                               | 是否统一                       |
| ---------------------- | --------------------------------------------------------- | -------------------------------------------------------- | ------------------------------ |
| 登录、刷新、吊销、身份 | `DeviceFlowProvider`                                      | `AuthorizationCodeProvider`（PKCE）                      | 已统一（`ServerHeldProvider`） |
| 资格                   | `externalaccounts.Permitted`                              | 同                                                       | 已统一                         |
| 替身                   | `feishu_gateway_grants`，`fsg_` 派生 `fsu_`/`fsr_`/`fst_` | `fdycf_`，经 `connectorHandleIssuer` 分发                | 接口统一，实现两套             |
| 网关                   | `feishugateway.Gateway.Serve`                             | `CloudflareGateway.RequestSession`（DEV-126 起唯一入口） | 两套                           |
| 策略                   | scope 内透传 + 黑名单（`policy.go`）                      | zone + 级别（read / dns_edit）                           | 两套                           |
| 审计                   | 逐请求（`/api/feishu-gateway/requests`）                  | 写操作进账号活动                                         | 两套                           |
| Worker 转发器          | `startFeishuGatewayForwarder`                             | 同一个函数                                               | 已共用（名字待改）             |

### 3.2 形状

```go
// 每个请求只走这一个函数；顺序固定，连接器无法跳过任何一步。
func (p *Pipeline) Serve(w http.ResponseWriter, r *http.Request) {
    lease := p.authenticate(r)          // 替身哈希 + 设备凭证 → 会话租约   共用
    p.recheckEligibility(lease)         // Permitted                          共用
    need := lease.Provider.Classify(r)  // 资源与所需级别                     连接器
    if why := p.decide(lease, need); why != nil {
        lease.Provider.Refuse(w, why)   // 厂商错误格式 + foundry{…}          连接器
        p.audit(lease, r, why); return
    }
    lease.Provider.Upstream(w, r, lease.Credential) // 传输，流式             连接器
    p.audit(lease, r, nil)              // 限流、审计                         共用
}
```

- 必需接口：`Classify`、`Refuse`、`Upstream`。可选接口沿用 `provider.go` 的类型断言写法：`TokenEndpoints`（飞书代答 `tenant_access_token` 与用户 token 刷新，返回替身）、`ListResources`（页面的资源选择器，Cloudflare 的 zone）。
- 飞书 `Classify`：命中黑名单则拒绝，否则 `full`、不分资源，行为与现在一致（2026-10-12 的透传决定不变）。给飞书加级别是另一个产品决定。
- Worker 侧“物化器”仍按 CLI 各写各的（feishu-cli 的 `config.yaml`/`token.json`，`cf` 的环境变量），只负责把替身写成该 CLI 原生认的形式。

### 3.3 不统一的部分与原因

- **传输**：飞书有 multipart 大文件、Range、事件 WebSocket、用户与 Bot 两种身份；Cloudflare 是 JSON、请求体上限 16 KiB。统一传输会让飞书退化。
- **租约表、审计表、通用授权编辑器**：只有两个 Server 持有型连接器，现在合并容易抽错；等第三个出现或需要统一审计页面时再做。

### 3.4 统一解决不了的：Cloudflare 不是字节级透传

`cf` 的 REST 请求到 Server 后被翻译成官方 Cloudflare MCP 的 `execute`，执行 `cloudflare.request(...)`（`externalaccounts/cloudflare.go` `APIRequest` → `MCPCall`），因为 OAuth token 的受众是 `mcp.cloudflare.com/mcp`。请求体大小、二进制与流式接口、部分响应头因此受限。根治需要能直接调 `api.cloudflare.com` 的凭据（例如 Server 保管用户提供的 API Token），未调研，单列为后续问题。

### 3.5 风险与验收

- 网关鉴权、黑名单、替身派生是安全边界（[security.md](../security.md)）。迁移飞书时，`external_accounts_cli_contract_test.go`（真实 feishu-cli）、`external_accounts_gateway_test.go`、`feishugateway/gateway_test.go` 的断言一条不改且全部通过，才算完成。
- 旧路由保留为别名；旧 Worker 能力（`feishu_gateway`、`cloudflare_gateway_v2`）照旧兼容；不改数据表，就不需要数据迁移。

## 4. 设备持有型：会话凭据代理

### 4.1 规则

1. **工具存储是唯一来源。** Worker 不解析、不刷新、不复制 refresh token，只用工具的公开命令读状态、取凭据。设备所有者在 Foundry 外照常使用，不会和 Foundry 抢刷新。
2. **会话环境只有一个来源。** 一个连接器在会话里的一切，都由 `sessionSetup` 在会话启动时按当前状态生成：可执行文件（不在会话 PATH 上就链接进会话自己的 bin）、凭据选择、描述里承诺的能力（GitHub：git 走 HTTPS）。登录时不改全局配置。
3. **默认拿不到。** 不能用的会话，工具的配置位置指向空目录；一个工具里的每份子凭据（bytedcli 的 SSO、Meego 网页会话、lark-cli）都要覆盖到。
4. **“可用”在会话环境里验证过。** 复用适配器已有的 `readLogin`、`readAuthorizations`，分别在“能用”和“被隔离”两种会话环境里跑：前者必须已登录，后者每一项都必须未登录。Connectors 页把“已登录”和“会话可用”分开显示。
5. **选择与隔离是同一件事。** `connector.status` 返回一组身份（profile、到期、各授权组状态）；工作区绑定“设备 + 连接器 + 身份”；“不能用”就是什么都不给。
6. **Server 决定，Worker 执行，请求不经过 Server。** 撤销由 daemon 消息作废会话的替身；需要时 Worker 只上报元数据审计。

### 4.2 两档交付方式

| 方式                    | 会话里有什么                                                | 条件                                                       |
| ----------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| 替身 + 本机转发（优先） | 只有替身；Worker 的转发器用工具命令取真凭据，只在转发时换上 | 工具有公开的 base URL / endpoint / 代理配置，不靠 hack     |
| 只选 profile（兜底）    | 只有“用哪个 profile”；真凭据在工具存储里                    | 以上做不到时。Agent 仍可能让工具打印 token，防误用不防恶意 |

### 4.3 各工具能力（逐项实测后更新）

| 工具                      | 替身 + 本机转发                                                                                                                                                                                                                                                                                                                 | 依据                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| git（HTTPS 到 GitHub）    | 可行：`url.<本机转发>.insteadOf https://github.com/` 是 git 公开配置，支持 http                                                                                                                                                                                                                                                 | git 文档；未在 Foundry 中实现         |
| gh                        | 有代价：设 `GH_HOST=127.0.0.1:<port>` 后 gh 按 GHES 访问 `https://<host>/api/v3/…`，**只走 HTTPS**（2026-11-05 在 sg-chaos 用 gh 2.67.0 实测：明文本机服务报 TLS 握手错误）。需要回环 TLS + 会话信任的 Foundry CA（`SSL_CERT_FILE`），且 gh 打印的链接会变成本机地址（信息失真）。暂按“只选 profile”，git 单独走替身            | 实测                                  |
| AWS CLI                   | 可行（待原型）：设 `AWS_ENDPOINT_URL` 后 aws-cli 2.39.2 用替身密钥签名，sts/s3/ec2 请求全部打到本机，`Authorization` 的 credential scope 带服务与区域（2026-11-05 macbook 实测），转发器可据此用真凭据重签并发往真实端点（同类：aws-sigv4-proxy）。难点：S3 分块流式签名需逐块重签；CLI 本地生成的预签名 URL 用的是替身，不可用 | 实测                                  |
| lark-cli（bytedcli 内）   | 隔离可行：`LARKSUITE_CLI_PROFILE=foundry-no-login` 或空的 `LARKSUITE_CLI_CONFIG_DIR` 都让 `lark-cli auth status` 报未配置，经 `bytedcli lark` 调用时同样生效（bytedcli 透传变量）。替身转发：未发现公开的 base URL 配置，`LARKSUITE_CLI_AUTH_PROXY` 语义未测。暂按“只选 profile”                                                | 实测（隔离）；替身未测                |
| bytedcli（SSO、Meego 等） | 不适合替身：凭据按几十个内部服务分散（各自的 `BYTEDCLI_*_API_BASE_URL` / `*_HOST` 与 `*_COOKIE` / `*_TOKEN`），逐服务映射不现实。按“只选 profile”（`BYTEDCLI_PROFILE`）                                                                                                                                                         | 变量名探查（`dist/` 内 `BYTEDCLI_*`） |

已知缺陷：`BYTEDCLI_PROFILE=foundry-no-login` 下 `bytedcli lark auth status` 仍显示设备所有者的飞书用户已就绪（2026-11-05 macbook 实测，lark-cli 1.0.90），隔离漏掉了 lark-cli。修法是在扩展的 `isolationEnv` 加 `LARKSUITE_CLI_PROFILE=foundry-no-login`（简单值，Server 现有校验允许，不需要平台改动），并把 lark-cli 声明为附加授权组，让反向检查覆盖它。

## 5. 实施顺序

1. **设备持有型：会话环境单一来源 + 正反向检查**（通用运行时；github 适配器只实现可选的 `sessionEnvironment()`）。修好 `sess_1793869900823251856` 中 gh/git 不可用。已部署（[DEV-128](../devlog/DEV-128-device-connector-session-environment.md)），macbook 真实会话 clone 私有仓库成功；sg-chaos 待旧执行宿主换新后复验。同时修正 Server：非所有者、无共享绑定的会话对每个设备持有型连接器都下发 `access:"none"`，不再取决于描述符是否声明 `isolationEnv`（此前 GitHub CLI 对其他成员会话没有隔离）。
2. **修 lark-cli 泄漏**：bytedcli 扩展的 `isolationEnv` 加 `LARKSUITE_CLI_PROFILE=foundry-no-login`（扩展 1.0.1，2026-11-05 已装到 macbook；Server 的设备记录里已出现该变量；在这组隔离变量下 `bytedcli lark auth status` 报 profile not found，`bytedcli auth status` 为 authenticated=false）。byte-dev、byte-dev-sg 上的扩展尚未更新。剩余：把 lark-cli 声明为附加授权组（读状态 `bytedcli --json lark auth status`），让反向检查覆盖它。
3. **Server 持有型流水线**：抽出共用骨架，先迁 Cloudflare，再迁飞书（断言不改）。已完成，见 [DEV-129](../devlog/DEV-129-gateway-pipeline.md)：`internal/gateway` 的 `Pipeline.Serve`；Cloudflare 和飞书都迁入；`external_accounts_cli_contract_test.go`、`external_accounts_gateway_test.go`、`feishugateway/gateway_test.go` 的断言一条未改且通过；Worker 转发器改名 `gateway-forwarder.ts`（旧名为别名）。进行中，由 `sess_1793875434935721433` 负责。
4. **设备持有型多身份与替身转发**：按 4.3 的实测结果逐个工具接入；授权组带到期时间。
5. **单独评估** Cloudflare 改用直接 API 的凭据。

## 6. 决定记录

- 2026-11-05 本人：原则如第 1 节；飞书不换 lark-cli；不在描述符里描述官方 skills / MCP；设备持有型不做 Foundry 独占；设备持有型请求不经过 Server；不向会话注入真 token；统一但不用继承，按本方案的范围做。
- 2026-11-05 编排会话（本人授权范围内，可调整）：Cloudflare 删除 Foundry MCP 工具，`cf` 经网关为唯一入口；会话下发 `CLOUDFLARE_ACCOUNT_ID` 而不由网关代答 `/accounts`（[DEV-126](../devlog/DEV-126-cloudflare-gateway-only.md)）。
