# Skills

[项目 Roadmap](../README.md#roadmap) · [文档索引](README.md)

Skills 负责会话能用哪些 Skill（含 `SKILL.md` 的工作方法包）：从设备和 git / npm 来源收进 Server 的 Skill 库，按不可变版本保存；Workspace 选用并可固定版本，个人默认 Skill 补到本人设备上的 Workspace；会话启动时把选定版本物化到设备上，并让会话只看到这些 Skill、它所用 Agent 的官方 Skill 和 Foundry 内置 Skill。它不负责会话怎么启动（执行内核的 Session Runtime 接收物化结果）、Skill 内容是否正确（由人发布时判断），也不替 Skill 准备运行环境，只有 bundle 声明的工具在人点击后由设备安装。在分层图中属于“能力供给”层：依赖“设备与 Workspace”（扫描、物化、程序检测都在设备上做）和“身份与共享”（库由 Admin 管理，Workspace 选用要求 Maintainer）；被执行内核和“Agent 能力面”使用（内置 `foundry` Skill 讲 Foundry MCP 工具的事实）。

## 设计

### 概念

- **来源**：设备的 Skill 根目录（默认 `~/.claude/skills`、`~/.codex/skills`，设备所有者可改）和该设备上每个 Workspace 自己的 `.agents/skills`、`.claude/skills`、`.codex/skills`。Workspace 里的是**草稿**：Agent（例如用 `skill-creator`）在那里新建或修改，经 Workspace 开关与设备能力协商启用后，Worker 将草稿及可解析依赖固定为受管快照用于当前执行。正式发布进库仍是独立动作。草稿与锁定版本试验的实施/准出状态见[接续记录](session-isolation-drafts-20261019.md)。
- **库条目与版本**：库里每个 Skill 有若干不可变的 zip 版本（revision），压缩后上限 64 MiB。内容不变不产生新版本。
- **仓库跟随**：库也可以跟随一个 git 仓库或 npm 包（`npm:<name>`），两种模式：`pick`（挑选其中若干 Skill）与 `bundle`（整个仓库作为一个单元）。都跟随最新 release tag / npm `latest` / 默认分支（或指定的分支、tag），变了的 Skill 才得到新版本；可回滚并暂停，再恢复；上游删除的 Skill 保留在库里并标记。
- **Workspace 选用**：Workspace 选库条目和 bundle，可把某个条目固定到某个版本；未固定的跟最新版本。
- **个人默认 Skill**：每个人可设默认 Skill 和 bundle，它们进入**本人拥有的设备上**的每个 Workspace；Workspace 可以逐个关掉，同名的选用优先。
- **三类会话可见的 Skill**：Workspace 的（选用 > bundle > 设备所有者的默认 Skill > 默认 bundle，同名只取第一个）、Agent 自己的官方 Skill、Foundry 内置 Skill（同名时内置优先，一个调用名只对应一个 Skill）。设备上其他已安装的 Skill 不可见。
- **所需程序**：一个 Skill 需要的程序 = `SKILL.md` 中 `metadata.requires` 列出的 + 脚本扩展名对应的解释器 + 脚本 `#!` 行指定的程序。Server（`skillarchive.ToolRequirements`）与 Worker（`skill-requirements.ts`）用同一规则。

### 关键决定

- **隔离：会话只看到它所在 Workspace 启用的 Skill。** Claude Code 用 SDK 的 `skills` 允许列表 + 一个本地插件目录（`foundry-workspace:<name>`）；Codex 按路径禁用原生 Skill，只提供 Foundry 校验过的目录。系统提示写明这份目录就是允许的完整清单，点名一个不在其中的 Skill 时说明需先发布并选用。会话的 receipt 记录它在哪个 Workspace 文件夹按此策略运行，Worker 被杀后仍保留（2026-09-28 实测）。
- **2026-10-09（#111）保留 Agent 的官方 Skill。** Codex 在 inventory 中以 scope `system` 标记自带 Skill，这些保持启用；Claude Code 自带的 Skill 不再禁用，而是写进允许列表。读取不发模型请求，按程序版本缓存；#112 起在从 Foundry 安装 Agent 后和 Worker 每 10 分钟的检查中重读，只对没见过的版本执行。
- **Foundry 内置 Skill**（`apps/server/internal/builtinskills`）：`foundry` 给 Claude Code 和 Codex，`skill-creator`（vendored，来源与许可见 `SOURCE.md`）只给 Claude Code。它们像 Workspace Skill 包一样下发，文件夹变化时在 `builtinskills.go` 中提升 revision。`foundry` Skill 只讲事实（会话是谁、代表谁、能触达什么、代价与限制），工具用法写在工具描述里（2026-10-12 起 revision 4，见 [Session 编排](session-orchestration-design.md)）。**`packages/worker/skills/foundry/` 与 `apps/server/internal/builtinskills/foundry/` 必须逐字节相同**：前者随 Worker 包发布、由 `foundry skill install foundry` 安装，后者嵌入 Server；`packages/worker/test/foundry-skill.test.mjs` 检查这一点，并检查 Skill 只提到存在的工具和参数。
- **入库按依赖闭包。** 从设备发布时，Skill 身份是设备 / 根目录 / 目录名，不是名字；Worker 的依赖分析（`skill-dependencies.ts`，只索引、不执行文件内容）找出它引用的其他 Skill，计划里一并列出；同名的不同安装版本、缺少依赖图或超限都会阻止发布，而不是悄悄换成另一个版本。发布对话框可与库中已有版本逐文件对比，决定新建条目还是作为已有条目的新版本。
- **Server 读取公开仓库：只用 https。** `internal/skillrepo` 先 `git ls-remote` 解析提交，再按提交 `--depth 1` 浅克隆，不使用 Server 主机的 git 配置和凭据；npm 包取 tarball。每天检查一次（`skillRepositoryCheckInterval`），`FOUNDRY_INTEGRATIONS=off` 时不自动检查，人手动触发的检查仍会运行。
- **2026-10-09（#115）由设备代读 Server 够不着的来源。** 仓库可指定由一台设备读取（只能是设置者自己的设备，Admin 也可选无人拥有的设备）（`skill-repository-fetch.ts`）：git / npm 用这台设备自己的配置与凭据（ssh key、credential helper、npmrc），凭据不离开设备，不弹出交互；设备离线时检查排队，重连后执行。因此这条路径接受 ssh 远端（`skillrepo/device.go`）。
- **2026-10-09（#115）bundle 可声明工具，按人的点击逐台设备安装。** 来源是 GitHub release 下载（只用 https，限大小，有校验和就核对）、npm 包（不运行 install 脚本）或经设备自己的 `uv` 安装的 PyPI 包；工具的后续步骤（如下载浏览器）另需点击，需要交互登录的 CLI 只显示命令（`managed-tools.ts`、`internal/skilltools`）。回滚 bundle 时一并恢复工具版本。推荐 bundle：agent-browser、playwright-cli、browser-use。
- **缺失程序告诉会话，不让它绕开。** 设备每次扫描 Skill 时检测库中 Skill 需要的程序；会话启动时，Worker 把本机缺失的程序写进 Skill 策略，要求 Agent 告诉人去安装，而不是想办法绕开。

## 实现边界

截至 2026-10-14（`3092162`）。

**已实现**

- 扫描：Server 在设备连接时和每 30 分钟（`deviceSkillRescanInterval`）请求扫描，同一设备同一组目录的并发扫描合并为一次；扫描在 Worker 的独立线程中运行，避免饿死心跳（`skill-scan-thread.ts`、`skill-scanner.ts`）。
- 库与版本：`internal/skillarchive`（不解压建立索引、清单解析、所需程序）、`sqlitestore/skills_catalog.go`、`skill_versions.go`；发布与对比 `httpapi/skill_promotion.go`、`skill_compare.go`（路由 `/api/skills/promote*`、`/api/skills/compare*`；发布要求设备所有者）。删除库条目、管理仓库要求 Admin（`routes.go` 中 `adminOnly`）。
- 仓库跟随：`internal/skillrepo`（git、npm、设备代读的远端格式）、`httpapi/skill_repositories.go`、`skill_bundles.go`、`skill_device_fetch.go`、`sqlitestore/skill_repositories.go`。
- 选用、固定、默认与关闭：`PUT /api/workspaces/{id}/skills`、`.../skills/{skillId}/pin`、`.../skill-bundles`（Maintainer），`/api/me/default-skills`；合并规则在 `httpapi/default_skills.go`（`resolveWorkspaceSkills`、`sessionSkillRefs`），内置 Skill 在 `httpapi/skills.go` `withBuiltinSkills` 加入。
- 物化与隔离：`skill-materializer.ts`（按 Skill + 版本从 Server 取包、校验 checksum，解包到内容寻址的 `<state>/skill-sets/<hash>/`，不碰用户自己的 Skill 目录）、`skill-isolation.ts`、`session-policy.ts` `claudeSessionOptions`、`official-skills.ts`。Issue 的判定者也拿到选定版本的只读副本（[模块架构 D4](architecture-modules.md)）。
- 工具安装：`POST /api/devices/{deviceId}/tools/install`（设备所有者，仅 bundle 的工具），Worker `managed-tools.ts`。
- Web：Skill 库页（`/skill-library`，`features/skill-library`：仓库、bundle、推荐 bundle、版本与工具状态）；Workspace 的 Skills 页（`/workspace/skills`，`features/skills`：选用、默认、固定版本、官方与内置 Skill、缺失程序标记）与 `foundry` Skill 详情页（`/workspace/skills/foundry`）；设备页的 Skill 搜索；输入框 `/` 菜单按会话实际解析的结果列出（`features/chat/composer-slash.ts`）。

**未实现 / 已知缺口**

- 从 Foundry 安装 `metadata.requires`、解释器、shebang 推出的缺失程序：目前只检测并告诉会话；只有 bundle 的工具可以安装（release / npm 包自带的命令，以及跟随时额外声明的至多 4 个 uv 或 npm 工具）。
- Server 直接读私有仓库：Server 只读公开 https 来源，不保存仓库凭据；私有来源目前只能经设备代读，依赖那台设备在线。
- 自动提炼与推荐 Skill：不存在。
- `bundle` 不能改回 `pick`（`handleSetSkillRepositoryMode` 注释）。
- 旧 Worker 写过的 `.foundry/skills.yaml` 不再读取（[存储策略](storage-strategy.md)），本仓库中的那份只是遗留文件。

**验证情况**

- 有真实运行记录：Skill 隔离 receipt 在 Worker 被杀后保留（2026-09-28，dev 与真实 Mac）；Skill 库、默认 Skill、版本固定、官方 Skill 与选用页面在隔离栈和 dev 上运行（2026-10-09）。`packages/worker/scripts/verify-native-skill-isolation.mjs` 是对真实原生 CLI 的隔离检查脚本，不在 CI 或 `pnpm verify` 中，需手动运行。
- 只有单元 / 接口测试：依赖闭包与冲突、仓库跟随与回滚、设备代读、npm bundle、扫描合并（`apps/server/internal/httpapi/skill_*_test.go`、`default_skills_test.go`、`sqlitestore/skill_*_test.go`），Worker 的扫描、依赖、隔离、所需程序、zip 安全（`packages/worker/test/skill-*.test.mjs`），Web 的选用与版本（`apps/web/test/skill-*.test.mjs`）。本次整理未重新运行。

## 后续

- **已实现并自验：** [Workspace 草稿试用、隔离补全与启动准备](session-isolation-design.md)。已支持受管草稿快照、刷新、固定版本 include/exclude/previous 试验，以及缓存内容复核、精确挂载和共享启动准备。正式发布仍是独立动作；原生子 Agent 的 Skill 隔离尚未独立验证，因此试验使用 Foundry 独立会话。完整范围与平台局限见 [DEV-006/007 交付记录](devlog/DEV-006-007-isolation-drafts.md)；准出与源码合入见 [DEV-025](devlog/DEV-025-release-closure.md)。
- **下一步：** 从 Foundry 安装 Skill 缺失的程序，沿用 bundle 工具的安装路径（按设备、人点击、https 与校验）。
- **下一步：** 私有仓库：让 Server 也能读需要凭据的来源，不依赖某台设备在线；凭据按[安全边界](security.md)的 sealed secret 规则保存。
- **探索：** 自动提炼与推荐 Skill：从会话中提炼可复用的方法成为 Workspace 草稿，或按 Workspace 推荐库中已有的 Skill；产物仍经人发布进库。

## 代码位置

- 协议类型：`packages/protocol/src/skills.ts`。
- Server：`apps/server/internal/skillarchive/`、`skillrepo/`、`skilltools/`、`builtinskills/`（含 `SOURCE.md`）；`apps/server/internal/httpapi/skills.go`、`skill_*.go`、`default_skills.go`、`foundry_skill.go`；路由 `routes.go`。
- 存储：`apps/server/internal/store/skill_repositories.go`；`apps/server/internal/sqlitestore/skills_catalog.go`、`skill_versions.go`、`skill_bundles.go`、`skill_promotion.go`、`skill_repositories.go`。
- Worker：`packages/worker/src/skill-*.ts`、`official-skills.ts`、`managed-tools.ts`、`session-policy.ts`，daemon 处理 `packages/worker/src/daemon/handlers/skills.ts`；随包 Skill `packages/worker/skills/foundry/`。
- Web：`apps/web/src/features/skill-library/`、`apps/web/src/features/skills/`、`apps/web/src/features/devices/skill-search.tsx`、`apps/web/src/features/chat/composer-slash.ts`。

## 2026-10-23 启动准备优化

实现与部署状态见 [DEV-038](devlog/DEV-038-skill-preparation.md)。新 Worker 可用 Server 下发的 revision 内容摘要验证展开缓存，缓存命中跳过 ZIP 解包；会话目录的完整性检查和版本隔离保留。后台准备由所选版本变化与设备连接触发，不改变授权清单。二级目录只影响初始展示，成员仍可被用户精确指定；正文继续按需读取。旧 Worker 或缺少摘要的旧清单走兼容路径。
