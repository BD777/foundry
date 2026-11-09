# DEV-156 助理默认可用本人的全部连接器

## 状态

状态：已部署 dev（Server `foundry-server.pre-assistant-connectors` 之后的版本、Web `2867696b118a39f8`），Go / Web 测试与审计通过，待人工验收。本人的助理自 2026-10-25 起处于停用状态，真实飞书调用未在本人助理上验证（见“限制”）。由编排会话 `sess_1794143153454726480` 拆分，实现由 Tencent TokenHub · deepseek-v4.1-flash-1017 子会话完成并经编排会话审查。

## 问题

本人（2026-11-10）：使用助理时发现它没有被授权任何 Connector 的能力；“要么就有个地方授权 Assistant，要么就默认打开所有的授权”。

## 调查

- 服务端持有的账号（飞书、Cloudflare 等）按 Workspace 授权：会话派发时 `sessionConnectors` → `connectors/module.go` `SessionMaterials(ctx, session.WorkspaceID, …)` → `externalaccounts/sessions.go` 要求账号绑定到该 Workspace。
- 助理的会话跑在它自己的 `personal_agent` 类 Workspace（`personalagent/assistant/assistant.go` `createFolder`），创建后从未获得任何绑定；代码里没有显式排除助理，只是没有绑定。
- 助理派到项目的子会话使用项目 Workspace 的绑定，原本就能用。

## 修复

- **一条规则**（`externalaccounts/connector_access.go` `Policy`）：会话所在 Workspace 是本人的助理 Workspace 时，本人拥有且可用的连接器账号视为已绑定，本人关掉的除外。服务端持有的账号（`sessions.go`）、设备持有的连接器（`connectors/deviceheld.go`）、网关复查（`gateway/pipeline.go`）都用这一条。别人的会话即使在该 Workspace 也拿不到。在助理 Workspace 里，本人关掉的账号即使被显式绑定也保持关闭；其他 Workspace 行为不变。
- **网关显式依赖**：`gateway.Pipeline.Access` 为必填，飞书与 Cloudflare 网关构造时传入，缺失即启动失败，不再用类型断言静默降级。
- **存储**：`personal_agents.connector_opt_out`（账号 id 列表，默认空 = 全部可用）。
- **接口**：`GET /api/personal-agent/connectors`、`PUT /api/personal-agent/connectors`（`{disabled: [...]}`），`personOnly()`。
- **Web**：助理设置新增“Connectors”分区：服务端账号在前、按设备分组，每个账号一个开关，切换即保存，失败回滚并就地报错；无账号时给出前往 Connectors 页的入口。中英文案齐全。

## 检查

- Go：`externalaccounts`、`gateway`、`connectors`、`feishugateway`、`sqlitestore` 全包通过；`httpapi` 中 PersonalAgent / Connector / ExternalAccount / Feishu / Cloudflare 相关测试通过。新增测试覆盖：未绑定也可用、关掉后不可用、助理 Workspace 中关掉优先于绑定、项目 Workspace 仍需绑定、别人的助理拿不到、网关 `Live` 放行与关掉后拒绝、接口读写。
- Web：`tsc`、`audit-component-system/copy/native-controls/state-layout/feature-architecture/buttons/inline-styles` 通过；`assistant-settings-connectors.test.mjs` 3 项通过。

## 部署

- 2026-11-10 04:06（UTC+8）：DB 备份 `backups/foundry-20261109-1506-pre-assistant-connectors.db`（新增一列），Server 切换，healthz 正常、7 台设备重连；Web `2867696b118a39f8`（上一版 `60c32b7cb3ca16ca`，回滚目录 `releases/assistant-connectors-web/`）。

## 限制

- 本人的助理处于停用状态，未做“助理实际调用飞书”的真实验证；规则与网关放行由测试覆盖。
- 设备持有的连接器以“设备 + 类型”作为开关单位（`device:<deviceId>:<kind>`）。

## 验收步骤

1. 打开助理设置 → Connectors：应列出本人全部连接器账号，默认全部开启。
2. 启动助理后，让它用飞书读一次本人的用户信息（只读）：应成功，无需在任何 Workspace 绑定飞书。
3. 在设置里关掉飞书账号，再让助理读一次：应被拒绝（提示访问已结束或不可用）；重新打开后恢复。
4. 在某个项目 Workspace 里新开对话：该项目的连接器仍按项目绑定决定，不受助理设置影响。
