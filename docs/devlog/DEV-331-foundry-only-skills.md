# DEV-331 会话只认 Foundry 的 Skill；草稿优先并可发布；本地 Skill 只作导入来源

本人 2026-11-24（看到 feishu-structured-doc 被改进 my-skills、Foundry 却不知道之后）：「我们 foundry 的 skill 管理逻辑看起来问题很大啊……要优雅，要高内聚低耦合，要统一规则不要到处 hack」。三项决定（同日，逐条批注）：

1. 「我想否定 DEV-105 的判断了。因为随着模型能力越来越强，skill 很多时候会造成反作用。所以我希望改成：只认 Foundry 的 skill，不认用户机器本地的 skill。后者可以被 foundry 识别出来，用户可以在 foundry promote 他们并 apply 到某个 workspace，那之后才能使用。」
2. 「草稿优先。且要明确告知用户本地 skill 跟 library skill 有了差异，给用户将它 promote 到 foundry skill library 的入口。」
3. 「my-skills 可以废弃了。我自己也会统一用 foundry 来管 skills。」

## 起因与证据（2026-11-24）

- 会话 `sess_1795423194895939999`（project_a，byte-dev）用 skill-creator「更新 feishu-structured-doc」，改的是 byte-dev 上的 `my-skills/skills/feishu-structured-doc`（未提交），Foundry 库里仍是 rev 1。
- 原因：Foundry 给会话建的配置目录里 `skills → ~/.claude/skills`（`harness/runtime-isolation.ts` `claudeConfigurationNames`，DEV-105），byte-dev 的 `~/.claude/skills/feishu-structured-doc → my-skills/...`。会话里同时有 `feishu-structured-doc`（本地）与 `foundry-workspace:feishu-structured-doc`（库 rev 1）；06:27 的 `Skill` 调用用了裸名，读写的都是本地那份。
- 同一个 Skill 此时有四份互不相同的内容：库 rev 1（10-09 从 sg-chaos `~/.claude/skills` 发布，即 sg-chaos my-skills 未提交的改写）；foundry 仓库 `.agents/skills/feishu-structured-doc`（10-10 在 rev 1 上继续改、从未发布，会话里显示为 `foundry-workspace:workspace-draft-2fbfcf40…`）；byte-dev my-skills（git 旧底稿 + 今天 4 处修改 + `references/whiteboard-style.md`）；git HEAD。
- 同名规则三处各一套：Claude 本地与库同时可见；Codex 在 Workspace `.agents/skills` 里本人同名文件夹优先（`codex-native-skills.ts`）；草稿一律改名 `workspace-draft-<id>` 与库并存（`workspace-skill-runtime.ts:106`）。
- 「是不是 Foundry 自己的链接」各处各判：草稿扫描只排除 `.foundry/assistant-skills`（`workspace-draft-skills.ts` `managedAssistantSkill`），Codex 链接用 `skill-sets` 前缀加正则，文件浏览另有 `managedSkillLinkFolder`，设备扫描不判断，于是把 Foundry 放进各 Workspace 的链接当成本机 Skill 扫回（byte-dev 6 个目录“装了” feishu-structured-doc，全是 rev 1 的链接；`httpapi/skills.go:373` `workspaceSkillDirs` 被当作设备扫描根）。
- 发布不记录基于哪个版本，byte-dev 那份直接发布会覆盖 rev 1；发布只能在 Web 点，MCP 没有。
- 文档矛盾：`workspace-sandbox-overview.md` 说“设备上其他 Skill 不可见”，`skills.md` 说本人 Skill 照常可见。DEV-218 实测 Claude 清单 465 条中 418 条只剩名字，多数是设备本地 Skill。

## 规则（取代 DEV-105 中“本人 Skill 照常可见”的部分）

