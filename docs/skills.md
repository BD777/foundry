# Skills

[Roadmap](roadmap.md) · [文档索引](README.md)

Skills 负责会话能用哪些 Skill（含 `SKILL.md` 的工作方法包）：从设备和 git / npm 来源收进 Server 的 Skill 库，按不可变版本保存；Workspace 选用并可固定版本，个人默认 Skill 补到本人设备上的 Workspace；会话启动时把选定版本物化到设备上，并让会话只看到这些 Skill、它所用 Agent 的官方 Skill 和 Foundry 内置 Skill。它不负责会话怎么启动（执行内核的 Session Runtime 接收物化结果）、Skill 内容是否正确（由人发布时判断），也不替 Skill 准备运行环境，只有 bundle 声明的工具在人点击后由设备安装。在分层图中属于“能力供给”层：依赖“设备与 Workspace”（扫描、物化、程序检测都在设备上做）和“身份与共享”（库由 Admin 管理，Workspace 选用要求 Maintainer）；被执行内核和“Agent 能力面”使用（内置 `foundry` Skill 讲 Foundry MCP 工具的事实）。

## 设计

### 概念

- **来源**：设备的 Skill 根目录（默认 `~/.claude/skills`、`~/.codex/skills`，设备所有者可改）和该设备上每个 Workspace 自己的 `.agents/skills`、`.claude/skills`、`.codex/skills`。Workspace 里的是**草稿**：Agent（例如用 `skill-creator`）在那里新建或修改，经 Workspace 开关与设备能力协商启用后，Worker 将草稿及可解析依赖固定为受管快照用于当前执行。正式发布进库仍是独立动作。草稿与锁定版本试验的实施/准出状态见[接续记录](session-isolation-drafts-20261019.md)。
- **库条目与版本**：库里每个 Skill 有若干不可变的 zip 版本（revision），压缩后上限 64 MiB。内容不变不产生新版本。
- **仓库跟随**：库也可以跟随一个 git 仓库或 npm 包（`npm:<name>`），两种模式：`pick`（挑选其中若干 Skill）与 `bundle`（整个仓库作为一个单元）。都跟随最新 release tag / npm `latest` / 默认分支（或指定的分支、tag），变了的 Skill 才得到新版本；可回滚并暂停，再恢复；上游删除的 Skill 保留在库里并标记。
- **Workspace 选用**：Workspace 选库条目和 bundle，可把某个条目固定到某个版本；未固定的跟最新版本。
- **个人默认 Skill**：每个人可设默认 Skill 和 bundle，它们进入**本人拥有的设备上**的每个 Workspace；Workspace 可以逐个关掉，同名的选用优先。
- **Foundry 提供的 Skill**：Workspace 的（选用 > bundle > 设备所有者的默认 Skill > 默认 bundle，同名只取第一个）与 Foundry 内置 Skill（同名时内置优先，一个调用名只对应一个 Skill）。会话照常看到 Agent 自己的官方 Skill 和本人自己安装的 Skill（DEV-105）。
- **所需程序**：一个 Skill 需要的程序 = `SKILL.md` 中 `metadata.requires` 列出的 + 脚本扩展名对应的解释器 + 脚本 `#!` 行指定的程序。由 Server（`skillarchive.ToolRequirements`）得出，设备只回答有没有（Worker `skill-requirements.ts` `checkPrograms`）。

### 关键决定

