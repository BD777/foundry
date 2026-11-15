# DEV-235 助理按工作区摘要文件路由，去掉 find_workspace

状态：已部署 dev（train1-20261116）；Agent 代验收（2026-11-16，范围见验收记录）；已合入 main（PR #269）。

2026-11-16 E2E（`sess_1794776456356919583`，第 2 轮）：助理按 `.foundry/project-index.md` 与 `.foundry/projects/*.md` 路由到 ccm-omh-integration。

来源：2026-11-16 本人的设计（[assistant-usable-20261116](../briefs/assistant-usable-20261116.md) 与编排者的两次范围修正）：Workspace 的维护循环（digest + summary，§3）整理出的信息应展示在助理自己的 Workspace 里，助理的 runtime 原生读到它能管理的全部 Workspace 摘要，据此路由；不应由 Foundry 的排序工具替它判断。原有 `find_workspace` 因此移除。

**依赖（重要）：** DEV-238 正在修概括循环自 11-12 起停滞的问题。摘要文件的内容来自同一循环，DEV-238 完成前，已有摘要能正常写入，但过期/新增项目不会得到新摘要；文件仍会按当前 digest 生成。

## 改了什么

### 1. 每个项目一份摘要文件（Server + Worker）

- `workspacedigest.ProjectFiles`（`internal/workspacedigest/projectfiles.go`）从 `WorkspaceDigest` 生成：
  - `.foundry/projects/<slug>.md`：名称、workspace id、设备与在线/文件夹不可用、访问角色、purpose、模型 summary（≤600 字符）、routeWhen/notWhen、Skills、连接器、Git 分支与脏状态、最近会话（标题/状态/时间）、open Issues、`as of` 与是否可能过期；
  - 有路由笔记时写明 `cards/<workspaceId>.md`；
  - `.foundry/projects/.manifest`：当前文件名的清单，供 Worker 删除旧文件。
- 只覆盖助理权限包允许、设备仍存在、未归档、非助理自身工作区的项目；复用 `assistant.workspaceCandidates` 的 DEV-191 权限过滤与设备过滤。摘要内容再次经 `redact.Text` 脱敏。
- slug 来自项目名（Unicode 字母/数字，其余折叠为 `-`）；同名项目在不同设备上先加设备名，仍冲突再加 workspace id 尾部，保证文件互不覆盖。
- 写入路径：
  1. **每次助理运行前**：`prompt.RunFiles` 追加这些文件，与 `.foundry/project-index.md` 一样由 Worker 写入（`personal-agent-files.ts`）。项目文件变化不计入 runtime revision，避免摘要更新把原生对话重启；它们是用工具/文件按需读的事实，不是启动说明。
  2. **digest 或 summary 变化时**：`refreshWorkspaceDigests` 和 `finishDigestSummary` 调用 `assistant.WriteProjectFiles`，后台写入受影响助理的家目录，并删除不再覆盖的文件。权限包保存和归档/恢复也会触发一次同步。
- Worker 只允许 `.foundry/projects/<安全 slug>.md` 与 `.manifest`；写入后按 manifest 删除多余的 `.md`。旧 Server 不发 manifest 时不清理。
- `.foundry/` 仍由 Web 编辑器标为只读（`generatedAssistantPath`）。
- 项目索引继续是短列表，现在每行带上 `.foundry/projects/<slug>.md`，溢出提示改为“见 `.foundry/projects/`”。

### 2. 去掉 `find_workspace`

- 从 `personalAgentMCPTools`、MCP 路由、`mcp_tools.json`、Foundry CLI（`workspace find`）移除；`get_workspace` 保留。
- 移除 `assistant.FindWorkspace`、`routingNotes`（改为只查笔记是否存在）、`workspacedigest.Rank/RankRecords/Close` 及 `WorkspaceCandidate`（Go 与 protocol 类型）、`Service.Find/FindOptions`、`FindWorkspaceLimit` 与 `rank_test.go`。`Stale` 与 `isCJK` 移到 `index.go`；其余 digest 逻辑不变。
- 系统提示与 AGENTS.md 的路由步骤改为：读 `.foundry/project-index.md`、`.foundry/projects/` 与 `cards/<project id>.md`；拿不准就问本人。prompt 版本 `2026-11-16.1`（`prompt_test` 记录新 digest）。
- 评测脚本 `scripts/pa-eval-run.mjs` 的“无模型 `find_workspace` 排序”模式已移除；它现在只走 `--e2e`（真实助理回合，按实际派发到的工作区判分），`--scenario` 保留，旧命令里的 `--no-routing` 作为无操作参数继续接受。`cases/personal-agent/a03`、`a08` 的旧排序断言改为按派发工作区判定。`pa_routing_decisions` 表/类型保持原样（本来无生产写入；本次不记录路由选择）。

## 验证

- 定向 Go（远程 byte-dev，`remote-check` PASS）：`workspacedigest`（项目文件覆盖、同名分流、归档/助理自身排除、脱敏、索引预算与行）、`personalagent/prompt`（版本与 golden/digest、AGENTS.md 预算）、`personalagent/assistant`（编译）、`httpapi`（`TestAssistantProjectFilesFollowTheDigest`、`TestAssistantProjectSummariesAppearInTheWorkspaceFileTree`、权限包与设备移除相关用例）。
- Worker（远程 byte-dev，22/22 PASS）：`personal-agent.test.mjs` 新增项目文件写入、manifest 清理和 runtime key 不变；`foundry-cli.test.mjs` 移除 `workspace find`。
- scratch 栈真实 e2e（远程 byte-dev，空库 + 真实 worker + 随机端口）：创建助理 home（`personal-agent`）与项目 `project`，触发权限包保存后，磁盘出现
  `.foundry/projects/.manifest` 与 `project.md`（内容含 `ws_0032c4fe…`、设备、在线状态、`(not summarized yet)`、as-of）；
  Web 的同一数据接口 `GET /api/workspace-files/tree?workspaceId=…&path=.foundry/projects` 返回这两个条目。验证后 worker/server/实例目录已清理。
- 因为 scratch 设备没有可用的模型登录，摘要循环没有运行；文件按当前 digest 生成，正文显示 `(not summarized yet)`。这正是 DEV-238 的依赖：循环恢复后同一路径会写入模型摘要。

## 验收步骤

1. 打开助理设置 →「工作区文件」，主工作区下应出现 `.foundry/projects/`，里面每个可管理项目一份 `<名字>.md`，内容含摘要、设备、最近会话与 open Issues，且没有权限包外项目。
2. 在该文件里应看到 `cards/<workspaceId>.md` 仅在存在路由笔记时出现。
3. 让某个项目的 digest 变化（结束一轮会话或改 Issue）后，对应文件更新；归档一个项目后文件消失。
4. 对助理说一个没有点名项目的请求，它应引用项目摘要文件路由，而不是调用已移除的 `find_workspace`。
