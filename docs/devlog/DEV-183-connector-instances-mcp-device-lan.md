# DEV-183 连接器实例的 MCP/CLI 管理与经设备连接的内网实例（byte-dev OpenLark）

## 问题

1. 连接器实例（扩展的服务器保管实例，如 OpenLark）只能由人在网页上创建和绑定，Agent 做不了；人要求 Agent 也能管。
2. byte-dev 上的 OpenLark 在公司内网，Server 访问不到，需要「经设备连接」：由 byte-dev 这台设备去连 `127.0.0.1` 上的服务。
3. 令牌不能出现在 Agent 的对话、命令行参数或日志里。
4. 探测 OpenLark 时请求的是 `/agent/v1/`，实际正确路径是 `/agent/v1`，探测失败。
5. CuaDriver 在 acquire 时不会自动启动，租约拿到后屏幕控制不可用。

## 调查

- 参考设计：`docs/research/mcp-connector-instances.md`。
- 在 byte-dev 上用 Codex 会话实操（sess_1794421179488223004）：第一次 `probe` 报 failed（探测路径带了尾部斜杠），修复后重做。
- 在 byte-dev 起新会话验证环境变量与 HTTP 调用（sess_1794423922764864945）。

## 修复

- 新增 MCP 工具 `connector_instances`（`httpapi/connector_extension_instances_mcp.go`），动作含 list / probe / create / bind 等，网页与 MCP 共用同一条服务端路径。
- 秘密只按文件引用传递（`secretFiles`），由 Worker 在设备侧读取（`packages/worker/src/session/connector-instance-secrets.ts`），不经过 Agent 对话。
- 回环或 localhost 地址只由校验过的设备使用，其他设备不会拿去连自己的本机。
- OpenLark 描述符升为 1.2.1，探测路径改为 `/agent/v1`。
- CuaDriver 在 acquire 时自动启动（`packages/worker/src/resources/cua-driver-permissions.ts` 等）。

## 部署与版本证据

- Worker 随本批部署；byte-dev 上 OpenLark 扩展 1.2.1，执行宿主 `…1794423200`（来自 sess_1794421179488223004 的回报）。
- byte-dev 实例：`xapp_8ef44948-45e9-4e98-b279-b3eae3a40db1`，名称 byte-dev OpenLark（内网），状态 ready，1132 条路由；探测、创建并绑定 8 个工作区全部成功（agent-harness、ccm-harness-stat、llm-gateway、ccm-omh-integration、open-lark、my-feishu、workspace、ccm）。
- 新会话验证（sess_1794423922764864945）：5 个环境变量均存在；`/health`、`/accounts`、`/capabilities` 均返回 200；账号 `1`，`OPEN_LARK_MCP_READ_ONLY=0`；未输出任何令牌值。

## 检查

- Worker 测试 `connector-instance-secrets.test.mjs`；Server 测试 `connector_extension_instances_mcp_test.go` 与既有 extension_instances 测试。
- PR 上的 CI 结果见 PR 描述。

## 限制

- 第一次 byte-dev 会话（sess_1794421179488223004）结束时当前会话尚无 `olk` 和连接器环境变量，会话内实际调用由后一个新会话验证。
- 真实调用只验证了只读接口；写接口未在本验证中调用。

## 验收

1. 在 Agent 会话里用 `connector_instances` 对 openlark 执行 list，能看到 byte-dev OpenLark（内网），状态 ready。预期：不出现任何令牌值。
2. 用 `probe` 加 `network: device`、`baseUrl: http://127.0.0.1:...` 探测：由 byte-dev 执行，成功；换一台设备作为 probe 设备时被拒绝。
3. 绑定过的工作区开新会话，环境里有 `OPEN_LARK_AGENT_BASE` 等变量，`GET <base>/agent/v1/health` 返回 200。