- **原生发现（DEV-105，2026-10-31；取代 2026-09-28 起的“会话只看到 Workspace 启用的 Skill”隔离）。** Foundry 提供的 Skill 放到 Agent 原生会找的位置：Claude Code 是一个本地插件（`foundry-workspace:<name>`），Codex 是工作区 `.agents/skills/<name>` 下指向已校验快照的链接（写入 `.git/info/exclude`）。不禁用任何 Skill、不在提示里列目录、不按 receipt 拒绝续接原生会话、自定义命令的账号照常运行。只有 Issue 的判定者保持原生发现关闭（防止候选结果给判定者埋 Skill）；2026-11-05 起它不再从提示里拿到 Skill 清单，目前没有 Workspace Skill，原生方式留待 Issue 重构（[D4 修订](architecture-modules.md)）。
- **不往提示里注入 Skill（2026-11-05，DEV-121）。** 任何角色都不把 Skill 目录、索引或清单写进系统提示或输入，包括 Issue 的各个身份。Skill 只按 Agent 原生的形态提供，大 bundle 的列表大小由 Agent 自己的预算控制：Claude Code 的技能列表约占上下文的 1%，Codex 默认不超过 2%、可用 `skills.max_context_tokens` 调整。原来把大 bundle 合成一个条目的 `skillCatalog` 和 `skill-indexes/` 已删除。
- **清单预算提示（DEV-218）。** Claude Code 把会话能用的 Skill 写进一份有预算的清单：上下文窗口 × 每 token 字节数 × 1%，按显示宽度计（中日韩字符算 2），描述最多 1,536 字符；超出时先全部只留名字，再按它自己的优先级把描述加回去（读自 Claude Code 2.1.311；dev 上 Opus 5.5 与 Haiku 5.5 的清单都填到 29,981 / 30,000）。Workspace 的 Skills 页按这条规则估算（`features/skills/skill-listing-budget.ts`，30,000 宽度，从最窄的描述加起，所以是下限），超出时提示“至少 N 个只显示名字”。计入的有 Foundry 给的（`foundry-workspace:` 前缀）、Claude Code 自带的（总带描述）和设备 `~/.claude/skills` 与本 Workspace `.claude/skills` 里的；不含本人另外装的插件。Codex 的初始清单上限是窗口的 2%（`skills.max_context_tokens`），未估算。
- **Agent 的官方 Skill 清单**（`official-skills.ts`，#111/#112）：读取不发模型请求，按程序版本缓存，随账号状态上报，供输入框的 Skill 菜单显示。
- **Foundry 内置 Skill**（`apps/server/internal/builtinskills`）：`foundry` 给 Claude Code 和 Codex，`skill-creator`（vendored，来源与许可见 `SOURCE.md`）只给 Claude Code。它们像 Workspace Skill 包一样下发，文件夹变化时在 `builtinskills.go` 中提升 revision。`foundry` Skill 只讲事实（会话是谁、代表谁、能触达什么、代价与限制），工具用法写在工具描述里（2026-10-12 起 revision 4，见 [Session 编排](session-orchestration-design.md)）。**`packages/worker/skills/foundry/` 与 `apps/server/internal/builtinskills/foundry/` 必须逐字节相同**：前者随 Worker 包发布、由 `foundry skill install foundry` 安装，后者嵌入 Server；`packages/worker/test/foundry-skill.test.mjs` 检查这一点，并检查 Skill 只提到存在的工具和参数。
- **入库按依赖闭包。** 从设备发布时，Skill 身份是设备 / 根目录 / 目录名，不是名字；Worker 的依赖分析（`skill-dependencies.ts`，只索引、不执行文件内容）找出它引用的其他 Skill，计划里一并列出；同名的不同安装版本、缺少依赖图或超限都会阻止发布，而不是悄悄换成另一个版本。发布对话框可与库中已有版本逐文件对比，决定新建条目还是作为已有条目的新版本。
- **Server 读取公开仓库：只用 https。** `internal/skillrepo` 先 `git ls-remote` 解析提交，再按提交 `--depth 1` 浅克隆，不使用 Server 主机的 git 配置和凭据；npm 包取 tarball。每天检查一次（`skillRepositoryCheckInterval`），`FOUNDRY_INTEGRATIONS=off` 时不自动检查，人手动触发的检查仍会运行。
- **2026-10-09（#115）由设备代读 Server 够不着的来源。** 仓库可指定由一台设备读取（只能是设置者自己的设备，Admin 也可选无人拥有的设备）（`skill-repository-fetch.ts`）：git / npm 用这台设备自己的配置与凭据（ssh key、credential helper、npmrc），凭据不离开设备，不弹出交互；设备离线时检查排队，重连后执行。因此这条路径接受 ssh 远端（`skillrepo/device.go`）。
- **2026-10-09（#115）bundle 可声明工具，按人的点击逐台设备安装。** 来源是 GitHub release 下载（只用 https，限大小，有校验和就核对）、npm 包（不运行 install 脚本）或经设备自己的 `uv` 安装的 PyPI 包；工具的后续步骤（如下载浏览器）另需点击，需要交互登录的 CLI 只显示命令（`managed-tools.ts`、`internal/skilltools`）。回滚 bundle 时一并恢复工具版本。推荐 bundle：agent-browser、playwright-cli、browser-use。
- **缺失程序告诉会话，不让它绕开。** 设备每次扫描 Skill 时检测库中 Skill 需要的程序；会话启动时，Worker 把本机缺失的程序写进 Skill 策略，要求 Agent 告诉人去安装，而不是想办法绕开。

