# 多仓 Workspace：submodule + worktree 调研与实验

日期：2026-09-07。用户约束：一个 Project 下多个 Git 仓库是第一期必须支持的核心场景。允许根目录纳入 Git；不以“单仓先做、多仓以后再说”缩减范围。

本次只查阅官方资料并运行临时 Git 实验，没有修改 Foundry 执行代码，没有转换任何真实 Workspace，没有向远端推送。

后续决策：用户采用“根仓库 + Foundry 登记独立仓库”，不强制 submodule。本文保留实验事实和已有 submodule 的兼容参考；当前执行模型、外置 worktree 布局和实施顺序见 [具体方案](../issue-workspace-execution.md)。

## 结论

**可以把多仓放进第一期。推荐把 submodule 用作仓库结构与版本声明，由 Foundry 显式管理根仓库及各子仓库的独立 worktree、候选提交和递归 Accept。**

`git worktree add` 不会自动完成全部子模块准备，父仓库 `git merge` 也不会自动完成子仓库内容合并。缺少的是多仓生命周期编排，不是所有组合都不能工作。普通流程可用与官方仍标记支持不完整可以同时成立。

建议方案不依赖 AgentFS，也不实现普通文件的通用 lazy-write 文件系统。代码、Rules、Docs、Know-how 与 Domain Knowledge 纳入根仓库，Workspace Accept 以明确的 Git 提交组合为基线。Git init 只是第一步，还需定义应追踪文件、忽略项、初始提交和现有仓库的 submodule 声明；不自动重置或吸收现有仓库的私有 Git 目录。

## 官方资料说明了什么

