# Chats：轻量 Web UI 与原生 Harness

[项目 Roadmap](../README.md#roadmap) · [文档索引](README.md)

## 交付目标

实现一个 Web Chat 页面，使用 Claude 和 Codex 的原生 Harness，让纯对话体验接近 Codex App。Chats 是一项完整的用户能力，Web、Daemon 和执行容量管理是它的基础。

当前纯 Chat 已基本接近目标。工具调用的呈现、操作与证据采集继续在[基础 Tool Use](resources.md#tool-use-与证据契约)中完善，Chats 的完成不代表完整工具体验已经对齐。

## 设计与已有基础

Web 负责输入、阅读和会话管理；Daemon 在执行设备上经 Claude Agent SDK / Codex SDK 驱动设备自己的 Claude Code / Codex，没有 CLI 回退。Worker Pool / 执行槽位管理可用容量，执行与凭据留在设备侧。

Chat 页面已经支持消息输入、流式回复、附件、模型与运行参数配置；原生会话发现、历史读取与继续对话；分组、搜索和重命名；长对话阅读、轮次导航、排队输入、steer 与取消。

界面复用共享的对话展示契约，Provider 差异在适配层处理。实时过程与历史回放围绕同一会话组织，用户可以继续原有工作。

Chat 和 Issue 都使用完整的 `components/conversation/Conversation`：输入、草稿、附件交互、消息队列、steer、停止、失败恢复与阅读/滚动由同一套实现负责。ChatSurface 只组合导航、业务详情和参数；IssueConversation 只转换消息并连接 Issue API。模型工具栏通过 selectable/fixed 配置切换，业务层不再复制输入或队列逻辑。具体组件契约及回归入口见 [Issue 对话设计](issue-conversation-design.md#页面与共享组件)。

## 后续工作与完成口径

纯 Chat 保持体验优化与恢复回归。Tool Use 需要继续完善调用过程、结果阅读和人工交互，并保留真实工具输出及其任务关联；其设计、依赖和完成标准统一维护在[基础 Tool Use](resources.md#tool-use-与证据契约)，本页不再重复维护任务清单。Browser、Computer Use、Simulator 等按场景接入操作与证据采集；多个 Issue 对这些环境的分配与竞争由[共享资源调度](resources.md#共享资源调度)统一管理。

Roadmap 中的 Chats 表示上述纯对话范围已基本交付，接近 Codex App 是持续体验目标；Session 间协作（CHAT-01）已单独交付。具体改动在实现时按场景拆分，验证实时对话、历史阅读和中断恢复。

<a id="session-collaboration"></a>

## Session 间协作

Roadmap：**CHAT-01** · 已交付。设计、鉴权与验收见[会话编排设计](session-orchestration-design.md)。

- 当前 session 的 Agent 能创建另一个 session 并交付任务，也能向它发送 steer 补充或调整正在执行的任务（通过 `foundry` CLI / MCP）。
- 新 session 默认加入当前 session 所在分组；当前 session 未分组时，自动创建分组并将两者一起放入（[血缘与自动入组](session-orchestration-design.md#5-血缘与自动入组)）。
- 分组属于会话组织关系，不决定是否共享执行目录或候选改动；Agent 可操作的 session 范围见[鉴权与授权](session-orchestration-design.md#4-鉴权与授权)。

## 实现边界

截至 2026-10-14（`3092162` 加未提交的工作区改动，见“阅读与组织”最后一项）。

**已实现**（路径相对仓库根目录）：

- 会话模型：一个 Foundry 会话对应每个 runtime 与设备上的一个原生 Claude Code / Codex 会话，续聊是同一会话的新输入（[会话模型](session-model.md)；`apps/server/internal/sqlitestore/native_sessions.go`）。经 Claude Agent SDK / Codex SDK 驱动设备上的 CLI，SDK 出错即会话出错，没有 CLI 回退（`packages/worker/src/runner/`）。原生会话发现与接管、按会话活动排序。
- 输入：附件存放在 Workspace 所在设备、由 Server 中转，远程设备同样可用（`httpapi/daemon_attachments.go`）；steer 可带附件，包括只有图片的 steer（2026-10-10，#116）；Codex 不能 steer 进行中的一轮，消息排到下一轮。Chat 的排队消息存在 Server（`chat_queue_items`，`httpapi/chat_queue.go`），本轮结束后由 Server 恰好发送一次，关掉所有标签页也照发；编辑、删除、排序带 revision，冲突返回 409 与当前队列（2026-10-10，#118）。Issue 对话的队列仍在浏览器（`components/conversation/use-local-queue.ts`）。创建与发送接受 `Idempotency-Key`（`httpapi/idempotent_requests.go`）。
- 会话产出：文件只来自会话自己成功的写工具（主线程与子 Agent，Workspace 内外都算）以及回答中提到且存在的路径，不再按时间窗口扫目录（`packages/worker/src/session-files.ts`、`httpapi/session_files.go`）；Changes 显示变更类型与增删行数，diff 来自 Claude 每轮首次写入前与末次写入后的副本，Codex 则是轮次开始时用临时索引写出的 Git 快照，后者可能包含其他人对同一文件的修改（`session-file-diffs.ts`、`internal/textdiff`，2026-10-10，#117）。读文件与 diff 由 Server 按角色检查，规则见[账号与权限 §3](accounts-permissions-design.md#3-device-跟随-workspace)。
- 后台工作与定时器：Chat 的一轮在 Claude 回答时结束，后台命令与子 Agent 继续运行，结束后的续写在轮次之间送达；Background 区显示状态、输出末尾和 Stop（`agent-background-tasks.ts`、`httpapi/session_background_tasks.go`）。Issue、编排与 verifier 会话仍等后台工作结束。定时器在会话空闲时也触发，Worker 重启后保留（`agent-timers.ts`、`httpapi/session_timers.go`）。
- 恢复：Worker 重启后孤儿输入由设备在重连后数秒内结算，有完成标记的按标记里的回答完成，否则标为结果丢失（`httpapi/agent_session_recovery.go`、Worker `recover_session`）；Server 定期把设备不再上报的运行中会话判为失败。Worker 升级后接管上一版留下的定时器、scratch 目录和聊天上传记录（#123）。
- 阅读与组织：线程化聊天记录与子 Agent 记录、分组 / 搜索 / 重命名 / 排序、AI 标题（`internal/chattitle`）、会话状态行、每个浏览器一条可续传的事件流并在标签页间共享（`apps/web/src/stream/`，#122）、聊天记录窗口化加载、标签页与 favicon 状态（#120）。
- 未提交的改动（2026-10-14）：Claude 进程结束（被替换或关闭）时没报告结束的子 Agent 标为失败，不再显示运行中（`agent-background-tasks.ts`、`runner/active-runtimes.ts` `claudeProcessRunsSubagent`、`subagent-transcript.ts`；Worker 重连时 Server 作废子 Agent 缓存，`subagent_cache.go`）；被 steer 拆开的同一工具调用的两组各有唯一行 id，不再留下重复行与空白（`transcript-projection.ts`、`transcript-adapters.ts` 的 `stepId`）；会话状态行显示 Foundry 为兼容端点设的上下文窗口及来源（[模型与账号](models-and-accounts.md)）；命名会话以 `dontAsk` 运行（[会话列表与命名](chat-list-design.md)）。
- Session 间协作见上文与[会话编排设计 · 实现边界](session-orchestration-design.md#实现边界)。

**未实现 / 已知缺口：** 工具调用的呈现与操作仍在[基础 Tool Use](resources.md#tool-use-与证据契约) 中推进；Worker 重启用例 C10、C20 仍是手工步骤，C19 有脚本但只在显式 `--kill-worker` 时运行（[实机回归 §3](live-regression.md#3-覆盖缺口待补)）。

**验证情况：**

- 实机回归（真实 Claude / Codex、真实 Worker）：会话模型、steer、取消、附件、Worker 重启恢复（C1–C10、C16、C19–C21 等）最近一次全部通过是 2026-09-29，环境与用例见[实机回归](live-regression.md)。
- 以下改动在各自 PR 中记录了真实模型检查，日期为合并日：会话产出、带图片的 steer、12 分钟后台命令（Claude，隔离栈，2026-10-10，#116）；Claude diff（2026-10-10，#117）；Codex diff、关掉浏览器后 Server 按编辑后的顺序发出排队消息、队列的真实浏览器检查（2026-10-10，#118）；dev 数据库副本上的页面加载请求数与 Server 重启后重连（headless Chromium，2026-10-11，#120）；4 个标签页共享一条事件流、空闲与 Worker 重启后的定时器（2026-10-11，#122）。
- 未提交的改动已实现，在测试中验证（`packages/worker/test/subagent-transcript.test.mjs`、`chat-naming.test.mjs`，`apps/web/test/transcript-pipeline.test.mjs` 用真实会话裁剪的事件、`chat-session-status.test.mjs`），尚未实机验证。
- 上述 PR 之后没有重跑整套实机回归；C10、C20 自 2026-09-29 起没有新的运行记录。

## 相关设计

- [会话列表与命名](chat-list-design.md)：分组、搜索、排序、已读状态、标题归属与列表宽度调整。
- [轮次导航](chat-turn-navigator-design.md)：长对话阅读、滚动跟随与响应式布局。
- [共享对话管线](chat-transcript-design.md)：消息契约、工具身份与实时投影。
- [Daemon 生命周期](daemon-lifecycle.md)与[安全边界](security.md)：执行、恢复、连接和凭据。
