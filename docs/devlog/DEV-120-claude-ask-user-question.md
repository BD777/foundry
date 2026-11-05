# DEV-120 Claude 会话的结构化提问（AskUserQuestion）

## 状态

状态：已部署 dev（Server、Web、Worker），Agent 自验完成；待人工验收。未提交（提交窗口 22:00–09:00）。

| 环节                | 状态   | 说明                                                                      |
| ------------------- | ------ | ------------------------------------------------------------------------- |
| 问题理解/调研       | 已完成 | 见“调研”；延续 [DEV-063](DEV-063-interactive-agent-questions.md) 第二阶段 |
| 代码                | 已完成 | Contract、Protocol、Worker、Web，见“改动”                                 |
| dev Server/Web 部署 | 已完成 | Server `101be7c0cd0ac603`、Web `6ec8d85fc8573af3`，见“部署”               |
| Worker 更新         | 已完成 | `0.5.7-dev.269.g97415a6e.local.1793854123`，7 台在线设备，见“部署”        |
| Agent 自验          | 已完成 | 单测 + scratch 栈真实浏览器端到端（Claude Code CLI），见“自验证据”        |
| 人工验收            | 待确认 | 见“验收步骤”                                                              |

## 流水

- 2026-11-05 用户问题：问题卡片（DEV-063）只在 Codex 会话出现，Claude 会话是不是适配得不够好。会话 [`sess_1793847986445716844`](https://dev.foundryapp.app/chats/sess_1793847986445716844)。
- 2026-11-05 调研结论（只读取证，下文“调研”）：不是渲染问题。Claude Code 的 `AskUserQuestion` 在非交互模式下只有宿主接管权限提示（SDK `canUseTool` → CLI `--permission-prompt-tool stdio`）时才提供给模型；Foundry 从未传 `canUseTool`，模型看不到这个工具，只能在回合末用正文提问。DEV-063 当时已记录并把阻塞式提问列为第二阶段暂缓。
- 2026-11-05 用户决定：按 Claude 原生方式做（回合停下等回答），超时 3 分钟，只在聊天开放；Foundry 不自建提问工具、不在提示词里引导 Agent 提问，尊重 Agent 自己的行为；正文里的问题不做识别。
- 2026-11-05 12:2x scratch 栈端到端发现：等待期间在输入框发的普通消息要等问题超时才进去。原因：Server 把“有工具在运行”当作 boundary，Worker 把 `AskUserQuestion` 改成问题消息后，Server 看不到这一步。修复见“改动 / Server”，复测通过。
- 2026-11-05 12:4x–12:5x 部署 dev 并更新 Worker（见“部署”）。
- 2026-11-05 用户追加：卡片里的 URL 要能点击，在新标签页打开（截图中的飞书授权链接是纯文本）。问题文字改用对话正文同一个 Markdown 渲染（`MarkdownContent`，保留换行），GFM 自动链接与中日韩标点后的链接规则复用现有插件，外链 `target="_blank" rel="noreferrer"`；作答表单、已回答的问答、回答行三处都生效。选项文字仍是纯文本（在 `<label>` 里，点链接会同时选中选项）。标题不再放在 `<legend>`（只允许行内内容），改由 `aria-labelledby` 命名该组选项。13:2x 部署 Web `30198d15189951ac`（原 `88b16d8f4aeef0fc`，期间其他会话发布，构建自 `foundry-int` 一并包含；回滚 `releases/dev120/previous-20261105T052241Z`）。

## 调研

一手来源：本机 Foundry 管理的 Claude 运行时 `2.1.311-sdk-0.3.317`（CLI 二进制字符串、SDK `sdk.d.ts`），Foundry 源码与原生会话记录。

- 工具开关：CLI 中 `AskUserQuestion.isEnabled()` 为 `TY()`：非交互且没有权限提示工具时返回 false。SDK 只有传了 `canUseTool` 才加 `--permission-prompt-tool stdio`。Foundry 的 Claude 会话启动参数里没有它；本机 Foundry 运行的 Claude 原生记录中 `AskUserQuestion` 调用为 0（终端里直接用的 Claude Code 会话有调用）。
- 提示词：Foundry 用 Claude Code 原生 `claude_code` 预设，不追加系统提示；DEV-079 的“Foundry decisions”提示已不在代码中。没有诱导。
- 回答协议：宿主的 `canUseTool("AskUserQuestion", input)` 返回 `{behavior: "allow", updatedInput: {...input, answers: {问题文本: 选项 label}}}`；CLI 校验只允许宿主加 `answers`/`annotations`/`response`/`followUp`，`afkTimeoutMs`（终端的离开超时）宿主不能用。工具结果由 CLI 自己写：“Your questions have been answered: …”、“The user answered: …”、`response` 为 “The user responded: …”、空 `answers` 为 “The user did not answer the questions.”。因此超时返回空 `answers`，用 Claude Code 自己的措辞，Foundry 不写引导文字。
- 其他权限提示：接管后，原本无人可批的提示（例如 bypass 模式下的安全检查）会改为询问宿主；Foundry 对它们照旧拒绝，文字沿用 CLI 无审批面时的说法。
- 正文问题：不识别。只能靠猜（正则或再调模型），没有结构化选项；回合末的正文问题直接在输入框回复即可，卡片的价值在回合中途停下等人。

## 改动

- Contract（`contracts/models/chats.yaml`）：`AgentQuestion` 增加 `header`、`descriptions`（按选项）、`multiSelect`、`unranked`（选项顺序不表示推荐；Claude 把推荐写在选项文字里，回答必须是原文 label）；`TranscriptMessage.questions` 说明两种来源。生成 TS/Go/JSON Schema。
- Protocol：回答信封的生成与解析移到 `packages/protocol/src/agent-question-reply.ts`，Web 与 Worker 共用。
- Worker：
  - `session/runner/claude-questions.ts`：`claudeAsksPerson`（`source=chat`、无 `parentSessionId`/`issueId`/`role`、非工具会话），`ClaudeQuestionGate`（`canUseTool`：只等 `AskUserQuestion`，其他提示照旧拒绝；回答信封按问题文本组装 `answers`；等待期间的普通消息作为 `response`；3 分钟未答返回空 `answers`；中断或进程结束拒绝）。等待时长可用 `FOUNDRY_CLAUDE_QUESTION_WAIT_MS` 调整（测试用）。
  - `claude-runtime-start.ts`：进程启动时对上述会话安装 `canUseTool`；`active-runtimes.ts` 关闭进程时结束等待。
  - `sdk-messages.ts`：`AskUserQuestion` 调用显示为问题消息（`Response stream` 事件，消息 id 即调用 id，带 `questions`），不再是工具行；`claude-messages.ts` 不为它补“已用工具”行，回合之间的提问也发出。
  - `claude-turn-controls.ts`：steer 到达时先交给等待中的问题（只限本人的、无附件的消息）；被接住的回答不再作为一条用户消息送进 Claude，事件照常记录。
- Server（`httpapi/chat_queue_steer.go`）：带 `questions`、`delivery` 不是 `async` 的消息（即 Claude 在等的提问）也算一步：此后到该会话下一个工具事件或回合结束前，待 boundary 的消息立即送进回合，Worker 再把它交给等待中的问题。Codex 的异步提问不变。
- Web：卡片支持多选（复选框）、选项说明、问题标题上方的 header；`unranked` 时不标“推荐”。转录投影修复：问题条目之后、没有消息 id 的文字快照不再覆盖问题条目（Claude 超时后直接继续写文字时会发生）。回合结束未答时的提示改为“Agent 没等到回答，已先继续”，原文“没有等待”对 Claude 不准确（中英两版）。

## 自验证据

- Worker：`test/claude-questions.test.mjs`（假 SDK 模拟 CLI：有 `canUseTool` 才提问）——问题消息结构、回答结算为 `answers`、回答不重复送入 Claude、其他提示被拒、超时空答案、普通消息成为 `response`、非本人会话没有 `canUseTool`。相关既有测试（steer、SDK runtime、消息、计时器、子 Agent、后台任务等 9 个文件）全部通过。
- Web：`test/agent-questions.test.mjs` 新增 Claude 卡片（header、说明、多选数字键、无隐含推荐、回答拼接）；`test/agent-questions-thread.test.mjs` 新增“问题后文字快照不覆盖问题”，并确认去掉修复时该用例失败。
- Server：`TestChatQueueBoundaryWhileQuestionWaits`（Claude：问题等待时 boundary 消息立即进入，之后工具事件解除；Codex 异步提问不触发）；`TestChatQueue*` 全部通过。
- `scripts/check-changed.sh`（本项文件）：protocol、tsc web、68 个 web 测试文件、88 个 worker 测试文件、go store、audit:ui/contract/openapi/modules 通过；prettier 随后修正并复查。
- scratch 栈端到端（本机，DB 副本，`FOUNDRY_INTEGRATIONS=off`；Server/Web/Worker 来自主工作区构建；合成工作区 `/tmp/dev120-ws`，用后删除）。本机没有 Claude 订阅登录，hell-tw 网关当时返回 503，Limen 需在设备上另行注册，因此用 Anthropic 兼容端点 my-cpa（模型 gemini-3.8-flash-high），同一 Claude Code CLI 2.1.311 / SDK 0.3.317 运行。验证的是 Foundry 的链路（CLI 调 `canUseTool` → Worker 等待 → 卡片 → 回答 → CLI 的工具结果），与模型无关：
  1. 提问：发送 10 s 后卡片出现，header、选项说明、多选复选框与 `unranked` 经 Server 原样到达。键盘选 Bonjour 与 Emoji、Signature，Enter 发送；同秒 “Steered into active turn”、下一次模型请求开始。CLI 原生记录的工具结果：`Your questions have been answered: "Which greeting should README.md get?"="Bonjour", "Which extras would you like to add?"="Emoji, Signature". …`；回答没有另作为用户消息送进 Claude。卡片“已回答”，下方“回答了 Agent 的提问”。
  2. 不回答：04:27:46 提问，04:30:46 工具结果为 CLI 的 `The user did not answer the questions.`，Claude 自选 Hello 并结束；卡片“已按自己的假设继续”并收起。迟到回答 Bonjour 开始新回合，文件改为 Bonjour，卡片“已回答”。
  3. 在输入框回复（修复后）：提问后发“Banana please, it is funnier.”，4 s 后进入，工具结果 `The user responded: Banana please, it is funnier.`，没有重复的用户消息。
  4. 同时跑的 Codex 会话：异步提问仍为 `delivery: async`，卡片标“推荐”。
  5. 截图（本机，不入库）：`.foundry/attachments/20261105/dev120/`，浅色 1280/390 等待、选中、已回答、按假设继续；深色 1280 已回答（迟到）、Codex 展开表单；深色 390 已回答。390 宽无横向滚动。
- 多题卡片的 Enter（追加，2026-11-05 14:3x 本人报告）：在第一题“其他回答”输入框写完按 Enter，后两题按预选项一起发出，本人还没看。原因：卡片只拦截单选/复选上的 Enter，文本框里的 Enter 走了表单的原生提交。改为逐题作答（同 Claude Code 终端）：非最后一题按 Enter 进入下一题（文本框、单选、复选都一样），最后一题按 Enter 才发送，且有没看过的题先跳过去；输入法组字中的 Enter 不处理；“发送回答”按钮照旧整卡发送。多题时提示改为“Enter 进入下一题，最后一题按 Enter 发送”（中英）。单测 `agent-questions.test.mjs` 新增两例（含组字 Enter），原两例改为新流程。scratch 栈真实 Codex 三题卡片：第一题选“其他回答”输入后 Enter，未发送、焦点到第二题；方向键选 Large、Enter 到第三题、Enter 发送，答案为“我自己的答案 / Large / Circle”。截图 `multi-enter-moves-1280.png`、`multi-answered-1280.png`。Web `f7a9c6c97c638ba0`（原 `f0b631808c4fac7f`，回滚 `releases/dev120/previous-20261105T063717Z`），构建自 `foundry-int`。
- 链接（追加）：`test/agent-questions.test.mjs` 新增“问题中的链接在新标签页打开，含中文冒号后的 URL”。空库 scratch 栈真实 Codex：让它用 `request_user_input_async` 问一个带“仓库：https://…”的问题，卡片中 URL 为链接（`href` 完整、`target=_blank`、`rel=noreferrer`），换行保留；点击后新开标签页（Example Domain），聊天页与展开的卡片不变。截图 `link-light-1280.png`、`link-dark-1280.png`。用后栈与合成工作区已删除。
- 未在线上用真实 Claude 模型验证：线上只有本人账号能在聊天里作答，交人工验收。

## 部署

- 2026-11-05 12:4x UTC+8，持 `/tmp/fdy-deploy.lock`，把本项补丁 3-way 应用到 `foundry-int`（基于 `97415a6e` 加其他会话的暂存改动，无冲突），三个与他人共用的文件（`transcript-adapters.ts`、中英 `conversation.ts`）只替换本项的片段。`foundry-int` 的 Worker 源码等于 `6689b6e3`，不含已上线的 DEV-122（Worker 包由其单独构建），因此同时带上 DEV-122 的 5 个 Worker 文件（主工作区的未提交改动，与线上包核对一致），避免回退。在该树上：protocol/worker 构建、7 个 worker 测试文件、web typecheck、5 个 web 测试文件、copy/component-system/native-controls 审计、`TestChatQueue|TestTranscript|TestContract`、`generate-contracts --check` 通过。
- Server：`101be7c0cd0ac603`（原 `7aafb2c26c7df7b9`），SIGHUP 交给 supervisor（pid 3293579），新子进程 551206，`/healthz` 200。回滚：`releases/dev023-candidate/foundry-server.pre-dev120`，换回后 SIGHUP。数据库无结构变化。
- Web：`scripts/deploy-web-dev.sh` 发布 `6ec8d85fc8573af3`（原 `184225cf3ed372be`，保存在 `releases/dev120/previous-20261105T044839Z`），脚本核对入口资源与同源 API 通过。
- Worker：`pnpm pack:worker-release` 发布 `0.5.7-dev.269.g97415a6e.local.1793854123`（版本名取 `foundry-int` 的基线 commit），包内确认含 `claude-questions.js` 与 DEV-122 的改动。原 `release.json` 存于 `worker-packages-rollback/before-dev120/` 与 `release.before-dev120.json`。经 compute 租约在 7 台在线设备后台运行 `foundry-worker update`（macbook 用 `~/.foundry-stacks/dev/bin`），7 台 daemon 均为新版本；执行宿主已切换：CanWendeMac-mini、byte-dev-sg、cottoncpp、limen-canada；byte-dev（旧宿主 `…815663`）、macbook（`…852079`）、sg-chaos（`…815663`、`…226`，含本会话）还有回合在旧宿主上，排空后切换，未强制。
- 部署前磁盘 5.9 GiB：先拆掉本项 scratch 栈腾出约 1 GiB，未清理他人缓存。

## 验收步骤

前提：设备的执行宿主已切到 `…1793854123`（新开的回合即可）。

1. 在任一工作区新建 Claude 聊天（任一 Claude 智能体），发送：“用 AskUserQuestion 问我两个问题：README 的问候语（Hello / Bonjour / Hola），以及要加的附加项（多选：Emoji、Signature）；然后把结果追加到 README。”
   - 预期：出现“Agent 提问”卡片，状态“等待你的回答”；问题上方有短标签，选项下有说明，第二题是复选框；不自动标“推荐”。
2. 用方向键/数字键选择，Enter 发送。
   - 预期：卡片变“已回答”，下方出现“回答了 Agent 的提问”；Claude 立即按所选继续，不再重复问。
3. 再开一个同样的聊天，不回答，等 3 分钟。
   - 预期：Claude 自己选一个继续；回合结束后卡片“已按自己的假设继续”并收起。点“回答”迟到作答，开始新回合并按答案调整。
4. 再开一个，问题出现后不点卡片，直接在输入框打字回复并发送。
   - 预期：几秒内进入，Claude 按你写的继续，不等 3 分钟。
5. 让 Agent 新建子会话或在 Issue 里运行 Claude：不会出现这个工具（只有你自己开的聊天有）。

## 限制与后续

- 飞书发起的会话也是 `source=chat`，同样会拿到这个工具；飞书卡片不能作答，提问会让回合最多停 3 分钟（可在 Web 打开该会话作答）。
- Claude 在回合之外（定时器、后台任务后的自行继续）提问时，没有 Foundry 回合接收 steer，回答在超时后作为下一回合输入送达。
- 原生聊天导入（终端里的 Claude Code 会话）中的 `AskUserQuestion` 仍显示为工具调用。