### Bundle 版本：CLI、Skill 与连接器一致（DEV-154）

起因（2026-11-09）：sg-chaos 上的 feishu-cli 还是 v1.41.0（只在设备所有者点击时才安装），Skill 库却已跟到 v1.44.0，会话拿到的 `SKILL.md` 写着 `Requires feishu-cli v1.44.0+`，执行 `doc media-preview` 得到 “unknown subcommand”。版本之间没有任何检查：`compatibility` 不被读取，Worker 的 `verifiedFeishuCliVersions` 只写日志，scope 预设写死在 v1.41.0。本人决定（2026-11-09）：CLI、Skill 和 Foundry 这一侧的连接器（网关兼容、scope 集）是**一个版本**，一致优先；默认自动、可切到手动，自动与手动都走同一条“先金丝雀、检查、失败整体回滚”的路径；通用，不为飞书开特例。

**版本是什么。** 一个 bundle 版本 = 跟随记录里的一条 `SkillBundleVersion`：tag、commit、成员（Skill 与 revision）、工具（名字与版本）。再加两项 Foundry 这一侧的数据：`check`（这个版本在金丝雀设备上的检查结果，取代代码里的“已验证版本”列表）；连接器的 scope 集按工具版本取（见下）。

**每台设备一个版本，按设备上实际装的 CLI 选。**

- 设备的版本 = 最新的一条记录，其工具版本与这台设备上 Foundry 装的版本（`device_tools.version`，安装时与每次扫描时上报）全部相同；早期没有记录工具的版本按 tag 等于工具版本匹配。函数只有一个（`bundleVersionForDevice`），会话派发与页面都用它。
- 会话得到这条版本的成员 revision，不是“最新”。设备上没有 Foundry 装的这个工具时，用库的当前版本（这时 Skill 依赖的程序本来就缺，照常标出缺失）；装的是任何记录里都没有的版本时也用当前版本，并在页面上标为不一致。
- Workspace 对单个 Skill 的版本固定仍然优先：那是人的显式选择。没有工具的 bundle 不受影响，仍取最新。

**会话启动时钉住 CLI。** `run_session` 带 `toolPins`（工具名、版本、所属 bundle、这个版本的检查是否通过）。Worker 为会话建 `<状态根>/session-tools/<会话>/`，其中每个工具链接到 `~/.foundry-tools/<名字>/<版本>/<名字>`：被钉住的用指定版本（版本目录在才用），其余 Foundry 工具用会话开始时的当前版本。会话 PATH 用这个目录代替会移动的 `~/.foundry-tools/bin`，之后的升级、回滚不会改变正在运行的会话里的 CLI。会话结束删除，残留的随 session-bin 一起清理。旧版本目录不删：回滚与正在运行的会话都依赖它们。

**绑定更新。** 每个带工具的 bundle 有更新方式 `updatePolicy`：`auto`（默认）或 `manual`，Admin 在 Skill 库切换。

