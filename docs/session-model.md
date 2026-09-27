# 会话模型

[文档索引](README.md) · [Session 编排](session-orchestration-design.md) ·
[模块架构](architecture-modules.md)

## 决定（2026-09-27）

**一个会话就是一个会话。** Foundry 的 `AgentSession` 对应一个原生 Agent 会话
（Claude Code / Codex 的同一个 session），从创建到删除都是同一行、同一个 id。
多轮对话由原生 Agent 自己管理，Foundry 不再把每一轮存成独立的会话。

此前每一轮是一行 `agent_sessions`，同一对话靠 `threadId` 串联。身份、令牌、血缘、
权限、派发、Worker 产物都按"轮"计，导致：下一轮管不了上一轮派出的子会话；复用的
长驻进程带着第一轮的会话 id 和已作废的令牌；adopt 混用两种 id；列表按行截断会挤掉
长对话的旧轮次；子 Agent 只能在派出它的那一轮下找到；handoff 只带最后一轮。

## 模型

| 概念 | 含义 |
| --- | --- |
| 会话 `AgentSession` | 一个原生会话。`id` 即对话 id（`threadId == id`，保留字段仅为兼容读取）。`prompt` 是开场目标，`response` 是最近一次回答，`status` 反映最近一次输入的处理状态。 |
| 输入 `SessionInput` | 发给会话的一条消息：`{id, prompt, attachments, importedContext, profileTransitionNote}`。它是派发单位，不是会话：不带身份、不参与权限、不记血缘。Claude 路径把输入 id 作为原生用户消息的 `uuid` 传入。 |
| 事件 | 挂在会话上。每条输入写入一条 `User message` 事件（`message.kind = "user"`），聊天记录只由事件构成。 |

状态：`queued → running → completed | failed | canceled`，`blocked` 为运行中的等待。
结束态不是会话终点：给会话发新输入会让它回到 `queued`，沿用同一个原生会话。

### 发消息

`POST /api/agent-sessions/{id}/messages`（MCP `send_message`）是给会话发消息的唯一入口：

- 会话正在运行：作为 steer 注入当前执行（Codex 为下一轮排队）。
- 会话空闲：成为新的输入，会话回到 `queued` 并派发。可同时切换 profile / model；
  runtime 与原生会话不兼容时清空 `nativeSessionId`，由调用方带上 `importedContext`。

新建会话仍是 `POST /api/agent-sessions`，请求中的 prompt 成为第一条输入。

### 派发与 Worker

- `run_session` 载荷为 `{session, input, sessionToken, …}`；Worker 以 `input.id` 去重，
  执行视图是会话叠加这条输入。
- 生命周期消息（`session_started/completed/canceled`）带 `inputId`，Server 忽略
  不属于当前输入的旧消息。
- Worker 产物目录 `.foundry/sessions/<sessionId>/inputs/<inputId>/`（结果、完成标记、
  原生消息日志）。中断恢复只读当前输入的目录，旧输入的标记不会误判新输入。子 Agent
  列表扫描会话下全部输入目录。

### 令牌与权限

- 令牌属于会话：每次派发签发一个新令牌，旧令牌在会话存续期间继续有效，会话删除时全部作废。
  复用的长驻进程里的 `FOUNDRY_SESSION_ID` / `FOUNDRY_SESSION_TOKEN` 始终有效。
- **同一 Workspace 内，任意 Agent 会话可以读取和操作任意会话**（用户在对话中指定对象即可）。
  血缘 `parentSessionId` 只作记录（界面归属、深度与扇出上限），不作为权限来源。
  adopt / 监管机制删除。人的权限仍按 Workspace 角色判定。

## 不受影响的部分

- 轮次导航（[设计](chat-turn-navigator-design.md)）是聊天记录的前端投影，只认用户消息。
- Issue 的每次执行报告、验证结论保存在 Issue 自己的记录里；将来引用"会话 + 输入 id"。
- 验证（verification）本来就是独立会话。

## 迁移

开发期直接清空历史数据，不写行合并迁移。旧的多行对话在读取时仍按 `threadId`
聚合显示，但不再产生。`agent_session_tokens` 改为按令牌哈希为主键，旧表直接重建。
