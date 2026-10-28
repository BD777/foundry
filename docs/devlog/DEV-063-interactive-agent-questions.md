# DEV-063 Agent 结构化提问显示为纯文本

## 状态

状态：第一阶段（Codex 异步问题卡片）已实现并部署 dev Web，待人工验收；阻塞式提问（第二阶段）按决定暂缓。

合并：2026-10-28 夜间窗口经 PR #154 合并到 main（分支 `release/dev054-068`，本事项单独提交，共用文件在 shared wiring 提交）。

| 环节                | 状态   | 说明                                                                                                                                                        |
| ------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 问题理解/调研       | 已完成 | [研究记录](../research/DEV-063-interactive-agent-questions.md)                                                                                              |
| 代码                | 已完成 | Protocol、Worker、Server、Web，见下文“改动”                                                                                                                 |
| dev Server/Web 部署 | 部分   | Web 已发布 build `421f79759d57b573`；运行中的 Server 已含 `questions` 字段与 `steer`（随 DEV-057 部署），回答默认走 `boundary` 的一行改动待下次 Server 部署 |
| Worker 更新         | 待执行 | 改动已在 Worker 包 `0.5.7-dev.104.g4d184b2.local.1793172116`；设备的 session runner 仍是 `.1793154141`，切换归 DEV-066                                      |
| Agent 自验          | 已完成 | 单元测试 + scratch 栈上真实 Codex（gpt-6-luna）端到端，浏览器 light/dark、1280/390、键盘                                                                    |
| 人工验收            | 待确认 |                                                                                                                                                             |

## 流水

- 2026-10-28 用户问题：Codex 会话中 Agent 问了一个三选一的范围问题，Web 显示为普通段落，回合在没有回答的情况下继续。用户问是否应做成可交互输入：超时后收起成可重新打开的按钮，选择作为 steer 进入队列；并问 Claude Code 是否有同样场景。负责会话 `sess_1793157249483439973`，编排 `sess_1793063405185071529`。
- 2026-10-28 只读调研完成（Server DB `mode=ro`、Foundry 源码、codex 0.163 app-server 生成的协议类型与二进制内嵌提示词、Claude Agent SDK 类型）：
  - 来源：Codex 非阻塞工具 `request_user_input_async`（gpt-6 系列在模型目录中默认启用）。问题记录为 `agentMessage`，`delivery: "async"`，`questions: [{title, options}]`；工具立即返回，回合继续，没有原生超时，回答就是下一条用户消息。事件中的消息 id 是工具调用 id，与此一致。
  - Foundry 生成消息事件时只保留 `text`（Codex 的后备文本），丢掉了 `questions`，所以显示成纯文本。
  - Codex 阻塞式 `item/tool/requestUserInput` 只在 Plan 模式或未发布的特性开关下出现；Foundry 对它回 -32601，实际触发不到。
  - Claude：Foundry 不提供 `canUseTool`，CLI 不向模型提供 `AskUserQuestion`，没有同样场景；Claude 在回合末用文字提问。
- 2026-10-28 编排会话决定：实施第一阶段，第二阶段暂缓。
- 2026-10-28 回答格式确认：本机一份由 Codex 官方客户端回答过的会话中，回答是一条用户消息：`<send_user_message_question_reply>\n[{"questionItemId":"[\"request_user_input_async\",\"<调用 id>\",<序号>]","question":…,"answer":…}]\n</send_user_message_question_reply>\n`。Foundry 发送同一格式，Web 把这类用户消息显示为“回答了 Agent 的提问”和问答列表。
- 2026-10-28 实现与自验完成，Web 已部署。

## 改动

- Protocol（`packages/protocol/src/chat.ts`）：`TranscriptMessage.questions?: AgentQuestion[]`、`delivery?: "async"`；`AgentQuestion {title, options?}`；`EnqueueChatMessageInput.steer?: boolean`。
- Worker：`sdk-messages.ts` 的 `sdkResponseMessage` 保留 `questions`/`delivery`（`agentQuestions` 规范化，丢弃空标题与空选项）；`transcript-adapters/codex.ts` 在原生日志回放（`item_completed` 的 `AgentMessage`）中同样保留。
- Server：`store.TranscriptMessage` 增加 `Questions`/`Delivery`；`POST /api/chats/{id}/queue` 接受 `steer: true`：入队后若有运行中的回合，立即 steer（`boundary`）进去，否则留在队列里作为下一回合输入。`Idempotency-Key` 由卡片给出（`question:<item id>`），同一卡片重复提交只发送一次。为此把 queue steer 的处理抽成 `steerChatQueueItem`（DEV-057 随后在其上加了 `delivery` 参数）。
- Web：
  - `components/conversation/agent-questions.ts`：回答信封的生成与解析；`withAgentQuestionStates` 按转录推导状态：`waiting`（回合进行中且之后没有用户消息）、`answered`（之后有指向该问题的回答）、`assumed`（回合已结束且未回答，即 Agent 按假设继续）、`unanswered`（之后用户说了别的）。
  - `agent-question-card.tsx`：问题卡片。原生单选（新增 `Radio` 原语，`components/ui/field.tsx`），推荐项预选并标注，“其他回答”文本框，无选项时只有文本框。键盘：方向键/数字键选择，Enter 发送，Esc 收起。等待时展开；其他状态收起为“回答”按钮，可重新展开迟到回答。已回答时显示问答。
  - 回答投递：`conversation-actions.ts` 的 `answerQuestion` 是唯一入口。聊天经服务端队列（`steer: true`）；没有服务端队列的会话（Issue）回合进行中用 `onSteer`，否则作为下一条消息发送。
  - `features/chat`：转录投影带上 `questions` 与原生 item id（Foundry 消息 id 形如 `<input id>/<call id>`，取最后一段）。
  - 中英文文案（`conversation.question.*`）、样式（`20-chat-tool-call-and-issue-draft.css`）。

