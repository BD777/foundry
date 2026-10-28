# DEV-063 Agent 结构化提问：调研与方案

调研日期：2026-10-28。范围：Codex 0.163–0.165 app-server、Claude Code 2.1.308 / Agent SDK、Foundry 当前 Worker/Server/Web。只读取证，没有改产品代码。

## 结论

- 截图里的问题来自 Codex 的**非阻塞**提问工具 `request_user_input_async`，不是纯文本，也不是阻塞式的 `item/tool/requestUserInput`。工具立即返回 `{"accepted":true}`，回合照常继续；Codex 没有超时，也不等待回答，回答本来就是以“下一条用户消息”的方式送达。
- Foundry 丢掉了结构：Worker 把这条 `agentMessage` 的 `questions` 字段丢弃，只保留了 Codex 生成的后备文本（问题加 `-` 列表），所以 Web 显示成普通段落。
- Claude Code 在 Foundry 里**没有**这个场景：`AskUserQuestion` 只在宿主提供 `canUseTool` 时才提供给模型，Foundry 没有提供，模型看不到这个工具，只能在回合末用文字提问。
- 建议做第一阶段：把 Codex 异步问题渲染成可交互卡片，回答作为 steer（`boundary`）或下一回合输入发出。改动小（约 2–3 人日），直接对应用户看到的问题。阻塞式提问（Claude `AskUserQuestion`、Codex 阻塞 `requestUserInput`）放到第二阶段，等用户确实需要“回合停下来等人”时再做。

## 1. 现场证据（只读）

会话 `sess_1793086209811503213`（Codex 0.165.0，模型 gpt-6-astra，兼容端点）：

| 时间（UTC） | 事件                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------- |
| 03:11:01    | 助手消息，id 后缀为 `call_OEEf…`（工具调用 id，不是普通消息 id），文本是一个问题和 3 个选项 |
| 03:11:14–51 | 模型继续思考并输出 commentary，没有停下来等                                                 |
| 03:12:23    | 回合结束，最终回答按自己的假设给出方案                                                      |
| 03:15:05    | 用户在下一回合用文字补充了范围（相当于迟到的回答）                                          |

消息 id 是工具调用 id，与 Codex 的实现一致：`request_user_input_async` 把问题记录为一条 `agentMessage`，`delivery: "async"`，`questions: [{title, options}]`，item id 即调用 id。

## 2. Codex

### 2.1 三种机制

| 机制                                                | 触发条件                                                                                                 | 是否阻塞 | Foundry 现状                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------- |
| `request_user_input_async`（本事项）                | 模型目录 `experimental_supported_tools` 含 `send_user_message_async`；gpt-6 系列默认带，gpt-5.6 系列没有 | 否       | 显示为纯文本，`questions` 被丢弃                                     |
| `request_user_input` → `item/tool/requestUserInput` | Plan 协作模式，或开启 `default_mode_request_user_input`（under development，默认 false）                 | 是       | Worker 回 JSON-RPC 错误 -32601；Foundry 不用 Plan 模式，实际触发不到 |
| `mcpServer/elicitation/request`                     | MCP 服务器请求输入                                                                                       | 是       | 同样回 -32601                                                        |

来源：本机 codex 0.163.0 的 `app-server generate-ts` 生成的协议类型、二进制内嵌的工具描述与提示词、`codex features list`、Foundry 托管的 `models_cache.json`。

### 2.2 异步问题（`request_user_input_async`）

- 协议：`ThreadItem.agentMessage` 带 `delivery: "async" | null` 与 `questions: AsyncUserInputQuestion[] | null`，`AsyncUserInputQuestion = { title: string, options: string[] | null }`。`options` 为空表示只接受自由文本；UI 自动提供自由文本输入，模型被要求不要自己加 “Other”。第一个选项是推荐项，默认预选。`text` 字段同时带有后备文本（问题 + `-` 列表）。
- 工具立即返回 `{"accepted":true}`，不结束回合。
- 超时：没有。模型提示词约定“给用户合理的回答时间，例如简单单选约 60 秒，复杂问题更久，然后带着说明过的假设继续”；“答案或批准是必需的时候，保持问题待定，不做依赖它的工作；时间流逝不等于回答”。
- 回答方式：一条新的用户消息（回合进行中就是 steer，否则是下一回合输入）。Codex TUI 有专门的 `bottom_pane/async_questions` 面板，回答被序列化为 `AsyncQuestionReply { questionItemId, question, answer }`，包在 `<send_user_message_question_reply>` 里发出。第三方客户端报告 `questionItemId` 形如 `["request_user_input_async", "<itemId>", <index>]`（见参考）。具体信封要在第二阶段抓一次真实 TUI 回答确认；即使信封不对，纯文本回答模型也能读懂。
- 官方 UI 行为（二手来源）：0.156 起异步问题到达会通知；0.157 起回合结束时把未发送的回答恢复到输入框；桌面 App 存在问题卡片在最终回答渲染时被自动收起、之后无法回答的缺陷（openai/codex#43803）。用户记得的“超时后收成按钮、可以重新打开”与此接近，但不是官方承诺的行为。

