# DEV-184 边缘访问凭据（Edge Access）

## 问题

内网服务（如 NAS 上的 OpenLark）放在 Cloudflare Access 后面，请求需要带 Access 服务令牌。DEV-182 把它做成了 OpenLark 描述符里的两个字段，但边缘认证与具体服务无关，应该是独立对象，按地址匹配，不属于任何连接器。

## 调查

设计：`.foundry/briefs/edge-access.md`（人确认，2026-11-12）。分为 S1（数据、注入、识别）、S2（Cloudflare Zero Trust 与自动开通）、S3（Web 与 MCP）。证据会话：

- S1：sess_1794421123713924996；
- S2：sess_1794421136240383649；
- 自动开通接入 API：sess_1794423679340931586；
- Web 移到连接器页：sess_1794423750749666939；
- MCP/CLI 合并：sess_1794425347306844357。

## 修复

- S1：契约 `contracts/models/edge_access.yaml`（`EdgeAccess`、`EdgeAccessInput`、`EdgeAccessRequired` 等）；新表 `edge_access`（`(owner, host, pathPrefix)` 唯一，冲突 409）；clientId/clientSecret 封存在 secretstore，任何 API 不返回；匹配规则：host 精确且不区分大小写，多条命中取最长 pathPrefix；网关在 server 路径与 device 路径都按 URL 注入 `Cf-Access-Client-Id/Secret`；探测遇到 Access 跳转归类为 `edge_access_required`。移除 OpenLark 描述符里的两个 Access 字段。
- S2：Cloudflare 连接器新增 `zero_trust` 访问级别；服务令牌、应用、策略、Tunnel 读取；写入都是风险写入（Assistant 走确认卡片，普通会话写审计）；全局拒绝 Bypass；自动开通创建令牌与 `non_identity` Service Auth 策略，已有应用只追加策略；失败回滚新建对象；Tunnel 缺 ingress 只报告 `needsIngress` 与建议规则。
- API：`POST /api/edge-access/provision`（仅限本人），未授权 Zero Trust 返回 `cloudflare_zero_trust_required` 且不发起 Cloudflare 写入。
- Web：`/connectors/edge-access`，列表、添加、替换、删除；`edge_access_required` 的「添加凭据」跳转并预填。
- MCP：`edge_access`（list / create / delete / provision），create 的秘密只能走 `secretFiles`；CLI 同步；两份 foundry SKILL.md 逐字节一致。

## 部署与版本证据

随 dev Server/Web 与 Worker 部署；S3a 的 Web 页面 worker 做过窄屏（390）截图。具体版本以 PR 描述和部署记录为准。

## 检查

- Go：`connectors`、`externalaccounts`、`httpapi` 中新增的 edge access 测试；Web：`apps/web/test/edge-access.test.mjs`。
- 提交前本地：prettier、generate-contracts --check、audit:ui、模块与契约审计；完整后端测试在 CanWendeMac-mini；结果见 PR。

## 限制

- provider 枚举含 `basic`，服务端目前只接受 `cloudflare_access`。
- 自动开通不修改 Tunnel，只给出建议规则。
- 真实 Cloudflare 账号上的自动开通没有端到端演练；Cloudflare 侧由 mock 服务测试覆盖。
- S2 的一次测试失败（zero_trust 访问与 Classify 的交互）在会话内修复；最后一次 `gofmt` 之后的测试由 PR 的 CI 复核。

## 验收

1. 连接器选择器底部有「边缘访问」，打开为 `/connectors/edge-access`。
2. 添加凭据（host、可选 pathPrefix、clientId/secret）后，列表只显示 label、provider、匹配范围、最近使用；任何接口都看不到 secret。
3. 对 Access 后面的地址做实例校验，原位置出现「在 Cloudflare Access（团队 …）后面，需要边缘访问凭据」及「添加凭据」「自动开通」。未授权 Zero Trust 时点自动开通，提示去授权，且 Cloudflare 无任何新增对象。
4. `edge_access` MCP：list 返回元数据，create 只接受 secretFiles。