- 目标设备：已经由 Foundry 装了这个 bundle 某个工具的设备（设备所有者之前点过安装，相当于选择了跟随更新）。没装的设备不碰；设备自带的同名程序 Foundry 不改。
- 新版本被跟随进库后（每天检查或人手动检查），`auto` 立即开始一次**更新（rollout）**；`manual` 只显示“有更新”，Admin 点“更新”开始同一次 rollout。暂停（回滚后）的 bundle 不会自动开始。`auto` 的 bundle 若最新版本从未做过 rollout（例如库在设备能被更新之前就已跟到新版本，正是起因中的状态），Server 启动、具备能力的设备连上、或 bundle 切到 `auto` 时补做这一次；做过 rollout 的版本（即使某台失败）或回滚后暂停的不会自己再试。
- **金丝雀**：选一台在线、Worker 支持 `bundle_rollout_v1` 的目标设备；工具属于 Server 持有型连接器时，优先选设备所有者有可用账号的那台。步骤：暂存安装（装进版本目录，不切换当前版本，旧版本保留）→ 检查 → 通过后原子切换（重写 `bin/<名字>` 链接）。
- **检查**（同一套步骤，数据来自连接器目录，不写飞书特例）：① `<工具> --version` 报告目标版本；② 工具是某个连接器的命令且目录声明了 `versionCheck` 时，在这个连接器给会话的同一种环境里依次运行声明的命令，全部退出码 0（有 `expect` 的输出须含它）。飞书的声明是 `auth status`、`auth refresh`（网关代答）和一次经网关的用户读取（`authen/v1/user_info`）。Server 持有型的检查需要替身凭据：Server 为这次检查签发**检查授权**（`chk_` 前缀，只对这台设备、这位设备所有者本人的这个账号，5 分钟，检查结束即删除），网关的资格复查对它按“本人账号、本人设备、账号可用”判断，不涉及 Workspace。设备所有者没有账号时这一步记为跳过并写明原因（没有账号也就没有会话经网关用它）。完整的网关合同（`TestFeishuCLIContractThroughTheGateway`，假飞书上覆盖用户、Bot、分片上传、Range 下载、事件）在 CI 与升级时运行，见下文“立即结果”。
- **通过**：版本的 `check` 记为通过；其余目标设备逐台暂存安装、`--version` 检查、切换；离线的设备记为等待，重新连上时继续；下一个版本的 rollout 接管仍在等待的设备，一台不再上线的设备不会挡住之后的更新。某台设备失败只让这台留在旧版本（它的会话照旧拿旧版本的 Skill，仍然一致），rollout 结果显示这台的原因。
- **失败**：删除金丝雀上暂存的版本（从未切换，会话不受影响），版本的 `check` 记为失败；库回滚到设备原来所在的版本（复用 bundle 回滚，Skill 与工具一起）并暂停跟随；在“等你处理”里告诉跟随这个仓库的人（仓库创建者）。“恢复”重新跟随并再走一次 rollout。安装失败（例如发布站点的下载返回 5xx）不算检查失败：每台设备的安装隔 15 秒、45 秒各重试一次；金丝雀仍装不上时 rollout 记为失败，不回滚、不暂停（什么都没动，各设备的会话仍拿与自己 CLI 一致的 Skill），同样在“等你处理”里告诉跟随的人，“更新”再试。自动开始（跟到新版本、补做）从不替换同一版本已有的 rollout。
- 每次 rollout 的状态（目标版本、金丝雀、每台设备的步骤与原因）存在仓库上，Skill 库实时显示；Server 重启时继续未完成的 rollout（暂存安装可重复执行）。
- 演练：`POST /api/skill-repositories/{id}/update` 带 `failCheck: true` 让金丝雀检查在真实步骤之后判为失败，用来验证回滚；只有 Admin 能调用，页面不提供。

**Scope 集跟着版本。** Server 持有型连接器的 scope 预设按工具版本取：飞书是 `feishu_cli_scopes.json` 中该 feishu-cli 版本的 `auth login --recommend` 清单（由 `scripts/feishu-cli-scopes.sh <tag>` 从该版本源码生成，与生成 v1.41.0 清单的方法相同：v1.44.0 完全复现；v1.41.0 的推荐清单复现，其 skill/approval 两组是当时库中较新 Skill 点名的、按原样保留），预设版本 = 已完成 rollout 的版本；没有生成清单的新版本沿用最近的已知版本并在页面写明。新版本的预设多出 scope 时，经 DEV-136 的权限选择器重新授权：每个账号在“等你处理”里出现一条“feishu-cli vX 需要新增的权限”，打开 Connectors 中这个账号的重新授权，不会静默失败。

