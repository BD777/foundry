# Chats：轻量 Web UI 与原生 Harness

[项目 Roadmap](../README.md#roadmap) · [文档索引](README.md)

## 交付目标

实现一个 Web Chat 页面，使用 Claude 和 Codex 的原生 Harness，让纯对话体验接近 Codex App。Chats 是一项完整的用户能力，Web、Daemon 和执行容量管理是它的基础。

当前纯 Chat 已基本接近目标。工具调用的呈现、操作与证据采集继续在[基础 Tool Use](tool-use-and-resources.md#basic-tool-use)中完善，Chats 的完成不代表完整工具体验已经对齐。

## 设计与已有基础

Web 负责输入、阅读和会话管理；Daemon 在执行设备上运行 Claude Agent SDK / Claude Code CLI 或 Codex SDK / CLI。Worker Pool / 执行槽位管理可用容量，执行与凭据留在设备侧。

Chat 页面已经支持消息输入、流式回复、附件、模型与运行参数配置；原生会话发现、历史读取与继续对话；分组、搜索和重命名；长对话阅读、轮次导航、排队输入、steer 与取消。

界面复用共享的对话展示契约，Provider 差异在适配层处理。实时过程与历史回放围绕同一会话组织，用户可以继续原有工作。

Chat 和 Issue 都使用完整的 `components/conversation/Conversation`：输入、草稿、附件交互、消息队列、steer、停止、失败恢复与阅读/滚动由同一套实现负责。ChatSurface 只组合导航、业务详情和参数；IssueConversation 只转换消息并连接 Issue API。模型工具栏通过 selectable/fixed 配置切换，业务层不再复制输入或队列逻辑。具体组件契约及回归入口见 [Issue 对话设计](issue-conversation-design.md#页面与共享组件)。

## 后续工作与完成口径

纯 Chat 保持体验优化与恢复回归。Tool Use 需要继续完善调用过程、结果阅读和人工交互，并保留真实工具输出及其任务关联；其设计、依赖和完成标准统一维护在[基础 Tool Use](tool-use-and-resources.md#basic-tool-use)，本页不再重复维护任务清单。Browser、Computer Use、Simulator 等按场景接入操作与证据采集；多个 Issue 对这些环境的分配与竞争由[共享资源调度](tool-use-and-resources.md#shared-resource-scheduling)统一管理。

README 的 Chats 勾选表示上述纯对话范围已基本交付，接近 Codex App 是持续体验目标；Session 间协作（CHAT-01）已单独交付。具体改动在实现时按场景拆分，验证实时对话、历史阅读和中断恢复。

<a id="session-collaboration"></a>

## Session 间协作

Roadmap：**CHAT-01** · 已交付。设计、鉴权与验收见[会话编排设计](session-orchestration-design.md)。

- 当前 session 的 Agent 能创建另一个 session 并交付任务，也能向它发送 steer 补充或调整正在执行的任务（通过 `foundry` CLI / MCP）。
- 新 session 默认加入当前 session 所在分组；当前 session 未分组时，自动创建分组并将两者一起放入（[血缘与自动入组](session-orchestration-design.md#5-血缘与自动入组)）。
- 分组属于会话组织关系，不决定是否共享执行目录或候选改动；Agent 可操作的 session 范围见[鉴权与授权](session-orchestration-design.md#4-鉴权与授权)。

## 相关设计

- [会话列表与命名](chat-list-design.md)：分组、搜索、排序、已读状态、标题归属与列表宽度调整。
- [轮次导航](chat-turn-navigator-design.md)：长对话阅读、滚动跟随与响应式布局。
- [共享对话管线](chat-transcript-design.md)：消息契约、工具身份与实时投影。
- [Daemon 生命周期](daemon-lifecycle.md)与[安全边界](security.md)：执行、恢复、连接和凭据。
