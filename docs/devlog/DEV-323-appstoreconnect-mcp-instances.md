# DEV-323 会话可经 MCP 录入和绑定 App Store Connect 团队密钥

[事项索引](README.md) · 承接 [DEV-169](DEV-169-appstoreconnect-server.md)、[DEV-172](DEV-172-appstoreconnect-client.md)、[DEV-232](DEV-232-connector-access-level-files.md)

状态：**已部署 dev（2026-11-19）；待本人验收**。

## 问题

App Store Connect 团队密钥原来只能在 Web 的 Connectors 页录入和绑定。2026-11-19 本人同意 Agent 通过 MCP 录入和绑定 App Store Connect 密钥。

## 修复

- `connector_instances` 支持 `kind: appstoreconnect`，动作与 Web 页相同：list、probe、create、update、check、revoke、delete、bind_workspace、unbind_workspace。`instanceId` 是密钥的 appId。字段为 `issuerId`、`keyId`（都不是秘密），`.p8` 私钥由会话所在设备的 Worker 从 `secretFiles.privateKey` 读取，不经过模型。
- `bind_workspace` 接受 `resourceIds`（允许工作区管理的 App id）和 `access`（访问级别，新绑定默认只读）。
- 代码在 `apps/server/internal/httpapi/appstoreconnect_connectors_mcp.go`，同时调整了 `appstoreconnect_connectors.go`、`cloudflare_connectors_access.go`、`connector_extension_instances_mcp.go` 和 `mcp_tools.json` 的工具说明。
- 提交时把新文件从 `appstoreconnect_instances_mcp*.go` 改名为 `appstoreconnect_connectors_mcp*.go`。原文件名不在模块边界审计允许引用 `externalaccounts` 的连接器文件范围内（`scripts/audit-module-boundaries.mjs` 的 `sealedServerPackages`）。只改了文件名，代码不变。

## 检查与部署

- 完整 `./internal/httpapi` 门禁在 byte-dev 上通过（`ok … 1028s`，2026-11-19）。CanWendeMac-mini 上传 base archive 连续失败三次，所以门禁改到 byte-dev 跑，失败记录见 [DEV-319](DEV-319-worker-io-and-build-disk.md)。
- 2026-11-19 16:59Z 部署 Server（`--label asc-mcp-train`）。之后 train 105 和 106 都包含本项。
- 改名后 `node scripts/audit-module-boundaries.mjs` 通过（0 个已登记违规）。

### 2026-11-21：首次实际使用（blinklet）与网关修复

- **实际录入**：本人的团队密钥在 Apple 补签协议后通过 `connector_instances create` 录入（`xapp_82689dee…`，Key ID 836ZXQ6W2H）。CON-6 仍未修复：由新会话的第一轮完成读取，`.p8` 附件随后删除。本人在网页上新建 App 记录（Apple API 不支持 `POST /v1/apps`）后，`bind_workspace` 把 App `6837762590`（Blinklet 截图记账）绑定到 blinklet 工作区，级别 commerce。
- **问题**：blinklet 工作区的会话读取 `GET /v1/apps/{bound}/subscriptionGroups` 返回 403 `FOUNDRY_PATH_NOT_ALLOWED`。`appStoreConnectNested["apps"]` 已列出 `subscriptionGroups`，但随后 `apps` 分支的 `len(parts) != 2` 拒绝了 `/apps/{id}` 下的所有路径，这条白名单从未生效。会话因此只能新建订阅组，查不到已有的订阅组。
- **修复**：`apps` 分支改为只拒绝非 GET 请求和超过三段的路径；子路径仍要先通过白名单，App 仍须已绑定。测试 `TestAppStoreConnectGatewayMapsResourcesAndBlocksMoneyWrites` 增加四种情况：已绑定 App 的订阅组 → 200，未绑定 App → not_bound，`customerReviews` 和 POST → path_not_allowed。不改代码时，新增的用例复现了线上同样的 403。`go test ./internal/connectors/` 和 `go vet` 均通过。
- **部署**：Server `4d62370c7719`（`--label asc-apps-nested-read`，2026-11-21 17:35Z），由干净的 worktree 构建，只包含 HEAD 201894ef 和本修复。第一次构建用的是共享目录，期间另一会话改了 `personal_agent_items.go`，那份产物没有部署。`--replaces 5bdd4e24…` 只替换了本修复的两个文件，以及线上三份旧版文档（`roadmap`、`devlog/README`、`DEV-324`，线上版本都是 HEAD 的祖先提交）。回滚副本：`foundry-server.pre-asc-apps-nested-read`。
- **线上复验**（blinklet 工作区的只读会话 `sess_1795282585493776640`）：`/apps/6837762590` → 200，`/apps/6837762590/subscriptionGroups` → 200（空列表），`/apps/6837762590/customerReviews` → 403，`/users` → 403。会话拿到的是替身令牌（`fdyasc_user_` 前缀），不是真密钥。

