# DEV-157 用 Agent 管理设备与 Skill 仓库：改读取设备、移除设备（必须确认）

## 状态

状态：已部署 dev（Server、Worker `0.5.7-dev.332.g48f40eba.local.1794256448`），Go / Worker 测试通过；`set_skill_repository_source` 已在 dev 真实使用（bytedcli 改由 byte-dev 读取，检查通过）；`remove_device` 待助理启动后由本人在确认卡片上验收。由编排会话 `sess_1794143153454726480` 拆分，实现由 Tencent TokenHub · deepseek-v4.1-flash-1017 子会话完成并经编排会话审查。

## 问题

本人（2026-11-10）希望这两件管理操作能由 Agent 代办：把 bytedcli 的读取改到 byte-dev（CanWendeMac-mini 解析不了 `bnpm.byted.org`），以及移除 10 月测试遗留的“DEV023 synthetic Linux”设备；删除类操作“要二次确认”。

## 修复

- **`set_skill_repository_source`**（MCP + `foundry library source <repositoryId> --device <id> [--registry <url>]`）：与 `PUT /api/skill-repositories/{id}/source` 共用 `setSkillRepositorySource`（`httpapi/skill_device_fetch.go`），HTTP 行为不变；仅本人的对话与助理可用，且本人须为实例管理员；Issue 会话、验证会话、工具会话拒绝。
- **设备移除预览**：`store.DeviceRemovalPreview` 与真正的清除共用一份执行计划（`sqlitestore/device_removal.go` `deviceRemovalPlan`，顺序与语句与原清除逐条一致），统计将删除的 Workspace（名称）、会话、Issue 与其他记录；`GET /api/devices/{deviceId}/removal-preview`（与删除同权限），并报告是否有运行中的回合。
- **`remove_device`**（仅助理）：走助理现有的提议/确认流程，**始终询问**（不受写入策略影响，`ProposalKind` 也强制为提议）；确认卡片列出预览（最多 5 个 Workspace 名称），并写明“此操作无法撤销”。不是本人的设备、未知设备、助理自身所在设备、设备在线且有运行中的回合，均直接拒绝不生成提议；接受时重新检查后调用与 HTTP 删除相同的核心。Web 提议卡片与飞书卡片按通用摘要渲染，无需改动。
- Foundry skill revision 29（两条新工具说明，两份副本逐字节一致）；助理提示词加入一行说明。

## 检查

- Go：`sqlitestore` 全包（含原有级联删除与归类防护测试）通过；`personalagent/...` 通过；`httpapi` 中 MCP / FoundrySkill / RemoveDevice / DeviceRemoval / SkillRepository / PersonalAgent / Proposal / Connector 相关测试通过；`builtinskills` 通过（合并后校验和）。
- Worker：`foundry-skill.test.mjs`、`foundry-cli.test.mjs` 13 项通过。
- 新增测试：管理员对话可改读取设备、非管理员与 Issue/验证会话拒绝、未知设备与 HTTP 同样报错；预览计数与实际删除一致且预览不写入；`remove_device` 在自动策略下仍询问、接受删除、拒绝不变、运行中回合在提议与接受时都拒绝、他人设备与助理自身设备拒绝、非助理调用拒绝。

## 部署 / E2E

- 2026-11-10 04:06 Server（含 `set_skill_repository_source`）、04:33 Server（含 `remove_device`），healthz 正常、7 台设备重连；Worker `0.5.7-dev.332` 发布到本人设备。
- 真实使用：子会话调用 `set_skill_repository_source`（bytedcli → byte-dev，registry `https://bnpm.byted.org`），返回 `checkStatus: passed`；库中 `fetch_device_id` 为 byte-dev、错误清空，上游版本读到 0.189.0。

## 限制

- `remove_device` 只有助理能用；本人助理当前停用，确认卡片的真实验收需先启动助理。
- 预览的“其他记录”是表级计数，不区分种类。

## 验收步骤

1. 启动助理，对它说“把 DEV023 synthetic Linux 这台设备移除”：应出现确认卡片，写明将删除的 Workspace 名称与会话、Issue 数量，以及“此操作无法撤销”。
2. 拒绝：设备仍在。再说一次并确认：设备与它名下的 Workspace、会话从列表消失。
3. 对助理说“把 bytedcli 改回由 CanWendeMac-mini 读取”再改回 byte-dev：Skill Library 卡片上的“由 … 读取”随之变化，并立即检查一次。