- **R1 会话里的 Skill 只来自 Foundry**：Foundry 内置、Workspace 选用 / 固定 / bundle、个人默认、本 Workspace 的草稿，加上运行时自带的官方 Skill（Claude Code / Codex 随程序发布的）。设备本地（`~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills`）和本人插件带的 Skill 不进入 Foundry 会话。在本机直接开的 Claude Code / Codex 不受影响。
- **R2 一个名字只对应一份**，顺序：内置 > 本 Workspace 草稿 > Workspace 选用与固定 > bundle > 个人默认 > 默认 bundle。草稿用它自己的名字（不再改名），遮住同名库条目。一个函数算出结果，Claude、Codex、Antigravity（DEV-328，若支持 Skill）、`/` 菜单、Skills 页清单预算都用它。
- **R3 用原生开关实现，不改 Agent 行为**：Claude 用 Agent SDK 的 `skills: string[]`（官方的会话 Skill 白名单，清单与 `Skill` 工具都按它过滤）；会话配置目录不再链接本人的 `skills`；Codex 用 `[[skills.config]] path=… enabled=false` 关掉非 Foundry 的 Skill（Foundry 组的 CODEX_HOME 里写），不改 HOME。
- **R4 一个“Foundry 管理的路径”判断**：快照（`skill-sets`）及其链接、助理 Skill 链接由一个函数判断，设备扫描、草稿扫描、Codex 链接、文件浏览共用；设备扫描跳过它们。
- **R5 来源分工**：设备 Skill 目录 = 导入来源（扫描、比较、发布进库，之后选用到 Workspace 才能用）；Workspace 的 `.agents/skills`、`.claude/skills`、`.codex/skills` = 草稿（试用、发布）；不再把 Workspace 目录当设备扫描根。库条目只读，改一个库 Skill = 把它检出成草稿、改、发布。
- **R6 差异要告诉人，并给入口**：草稿与同名库条目不同、设备本地 Skill 与同名库条目不同或库里没有时，Workspace Skills 页与设备页标出（“草稿与库 rev N 不同”“本地与库 rev N 不同 / 未入库”），旁边就是发布入口；发布后可直接选用到某个 Workspace。
- **R7 发布一条路径、带基线**：Web 与 MCP（新增）走同一个发布接口；发布时带上看过的库最新 revision（乐观并发），库在此后变了就拒绝并要求重新比较；从库检出的草稿记下基线 revision，基线不是最新时标为“分叉”，发布前须先合并。
- **R8 写给 Agent 的只有事实**：`foundry` Skill 一句话说明库里的 Skill 只读、修改要检出为草稿并发布，以及对应的 MCP 工具；不注入提示。

## 实施切片

| 切片           | 内容                                                                                                                                                                                | 状态                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| A Worker       | R1–R4：会话 Skill 解析单一函数、Claude `skills` 白名单、配置目录去掉本人 `skills`、Codex 关闭非 Foundry Skill、草稿保留原名并遮住库条目、共享的 Foundry 路径判断、扫描跳过受管链接  | 已合入 dev 检出，待部署 |
| B Server + MCP | R5–R7：草稿 / 本地与库的差异状态、从草稿发布（带基线与并发检查）、检出库 Skill 为草稿、MCP `publish_skill` 等、Workspace 目录不再作设备扫描根                                       | 已合入 dev 检出，待部署 |
| C Web          | R6：Skills 页草稿差异与发布入口、设备页本地 Skill 差异 / 未入库与“发布并选用”、清单预算只计 Foundry 的                                                                              | 并入 B，已合入，待部署  |
| D 文档与迁移   | `skills.md`、overview 矛盾、`foundry` Skill 事实句；本人设备上未入库的本地 Skill 清单；feishu-structured-doc 合并为 rev 2（foundry 仓库草稿 + byte-dev 今天的修改）作为首个真实用例 | 部分完成（本文件）      |

## 验收步骤（预期结果）