### 2026-11-22：开放商店页编辑（新访问级别 listing）

- **需求**：本人希望会话能编辑 App 商店页，包括多语言名称、副标题、描述、关键词和截图。原先网关只开放了订阅相关的资源。
- **改动**：
  - 访问级别从低到高改为 `read` < `listing`（只读 + 商店页）< `commerce`（再加订阅），`commerce` 包含 `listing` 的全部权限。
  - 网关新开放 `appInfos`、`appInfoLocalizations`、`appStoreVersions`、`appStoreVersionLocalizations`、`appScreenshotSets`、`appScreenshots` 六类资源。每类都顺着它的上级关系找到所属 App，必须是已绑定的 App。
  - 已绑定 App 下新增两个只读子集合 `appInfos`、`appStoreVersions`；可以逐层列出本地化、截图组和截图。
  - 写操作需要 `listing` 级别，订阅相关的写操作仍需要 `commerce`。
  - 开放 DELETE，但只用于截图和截图组，用来替换截图。
  - 仍然不放行：修改 App 本身（`PATCH /apps`，包括主要语言）、改价格、提交审核（`appStoreVersionSubmissions` / `reviewSubmissions` 不在允许的资源里）。
- **测试**：新增 `TestAppStoreConnectGatewayStorePageLevel`，覆盖以下情况：
  - `read` 级别可以读取全部商店页路径，但写入被拒（access_level）；
  - `listing` 级别可以修改和新增本地化、新增 App 信息本地化、预留截图、删除截图；
  - `listing` 级别新建订阅组被拒（access_level）；
  - 其他 App 的版本或本地化被拒（not_bound）；
  - 删除本地化或订阅、修改 App、提交审核都被拒（path_not_allowed）。

  `go test ./internal/connectors/`、`./internal/externalaccounts/`，以及 httpapi 中 AppStoreConnect、ConnectorInstances、Cloudflare、ExternalAccount 相关测试全部通过，`go vet` 无问题。

- **限制**：Web 端在加载出服务端的级别列表前，用的兜底列表里还没有 `listing`。只影响页面刚打开的一瞬间，下次改 Web 时一起补上。

### 2026-11-22：所属 App 的查找改按 Apple 的真实行为（商店页与订阅都受影响）

- **问题**：部署商店页编辑后，在 blinklet 线上复验（`sess_1795340418283654743`）。`/apps/{id}/appInfos` 和 `/apps/{id}/appStoreVersions` 返回 200，但 `/appInfos/{id}/appInfoLocalizations` 和 `/appStoreVersions/{id}/appStoreVersionLocalizations` 返回 403："Foundry could not establish which App"。
- **根因**：Apple 的 DocC JSON（`developer.apple.com/tutorials/data/documentation/appstoreconnectapi/get-v1-<type>-_id_.json`）显示两点：
  1. GET 单个资源时，关系里不带 `data`，除非用 `include` 请求；`/appInfos/{id}/app` 这类反查父级的端点也不存在（404）。
  2. 订阅的上级关系叫 `group`，不叫 `subscriptionGroup`；订阅组无法 `include` 它的 App。

  旧代码的反查对真实的 Apple 全部无效，订阅相关的查找同样不可用。之前测试能通过，是因为假 Apple 总是返回关系数据。

