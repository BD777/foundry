# DEV-169 · App Store Connect 连接器服务端 ASC-1

## 问题

App Store Connect 需要服务端安全持有 Issuer、Key ID 与私钥，并由连接器按工作区授权和审计请求；此前没有该连接器的绑定、密钥生命周期或网关。

## 调查与修复

- 新增 App Store Connect 账号模型、连接器 catalog 与 Server 路由，绑定密钥时校验材料并加密保存；只返回 `keySet` 等非秘密状态。
- Server 生成短期 ES256 JWT，缓存到到期前但可随密钥撤销立即失效。
- 网关映射 App Store Connect 资源，按已绑定工作区与权限范围拒绝越权请求，并阻止涉及金额写入的操作。
- 契约、生成模型、模块边界与 JWT、密钥撤销、HTTP 和网关测试同步更新。

## 部署与版本证据

ASC-1 服务端属于 dev 已部署状态，已纳入 2026-11-10 部署状态快照 D。ASC 客户端与后续 ASC-2 不在本项。

## 检查

- 契约重新生成
- Server `go build ./...`
- Server `go vet ./...`
- `go test ./internal/externalaccounts ./internal/connectors ./internal/httpapi -run '<AppStoreConnect tests>'`

## 限制

本次为提交窗口本地演练，不推送、不创建 PR。真实 App Store Connect 调用需要用户提供的有效 API key 与明确工作区授权，仓库内不使用真实密钥。

## 验收步骤

1. 在 Connectors 绑定 App Store Connect，提交 Issuer、Key ID 和私钥；界面只应看到已配置状态。
2. 网关读取允许的应用/构建资源应成功，JWT 在到期前复用。
3. 撤销或替换 key 后，旧 JWT 缓存应立即失效。
4. 未授权工作区或金额写入请求应被拒绝，并留下审计记录。
