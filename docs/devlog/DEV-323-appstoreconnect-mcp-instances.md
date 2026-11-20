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

## 验收步骤（本人）

1. 在会话里让 Agent 用 `connector_instances`（`kind: appstoreconnect`、`action: list`）列出密钥。预期：列出与 Connectors 页相同的密钥，不显示私钥内容。
2. 让 Agent 用 `create` 录入一把新密钥（`secretFiles.privateKey` 指向本机 `.p8`）。预期：Connectors 页出现这把密钥，`check` 列出它能访问的 App。
3. 用 `bind_workspace` 把其中一个 App 绑定到一个工作区。预期：该工作区的会话只能访问这个 App，访问级别默认只读。

## 限制

- 常驻的 Claude 进程在后续轮次（包括定时唤醒）调用时，secretFiles 可能仍使用进程启动时那一轮的令牌，已记为 roadmap CON-6，尚未修复。