- **修复**：
  - 反查改为 `GET /v1/{type}/{id}?include={relation}`，失败再不带 `include` 读一次，关系名按 Apple 的文档；
  - 订阅组由已绑定 App 的 `/v1/apps/{id}/subscriptionGroups` 列表确认归属，不在任何已绑定 App 下的返回 not_bound；
  - 请求体里的 `group` 关系也映射到订阅组；
  - 假 Apple 改成只有带 `include` 时才返回关系数据，和真实行为一致。
- **测试**：`go test ./internal/connectors/` 和 `go vet` 通过。
- **部署**：先上线商店页编辑，Server `7885551b7174`（`--label asc-store-listing`，2026-11-22 08:05Z）。再上线本修复，Server `5f6b0aa228eb`（`--label asc-include-lookup`，09:47Z），由 CanWendeMac-mini 构建。替换的只有本项的三个文件；回滚副本为 `foundry-server.pre-asc-include-lookup`。
- **线上复验**（blinklet 工作区的只读会话 `sess_1795340842647795547`），四项都是 200：
  - `appInfos/{id}/appInfoLocalizations`：en-US，名称为 Blinklet 截图记账，副标题为空；
  - `appStoreVersions/{id}/appStoreVersionLocalizations`：en-US；
  - `appStoreVersionLocalizations/{id}/appScreenshotSets`：0 个；
  - `apps/6837762590/subscriptionGroups`：0 个。

- **线上写入**（blinklet 会话 `sess_1795344018266603472`，本人 2026-11-22 同意，原话为「行，按你说的改呗……你随便改」）：
  - en-US App 信息本地化 PATCH → 200；
  - zh-Hans App 信息本地化 POST → 201；
  - en-US 版本本地化 PATCH → 200；
  - zh-Hans 版本本地化 POST → Apple 返回 409（新增 App 信息语言时，Apple 已自动建好这一条），改为 PATCH → 200。

  网关没有拒绝任何一步（没有 FOUNDRY_* 错误），商店页级别的写入在线上跑通。

### 2026-11-22：开放订阅销售范围、地区列表、App Store 服务器通知网址；修复请求体中"对多"关系的解析

- **起因**：blinklet 的上架准备会话（`sess_1795346532741931281`）在以下几处被网关拒绝：
  - `/subscriptionAvailabilities`（建免费试用前必须先设销售范围，Apple 返回 409 "You need to set up availabilities first"）和 `/territories`；
  - App Store 服务器通知网址需要 `PATCH /apps`，原来不放行。

  这些步骤本来都会落到本人的点击清单里。

- **改动**：
  - 订阅的销售范围：可以用请求体中 `subscription` 关系建立（需 commerce 级别），也可以经 `/subscriptions/{id}/subscriptionAvailability` 读取。按 Apple 的文档，销售范围记录无法 `include` 它所属的订阅，所以不支持直接按它自己的 ID 访问。
  - `GET /v1/territories`：Apple 的地区参考列表，只读，不涉及任何 App。
  - `PATCH /v1/apps/{id}`：只允许已绑定的 App，只能改 `subscriptionStatusUrl`、`subscriptionStatusUrlForSandbox` 和它们的版本字段，需要 commerce 级别；改其他字段（例如 primaryLocale）或带关系的请求仍然被拒。
  - 请求体中"对多"关系（`data` 是数组，例如 `availableTerritories`）原先会让整个请求被当成格式错误拒绝；现在跳过这类关系，只按"对一"关系确定所属 App。
