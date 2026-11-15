# DEV-242 通道工作区也拿到助理的项目索引与摘要文件

状态：已部署 dev（train6-20261116）；Agent 代验收（2026-11-16，范围见验收记录）；已合入 main（PR #269）。

2026-11-16 E2E（`sess_1794776456356919583`，第 2 轮）：通道会话按 `.foundry/project-index.md` 与项目文件路由，未再退回 `list_workspaces`/`list_sessions`。

来源：E2E 第一轮 `sess_1794771302095655670` 的最终报告（缺陷 2）与本人的设计 [assistant-usable-20261116](../briefs/assistant-usable-20261116.md)。E2E 发现：助理按 `.foundry/project-index.md` 与 `.foundry/projects/*.md` 路由，但 Foundry 只把这些写进助理 home（`ws_802a0130…`）；通道会话跑在通道工作区（`ws_0349bea7…`），那里没有任何 `.foundry` 项目文件，三个路由用例都退回到 `list_workspaces`/`list_sessions`。此外 home 的 `project-index.md` 停在 11-13 且仍提到已删除的 `find_workspace`：索引只在运行前由 Worker 写入，digest/summary 变化只刷新 `projects/*.md`。

## 改了什么

### 1. 同一份内容写进助理运行的每个工作区（复用 DEV-235 的写入器，不另起写手）

- `prompt.ProjectFilesAndIndex(in)`：项目索引 + 每个项目一份摘要 + `.manifest`，与运行文件完全同源；`RunFiles` 改为复用它，不再在别处拼索引。
- `assistant.AssistantProjectFiles(ctx, agent)`：从 `PromptInput` 生成这些文件，内容与被权限包过滤的 digest/summary 来源一致。
- `assistant.WriteProjectFiles` 改为写**目标工作区**：home 加每个通道工作区（`projectFileWorkspaces` 取 `ListMessageChannels(userID, assistantID)` 的 `WorkspaceID`，与 home 去重）；每个目标走同一个 `writeAssistantFiles`（按 keep 清单删除不再覆盖的旧摘要，再逐个写）；设备在线的目标才写，单个目标失败只记日志、不影响其它目标。
- 同一助理的写入用 keyed mutex 串行（`Service.projectFileWrites`）：digest 刷新、权限包保存、归档/恢复和运行前写入可能并发；不串行时一个更早算出的快照可能在新写入之后才执行清理，把刚写好的摘要删掉（定向测试在并发下复现 2/20，串行后 `-count=20` 全过）。
- `RunFor`：通道会话（`session.WorkspaceID != agent.WorkspaceID`）现在返回 `ProjectFilesAndIndex`，不再只给 turn context；home 仍给完整的 `RunFiles`（AGENTS.md、示例、索引、摘要、技能）。

### 2. 索引与项目文件一起刷新

`WriteProjectFiles` 现在同时写 `.foundry/project-index.md`。它已由 digest/summary 变化（`refreshWorkspaceDigests` / `finishDigestSummary`）、归档/恢复（`setWorkspaceArchived` → `refreshWorkspaceDigests`）和权限包保存触发，因此索引不再只在运行前刷新。

### 3. 通道工作区里仍是 Foundry 生成、只读

- `generatedAssistantPath`：`.foundry/` 在 home 与通道工作区都算 Foundry 生成（Web 编辑器标只读）；`.claude/skills`、`.agents/skills` 的链接仍只在 home 生成。
- Worker `writePersonalAgentFiles`：只读工作区（通道）只接收 Foundry 的事实文件（`.foundry/project-index.md`、`.foundry/projects/<slug>.md`、`.foundry/projects/.manifest`）；AGENTS.md 与助理技能不写，其它只读会话仍然什么都不写。索引与摘要都不计入 runtime revision，digest 变化不会重启原生会话（与 DEV-235 的项目摘要同一原则）。

### 4. 通道 AGENTS.md 种子