### 2.3 阻塞提问（`item/tool/requestUserInput`）

- 参数：`{threadId, turnId, itemId, questions: [{id, header, question, isOther, isSecret, options: [{label, description}] | null}], isBlocking, autoResolutionMs(已弃用)}`。
- 回答：`{answers: {[questionId]: {answers: string[]}}}`。
- 提示词约定：“返回空答案时，按最佳判断继续，不要再问，也不要把回合当作被阻塞”。因此宿主超时后返回空答案是安全的降级方式。
- 只有根线程可用；子 agent 调用会被拒绝。

## 3. Claude Code / Agent SDK

- `AskUserQuestion` 输入：1–4 个问题，每个含 `question`、`header`（≤12 字符）、2–4 个 `options: {label, description, preview?}`、`multiSelect`。UI 自动提供 “Other”。
- SDK 路径：CLI 发 `can_use_tool` 控制请求，宿主的 `canUseTool("AskUserQuestion", input)` 返回 `{behavior: "allow", updatedInput: {questions, answers: {问题文本: 选项 label（多选用逗号连接）}, annotations?}}`。拒绝即返回 deny 和说明。
- 超时：SDK 不设超时，`canUseTool` 可以一直挂起。交互式 TUI 有 `askUserQuestionTimeout` 设置（`60s`/`5m`/`10m`/`never`，默认 `never`），到时“按已选答案自动继续”。
- `ExitPlanMode`：只在 Plan 模式出现，同样经 `canUseTool` 审批。Foundry 不使用 Plan 模式，不在本事项范围内。
- Foundry 现状：Claude 会话以 `--permission-mode=bypassPermissions` 启动，没有 `canUseTool`/`--permission-prompt-tool`，CLI 因此不向模型提供 `AskUserQuestion`/`EnterPlanMode`（本调研会话自己的工具列表中就没有）。Claude 只能在回合末用文字提问，然后等待下一条消息，这在 Foundry 里一直能正常工作。

## 4. Foundry 现有可复用部分

- Worker：`packages/worker/src/agent-runtime/codex-client.ts` 对所有非刷新类服务端请求回 -32601，注释明确“不自动批准”；`runner/codex-app-server.ts` 的 `appServerItem` 把 item 原样展开，`questions`/`delivery` 在 Worker 内仍在，之后生成 Foundry 消息事件时只取了 `text`：Server 中这条事件的 `message` 只有 `id`/`kind`/`text`。
- Issue 的 `ask_person` 与 `issue-question-card.tsx`：只用于 Issue 执行会话，卡片含选项按钮，回答经 Server 写回 Issue。卡片的视觉和交互可以参考，数据模型不通用（绑定 Issue 状态 `blocked`）。
- DEV-057（进行中）：持久收件箱、`send_message` 的 `delivery`（`interrupt`/`boundary`/`turn_end`）与 `inputId` 幂等、回执。回答直接走这条路径，不另建通道。

## 5. 方案

### 第一阶段：Codex 异步问题卡片（建议做）

1. Worker：映射 Codex `agentMessage` 时保留 `questions`（规范成 `{title, options}`）与 `delivery`，作为助手消息的结构化字段一起上报；历史回放（transcript 适配器）同样保留。协议类型加在 `packages/protocol`。
2. Server：消息负载原样存储并下发（现有事件 JSON 已能承载），不需要新表。回答状态由后续用户消息推导，或在发送回答时记下 `answersItemId`。
3. Web：带 `questions` 的助手消息渲染为问题卡片，不再显示后备文本：
   - 每个问题一组单选（`SelectMenu`/选项按钮，第一个推荐项预选并标注），加自由文本输入（`TextInput`）；`options` 为空只显示文本框。多个问题一次提交。
   - 键盘：方向键/数字键选项，Enter 提交，Esc 收起；焦点、禁用、发送中、失败状态齐全；浅色/深色、390 宽度可用。
   - 状态：**等待回答**（回合进行中）→ **已回答**（显示所选答案与送达回执）；回合结束仍未回答时显示 **Agent 已按假设继续**，卡片收起成“回答”按钮，可重新展开并迟到回答；之后用户发了别的消息则标为 **未回答**，仍可展开。
