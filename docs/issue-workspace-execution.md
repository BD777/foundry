# 多仓 Issue 执行环境与 Workspace Accept

[项目 Roadmap](../README.md#roadmap) · [Issue 工作流](issue-workflow.md)

本文说明 Issue 候选环境（多仓 worktree）、执行约束、调度与 Workspace Accept 的设计。已实现，支持 macOS 与具备 bubblewrap / user namespace 能力的 Linux；实际操作边界见[第 12 节](#12-第一版实现与操作边界)。Evidence 的 Agent 阶段会话（澄清与判定）与 Accept/集成目前只在 macOS 开通，边界以 [Evidence v1 §9](evidence-and-verify-v1.md#9-尚需收口的实施项) 为准。

## 1. 目标与范围

Workspace 是持续演化的主体，包含代码、Rules、Docs、Know-how 与领域知识。用户选择一个目录即可建立 Workspace；Foundry 发现并登记其中的独立 Git 仓库，不强制改造成 submodule。

需要支持多个独立 Issue 在 Worker 容量内并行，每个 Issue 可涉及根仓库与多个任意深度子仓库。候选结果经过 Workspace Accept 后纳入已接受状态。已有 submodule 关系保留并识别，不能当作互不关联的独立仓库随意处理。

采用 Git worktree，不实现通用 OverlayFS/AgentFS，也不承诺候选 CWD 对所有未准备仓库提供透明目录映射。仓库范围由 Agent 在只读探索中逐步确定，不要求用户预先填写。Browser/Computer 工具、自动拆分和依赖 DAG 不在本方案范围内（见 [Tool Use](tool-use-and-resources.md)）。

## 2. worktree 放在哪里

**默认使用用户级执行存储：`~/.foundry/workspaces/<workspace-id>/environments/<issue-id>/workspace/`。**

`workspace/` 本身是根仓库的候选 worktree；参与仓库的 worktree 嵌入其登记的相对位置。环境属于 Issue，持续到验收或明确放弃；不是每个 Run 新建、结束即删除的临时目录。

选择外置目录的理由：避免候选树进入源 Workspace 的仓库扫描、全文搜索与备份；避免多层 `.foundry/worktrees` 递归；分开已接受内容与候选写入边界；候选与源目录重定位、空间统计和清理可分别管理。

已实现布局：

```text
~/.foundry/
  workspaces.json                   现有机器级 Workspace 注册表
  storage.local.json                可选 executionRoot；不进入仓库
  workspaces/
    <workspace-id>/
      registration.local.json       源目录、实际 Git 路径、扫描状态
      environments/
        <issue-id>/
          environment.json          环境版本、仓库映射、状态；daemon 持有
          workspace/                根仓库 worktree，Agent 初始 CWD
            AGENTS.md
            CLAUDE.md
            docs/
            services/backend/       按需创建的 backend worktree
            apps/frontend/          按需创建的 frontend worktree
          scratch/                  该 Issue 的临时输出
      runs/
        <run-id>/                   每次执行的事件、结果、验证与恢复证据
      acceptances/
        <acceptance-id>/            候选版本组合、集成记录与恢复日志
```

允许通过设备本地配置 `executionRoot` 更换到其他本地磁盘；上图 `~/.foundry/workspaces/` 即默认 executionRoot。配置改变仅影响新环境，已有环境使用 manifest 中保存的实际路径。路径不依据 Workspace 显示名称拼接，使用持久 UUID；不改用 `$HOME` 等系统变量承载配置。

创建前规范化源路径及执行路径，确保执行根不落在所选 Workspace、登记仓库或其他候选环境内。不要跟随软链接把候选环境放回源目录。默认执行位置空间不足或不可用时明确报错并允许配置外部位置，不静默回退到源目录写入。

所选目录中的 `.foundry` 保留 Workspace 声明及兼容数据：

```text
<source-workspace>/
  AGENTS.md / CLAUDE.md / docs/      纳入根仓库的项目资产
  .foundry/
    workspace.json                 现有 Workspace 身份与基线声明
    repositories.yaml              可版本化的相对仓库登记与策略
    assets.yaml / skills.yaml      项目级声明
    ...                            现有 sessions / attachments / 历史运行数据
```

不把整个 `.foundry` 一概加入 Git：共享声明与运行时/私有数据分别设置 ignore 规则。Chat sessions、浏览器附件和旧 Issue 证据保持原位置，不随执行环境迁移。

Git object store 不会因 worktree 在 `~/.foundry` 而搬走：使用登记仓库的既有 Git 对象库创建 linked worktree，并保留 Issue 专属候选 refs；工作文件在外置执行目录，Git 管理信息仍由 Git 维护。不得手工移动 `.git` 或硬链接整份 Git 管理目录。候选 refs 的存在不代表已接受分支已更新。

## 3. Workspace 注册与仓库发现

用户操作只有选择目录。Foundry 完成规范化、扫描与登记，并展示发现结果及不可用原因：

1. 所选目录可以是仓库根、普通目录，也可以是现有仓库内的子目录。位于现有仓库内部时不在其中初始化嵌套 Git，按普通目录继续发现其下的仓库（`repository-registry.ts`）。
2. 根目录不是 Git 时，准备初始化、ignore 与初始提交；只纳入明确的 Workspace 内容，不通过一次 `git add -A` 将所有嵌套仓库、缓存和私有文件收进去。
3. 发现任意深度的 Git 边界，识别 `.git` 目录、`.git` 文件、linked worktree 与已有 submodule。跳过 Git 内部数据、已知依赖缓存与 Foundry 自身环境；保留显式重新扫描入口。
4. 已发现仓库登记为 Workspace 可用资源；不立即创建全部 worktree。未完成扫描、无法访问和未初始化仓库必须可见，不把扫描失败当作不存在。
5. 不跨越目录外软链接自动登记外部仓库；不改变现有远端、历史、分支和私有配置。

每个 Repo 至少记录 `repoId`、相对路径、实际源路径、Git common directory、关系类型（root / independent / submodule）、父仓库（如有）、基线策略与可用状态。远端信息仅作辅助识别，同远端多路径不能被自动合并成同一个执行目录。共享声明不包含凭据或本机绝对路径。

独立仓库路径应从根仓库普通文件追踪中排除；已有 gitlink 不擅自删除。根仓库若已经追踪该路径下的普通文件，需要作为登记冲突处理，不能在上面直接叠放另一份 worktree。

## 4. Agent 在哪里、怎样启动

Issue 创建后先进入准备状态，在实际执行前完成根 worktree 的创建并落盘环境记录：

```text
用户输入 → Issue 等待执行
  → 固定根仓库起始 commit
  → 创建 Issue 根分支及 worktree
  → 启动绑定环境的 Agent
       cwd = <executionRoot>/<workspace-id>/environments/<issue-id>/workspace
```

初始候选目录包含根仓库已追踪内容，不包含未展开的独立仓库代码。启动上下文明确提供：Issue 目标、根规则文件、候选 CWD、源 Workspace 的只读路径、仓库索引、各仓库准备状态以及准备仓库的入口。

Agent 可以先读取根规则，再在源目录只读检索。不是靠 Issue 标题猜定全部仓库，也不是必须另启动一个规划 Agent。初始 `ls` 不会透明穿透到尚未准备的源子仓库；这一点明确写入执行规则和工具返回值。

仓库准备操作完成后，同一 Agent 会话继续执行，根 CWD 不变；仅增加其可用路径。Issue 内后续会话和 Run 复用环境，禁止两个修改型 Run 同时占用同一个候选环境。

## 5. 按需准备仓库

daemon 侧提供幂等 `ensureRepository(workspaceId, issueId, repoId)`。Agent 通过执行上下文给出的内部 CLI 请求；IPC capability 只允许枚举当前 Workspace 及请求准备已登记的仓库，不提供 Accept 权限：

```text
node <worker-dist>/repository-tool.js prepare <repo-id>
```

处理顺序：

1. 验证该 repo 已登记、属于本 Workspace，且环境尚未封存；对同一 environment/repo 加准备锁。
2. 仓库已就绪则返回原映射；仍准备中则合并请求；失败可以按记录恢复，不创建重复分支。
3. 固定该 repo 的起始 commit。独立仓库默认在首次准备时捕获其配置基线分支的 commit；记录捕获时间。已有 submodule 使用父候选 commit 指向的 gitlink，不能偷偷取子仓库最新 HEAD。
4. 创建专属候选分支和 worktree，目标为根候选 CWD 下的相对路径。父目录必须可安全创建，已有非空路径不能覆盖。
5. 先落盘 manifest，再把可用路径和基线版本返回给 Agent。准备中断留下可诊断状态，由恢复逻辑核对 Git 与磁盘事实。

准备集合包含需要读取/构建的依赖，不只是写入对象；必要时补上其祖先仓库环境和已有 submodule 的版本关系。不依靠文件系统第一次 write 自动展开整个仓库，不预先递归 checkout 所有登记仓库。

仓库一旦准备，针对它的编辑和验证使用候选路径；源路径保留为显式只读参考，避免同一次构建混用源文件与候选文件。

## 6. 执行约束

仅设置 cwd 不能提供写入约束。环境绑定同时覆盖 Agent SDK 内置文件操作、Shell、子进程和该 Issue 的后续会话：

- Source 工作文件：只读；禁止未验收改动直接写入。
- 当前 Issue 候选工作文件：可写。
- 已登记但未准备的候选 repo 路径：保护为不可写占位范围，避免 Agent 在里面建立普通文件来绕过 worktree 准备。
- 其他 Issue 目录、环境 manifest、调度状态与 Accept 凭据：不可写。
- scratch、运行日志、provider session state：按运行角色提供必要访问；不自动作为验收成果。

原目录绝对路径、目录跳转和软链接不能绕过写入限制。每次工具执行使用当前环境映射；新增仓库后更新后续工具进程的策略，不能假定已启动的 macOS 沙箱可随意扩大权限。必要时在保持 native session ID 的前提下重建执行进程，产品语义是继续同一会话。

Git metadata 与候选 refs 是特殊边界：不向 Agent 放开整个源 `.git`。只读 Git 可直接运行；需要修改 metadata 的操作可由受控本地 Git 入口代办，限定指定候选 index、分支和仓库，禁止直接移动已接受 refs。普通 Git 写命令是否可用窄权限直接开放，要在执行器实现阶段实测，不能承诺任意 Git 命令透明兼容。

采用 per-Issue 执行进程；不要对整个 daemon 动态修改权限。外部 MCP、已有宿主服务和 Browser/Computer 工具必须显式绑定该环境或经受控代理访问，不能因为由 Agent 调用就认为自动受限。

约束不可用时不以“worktree 路径正确”冒充已隔离，也不静默回退到源目录执行。执行器测试必须包含从原绝对路径写入失败的真实用例。

## 7. Worker 调度与 Run 生命周期

全设备使用同一个执行容量，Chats、Issue 执行及模型辅助作业都进入同一个调度器。达到上限的任务等待；有空位的独立任务并行。调度器属于 daemon 进程，不因 WebSocket 重连重置。

Worker 容量主要控制同时执行负载，会话和候选目录存在本身不占槽位。等待用户、等待验收时不继续占 Agent 执行槽；仍运行的构建、preview、后台子进程必须单独记账，不能因 UI 状态变成等待就视为机器没有负载。

Run 是一次执行记录，拥有独立 ID、事件和结果；同一 Issue 的后续 Run 默认使用原环境，不覆盖历史证据。中断后优先使用既有 native session 恢复；进程停止不等于候选环境可以清理。

环境状态：`preparing → ready → running → review → integrated/abandoned → cleanup_pending → cleaned`，另有可恢复的 `failed`。环境状态与 Issue 顶层状态相互独立。环境扩展、候选版本变化与每次运行都记录 revision。

## 8. Workspace Accept

已接受状态记录根仓库及参与仓库的 commit 组合；独立仓库无需把版本指针写成父 gitlink，已有 submodule 则维护其真实父子指针。

1. 汇总涉及仓库、规则/知识改动、候选 commits、差异与验证证据。把未提交改动保存为 Issue 候选提交，不移动已接受分支。
2. 在独立集成环境对比当前基线，解决文件冲突；submodule 自底向上处理。固定最终候选组合及其 revision。
3. 向人展示这份结果。若后续合并改变结果，重新验证并更新待接受版本，不能用旧的点头接受新的内容。
4. 接受请求绑定 candidate revision 和预期基线 commits。应用时再校验，基线已变化则回到整合流程。
5. 对同一 Workspace 的最终应用协调顺序，逐仓记录持久 journal；多仓不声称具有天然原子性。完成所有必要步骤并回传结果后，才显示 integrated。
6. 已接受源目录有普通 Chat 留下的未提交改动时，不自动 reset/stash；暂缓集成并说明冲突条件。Agent 候选基线不会自动包含这些未提交内容。

本地 Accept 不隐含 push。候选与已接受提交通过 durable refs 保留；需要跨机器恢复时，另行同步可访问对象与接受记录。根仓库单独 clone 不能重建所有独立仓库的状态，Foundry 登记和接受记录承担组合恢复职责。

## 9. 恢复、保留与清理

environment manifest 和 acceptance journal 由 daemon 原子写入，使用现有 owner-only JSON 机制。daemon 重启后核对实际 worktree、refs、进程和 Run 状态，恢复相同环境路径；记录缺失不能通过重新创建同名目录覆盖旧结果。

验收等待、失败和中断的候选默认保留。request changes 继续候选环境，不删除需要返工的 worktree。只有 integrated 或明确 abandoned 的环境进入可清理状态；即使放弃，也先保证需要保留的证据已落盘。

清理先停相关进程，核对未提交文件与候选提交的持久可达性，再从最深子仓库向根移除 worktree。不能以“已经 commit”作为强制删除私有子仓库对象的充分条件。不要按过期时间直接 `rm -rf` 候选目录；清理失败保留 journal，允许重试。

## 10. 与旧布局的兼容

早期 Issue 把 worktree 放在源目录 `.foundry/worktrees/<issue>-<run>`、运行证据放在源 `.foundry/runs`。新 Issue 一律使用外置环境（`issue-environments.ts` / `execution-storage.ts`）；`packages/worker/src/issues.ts` 中的旧路径只保留给旧 Issue 的读取与清理（`cleanupWorktree`、旧 `execution.json`）。

- 旧 Issue 根据原 `execution.json` 的实际路径继续读取/验收，不硬编码只允许新路径。
- 不自动移动已有 worktree。确需迁移时单独核对 refs、挂载、preview、子仓库与恢复元数据，不能用普通目录 rename 代替 Git 生命周期操作。
- server 只保存安全 projection；不因候选移出源目录就开放任意文件读取。由 worker 按 environment/artifact ID 提供限定内容。
- 配对凭据和 provider 配置保持本机私有，不注入根仓库、候选 diff 或版本化登记文件。

## 11. 设计依据与回归

仓库准备与 Accept 的内部操作通过同一 daemon 服务供 CLI/MCP/Web 复用，避免多套状态机。实现不依赖通用资源租约、自动 Issue 拆分、依赖 DAG 或 AgentFS。

Linux 后端依据 [bubblewrap 官方说明](https://github.com/containers/bubblewrap) 构造只读宿主文件系统和当前候选的可写挂载；启动前实际探测 user/PID/mount namespace，不把二进制存在当作能力可用。采用“根仓库 + Foundry 登记独立仓库”而非强制 submodule；[Git 多仓实验](research/git-submodule-worktree.md)记录了 worktree/嵌套/冲突/保留行为，[文件系统调研](research/workspace-candidate-filesystem.md)解释了 cwd 与实际权限之间的区别。

涉及本方案的改动应对应产品回归 case 并运行相关测试，提交前通过 `pnpm regression:commit`。代表性场景：根规则仓库 + 两个独立子仓库 + 一个已有嵌套 submodule，多 Issue 超过容量排队、动态加入仓库、运行中重连、同文件冲突、脏源目录、旧 Issue 恢复与自底向上清理。

## 12. 第一版实现与操作边界

- `foundry-worker init <目录>` / UI 建立 Workspace 会扫描任意深度仓库；`foundry-worker workspace scan <目录>` 可重新扫描并查看不可用原因。非 Git 根与无初始提交的 Git 根均可初始化，按 Git ignore 纳入普通项目资产，不依赖固定目录名。默认排除私有配置、缓存及生成文件；超过 25 MiB 的文件和越界/断开的 symlink 单独排除并记录。初始提交有 staging journal，可中断后重试；不自动提交用户已有暂存内容。已有 Git 根需要事先提交希望带入候选的规则与文件。独立仓库不会变成 submodule。
- Issue 默认使用外置持久环境，Mock 也写候选目录。执行失败不回退到源目录。每次 Run 的事件、报告、完成消息独立保存；后续 Run 保留环境和 native session ID。Issue 内提供持久化会话：输入反馈后继续原候选环境，保存每轮结果和用户反馈。普通独立 Chat 仍使用原 Workspace；既有 Chat 的搬迁绑定不属于当前入口。
- macOS `sandbox-exec` 限制文件写入到当前候选及 scratch，源目录、其他环境、控制记录和 `.git` 管理文件不可写。原生工具照常读取；Git staging/commit、worktree 和 Accept 由 daemon 代办。Linux 使用 bubblewrap，启动前检测 user/PID/mount namespace；只读挂载系统目录、`/etc`（域名解析与证书）和源目录，隐藏 Foundry 运行目录下的 Server 数据，挂载完成后把根目录设为只读；共享宿主网络，挡不住控制面端口。不可用或其他未支持 OS 明确失败，不无约束执行。隔离由 Sandbox 模块统一提供（见[模块化架构 §5.1](architecture-modules.md#51-sandbox)）。
- 准备新仓库时，工具返回“结束本轮后准备”。执行器退出后创建子 worktree，再以相同 native session ID 和新轮次记录继续，重新生成权限配置。该流程同时适用于确定性 command profile 与真实 Claude/Codex 路径。Issue 执行器传入只读 runtime settings 快照，并将 Claude 专用临时目录配置到 scratch；Codex CLI 后备路径也保存首次 native session ID。
- Web 的 Review 显示每个仓库的实际 patch、基线/候选 commit 与 revision。长 diff 会明确截断；完整版本保留在本地候选目录。Accept 绑定不可变审阅包（`reviewSnapshotId + reviewDigest`，见 [Evidence v1 §5](evidence-and-verify-v1.md#5-准出人工接受与恢复)），本机预合并全部仓库后才开始应用 journal；全部成功才显示 integrated。Accept/集成在 macOS 与 Linux 上均可用。
- 源目录存在未提交改动时阻止 Accept，不自动 stash/reset。冲突时选择 Request changes，将最新基线合入候选，由 Agent 修改冲突文件，再形成新 revision 审查。多仓应用中断时继续使用原 journal；未对账完成前阻止修改候选。多仓不承诺对外部编辑器实现原子事务。
- Git 分支、对象及候选目录在 Review/失败时保留。合入后可用页面上的 Clean accepted worktrees 或 `foundry-worker issue environment <issue-id> --workspace <目录> --cleanup` 按叶子优先清理；保留候选 refs。页面显示目录、仓库状态及占用，未验收候选不可清理。不自动做磁盘 GC。
- 独立 Issue 和 Chat 使用进程级共享调度器，WebSocket 重连复用同一调度器。服务端按容量跨登记 Workspace 轮询派发；Run 事件和完成消息支持 ACK 重放与幂等持久化。daemon 重启检查本地 Run 记录，补回完成结果或标记可重试的中断。
- `.foundry/repositories.yaml` 不含本机绝对路径；已有项目的 ignore 规则可能需要 `git add -f` 才能把该声明纳入版本。`storage.local.json` 的 `executionRoot` 只影响新环境，已有环境和后续 Run 使用持久路径。
- 配置 `.foundry/preview.json` 后，可在 Review 启动/停止 preview；它使用同样的 OS 写入限制，并占用共享 Worker 槽位。Accept、继续执行和清理前会停止 preview。停止执行会终止整组子进程，daemon 退出时有进程守护回收；旧版 preview/补丁记录继续可读。

验证入口：`packages/worker/test/issue-environments.test.mjs`、`apps/server/internal/httpapi/issue_environment_test.go`、`apps/server/internal/sqlitestore/issue_runs_test.go`，由 `cases/daemon/issue-workspace-execution.case.json` 记录回归意图。
