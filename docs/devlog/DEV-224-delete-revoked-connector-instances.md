# DEV-224 已撤销连接器实例可删除，并清理误建测试实例

状态：Server/Web 已上线，两项 OpenLark 测试实例已删除并核验；待本人验收。已合入 main（PR #268）。

## 问题

本人 Connectors 页出现两个由验证会话创建的 OpenLark 实例：

- `DEV-209 synthetic device install`：`http://127.0.0.1:32333`，`dev209-synthetic`
- `DEV-216 live final check`：`http://127.0.0.1:32334`，`dev216-live`

两者都显示“Via a device (internal)”且已吊销，但页面只能继续保留，无法从列表移除。验证流程也不应把测试连接器写进本人账号。

## 只读核对

2026-11-13 通过 `connector_instances` 和线上 SQLite 副本只读检查：

- 两项均为 `visibility=personal`、`created_via=extension`，分别由本人账号下的两个验证 app/account 组成；地址和版本与验证会话记录一致。
- 两项都没有 `external_account_bindings`、没有 message-channel 引用；各自只有 `extension_instance_added`、`extension_instance_revoked` 两条 audit，`session_ref` 为空。
- 两项都没有 sealed extension secret。吊销已删除测试令牌。
- 真实 `byte-dev OpenLark（内网）` 仍是 `ready`，保留 `external-app:xapp_8ef44948-45e9-4e98-b279-b3eae3a40db1:extension` 凭据和 8 个 workspace bindings，未被触碰。

## 修复

- SQLite：`external_account_events` 去掉指向 `external_accounts` 的外键；启动时一次性重建旧表并复制全部 audit。新增原子删除 app/account 的 store 方法，account bindings 随 account 删除，audit 保留。
- Service：只有 `revoked` 实例可删除；删除先清除可能残留的 extension secret，再原子删除 app/account，最后写入 `extension_instance_deleted` audit。
- Server API：新增 `POST /api/connectors/extensions/{kind}/instances/{instanceId}/delete`。保留原 `DELETE` 路由的“吊销”语义，避免破坏已有客户端。
- MCP：`connector_instances` 新增 `delete` action，仍限本人启动的普通 Agent session，并受助理 connector permission package 约束。
- Web：已撤销实例默认收在原生 disclosure「已撤销 (N)」里；展开后有「删除」动作和二次确认，成功后从列表移除。
- 文档：`docs/where-things-live.md` 增加验证数据隔离规则，禁止在本人账号创建测试 connector instances/channels/data，改用 `e2e-alice` 或 scratch stack。

## 检查

- Go：`go test ./internal/sqlitestore -run '^TestExternalAccountAuditSurvivesAccountDeletionAfterMigration$'` 通过，覆盖旧 audit 表迁移、account/app 删除后 audit 仍在。
- Go（byte-dev shared compute）：`go test ./internal/httpapi -run '^(TestConnectorInstancesMCPCreateProbeAndListWithoutSecrets|TestDeleteServerHeldExtensionInstanceIsOwnerOnlyAndKeepsAudit)$'` 通过。覆盖 owner-only、仅 revoked 可删、binding 清理、audit 保留、MCP delete 和删除后 list 不再返回。
- Web：`server-held-connectors.test.mjs` 9/9 通过，包含 revoked 默认折叠、展开、确认删除和请求路径。
- Web（byte-dev shared compute）：整体 typecheck 通过；全部 `scripts/audit-*.mjs` 通过。
- 真实 Chromium（合成 fixture，不经 Server）：1280×900 light 与 390×844 dark；默认显示「已撤销 (1)」，展开后出现删除按钮和确认对话框，确认后实例消失；页面 `scrollWidth == clientWidth`，无横向溢出。截图：`.foundry/attachments/dev224/revoked-light-1280.png`、`.foundry/attachments/dev224/revoked-dark-390.png`。
- byte-dev remote-check job 目录已按会话清理；不使用测试实例，无需清理账号数据。

## 部署与验收

2026-11-13 14:17 UTC，DEV-224 patch `b5c3d8b7…` 由部署车次上线：Server `af4f7fcab4d4e625a76169178477acd7dbd4e55cebc3c7988bec2c03b608ffb0`（14:17:46Z 起运行，healthz 200），Web `ffecb90fcb9ddbf0`（entry assets match，API answers JSON）；无 Worker 变更。上线前车次在 byte-dev 的 live tree + patch 上重跑了 build/vet、SQLite/HTTP 定向测试、MCP tool description 检查、Web typecheck、9/9 Web test 和 UI audits。

上线后通过 MCP `connector_instances action=delete` 删除：

- `xapp_810fafad-b015-4614-93cf-678e65cc958a`
- `xapp_394e4c81-8227-4ee6-a58a-5a3992b79f6d`

随后 live inventory 只剩真实 `xapp_8ef44948-45e9-4e98-b279-b3eae3a40db1` / `byte-dev OpenLark（内网）`，仍为 `ready`、1132 routes、sealed secret 存在、8 个 workspace bindings。只读 live DB 复核：两项 test app/account/binding/sealed secret 均为 0；各自 audit 保留 `extension_instance_added`、`extension_instance_revoked`、`extension_instance_deleted`。

人工验收：打开 Connectors → OpenLark，应只看到真实的 `byte-dev OpenLark（内网）`，不再出现 `DEV-209 synthetic device install` 或 `DEV-216 live final check`。对任一未撤销实例调用 delete API/MCP 仍应返回冲突。
