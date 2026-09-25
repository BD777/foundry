# Issue 工作流设计

[项目 Roadmap](../README.md#roadmap) · [文档索引](README.md)

本文说明 Issue 从目标、候选执行到验证、接受与合入的设计。完成状态统一维护在 README 的 Roadmap，已实现边界见[当前状态](current-status.md)。设计背景来自已归档的 [0908 Plan](archive/workspace-ai-product-plan-2026-09-08.md) 与后续讨论；Plan 中的状态名、字段、角色和策略草案以本文及对应实现为准。

Issue 引擎（准出条件 → 候选执行 → 证据与验证 → 接受 → 合入）已在主干；Web 的 Issues 入口在体验打磨完成前暂时隐藏。本文描述目标行为，每节注明已有基础与剩余工作，不是实现完成声明。功能准出以[对话式准出标准](foundry-conversation-release-gate.md)为准。

## 产品边界

- Workspace 是**已接受的项目状态**的唯一真相源；元数据、Chat、日志和证据可以存放在不同位置，但必须关联同一任务与候选，不能各自成为另一份已交付状态。
- 人围绕 Issue 提出目标、补充约束和接受成果。Run、attempt、session 等可以作为内部记录；不要求用户创建或管理这些对象，也不新增独立 Asset 生命周期。
- Workspace 可以容纳代码、文稿、设计、数据、技能和工具配置。文件 diff 是一种审阅方式；二进制、图片或文稿需要适当的原文件或预览。
- Issue 在候选环境中工作，验收后更新 Workspace；独立 Chat 当前可直接修改本地 Workspace，不能把 Issue 的隔离与接受保证泛化给所有 Chat。
- 产品范围、已实现基础与设计建议分别记录；不可用已有测试日志、基础 Accept 按钮或 worktree 验收替代完整 Evidence / Verify 的实现证据。

## Issues

**交付目标：** 人围绕同一目标持续推进任务，每个 Issue 有自己的环境，可以与其他 Issue 并行；遇到需要人决定的问题时暂停等待，回应后继续。

**已有基础：** 多仓 worktree 候选环境、并发执行、会话恢复、diff、preview 与 Workspace Accept（见[多仓执行方案](issue-workspace-execution.md)）；六态状态机、主聊天只读澄清、人确认精确契约版本后才派发的执行链（见[Issue 对话与状态](issue-conversation-design.md)）。

**接下来做：** 重新开放 Issues Web 入口并打磨 Board、详情与 Issue 对话；通用的人工介入协议（Ask user / 权限应答的完整形态）；多 Agent 拆分见[下文](#issue-multi-agent)。Blocked 专指需要人介入，系统可自行重试或恢复的问题由系统处理。

**完成标准：** 两个 Issue 可独立推进；每项任务有明确目标与候选环境，回答问题后继续原 Issue，中断恢复不要求用户管理新的 Run。端到端可信交付另按最小闭环验收。

### 目标与完成条件

顶层状态为 Pending / In progress / Blocked / Verifying / Accepted / Abandoned 六态，Blocked 带信息、权限或系统错误等原因（见 [Issue 对话与状态](issue-conversation-design.md)）。

完成条件以可对照的自然语言为主。Agent 结合 Workspace 上下文起草目标、范围和验证计划，由人确认必要条件；不能为了显示完成而静默删除失败条件、降低标准或改写目标。

确认时点、条件版本与变更流程已落地：Agent 只产出 `agent_proposal` 草案，人确认精确 `revision + contentDigest` 后生效；每次再修订追加新草案并要求 `changeReason`，确认后旧版置为 superseded，已确认契约被改动时 Issue 回到 pending 重新实现（见 [Evidence v1 §2](evidence-and-verify-v1.md#2-契约与生命周期)）。允许一条条件使用多份证据、一份证据支持多条条件，不强制一对一，也不要求所有条件都有可执行测试脚本。

候选身份覆盖实际纳入的仓库、基线、候选文件状态及验证输入，不能只凭一个可能未变化的 HEAD 判断所有材料仍有效；dirty/untracked、忽略文件、二进制和动态准备子仓库的处理见 [Evidence v1 §3](evidence-and-verify-v1.md#3-候选与输入)。

### 人工介入与自动恢复

Blocked 表示当前无法继续，必须附具体原因：Needs input、Needs permission、System error 等。系统仍在重试、重连或等待容量时可以保持进度状态；执行因系统错误终止后使用 Blocked / System error，保留上下文和继续入口。

人回应后继续同一个 Issue 与候选上下文，其他独立任务可继续执行。重复回应、断线重送或重启不能重复触发已完成的外部动作；Agent 不自动放弃 Issue。Stop 进入 Blocked 等待继续，Abandon 是人明确选择的终态，历史与候选保留。

## Evidence and Verify

**交付目标：** 人可以知道每条完成条件是否成立、依据是什么、结果适用于哪个版本。

**已有基础：** [Evidence / Verify v1](evidence-and-verify-v1.md) 和[完整字段表](evidence-and-verify-v1-fields.md)记录当前实现：原始材料、条件、封存候选、程序（含项目自带命令）/独立 Agent 判断、人工接受和逐仓集成；澄清在所选 Workspace 只读探索，验证在候选 Worktree 实际检查取证。

**接下来做：** 通用输入绑定与 Accept 前复核、完整中途恢复、Codex 真实图文初判、复杂媒体，以及 Linux 上的受控 HTTP 目标（澄清、判定与集成已在 Linux 开通，见 [v1 §9](evidence-and-verify-v1.md#9-尚需收口的实施项)）。更多证据类型（浏览器、桌面、模拟器）依赖 [Tool Use](tool-use-and-resources.md#basic-tool-use)。旧日志、checks 和执行报告不自动成为结构化通过判断。

证据需要可保存、可预览、有来源和访问边界；清理临时候选后仍可追溯。Verify 优先采用确定性检查，需要模型或人工判断时保留依据与不确定性。

**完成标准：** 至少一条真实工具证据链贯通，缺失、失败、不确定和过期不会被显示为有效通过；证据与判断分别保留，旧材料不会被新结果静默覆盖。

### 材料与判断契约

Evidence 同时表达“证明什么”与“用什么载体”：例如视觉交互是否符合目标，以及对应的截图或录屏。材料需保留对应条件、来源、生成过程、候选版本、环境/构建和时间；模型说明不能冒充工具原始结果，截图本身不等于界面正确。

Verification 引用材料，说明判断方法、依据与适用状态。候选内容、条件或验证环境变化后重新判断是否过期；不确定、缺失、失败与过期都不能折算成通过。证据有独立存储和访问控制，保存新材料不应因其文件写入而触发候选自我失效。

测试脚本、规则和报告也可能被候选修改。审阅要展示这些变更，重要基线检查由受保护流程执行，不能让候选通过削弱自己的检查标准取得接受资格。

## Issue Multi-Agent

后续将同一个 Issue 的不同步骤拆给多个 Agent，允许步骤使用不同 Harness 或模型；用户继续围绕同一 Issue 对话、steer 和审阅。当前实现是一段绑定候选环境的会话，复用既有 Chat UI，不新增 Run 管理入口。步骤依赖、上下文交接、取消和恢复、候选写入协调以及每一步 Evidence 的归属在该阶段设计；不能因引入多个 Agent 绕过人工 Accept 或并发写入约束。此方向排在 Issue 对话与 Evidence / Verify 之后。

## Accept and Integration

**交付目标：** 人基于目标、改动与证据决定接受；最终合入对应正确的候选和 Workspace 最新状态。

**已有基础：** 绑定精确 reviewSnapshot 的显式 Accept（需要 Workspace Maintainer 及以上角色）、锁内核对待集成候选/材料/journal、基线前移拒绝旧批准并要求在候选中对齐后重验、逐仓 fast-forward 集成 journal 与部分应用/断线恢复；全部仓成功才置 Accepted（见 [Evidence v1 §5](evidence-and-verify-v1.md#5-准出人工接受与恢复)）。

**接下来做：** 完整的 Workspace Merge Queue 编排（冲突解决与复验）；外部写入的更广义处理与跨机同步；接受操作的审计视图。

**完成标准：** 人能继续修改、接受或放弃；只有具备权限的人可以接受。两个 Issue 的合入串行受控，主干前移后不沿用不适用的旧判断；合入未完成不显示已全部完成，部分失败可检测并恢复。

### 合入约束

先保留人的接受决定及其候选关联，再在该 Workspace 的队列中对齐最新状态、复验和合入；人工批准与最终集成成功分别表达。对齐发生在候选环境，不能把未验证的试合并留在 canonical Workspace。

对齐后不盲用旧证据。出现冲突解决、额外改动或条件变化，需要重新验证并重新审阅；无实质变更时是否复用批准、何时要求再次确认仍是待决规则，在实现前明确。

接受策略采用“必要条件有有效判断 + 有权的人明确接受 + 最终合入检查通过”。必选/参考条件、条件变更、是否允许豁免仍是设计项；不能把未定义的豁免作为绕过失败条件的默认入口。

队列/锁的范围是同一 Workspace；如底层仓库被多个 Workspace 共用，还需核对实际写入冲突域。锁不提供跨仓原子性，也不约束平台之外的写入。保留集成记录，检测部分成功、外部修改和进程中断，停止不安全的后续合入并提供恢复；不通过无条件覆盖源目录来消除冲突。

Accept 管理进入 Workspace 的候选变更。工具执行中的发送消息、部署、修改外部系统等副作用仍需当时的授权，不能用之后的 Accept 追认，也不能宣称放弃 Issue 会自动撤销它们。

## Open Source Release

**交付目标：** 外部用户可以从安装开始，复现一次可信的 Issue 交付闭环。

**接下来做：** 用代表性真实任务贯通目标、执行、工具证据、验证、人审与合入；覆盖并发、候选变化、掉线恢复、人工介入、部分合入失败和证据保留。同步完善安装说明、支持范围、样例 Workspace、恢复说明及许可证与依赖核对。

**完成标准：** 干净环境可复现首发范围内的完整流程，失败或过期结果不会被误报成功。若首发包含 Web UI 验证，则必须有真实可复现的浏览器证据路径。

依赖上述闭环在选定首发范围内完成；不等待完整云端与团队体系。首发场景范围仍需选定。

## Workspace Capabilities

**理念说明，不是独立 Roadmap 待办。** 测试脚本、项目指令、Skills、工具配置与工作方法可以作为普通候选变更，经同一套验证与接受进入 Workspace。后续 Agent 使用这些内容，使产品与工作能力一起积累；这不表示模型权重自动训练或 Agent 自行扩大权限。

Workspace Skills 已可用：设备扫描本地 Skill 并推送到服务器目录，Workspace 按版本选择启用，Chat 与 Issue 执行只看到当前 Workspace 启用的 Skill。自动提炼、推荐和分类尚未形成交付范围，等明确需求后再提出具体功能。
