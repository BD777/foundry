# DEV-185 集成包的 MCP（connector_packages）与私有上游由设备代取再分发

## 问题

1. 集成包在哪些设备上启用，只能人在网页上勾选；Agent 做不了，人要求 Agent 能做。
2. 在 byte-dev 上启用 OpenLark 集成包被拒：`byte-dev: Install the GitHub CLI connector on this device.`。上游 nwverse/open-lark 是私有仓库，byte-dev 是公司开发机，不应要求登录个人 GitHub；人的另一台设备（sg-chaos）已登录，能读。

## 调查

- MCP 切片：sess_1794421285935787398。
- 拒绝原因：`httpapi/connector_packages.go` 的 `connectorPackageDeviceEligible` 对目标设备本身检查上游连接器（GitHub）的安装、登录与就绪；Skill 已是 Server 分发快照，但读取设备用的是目标设备本身；repository 工具由目标设备用本机 gh 拉取。（sess_1794425338443123624）

## 修复

- 新增 MCP 工具 `connector_packages`：`list`、`get`、`set_devices`、`disable`，支持增量设备参数、权限过滤、逐次审计；网页与 MCP 共用设备选择预检与 apply 路径；CLI `foundry connector packages <action>`；两份 SKILL.md 一致。
- 私有上游：目标设备不要求能读，只要这个人有一台设备能读上游，就由它代取并由 Server 分发（`skill_device_fetch.go`、`skill_tools.go`、`skill_rollouts.go`、`connector_packages.go`；Worker 侧配合 `packages/worker/src/skills/`）。

## 部署与版本证据

随 dev 部署。可复核：byte-dev 启用 OpenLark 包不再要求 GitHub CLI（见 DEV-183 的 byte-dev 实例）。

## 检查

`connector_packages_mcp_test.go`（增量替换、端到端启用/禁用、审计、非本人与 Issue/verifier 拒绝、Assistant 写权限）、`skill_device_fetch_test.go` 的代取用例、角色工具目录用例；PR 的 CI 结果见 PR。

## 限制

- 目标设备若无人能读上游，仍被拒绝，提示去连接 GitHub CLI。
- repository 工具由读取设备取回后分发的路径，真实设备组合只在 byte-dev + sg-chaos 上用过。

## 验收

1. Agent 会话里 `connector_packages` list 能看到包与已启用设备；set_devices 增加设备后网页同步显示。
2. 对 byte-dev 启用 OpenLark 包成功，不出现 GitHub CLI 提示。
3. 对非本人的包操作被拒绝。