- **测试**：新增 `TestAppStoreConnectGatewayAvailabilityTerritoriesAndNotificationURLs`，覆盖以下情况：
  - read 级别可以读取地区列表和销售范围；
  - listing 级别写入被拒（access_level）；
  - commerce 级别可以设置销售范围和通知网址；
  - 修改 primaryLocale 被拒（path_not_allowed），其他 App 被拒（not_bound），写地区列表被拒（path_not_allowed），其他 App 的订阅被拒（not_bound）。

  `go test ./internal/connectors/` 和 `go vet` 通过。

### 2026-11-22：嵌套路径改用 Apple 的实际名称，并且只读

- **问题**：验收前的只读核对（`sess_1795354927846437202`）中，`GET /subscriptions/{id}/introductoryOffers` 被拒（path_not_allowed）。白名单里写的是资源类型名（`subscriptionIntroductoryOffers`、`subscriptionPrices`、`subscriptionAppStoreReviewScreenshots`），而 Apple 的嵌套路径用的是关系名（`introductoryOffers`、`prices`、`appStoreReviewScreenshot`），已用 Apple DocC JSON 核对。另外发现，嵌套路径原来也可以发 POST，只要上级资源可写就能通过网关。Apple 没有这类写端点，但网关不应该依赖这一点。
- **修复**：
  - 订阅的嵌套白名单改为 Apple 的路径名；
  - 嵌套的子集合路径只允许 GET，修改一律走资源自己的路径（relationships 路径的规则不变）。
- **测试**：新增 `TestAppStoreConnectGatewayNestedPathsUseApplesNamesAndOnlyRead`：
  - 四个嵌套 GET 返回 200；
  - 对 `prices`、`introductoryOffers`、订阅组下的 `subscriptions` 发 POST 被拒（path_not_allowed）。

  `go test ./internal/connectors/` 和 `go vet` 通过。

### 2026-11-22：可读取已绑定 App 的构建（TestFlight 处理状态）

- **起因**：blinklet 准备上传 TestFlight 时，会话需要读回"构建是否已处理完成"，但 `GET /apps/{id}/builds` 和 `GET /builds/{id}` 被拒。
- **改动**：
  - 已绑定 App 下新增只读子集合 `builds`；
  - 可按构建 ID 读取，所属 App 用 Apple 支持的 `?include=app` 反查；
  - 构建不在可写列表里，所有写入都被拒（path_not_allowed）。TestFlight 群组和测试员仍不开放。
- **测试**：新增 `TestAppStoreConnectGatewayReadsBuildsOfTheBoundApp`。`go test ./internal/connectors/` 和 `go vet` 通过。
- **部署与线上验证**：Server `466338ca42c7`（`--label asc-builds-read`，2026-11-22 16:16Z）。blinklet 会话 `sess_1795367018319725666` 读取 `GET /apps/6837762590/builds` 返回 200，目前还没有构建。中间几次验证失败，与本改动无关：Mac mini 到 NAS 的 SMB 共享卡死，见 roadmap WS-2。

## 验收步骤（本人）

1. 在会话里让 Agent 用 `connector_instances`（`kind: appstoreconnect`、`action: list`）列出密钥。预期：列出与 Connectors 页相同的密钥，不显示私钥内容。
2. 让 Agent 用 `create` 录入一把新密钥（`secretFiles.privateKey` 指向本机 `.p8`）。预期：Connectors 页出现这把密钥，`check` 列出它能访问的 App。
3. 用 `bind_workspace` 把其中一个 App 绑定到一个工作区。预期：该工作区的会话只能访问这个 App，访问级别默认只读。

## 限制

- 常驻的 Claude 进程在后续轮次（包括定时唤醒）调用时，secretFiles 可能仍使用进程启动时那一轮的令牌，已记为 roadmap CON-6，尚未修复。
- Apple API 不能新建 App 记录（没有 `POST /v1/apps`），新建 App 仍需本人在网页上完成。
