# DEV-103 · Agent 可以归档本人设备上的原生对话

状态：已部署 dev：Server `da4c81c8…`（SIGHUP 交接）。Agent 自验通过。人工验收待确认。未提交。来源：本人在 `sess_1793353072012341166` 中提出“改一下这个约束”。

## 问题

本人让 Agent 归档侧栏里 12 条旧的原生 Codex/Claude 对话（`native_codex_…`、`native_claude_…`）。`archive_session` 拒绝了：

- 按 id：`sessionTarget` 对原生对话直接回 “is a native chat on its device, not a Foundry session … cannot archive it”（`mcp_sessions.go`）。
- 按文件夹：`authorizeArchive` 对 Agent 逐个检查 `canControlSession`。原生对话不是 Foundry 会话，也没有 `CreatedByUserID`，所以整组都会被拒。

本人在网页上作为 Member 可以归档工作区里的任何对话，包括原生对话。Agent 的规则是“只能控制本人发起的会话”，而原生对话没有发起人记录，所以 Agent 一条都动不了。

## 修复

- `policy.go`：新增 `canArchiveNativeChat`。本人：工作区 Member 即可，与原来一致。Agent：同时满足三条才行：本人是该工作区的 Member；Agent 不在 Issue 里；该工作区的设备由本人配对（`workspaceDeviceOwner == agentFor`）。原生对话没有作者，所以用“设备由谁配对”代替“由谁发起”。
- `chat_archive.go` `authorizeArchive`：Agent 路径上的 `native_…` id 用上面这条规则，其余 id 仍走 `canControlSession`。按文件夹归档时，文件夹里的原生对话也按这条规则检查。
- `mcp_archive.go`：新增 `archiveTarget`。原生对话 id（或链接）先按原生对话解析，交给 `authorizeArchive` 判权；找不到时按原路径解析，这样被会话接管的原生对话仍作为那个会话处理。没有改 `mcp_sessions.go`：DEV-101 正在改这个文件，`sessionTarget` 对其他动词仍拒绝原生对话。
- `mcp_tools.json`：`archive_session` 的描述补一句：Agent 也可以归档本人配对设备上工作区的原生对话（Issue 外）。
- 不变的部分：Personal Agent 归档超过 3 条或整个文件夹仍先征求确认；恢复（restore）用同一套判权；设备侧的原生归档（Codex 把 rollout 移到 `archived_sessions`）沿用 DEV-048 的路径。

## 测试

- 新增 `TestArchiveNativeChatByAgentFollowsDeviceOwner`（`chat_archive_test.go`）：bob 的 Agent 能归档、恢复 bob 设备上的原生对话。alice 把工作区以 Member 身份共享给 bob 后，bob 的 Agent 归档 alice 设备上的原生对话仍被拒，对话保持未归档。
- `scripts/check-changed.sh --files <5 个文件>`：prettier、gofmt、go test（4 个归档测试）、audit:contract 通过。audit:modules 失败，原因是其他会话未提交的 `worker: runner/codex-compatibility` 未分配模块，与本项无关。
- 另外跑了 43 个涉及 MCP 工具 schema 与访问策略的测试，以及全部 `TestMCP*`、`TestInspection*` 和 `*Archive*` 测试：通过（67 s）。整个 httpapi 包在本机超过默认的 10 分钟上限，没有跑完；超时时的输出里没有失败的断言。

## 部署

- 用共享工作树原样构建（包含 DEV-101 第 2 轮：mcp_tools.json 里已经没有 `wait_session`/`handoff_session`），产出 `da4c81c8…`。回滚副本是 `foundry-server.pre-native-archive`（即 DEV-101 的 `d3cac98a…`）。
- 2026-10-30 18:09:56 SIGHUP：新进程接管，旧进程 347 ms 后以 `<nil>` 退出；`/healthz` 200。已通知 DEV-101 会话，它再部署时要带上这些文件。

## Agent 自验

在真实 dev Server 上，`sess_1793353072012341166` 用自己的会话令牌调用 `archive_session`，归档本人截图里的 12 条原生对话：7 条 Codex，5 条 Claude，均在工作区 `foundry`、设备 dev 服务器设备。结果：`archived` 12 条，无 blocker，batch `arch_01a18c4a-c1cb-7c10-8782-da58720ad733`。设备上 7 条 Codex 的 rollout 都已移到 `~/.codex/archived_sessions`，`~/.codex/sessions` 里不再有。

## 验收步骤

1. 打开 foundry 工作区的对话列表，选“已归档”：能看到上面 12 条原生对话，归档人是 `sess_1793353072012341166`。
2. 在任一 Agent 会话里让它归档本工作区的一条原生对话（例如 `native_codex_…`）：预期成功，并且这条对话从列表消失。再让它恢复：预期回到列表。
3. 预期被拒的情况：Issue 里的会话，或者设备由别人配对的工作区。报错是 “an agent may archive native chats only on a device its person paired, outside an Issue”。

## 限制

- 一台设备的系统账号如果被多人共用（例如 e2e-alice），这台设备上的原生对话无法区分是谁的。规则按“设备由谁配对”判断，配对人的 Agent 可以归档这台设备上所有原生对话；这与配对人自己在网页上的权限一致，且可以恢复。
- Claude 原生对话的归档只在 Foundry 侧生效，与 DEV-048 相同。

## 流水

| 时间（UTC+8）    | 变化与证据                                                                                   | 剩余动作                                |
| ---------------- | -------------------------------------------------------------------------------------------- | --------------------------------------- |
| 2026-10-30 18:16 | 定位、修复、测试、部署 `da4c81c8…`，并真实归档 12 条原生对话（见上）。Agent 自验通过，未提交 | 人工验收；按提交约束在 22:00–09:00 提交 |
