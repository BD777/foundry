# DEV-204 assistant connector tenant labels and opt-in defaults

## 状态

已实现、验证并部署 dev Server 与 Web（2026-11-13）。等待人工验收，未提交。

## 问题

- 助理设置里的两个飞书账号属于同一个人的两个租户，但列表只显示姓名、类型和状态，无法区分。
- 权限包把未单独列出的连接器账号硬编码为 `write`。工作区和带身份资源对非默认新助理默认是空的，连接器却默认全开。

## 实现

- Server 复用 Connectors 的同一份账号数据：`ExternalAccount.DisplayName`、`AppName`、`TenantName`、`OrgDomain` 进入助理连接器视图；设备账号同时带上 `Identity` 和 `Sites`。
- Connectors 与助理设置共用 `apps/web/src/lib/account-display.ts` 中的 `personName`、`customLabel`、`accountPlace`；Connectors 的 `account-format.ts` 保留原有导出，调用方无需分叉。
- `PermissionPackage` 新增 `connectorDefault: off|read|write`。没有账号 override 时由它决定级别，网关、连接器注入、资源判定和 helper 交集共用同一解析。
- `DefaultPackage` 仍为 `write`；服务启动时将旧包的缺失值幂等迁移为 `write`。非默认新助理在 `createPersonalAgent` 中显式设为 `off`，已有非默认助理不受影响。
- 新助理的连接器页顶部增加“新助理默认不能使用任何账号，请打开需要的”。

## 检查

- Go 定向测试：`internal/permission`、`internal/sqlitestore`、`internal/gateway`、`internal/httpapi` 全部通过。
- Web 相关测试：5 个文件、61/61 通过；包含两个同名账号显示不同租户和默认 `off`。
- `tsc --noEmit` 通过；`audit-hints`、`audit-component-system`、`audit-state-layout`、`audit-feedback` 通过。
- 部署前在线备份 `foundry-20261113-0138-pre-connectors-ui.db.gz`，`integrity_check` 与 `gzip -t` 通过；线上库没有缺失 `connectorDefault` 的权限包。
- 线上权限包抽查：默认助理为 `write`，已有非默认助理 ByteWork 保持 `write`。

## 部署

- Server SHA-256：`d7c43f522c9fc7698e93d816157bc2cf82f5b865b5237186b20121cac95b23a5`。
- Server 回滚副本：`~/.foundry/server/releases/dev023-candidate/foundry-server.pre-connectors-ui`。
- `/healthz`：`{"status":"ok","startedAt":"2026-11-12T18:27:49Z"}`。
- Web build：`b1033914d2c6c21f`；发布目录 `~/.foundry/server/web-releases/assistant-connectors-ui`。

## 截图

`/home/windeng/workspace/foundry/.foundry/attachments/20261112/connectors-tenant.png`

1280×900，浅色主题。浏览器内拦截助理连接器 GET，注入两个都叫“邓灿文”的飞书账号，租户分别为“字节跳动”和“ByteDance Global”。截图后已登出、清 cookie、删除临时 auth vault 并关闭浏览器。

## 验收

1. 打开“助理设置 → 连接账号”，同名飞书账号旁应显示各自的租户或域名与应用名。
2. 新建一个助理，未单独开启的连接器应显示“关闭”。
3. 在默认助理和已有 ByteWork 中，未单独修改的账号仍应保持“读写”。
4. 用新助理尝试未开启的账号，服务端应拒绝；打开该账号后才可使用。