## 自验证据

- 单元测试：`packages/worker/test/transcript-adapters.test.mjs`（实时与日志回放）、`apps/server/internal/httpapi/chat_queue_test.go` 的 `TestChatQueueEnqueueWithSteer`（无设备时留在队列；有设备时 steer 一次、`delivery=boundary`，重复请求不重复 steer）、`apps/web/test/agent-questions.test.mjs`（信封、四种状态、卡片数字键/Enter/Esc、收起后迟到回答）、`apps/web/test/agent-questions-thread.test.mjs`（会话事件到聊天行保留问题与原生 id）。
- `scripts/check-changed.sh`（本事项文件）：prettier、gofmt、protocol build、tsc、worker build/tests、go test、audit:ui、audit:modules 通过。失败项均不在本事项文件中：protocol 契约测试与 `audit:contract`（DEV-066 进行中的 `DeviceRunner`/`execution_runner*`）；Web 4 个测试（`file-delivery`、`session-work-controls` 的重试用例）。
- 真实端到端：scratch 栈（DB 副本，`FOUNDRY_INTEGRATIONS=off`，Server/Web/Worker 均来自共享树），Codex 官方登录，模型 gpt-6-luna，合成工作区。
  - 回合内回答：Agent 提问后运行 `sleep 30` 等待；在卡片中用键盘选 Chinese 并 Enter，10 秒后会话出现“Steered into active turn”（正文为回答信封），Agent 在 README 追加“你好！”并结束。
  - 迟到回答：另一会话 4 次等待后按假设追加英文并结束；卡片显示“已按自己的假设继续”并收起；重新展开选 Japanese 发送，作为下一回合输入，Agent 把问候改成日文。
  - 截图（本机，非仓库）：`.foundry/attachments/dev063/`，含 light/dark × 1280/390 的等待态、选择后的焦点态、已回答态与回答消息。
- dev Web：`scripts/deploy-web-dev.sh` 发布 `421f79759d57b573`（之前 `b3d2617e4d7a847c`，入口已保存在 `~/.foundry/server/releases/dev063/previous-20261028T083750Z`），脚本核对公网入口资源与同源 API 通过。

## 限制与后续

- 设备 runner 未切换前，dev 上的真实会话仍由旧 Worker 产生事件，不带 `questions`，问题继续显示为文本。runner 切到 `.1793172116` 或更新版本后生效（DEV-066）。历史事件不会补出结构。
- 运行中的 Server 尚未包含“回答默认 `boundary`”的一行改动；在此之前回合内回答按默认方式立即 steer（Codex 会打断正在生成的推理），功能正确。随下次 Server 部署生效。没有单独为一行改动用共享树（含其他会话未完成的 Go 改动）重建 Server。
- 新 Worker 上 Codex 的 `boundary` 会把回答保留到下一个工具开始（最长 15 分钟）；Agent 之后不再调用工具时何时送达，以 DEV-057 的规则为准。
- 通知（Web 未读、离开时 Feishu）未做：现有会话通知没有“Agent 在提问”这一类事件，需单独加事件类型与文案，列为后续。
- 子 Agent 详情面板（`ChatMessageList`）不计算状态，仍显示文本。

## 验收步骤

前提：设备 session runner 已切到含本改动的 Worker（`.1793172116` 或更新）。

1. 在任一工作区新建 Codex 聊天，模型选 gpt-6 系列，发送：“用 request_user_input_async 问我一个三选一问题（A/B/C），然后运行 `sleep 30` 最多 4 次等待我的回答。”
   - 预期：问题显示为卡片，标题“Agent 提问”，状态“等待你的回答”，第一个选项预选并标“推荐”，另有“其他回答”。
2. 用方向键或数字键选一个选项，按 Enter。
   - 预期：卡片变为“回答已发送”/“已回答”并列出答案；下方出现一条“回答了 Agent 的提问”的用户消息；Agent 在本回合内按所选答案继续。
3. 再开一个同样的聊天，不回答，等回合结束。
   - 预期：卡片收起，状态“已按自己的假设继续”，右侧“回答”按钮。点开、选一个答案发送后，Agent 开始新回合并按答案调整。
4. 在浅色/深色和窄屏（约 390 宽）下重复第 1 步，确认选项、焦点框、按钮可读可点。