1. 在 byte-dev 的 project_a 开新 Chat，问“列出你能用的 skill”：只有 `foundry-workspace:` 前缀的 Foundry Skill、内置与运行时官方 Skill；没有 `~/.claude/skills` 里的本地 Skill（如裸名 `feishu-structured-doc`、`bytedance-*`）。
2. 同一 Workspace 放一个与库同名的草稿：会话里只有一份，用的是草稿内容；Skills 页显示“草稿与库 rev N 不同”并有发布按钮，发布后库出现 rev N+1。
3. 设备页：本地改过的 Skill 显示“与库 rev N 不同”，未入库的显示“未入库”，都能发布并选用到某个 Workspace。
4. Agent 经 MCP 发布：用过期的 revision 发布被拒绝并提示重新比较。
5. feishu-structured-doc rev 2 = foundry 仓库草稿 + byte-dev 今天 4 处修改 + whiteboard-style.md；project_a 新会话用到 rev 2。

## 进展

| 时间（UTC+8）    | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-24 15:40 | 调查、本人三项决定、规则与切片定稿                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-11-24 16:10 | 切片 A（`sess_1795505244080737459`）与 B（`sess_1795505246373003970`）完成并审阅：A 修正被遮住库条目按实际目录移除；Codex `skills/list` 准备耗时实测冷 380 ms / 热 191 ms，不加缓存。合入 dev 检出；草稿摘要改为调用共享的 `skillContentDigest`；foundry Skill 升到 revision 48。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-11-24 16:45 | 部署 dev（Server + Worker，`--label dev329`）：线上来源含 `origin/main`（#306–#312）与其他会话已部署未提交的改动，故从“线上源码 + 本项补丁”重建（Server/Worker 源码除本项外与线上一致，仅 9 个 Web 文件不同）；Server `d6777300909d`，Worker `0.5.7-dev.403.gb62495c0.local.1795509542`，sg-chaos / CanWendeMac-mini / macbook / byte-dev 已更新。Web 未部署：线上 Web 有 3 个文件在任何检出与分支中都找不到。验收 1 通过：project_a 新会话（`sess_1795509879623971949`）只有 `foundry-workspace:` 与 Claude Code 自带的 9 个 Skill，无设备本地 Skill；`feishu-structured-doc` 只以 `foundry-workspace:` 名字出现、目录在 skill-sets 快照；`checkout_skill`、`publish_skill` 可用。编号与 origin 的 DEV-329 冲突，改为 DEV-331。待办：快照只读（已派 A）、Web 部署、提交。 |
| 2026-11-24 16:55 | 快照只读（A，worktree `dev331-readonly`）：库与草稿快照文件 0400、目录 0500，清理时恢复目录写位；Worker 33 项相关测试通过。从线上源码快照构建，Worker `0.5.7-dev.403.gb62495c0.local.1795510387` 部署 dev，更新 byte-dev / sg-chaos / CanWendeMac-mini / macbook。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-11-24 20:50 | PR 树（`work/dev331-foundry-skills`，origin/main + 本项）全量检查与审查修复：迁移列分类、skills-feature 拆分、发布/检出的角色策略（Issue 执行只能检出到候选目录、不能发布）、只读快照统一由一个删除函数清理、Codex `skills/list` 3 s 超时且失败时会话照常启动并记日志。byte-dev 全量 Worker 测试与 origin/main 基线失败项一致（仅环境的 image-previews、native-archive）；Server 全部包、Web、协议、UI 审计通过；契约生成检查在 Mac 通过（byte-dev 的 Go 1.24 过旧）。dev：Server `8fcaf301394a`、Worker `0.5.7-dev.403.gb62495c0.local.1795524555`，四台设备已更新。                                                                                                                                                                                                      |
| 2026-11-24 23:30 | PR #315 合并（`ae6e8a8f`，含 CI 发现的恢复脚本只读快照清理 `595f6967`）。Web 部署 dev `a2886d5d717f92e0`：基于 origin/main（含 #314/#316/#317）+ 本项，带上共享检出中与线上哈希一致的 DEV-328 未提交文件；线上 Web 文件的差异全部可由本项或已合并 PR 解释。待：本人用 checkout/publish 迭代 feishu-structured-doc（验收步骤 2–5），DEV-328 需自行提交其 Web/契约改动。                                                                                                                                                                                                                                                                                                                                                                                                     |