4. 回答投递：回合进行中用 DEV-057 的 `boundary` steer（不打断正在生成的推理，在下一个 item 边界送达）；会话空闲时作为下一回合输入。文本使用 Codex 的回答信封（待第二阶段确认格式），并附人可读的“问题：答案”。同一卡片重复提交用 `inputId` 幂等。
5. 通知：沿用现有会话通知链路（Web 未读、离开时的 Feishu 通知）把“Agent 在问你问题”作为一种事件；具体链路实现时确认，不新建通道。

超时：Codex 异步问题没有原生超时，Foundry 也不设超时；卡片状态只跟随回合状态。

### 第二阶段：阻塞式提问（暂缓）

- Claude：提供 `canUseTool`，只拦 `AskUserQuestion`（其他工具保持现有 bypass 行为），复用同一卡片。Foundry 设超时（建议 5 分钟；人在线可延长），到时返回 deny，说明“用户暂未回答，请按最佳判断继续并说明假设”；迟到回答走 `boundary` steer 或下一回合。
- Codex 阻塞 `requestUserInput`：同一卡片；超时返回空答案（Codex 约定的降级）。只在 Foundry 引入 Plan 模式或开启 `default_mode_request_user_input` 时需要。

## 6. 取舍

| 方面       | 第一阶段（异步卡片）                                            | 第二阶段（阻塞提问）                                                       |
| ---------- | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 收益       | 直接修复截图问题；gpt-6 系列会经常用到                          | Claude 可结构化提问；回合能停下来等人                                      |
| 风险       | 低：不改变回合控制流，回答只是用户消息                          | 回合挂起占用会话与子会话，编排可能停住；需要可靠超时；改变 Claude 权限路径 |
| 依赖       | DEV-057 的 `boundary` steer 与幂等                              | 同上，另需 Worker 权限回调与回合挂起状态                                   |
| 工作量估计 | 约 2–3 人日（Worker 0.5，协议/Server 0.5，Web 1–1.5，验证 0.5） | 约 3–4 人日                                                                |

建议先做第一阶段；第二阶段等用户确认需要阻塞语义后再做。

## 7. 协调

- `runner/codex-app-server.ts`（DEV-061）：只改 `agentMessage` 映射，避开 compact 恢复逻辑。
- `chat-message-list.tsx`/`markdown-content.tsx`（DEV-055）：卡片放在独立组件，消息列表只加分支。
- steer 路径（DEV-057）：只调用其 `send`/`steer` 接口（`delivery`、`inputId`），不改签名。

## 参考

一手来源：本机 codex 0.163.0 `app-server generate-ts` 输出（`ServerRequest.ts`、`v2/ToolRequestUserInput*.ts`、`v2/ThreadItem.ts`、`v2/AsyncUserInputQuestion.ts`、`v2/AgentMessageDelivery.ts`）、二进制内嵌提示词与工具描述、`codex features list`；Foundry 托管的模型目录缓存；Claude Agent SDK `sdk.d.ts`/`sdk-tools.d.ts`（`CanUseTool`、`AskUserQuestionInput/Output`、`askUserQuestionTimeout`）；Foundry 源码与 Server 事件（只读）。

二手来源（GitHub issue/PR，未逐条验证）：

- [openai/codex#43803 异步问题卡片在最终回答渲染时被自动收起](https://github.com/openai/codex/issues/43803)
- [RunMaestro/Maestro#1752 Codex 在异步提问工具上停滞](https://github.com/RunMaestro/Maestro/pull/1752)
- [PixelPaw-Labs/codex-trace#304 0.153.0 引入的 request_user_input_async](https://github.com/PixelPaw-Labs/codex-trace/issues/304)
- [cberner/hitch#678 渲染并回答 Codex 异步问题](https://github.com/cberner/hitch/pull/678)
- [kevinmanase/agent-wire#30 经 app-server 回答 Codex 原生问题](https://github.com/kevinmanase/agent-wire/issues/30)
