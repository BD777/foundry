# DEV-216 首次设备网络实例自动安装连接器扩展

## 状态

已合入 main（PR #267）。

## 问题

首次在设备上创建服务器保管连接器的 `network: "device"` 实例时，两条规则互相等待：

- 在设备上启用连接器包要求该设备已有可用实例；
- 创建或探测实例要求该设备已经安装对应扩展。

因此，扩展尚未安装的设备无法创建第一个实例。报告场景是 CanWendeMac-mini 需要经局域网访问 OpenLark，而当时只有 byte-dev 安装了 OpenLark 扩展。

## 调查

- `connector_packages` 的 `connectorPackageDeviceEligible` 之后还会检查 `no_instance`；该规则仍应约束普通 package 启用。
- `connector_instances` 的 probe/create/update 只验证设备属于本人并在线，然后直接要求 `ServerHeldDescriptorOn` 能找到已安装扩展。
- Worker 的既有 `extension_request` 已能安装 `bundledExtensionId` 或 Git source，并在安装后立即重新上报设备连接器。因此不需要修改 Worker，也不应放宽 package 对成员设备的规则。

## 修复

- `connector_extension_instances.go`：设备网络 probe/create/update 在探测前调用 `prepareExtensionProbeDevice`。
  - 只接受调用者本人拥有且在线、并且由人明确选中的设备。
  - 缺少扩展时，从描述符的 `extension.source` 安装 Git 副本，或从 `extension.bundled` 安装 Worker 自带副本。
  - 安装成功后等待 Worker 重新上报，最多 15 秒；上报后继续原有探测。
  - 设备离线直接说明；从本地文件夹安装、没有公开来源的扩展要求先手动安装。
- Web Connectors 的设备网络说明明确：扩展缺失时会先安装再校验。
- MCP `connector_instances` 描述同步说明 probe/create 的安装行为。

## 部署防回归

- 第一次部署 DEV-216 的 Web 时选错了源基线：`~/workspace/foundry-deploy203` 留有 live 0b8 的 `dist`，但从该树重建实际得到 d0716；0b8 的源码是后来 p2 superset。发现后立即恢复 0b8，并把最终 Web 改动折进 p2 部署列车。
- `remote-build.sh` 现在为构建产物写 `SOURCE_MANIFEST`（全仓库源文件 SHA-256）和源树、diff、manifest 摘要。
- `deploy-dev.sh` 在替换 Server 或 Web 前，要求新产物包含当前线上产物记录的源文件及相同哈希。
- 若确实要替换不同源树，必须用重复的 `--replaces <current-live-id>` 精确列出当前 Server SHA / Web build id。
- 同时修复了 `deploy-dev.sh` 经 `fdy-lock` 重入时丢失原始参数的集成错误；否则会打印 usage 并退出 2，部署无法开始。
- 已用 scratch Web root 验证：`live-new` 的旧候选产物被拒绝；只有明确传入 `--replaces live-new` 后才允许替换。

## 验证

- 定向 Server 检查：30 个 connector/httpapi 测试、protocol build、Worker build、contract/module audits 全部通过。
- Web：`server-held-connectors.test.mjs` 8/8 通过；typecheck 和 component-system、copy、hints、state-layout audits 通过。
- dev 真实设备流程：先移除 sg-chaos 上的 OpenLark 扩展，再通过 MCP 创建 `network: "device"` 的合成 OpenLark 实例。Server 自动安装扩展、Worker 回报后完成探测，实例 `xapp_394e4c81-8227-4ee6-a58a-5a3992b79f6d` 返回 `ready`、`access: write`、1 条路由；随后立即 revoke 并再次移除测试扩展，未创建或修改 NAS 实例。最终合并 Server 上重复同一流程也通过。

## 部署

- Server `789843f2ffc11b24b012aed124dee5f1a0dfd27da4e3abe8d86fae10ad9b6aee` 已部署；新的 handoff 进程与产物 SHA-256 一致，`/healthz` 返回 200。
- Web build `fbb6b42c7eb3e557` 已部署；入口 bundle 同时包含 DEV-203 的未命中消息/私聊文案和本项的自动安装说明。
- Server 与 Web 的源码 manifest 已随部署记录，后续 `deploy-dev.sh` 可做 lineage 检查。

## 限制

- 自动安装只适用于扩展描述符带有 bundled 或公开 Git source 的扩展；本地文件夹独有扩展仍需在该设备手动安装。
- 本次没有 Worker 代码改动，也没有重新打包或更新 Worker。
- 真实 OpenLark/NAS 实例仍需设备所有者提供 NAS token 后自行重试。

## 验收

1. 在 Web Connectors 中新建设备网络实例，选择一台未安装该扩展、但本人拥有且在线的设备。
2. 预期点击校验后先安装扩展，待设备上报后探测成功；保存后实例为 ready。
3. 使用 MCP `connector_instances create` 对同类设备执行相同流程，预期结果一致。
4. 选择离线设备时，预期立即返回明确的离线原因。
