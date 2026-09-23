# Issue 对话与状态

[Roadmap](../README.md#roadmap) · [Issue 工作流](issue-workflow.md)

用户以 Issue 作为持续工作单元。没有独立的 Runs 导航，旧 `/runs` 地址落到 Issues 视图；执行记录、原生会话 ID、事件和历史仍在内部保留，用来恢复候选与串联对话。

> Issues 的 Web 入口在体验打磨完成前暂时隐藏：侧栏没有 Issues 项，`/issues` 与 Issue 详情路由显示 Workspace 概览。下文描述的是 Issue 页面与对话的设计及已有实现，引擎、API 与 Worker 路径仍在主干。

## 状态

协议、服务端、Board、List 和详情统一为六个顶层状态。Needs input、Needs permission、System error 是 Blocked 的原因，不设 Interrupted / Needs input 独立列。

| 持久化值    | 显示        | 含义与后续                                               |
| ----------- | ----------- | -------------------------------------------------------- |
| pending     | Pending     | 待开始；准备目标或等待 Worker 容量                       |
| in_progress | In progress | 正在准备或执行候选，可补充指令、停止当前执行             |
| blocked     | Blocked     | 暂时无法继续，必须有具体原因；问题解决后沿原候选继续     |
| verifying   | Verifying   | 检查候选与完成条件，包括等待人工审阅；不等于验证通过     |
| accepted    | Accepted    | 人工接受且已有集成路径成功完成                           |
| abandoned   | Abandoned   | 人明确决定不再继续；候选与对话历史保留，不进入 Workspace |

`blockedReason` 包含 `kind`（`needs_input` / `needs_permission` / `system_error`）及具体 `message`。执行失败写入 System error；用户停止后写入 Needs input，说明需要下一条继续指令。恢复或新执行会清除旧原因。权限原因的模型和显示已就绪，完整 Ask user / 权限应答协议后续接入，不假装已有授权能力。

旧 JSON 在读取时归一化：inbox/ready → pending，producing → in_progress，review → verifying，integrated → accepted，interrupted → blocked。调度器兼容旧 ready 索引记录，新写入使用新枚举；环境内部 ready/review/integrated 与 Run 状态独立保留。旧 inbox 保留原本未派发语义，不因读取迁移而自动执行。

Verifying 已接入真实 Evidence / Verify，代表等待采集、检查或最终审阅，不代表已通过。Ready for Review、Queued / Integrating 等是验证或合入的进度阶段，不增加顶层状态。Accepted 只在准确 Review 获明确批准且全部集成成功后写入。

## 页面与共享组件

详情主区域是一段持续对话：原始目标、用户反馈、执行过程、回复和中断原因。内部多次执行按时间串联，不要求用户切换 Run。流式回复以增量保存；最终回复到达后替代临时流式文本，历史失败和已完成轮次继续保留。

用户消息和执行时间必须按解析后的时间值归并，兼容服务端秒精度、Worker 毫秒精度和时区偏移；不能直接比较 ISO 字符串。继续消息先于对应执行的流式回复，完成后的持久回复替换临时文本且不重复。Worker 的 Response reset/delta 经 Server 的 `issue_run_event` SSE 进入统一数据投影，再由共享 Chat 消息组件渲染。回归同时覆盖真实 WebSocket → SSE 传输、消息归并和浏览器逐段输出；测试页 `test/issue-detail.html` 提供流式回放按钮。

`components/conversation/Conversation` 是完整的通用对话组件，同时拥有消息 Markdown/工具过程折叠、图片预览、虚拟列表、自动跟随、轮次导航、输入区、草稿、消息队列、steer、停止和失败恢复。Chat 与 Issue 都只传标准消息、执行状态与 API 回调；feature 不再自行拼输入区或维护另一份队列。输入工具栏使用同一个 AgentComposer，通过 `composer.mode` 区分 `selectable`（Chat 可选模型）和 `fixed`（Issue 固定模型）。附件能力由回调是否提供决定；只读终态由参数表达。右侧业务详情和导航保留在外层，共用可调整宽度的分栏。

`useConversationInput` 统一处理队列顺序、执行绑定、请求互斥和草稿恢复。发送成功后等待业务层投影出新执行，才允许下一条排队消息启动，避免 HTTP 确认领先 SSE 时重复派发；失败不会自动反复重试，正在新写的草稿也不会被失败恢复覆盖。组件边界审计禁止 feature 重建对话、输入区和队列的根样式。`test/conversation.html` 在两种模型模式下回放同一组交互，`conversation-input.test.mjs` 对两种配置运行同一套行为测试。

顶部显示标题、Issue 编号、当前状态、统一授权与详情开关。主聊天是澄清、参考上传、确认卡、状态问题和执行反馈的唯一入口。这些人工决定按 Workspace 角色授权：确认契约、发起判定和人工覆判由 Issue 创建者或 Maintainer 及以上执行，Accept 与 Abandon 需要 Maintainer 及以上（见[账号与权限](security.md#accounts)）。右侧“目标与约定”分组展示目标、完成标准、范围和参考；“验收结果”展示实际观察、独立判断、局限与最终接受；“改动”显示真实候选 diff；“执行环境”容纳设备、基线、仓库和运行记录。阶段与下一步在 tabs 上方，不自动切走用户正在阅读的 tab。面板独立滚动并支持调整宽度，窄屏通过顶部开关进入，再关闭回到对话。没有候选时显示真实等待状态，不生成示意 diff 或默认 Vite artifact。

Environment 是结构化环境信息，不是运行日志。区分源仓库可用性与本 Issue 候选是否已准备：源仓库 Ready 不等于候选 Ready，未测量大小不显示为 0 MiB。仓库清单按路径搜索、按不可用/已准备筛选，每页 20 项。长失败信息使用共享 Alert 展示摘要，原始诊断可展开，避免重复占满对话与详情。

聚合 Workspace 中未初始化的子模块登记为对应仓库的 Unavailable，不应阻止不依赖它的根候选初始化。实际请求该子模块时仍拒绝准备；无法完成遍历、仓库边界冲突等发现错误仍阻止初始化。隔离回归覆盖无初始提交的根仓库与未初始化子模块共存的情况。

按需准备与仓库发现是两件事：当前启动路径会扫描仓库边界和 Git 元数据，根仓库没有初始提交时建立根基线，再只准备根 worktree；扫描不会为所有子仓库 checkout、安装依赖或初始化缺失的 submodule。Agent 后续通过 `ensureRepository` 请求具体仓库才创建其候选，已有子模块按需要补齐祖先候选。当前发现仍是全目录遍历，且注册前后会复扫；这部分尚未做增量/惰性发现，不能把“候选按需准备”表述为整个启动过程完全 lazy。

已有执行说明不能当作有效 Evidence，空检查列表不能推断通过。真实材料、条件绑定、独立判断与准确 Review Accept 见 [Evidence v1](evidence-and-verify-v1.md)；对话式功能准出见[准出标准](foundry-conversation-release-gate.md)。

## steer 与继续

- 执行中输入先进入共享消息队列。Claude 可以点击队列的“引导”，经过服务端校验 Issue、runtime 和当前执行 ID，再经 daemon 与候选执行子进程调用现有 Claude Agent SDK steer。执行侧确认后才移除队列项；原生拒绝或下线则保留消息、展示原因。执行 ID 已变化时禁止把旧队列项注入新执行。已确认的 steer 作为用户消息随事件幂等持久化。
- Codex 与 Chat 共用下一轮语义。输入可排队，当前轮次结束后在同一候选/原生会话继续；也可以先排队再停止，等待当前执行确实结束再继续，避免两个执行同时修改候选。浏览器队列要求保留页面打开，不宣称具备服务端调度持久性；未发送文本以 Issue 为粒度保存在本机草稿中。
- Stop 只取消执行，保留候选；Verifying / Blocked 下发送反馈通过原有 request-changes 路径回到 Pending，再继续原会话。Accepted / Abandoned 不再继续写入，提供 follow-up。
- Abandon 由人点击，运行中的 Issue 先停止。服务端原子核对状态和当前执行，已放弃的 Issue 不会再次派发、继续或接受。已有候选先由在线设备停止 preview 并检查是否有未完成的集成 journal；没有删除文件或自动清理，历史仍可审阅。离线候选需要设备恢复后完成该检查。
- 页面或网络丢失确认时不自动重试 steer。超时提示先检查对话，避免未经核对重复注入。

后续拆步骤、多 Agent / 不同 Harness 的方向见 [Issue Multi-Agent](issue-workflow.md#issue-multi-agent)。