`channels.SeedInstructions` 的「通道的事实」新增一行：判断某件事交给哪个工作区时，读本工作区的 `.foundry/project-index.md` 和 `.foundry/projects/`。已存在的通道 `AGENTS.md` 是本人的文件，不改写。

## 验证

- Go 定向（远程 CanWendeMac-mini，`scripts/remote-check.sh --go`）：
  - `internal/workspacedigest`、`internal/channels`、`internal/personalagent/prompt` 三个包全量通过；
  - `internal/httpapi`：`TestAssistantProjectFilesFollowTheDigest`、新增的 `TestAssistantProjectFilesReachAChannelWorkspace`（通道工作区收到索引与摘要、text 相同、digest 变化后索引刷新）、`TestAssistantProjectSummariesAppearInTheWorkspaceFileTree`、`TestChannelSessionInItsWorkspaceIsTheAssistantsConversation`（改为断言通道运行收到索引/manifest、没有 AGENTS.md）、`TestAssistantRunsCarryItsInstructionsAndTheTurnsContext`、`TestAssistantProjectIndexHoldsOnlyItsPersonsProjects`、`TestAssistantPackageGatesDispatchReadsAndCreatedWorkspaces`、`TestDeviceLifecycleMCPAndExplicitDefault`、`TestPermissionPackageSaveValidatesEveryReference` 全部通过；树测试 `-count=20` 在并发修复后全过。
- Worker 定向（远程，`scripts/remote-check.sh --worker test test/personal-agent.test.mjs`）：新增「只读通道工作区只收 Foundry 的 project facts」用例，以及既有项目摘要/ runtime key 用例通过（15/15）。
- scratch 栈真实 Worker（远程 byte-dev，空库 + 临时 HOME + 真实 Worker + 本树 Server/Worker）：配对设备 → 创建助理 home → 注册合成项目工作区 → 把它记为通道工作区 → 保存权限包后，磁盘上该通道工作区出现 `.foundry/project-index.md`、`.foundry/projects/project.md`、`.foundry/projects/.manifest`；索引 `As of 2026-11-16 04:37` 并列出 `project`；同目录没有助理 `AGENTS.md`。验后 scratch 栈与临时 HOME 已删除。证据（节选）：
  ```
  /tmp/dev242-scratch.qGO4qp/home/Foundry/project/.foundry/project-index.md
  /tmp/dev242-scratch.qGO4qp/home/Foundry/project/.foundry/projects/.manifest
  /tmp/dev242-scratch.qGO4qp/home/Foundry/project/.foundry/projects/project.md
  PASS channel workspace has Foundry's project index and summaries, no assistant AGENTS.md
  ```
  说明：空库里没有可用的连接器账号，无法走 `POST /api/personal-agent/channels` 的真实来源校验；检查在一次性 scratch 数据库里直接写入该通道记录（只用 `assistantId`/`workspaceId`），写入路径本身与生产相同（`WriteProjectFiles` → 设备 `write_workspace_file`）。

## 验收步骤

1. 部署后让助理在某个通道里运行一次，或等一次 digest/summary/权限包变化。
2. 到该通道工作区（助理设置「工作区文件」里 `kind=channel` 的那一项）确认出现 `.foundry/project-index.md`、`.foundry/projects/<项目>.md` 和 `.foundry/projects/.manifest`；home 的 `project-index.md` 的 `As of` 也应是新的。
3. 同一页里 `.foundry/` 下的文件只读；通道的 `AGENTS.md` 仍可编辑。
4. 在通道里问一个没有点名项目的问题，助理应引用索引/摘要文件路由，而不是只靠 `list_workspaces`/`list_sessions`。

## 限制

- 已存在的通道 `AGENTS.md` 不会自动改写（种子只影响新通道或缺失的文件）。
- 通道工作区仍由 `checkMessageChannelWorkspace` 约束在助理的 home 设备上；跨设备移动通道工作区不在本项范围。
- 离线设备保留上一次的 `.foundry` 文件，恢复后的下一次触发或运行再刷新。