**不一致在页面上显示。** Skill 库的 bundle 卡片按设备列出 CLI 版本与它对应的 Skill 版本：一致、有更新、版本不在记录中（不一致）、未检查；Connectors 的飞书页同样列出每台设备的 feishu-cli 版本与是否通过检查。Worker 的日志提示改为读 `toolPins` 中的检查结果。

**立即结果（本项）。** 2026-11-09 用 v1.44.0 跑网关合同测试通过（`TestFeishuCLIContractThroughTheGateway`），生成 v1.44.0 的 scope 集（推荐 173 项，相对 v1.41.0 新增 31 项、去掉 `docs:event:subscribe`），然后经自动 rollout 把各设备的 feishu-cli 升到 v1.44.0。

## 实现边界

截至 2026-10-14（`3092162`）。

**已实现**

- 扫描：Server 在设备连接时和每 30 分钟（`deviceSkillRescanInterval`）请求扫描，同一设备同一组目录的并发扫描合并为一次；扫描在 Worker 的独立线程中运行，避免饿死心跳（`skill-scan-thread.ts`、`skill-scanner.ts`）。
- 库与版本：`internal/skillarchive`（不解压建立索引、清单解析、所需程序）、`sqlitestore/skills_catalog.go`、`skill_versions.go`；发布与对比 `httpapi/skill_promotion.go`、`skill_compare.go`（路由 `/api/skills/promote*`、`/api/skills/compare*`；发布要求设备所有者）。删除库条目、管理仓库要求 Admin（`routes.go` 中 `adminOnly`）。
- 仓库跟随：`internal/skillrepo`（git、npm、设备代读的远端格式）、`httpapi/skill_repositories.go`、`skill_bundles.go`、`skill_device_fetch.go`、`sqlitestore/skill_repositories.go`。
- 选用、固定、默认与关闭：`PUT /api/workspaces/{id}/skills`、`.../skills/{skillId}/pin`、`.../skill-bundles`（Maintainer），`/api/me/default-skills`；合并规则在 `httpapi/default_skills.go`（`resolveWorkspaceSkills`、`sessionSkillRefs`），内置 Skill 在 `httpapi/skills.go` `withBuiltinSkills` 加入。
- 物化与隔离：`skill-materializer.ts`（按 Skill + 版本从 Server 取包、校验 checksum，解包到内容寻址的 `<state>/skill-sets/<hash>/`，不碰用户自己的 Skill 目录）、`codex-native-skills.ts`、`session-policy.ts` `claudeSessionOptions`、`official-skills.ts`。Issue 的判定者目前不拿 Skill（[D4 修订](architecture-modules.md)）。
- 工具安装：`POST /api/devices/{deviceId}/tools/install`（设备所有者，仅 bundle 的工具），Worker `managed-tools.ts`。
- Web：Skill 库页（`/skill-library`，`features/skill-library`：仓库、bundle、推荐 bundle、版本与工具状态）；Workspace 的 Skills 页（`/workspace/skills`，`features/skills`：选用、默认、固定版本、官方与内置 Skill、缺失程序标记）与 `foundry` Skill 详情页（`/workspace/skills/foundry`）；设备页的 Skill 搜索；输入框 `/` 菜单按会话实际解析的结果列出（`features/chat/composer-slash.ts`）。

**未实现 / 已知缺口**

- 从 Foundry 安装 `metadata.requires`、解释器、shebang 推出的缺失程序：目前只检测并告诉会话；只有 bundle 的工具可以安装（release / npm 包自带的命令，以及跟随时额外声明的至多 4 个 uv 或 npm 工具）。
- Server 直接读私有仓库：Server 只读公开 https 来源，不保存仓库凭据；私有来源目前只能经设备代读，依赖那台设备在线。
- 自动提炼与推荐 Skill：不存在。
- `bundle` 不能改回 `pick`（`handleSetSkillRepositoryMode` 注释）。
- 旧 Worker 写过的 `.foundry/skills.yaml` 不再读取（[存储策略](storage-strategy.md)），本仓库中的那份只是遗留文件。