- [git-worktree 手册](https://git-scm.com/docs/git-worktree#_BUGS)仍标记 submodule 支持不完整；[命令说明](https://git-scm.com/docs/git-worktree#_commands)明确包含子模块的 worktree 不能直接 move，remove 有额外限制。
- Git 自己的 [t2405-worktree-submodule.sh（v2.50.1）](https://github.com/git/git/blob/v2.50.1/t/t2405-worktree-submodule.sh)同时包含：根 worktree 创建后子模块未自动 checkout 的预期失败；手动初始化、手动给子模块添加 worktree，以及递归 checkout 不改变主工作树状态的成功测试。说明不能把手册一句警告解释成组合整体不可用。
- 2026-04-15 的[邮件讨论](https://www.spinics.net/lists/git/msg523891.html)明确区分共享 object database 与共享 HEAD；[Junio C Hamano 的回复](https://www.spinics.net/lists/git/msg523915.html)赞同子模块应拥有与父 worktree 对应的独立 worktree。这是维护者的设计意见，不是“已发布的一键递归命令”。
- [submodule 模型](https://git-scm.com/docs/gitsubmodules)规定父仓库记录子仓库 commit 的 gitlink；[update 命令](https://git-scm.com/docs/git-submodule)默认 checkout 到 detached HEAD，支持按路径选择与递归。这意味着修改、保存、合并都需显式处理子仓库。

## 本机实验

环境：macOS 26.5.2，`git version 2.50.1 (Apple Git-155)`。使用新建临时目录及假身份，禁用用户 Git 配置与 hooks。所有源仓库和所谓 origin 都在临时目录中；`protocol.file.allow=always` 只对实验命令生效。

结构：

```text
workspace/                         根 Git 仓库
  AGENTS.md
  docs/lessons.md
  services/team/backend/           深层 submodule
    vendor/deep/common/            真正嵌套的 submodule
  apps/frontend/                   不涉及本次任务的 submodule
```

共执行 259 条 Git 命令，29 个断言全部符合预期，包括明确断言某些 Git 命令失败；不是 259 条命令全部成功。只验证合成仓库行为，不代表真实大型仓库性能或 Foundry 端到端功能已通过。

| 场景                                         | 实测结果                                                                  | Foundry 应处理什么                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 根 worktree 创建                             | 根规则和 Docs 存在；子模块文件尚未展开                                    | 按需准备子模块，不能把空目录误认为仓库没有文件                                 |
| 两个候选同时初始化 backend 及嵌套 common     | 成功；frontend 保持未初始化；各自子仓库 Git 目录独立                      | 维护每个环境的实际仓库映射                                                     |
| 两个 Issue 独立修改相同子仓库                | 文件、HEAD 与源目录保持独立                                               | 为可写子仓库建立明确候选分支，避免仅依赖 detached HEAD                         |
| 只合并根仓库候选提交                         | 根 gitlink 更新，但子仓库工作文件没有随之更新                             | 根提交完成不等于整个 Workspace 已应用成功                                      |
| 子仓库候选提交尚未传到可用对象库             | 普通 update 报 `not our ref`                                              | 接受前保证所有引用的子提交可访问，先子后父；本地 Accept 不要求外部 push        |
| 两个 Issue 在同一子仓库改不同文件            | 根 merge 仍报 submodule 指针冲突                                          | 先在子仓库合并两条历史，再更新父仓库 gitlink；不能直接任选一个 SHA             |
| 嵌套 common → backend → root 接受            | 先保存/导入子提交、逐层更新指针后成功                                     | Accept 是递归仓库图操作                                                        |
| 候选递归 checkout                            | 未改变主子仓库 HEAD 或 core.worktree                                      | 这一常规路径在本机版本可用，不泛化为所有 Git 版本都无问题                      |
| move / 普通 remove 已初始化子模块的 worktree | Git 拒绝                                                                  | 候选路径固定；清理要有显式流程                                                 |
| force remove 标准初始化的候选 worktree       | 私有子仓库对象库随之删除；只存在其中的 child commit 无法从根 gitlink 恢复 | 即使 child 已 commit，也必须确认持久对象与保留 ref，不能仅检查有没有未提交文件 |
| 手工管理 root/backend/common worktree        | 保留相对布局，子候选提交进入持久子仓库对象库，主工作文件未变              | 这条路线适合作为第一期实现基础                                                 |
| 8 个并发候选，每个含三层仓库                 | Git 目录与文件集合独立，主仓库各层 HEAD 未变                              | 并发编排可行；这不是模型调用或构建压测                                         |
| 同一文本的真实冲突                           | 冲突可在独立集成 worktree 中解决，源文件未变                              | 合并冲突与重新验证发生在候选侧                                                 |
| 手工管理的候选自底向上清理                   | 各子候选提交仍可从持久仓库访问                                            | 候选提交保留与候选工作目录清理分离                                             |

实验脚本和原始命令记录只用于这次临时研究，未随仓库保留，也不进入测试门禁；上表是其结论。实验中的 force remove 仅用于复现临时数据的清理行为，不是给真实 Workspace 使用的清理命令。

## 推荐的第一期结构

**根仓库记录 Workspace，submodule 声明路径和版本；每个 Issue 拥有一组相互对应的候选 worktree。** 任意目录深度与真正的多级嵌套都纳入模型。

```text
已接受 Workspace
  root commit R
    backend commit B
      common commit C
    frontend commit F

Issue A 的候选目录
  root worktree A                  规则、Docs 与根目录修改
    services/team/backend/        backend worktree A
      vendor/deep/common/         common worktree A（需要时准备）
    apps/frontend/                未准备时保留声明

Issue B 的候选目录
  root worktree B
    services/team/backend/        backend worktree B
```

每个仓库对应一个持久 Git object store 和 Issue 专属 refs，候选 worktree 的 HEAD/index 独立。不要复制或硬链接整份 `.git/modules` 来伪装隔离。实验使用已接受 Workspace 的子仓库作为持久对象库；产品是否放进 Foundry 管理的独立 repo pool 仍待设计，但对象保留不能依赖临时目录是否存在。

每个候选仓库记录路径、父仓库/子模块关系、稳定仓库身份、起始 commit、候选 branch/commit、worktree 路径与生命周期。不能仅凭 basename 当身份，同一个远端也可能在不同路径挂载。

Issue 的后续 Run 可继续已有候选环境；新的独立 Issue 使用新的候选分支。规则与知识默认来自根 worktree 对应的版本，需要跟进新基线时显式更新，不再实现通用实时文件透读。

### 按需准备的实际含义

未涉及的仓库不全部 checkout；需要读取、修改或构建依赖时，再准备对应路径及必要的嵌套仓库。Git worktree 本身不提供透明的 lazy 目录读取，不能承诺只有第一次写入才产生任何 checkout。纯读原仓库是否作为额外入口，另行定义，不能用可写软链接冒充候选隔离。

初期可让 Foundry 根据 Issue 和 Agent 的请求扩展仓库集合；准备动作通过受控 CLI/MCP 提供，保持其他工具仍可使用普通 Git 与文件路径。Submodule update、deinit、absorbgitdirs、仓库移动和根目录清理由环境管理流程约束，避免绕开对象保留与任务生命周期。

### Workspace Accept

1. 收集根仓库和所有参与子仓库的差异、候选提交及验证证据，形成一次 Workspace 级结果。
2. 固定一个可审查的候选组合；各仓库候选提交持久保存。未提交内容先成为候选提交，不直接进入已接受分支。
3. 从叶子仓库向根仓库处理基线变化：合并 child，再更新 parent gitlink。指针冲突与文本冲突均在候选/集成环境处理。
4. 验证最终仓库组合；冲突解决改变已展示结果时重新呈现。准备阶段不改已接受目录。
5. 人接受后应用已验证的提交组合，记录每一步状态。多个 Git 仓库没有天然原子提交，应用中断需要续做/回退记录，完成全部必要步骤才显示 accepted/integrated。
6. 本地 Accept 与远端发布分开。其他机器需要复现时，再确保子仓库提交先发布到可访问位置、最后发布父仓库指针。

同一个 Workspace 的最终集成可以协调顺序，Issue 的执行仍按 Worker 容量并行。串行化短暂的基线应用不等于串行执行全部任务。

## 第一期开工前仍需确定和补验的事项

- 本地已存在仓库如何登记为 submodule：已有 remote、脏文件、没有 remote 的仓库、旧式 `.git` 目录形式；不自动修改用户现有历史或私有配置。
- repo pool 放置与候选 ref 保留策略；初始化同一路径、fetch/GC、清理的协调。
- 真实仓库版本组合与构建依赖：Git LFS、ignored 配置、依赖安装、工作目录的未提交更改均不因 git init 自动解决。
- 支持的 Git/OS 版本矩阵；本次只有 Apple Git 2.50.1 本机实测，不能据此声明全平台支持。
- `.gitmodules` 路径/URL 变更、子模块添加删除、branch 切换、初始化中断与 Accept 中断恢复还需要专项验证。
- worktree 提供版本和工作文件隔离；它不是任意 Agent/外部工具的 OS 写入沙箱。约束深度需要单独定案，但不再作为通用文件系统研发任务来阻塞多仓模型。

这些是第一期多仓实现的工作项，而不是把多仓排到下一期的理由。