**验证情况**

- 有真实运行记录：Skill 隔离 receipt 在 Worker 被杀后保留（2026-09-28，dev 与真实 Mac）；Skill 库、默认 Skill、版本固定、官方 Skill 与选用页面在隔离栈和 dev 上运行（2026-10-09）。（隔离已于 DEV-105 取消，原隔离检查脚本已删除。）
- 只有单元 / 接口测试：依赖闭包与冲突、仓库跟随与回滚、设备代读、npm bundle、扫描合并（`apps/server/internal/httpapi/skill_*_test.go`、`default_skills_test.go`、`sqlitestore/skill_*_test.go`），Worker 的扫描、依赖、隔离、所需程序、zip 安全（`packages/worker/test/skill-*.test.mjs`），Web 的选用与版本（`apps/web/test/skill-*.test.mjs`）。本次整理未重新运行。

## 后续

状态、依赖与完成标准见 [Roadmap · Skills](roadmap.md#skills)（SK-1–SK-4）；本节只保留设计要点。

- **已实现并自验：** [Workspace 草稿试用、隔离补全与启动准备](session-isolation-design.md)。已支持受管草稿快照、刷新、固定版本 include/exclude/previous 试验，以及缓存内容复核、精确挂载和共享启动准备。正式发布仍是独立动作；原生子 Agent 的 Skill 隔离尚未独立验证，因此试验使用 Foundry 独立会话。草稿试用（`skillSelection`）与隔离已于 DEV-105 删除，草稿本身与刷新保留。完整范围与平台局限见 [DEV-006/007 交付记录](devlog/DEV-006-007-isolation-drafts.md)；准出与源码合入见 [DEV-025](devlog/DEV-025-release-closure.md)。
- 从 Foundry 安装 Skill 缺失的程序，沿用 bundle 工具的安装路径（按设备、人点击、https 与校验）。
- 私有仓库：让 Server 也能读需要凭据的来源，不依赖某台设备在线；凭据按[安全边界](security.md)的 sealed secret 规则保存。
- 自动提炼与推荐 Skill：从会话中提炼可复用的方法成为 Workspace 草稿，或按 Workspace 推荐库中已有的 Skill；产物仍经人发布进库。

## 代码位置

- 协议类型：`packages/protocol/src/skills.ts`。
- Server：`apps/server/internal/skillarchive/`、`skillrepo/`、`skilltools/`、`builtinskills/`（含 `SOURCE.md`）；`apps/server/internal/httpapi/skills.go`、`skill_*.go`、`default_skills.go`、`foundry_skill.go`；路由 `routes.go`。
- 存储：`apps/server/internal/store/skill_repositories.go`；`apps/server/internal/sqlitestore/skills_catalog.go`、`skill_versions.go`、`skill_bundles.go`、`skill_promotion.go`、`skill_repositories.go`。
- Worker：`packages/worker/src/skill-*.ts`、`official-skills.ts`、`managed-tools.ts`、`session-policy.ts`，daemon 处理 `packages/worker/src/daemon/handlers/skills.ts`；随包 Skill `packages/worker/skills/foundry/`。
- Web：`apps/web/src/features/skill-library/`、`apps/web/src/features/skills/`、`apps/web/src/features/devices/skill-search.tsx`、`apps/web/src/features/chat/composer-slash.ts`。

## 2026-10-23 启动准备优化

实现与部署状态见 [DEV-038](devlog/DEV-038-skill-preparation.md)。新 Worker 可用 Server 下发的 revision 内容摘要验证展开缓存，缓存命中跳过 ZIP 解包；会话目录的完整性检查和版本隔离保留。后台准备由所选版本变化与设备连接触发，不改变授权清单。二级目录只影响初始展示，成员仍可被用户精确指定；正文继续按需读取。旧 Worker 或缺少摘要的旧清单走兼容路径。
