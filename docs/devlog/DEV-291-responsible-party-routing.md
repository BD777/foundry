# DEV-291 责任方路由：一个规则决定谁回答（切片 1，Server）

- 状态：已部署 dev（2026-11-18）；Agent 代验收（2026-11-18，范围见验收记录）；已合入 main（PR #278）。
- 设计：`.foundry/reports/needs-you-redesign.md`（§2 原则 1、§3.3、§3.2 的 `resolve` 行、§4、§6）。
- 现状地图：`.foundry/reports/needs-you-current-state.md`（G1、G4、G6、G8）。

## 问题

「谁来回答」的规则分散在多处：`questionsTo`（子会话问题中转）、`Handler`（待办归属）、频道保留/缺口条目（写死归本人）、`needs_you resolve`（不给帮手答复）。结果是：

- G1：助理停止时，帮手的问题不中转给助理，待办却仍归助理，助理恢复后也看不到。
- G4：没有投递方式（`delivery` 为空）的问题只建本人待办，不转给负责人。
- G6：消息通道的保留/缺口条目直接归本人，绕过助理。
- G8：`needs_you resolve` 把条目标为「助理已回答」，但帮手什么也没收到。

## 改动

### 1. 一个路由函数（`personalagent/assistant/responsibility.go`）

`ResponsibleFor(ctx, session) Responsibility` 沿创建链判断负责方：

| 会话                                  | 负责方        | 待办归属                     | 问题去向                         |
| ------------------------------------- | ------------- | ---------------------------- | -------------------------------- |
| 助理的首页、消息通道会话              | person        | 本人                         | 本人聊天                         |
| 本人自己开的对话                      | person        | 本人                         | 本人聊天                         |
| 助理的帮手（父为助理会话）            | assistant     | 助理                         | 父会话收件箱（助理停止时等恢复） |
| 普通编排会话的子会话                  | session（父） | 本人（不建待办，见「kept」） | 父会话收件箱                     |
| 父已归档或已取消的子会话              | session，无父 | 本人                         | 子会话自己的聊天                 |
| 定时任务、验证、Issue、角色、工具会话 | 无            | 本人                         | 无人回答，提示即刻拒绝           |

`Responsibility.Handler()` 与 `QuestionsTo` 由它派生。`questionsTo` 的旧纯函数与 `Service.Handler` 已删除，`pendingKept`、`SessionEventRecorded`、turn_failed 的待办归属、`helper_stuck` 都改为调用它。
（说明：频道条目不是某个会话的问题，它没有可沿链查询的会话；它按下面第 4 点直接归频道的助理。）

### 2. G1：助理停止时的帮手问题（`httpapi/session_questions.go`）

- 停止的助理：问题不中转，但待办保持 `handler=assistant`，不再归本人。旧的「kept for the person」分支已删除。
- 恢复：`relayHelperQuestionsOnResume` 在两个恢复入口（网页 `handleResumePersonalAgent`、飞书 `personalAgentDesk.Resume`）调用，遍历本助理仍开着的问题待办，找到对应事件（`questionEvent`）后调用 `relayChildQuestion`。
- 「只一次」靠 `InputID` 的确定性 UUID（子会话 + 问题消息）做收件箱去重；「已答/已被取代」靠待办不再是 open、以及 `questionAnswered` 的检查。

### 3. G4：空投递方式（见下面的「G4 调查结论」）

- `relayChildQuestion` 不再要求 `delivery` 为 `next_turn`/`async`：只要是子会话的问题，就转给负责方。
- 待办的 `rule=held` 只给本人聊天里的问题（`pendingItemsFromEvent(..., holdsTurn)`）。助理的帮手问题保持 open，直到被答复。
- 删除了未使用的 `questionWaits`。

### 4. G6：频道保留/缺口条目（`httpapi/message_channels.go`）

`tellAboutMessageChannel` 的 `handler` 改为 `assistant`（频道的助理）。只有助理已停止时才归本人，因为停止的助理无法处理，只能由本人恢复它。

### 5. G8：`needs_you resolve`（`httpapi/mcp_needs_you.go`、`mcp_tools.json`）

- 等待答复的条目（开着的问题/审批）：必须给 `answer` 或 `reason`。二者同时给被拒绝；都不给被拒绝（报「the helper waits for an answer」）。
- `answer`：走 `sendMessageForMCP`，与 `send_message` 的答复完全相同（包括 `answerWaitingQuestion` 包装）。
- `reason`：走 `sendInboxMessageForMCP`，作为普通消息发给帮手，内容是「问题 %q 得不到答复：%s。」。不走答复信封，以免被当成答复。
- 没人在等的条目：可以直接 resolve。
- `mcp_tools.json` 只改了 `needs_you` 的 `resolve` 描述，并新增 `answer`、`reason` 两个参数。

### 6. 答复记录（负责人的答复留痕）

按负责人给的补充要求：已答条目在 payload 里记录 `answer`（实际投递的答复文本，去掉首尾空白，截到 1000 个字符）和 `answeredBy`（`assistant` 或 `person`）。无需迁移（`payload_json`）。

- `store.PendingItem` 新增 `Answer`、`AnsweredBy`；`store.PendingAnswer{Text, By}` 作为 `ResolvePendingItem` 的参数，`PendingResolution.Answer` 作为 `ResolvePendingItems` 的参数。
- 写入点：帮手答复的 `Queued` 事件（助理的 `send_message`，由 `answerTextOf` 去掉答复信封）、本人在聊天里的 `Queued`/`Steered` 答复、`resolve` 带 `answer` 的场合。
- `answerTextOf`：信封（`agentQuestionReplyOpen` 块）里的 `answer` 合并成文本；没有信封则返回原文。

## G4 调查结论

- Worker 对 `delivery` 的赋值只有两处：`claude-questions.ts`（`shown()`，只在 `to === "parent"` 时设 `next_turn`）与 `codex-questions.ts:586`（relay 时设 `next_turn`）。`sdk-messages.ts:780` 只在 `item.delivery === "async"` 时保留 `async`。
- 因此空投递方式来自：(a) 本人聊天里的问题（`to === "person"`，按设计 `held`）；(b) 运行时没有提问门（`runtime.questions` 缺失，`claude-messages.ts:431` 与 `:698` 的 `?.`/`&&` 不做标记），此时问题仍显示但立即被拒绝，不会等待；(c) `codex-app-server.ts:1492` 的 commentary 问题只在 `async` 时带标签。
- 我没有找到一条 `to === "parent"` 的运行时路径会产生空 `delivery` 且真的在等待答复。所以 Worker 没有需要修的「错误标签」。服务端对所有子会话问题统一处理（上面第 3 点），不依赖 Worker 的标签。
- 限制：(b) 的情形需要运行日志确认（服务端的 `session question kept in its chat` 与 `kept for the stopped assistant` 日志可用来判断）。

## 检查

在 byte-dev（`res_309405e6874f83ccd87c`，`scripts/remote-check.sh`，共享租约）上：

- `go test ./internal/personalagent/assistant -run 'TestResponsibleFor|TestNeedsYou|TestHelper|TestStuck|TestRecordHelperStuck'`：ok。
- `go test ./internal/httpapi -run 'TestHelperQuestionOnStoppedAssistant|TestQuestionWithoutDelivery|TestNeedsYou|TestMessageChannelItemGoes|TestPendingItemsHeldByTurn|TestPending|TestMessageChannel|TestChildQuestion|TestAsyncChildQuestion|TestAsyncHelperQuestion|TestRelayedApproval|TestAnsweredItem|TestAnswerTextOf'`：ok（36s）。
- `go test ./internal/httpapi -run 'TestMCP|TestPersonalAgentMCP|TestNeedsYou|TestAnsweredItem|TestAnswerTextOf'`：ok（17s）。
- `go test ./internal/sqlitestore -run 'Pending'`：ok。
- `go test ./internal/personalagent/prompt`：ok。
- `go vet ./internal/httpapi ./internal/sqlitestore ./internal/store ./internal/personalagent/assistant`：通过。
- `node scripts/audit-module-boundaries.mjs`：通过（0 个追踪违规，73 个 store.Store 方法）。

未运行：Worker 测试（本切片未改 Worker）；`generate-contracts --check`（未改契约）；全包测试。

说明：`pnpm audit:modules` 在符号链接的 node_modules 下会触发 `pnpm install` 清理并中止，因此直接运行了脚本。

## 验收（dev，e2e-alice）

1. 助理停止后，让它的帮手提问：助理的「在处理」里出现该问题；本人列表不出现。
2. 恢复助理：助理收件箱收到一条「Foundry question」，且只有一条。
3. 助理用 `needs_you resolve`（不带 answer/reason）处理等待答复的条目：被拒绝。带 `reason`：帮手收到「gets no answer」消息。带 `answer`：帮手收到答复，条目显示 `answeredBy=assistant`、`answer` 为该文本。
4. 本人在自己的聊天里回答：条目显示 `answeredBy=person`，`answer` 为其文本。
5. 消息通道的保留条目：归助理（待办 handler=assistant）；助理停止时归本人。

## 限制

- 频道条目不沿创建链查询；它直接归频道的助理，停止时归本人。
- 「答复记录」的 `answer` 对同一会话的多条待办写入同一文本（一次答复对应该会话所有待答问题，与现有的会话级结算一致）。
- `waitingQuestion` 仍只看最新的等待问题（用于 `send_message` 的答复包装），与旧行为一致。
- 恢复时只查最近 200 条事件，超出窗口的旧问题不会被再次中转。
- 切片 1 不含：`needs_you ask`、提示词/system.md、网页、飞书。

## DEV-291b（跟进）

- **G6 一致性**：频道的保留/缺口条目一律归频道的助理，包括助理停止的时候。只有助理自己的故障（收件箱条目失败、无法运行）归本人。`tellAboutMessageChannel` 不再因停止而改归本人。
- **告诉助理**：频道条目没有会话，`NotifyPendingItem` 现在为它找频道最近活跃的会话（`MessageChannelSessions` 按 `ActivityAt` 取最新、未归档者），用 `NoticeKindChannelItem` 经既有的通知队列（`notices.add` → `tell`）发送。开启时由既有的 10 秒巡检发出一次（`NotifiedAt` 去重，重复轮询不会重复通知）。恢复时，已通知过且仍开着的条目再通知一次；尚未通知的留给巡检。
- **指向具体事项的答复**：`resolve` 带 `itemId` 与 `answer` 时，答复信封针对该事项的问题（`answerToItem`），不再针对帮手最新的等待问题。`send_message` 的行为不变。
- **未完成（需要网页配合）**：「等你处理」页的回复（`use-pending-items.ts` → `pendingReplyText`）发的是引用文本加普通文字（`steer: true`），不是答复信封，服务端无法得知它针对哪一条。要让本人对旧事项的回复也指向该事项，网页应改为对问题类事项发送 `agentQuestionReplyText(item.messageId, item.title, reply)`。这属于 DEV-292 的网页范围，本切片未改。

### DEV-291b 检查

- `go test ./internal/personalagent/assistant -run 'TestResponsibleFor|TestNeedsYou|TestHelper|TestStuck|TestRecordHelperStuck'`：ok。
- `go test ./internal/httpapi -run 'TestChannelItem|TestAnswerToAnItem|TestMessageChannelItemStays|…（DEV-291 的集合）'`：ok（41s）。
- `go vet ./internal/httpapi ./internal/personalagent/assistant ./internal/store`：通过。

## DEV-291c：live 验证后的四处修正

- 状态：已部署 dev（2026-11-18）；Agent 代验收（2026-11-18，范围见验收记录）；已合入 main（PR #278）。来源：2026-11-18 在 e2e-alice 上对「谁来回答」重设计的 dev 验证（场景 2 与场景 1 的审批展示）。

### 问题

1. **仅给理由的关闭被标为「助理替你决定」**。`resolveNeedsYou` 对所有关闭都写 `assistant_answered`，`reason` 路径没有答复，卡片却显示「助理替你决定」且无文字（G8 误标仍在）。
2. **理由送达太晚**。`reason` 以 `boundary` 投递的普通收件箱消息发出；Codex 帮手在 `clock.sleep` 步骤中等待，从不经过边界，直到回合结束才拿到理由。Claude 帮手在有开着的 AskUserQuestion/审批时，`reason` 会被当作空答复结算（允许且答案为空）。另外，Claude 的 `steerClaudeTurn` 对带 `sentBySessionId` 的答复信封不结算开着的提示（Codex 已用 `answersQuestion` 修正）。
3. **过期的 `helper_question` 通知**。助理在条目已答复或关闭后 30–40 秒才收到通知：通知先进入合并队列（`notices.add`），发送时不再检查条目是否仍开着。
4. **审批卡片看不到被批准的内容**。Worker 在审批问题上带了 `detail`（命令或改动的 Markdown），但 `pendingItemsFromEvent` 没有保存，列表只剩「Allow this command?」和「Approve」。

### 调查

- 答复信封（`<send_user_message_question_reply>`）由 Worker 的 `codex-stream.ts` 视为答复，`answersQuestion` 为真时无论投递方式都立即 `applySteer`（DEV-295）；`reason` 不是信封，因此走边界。
- Claude 的 `steerClaudeTurn` 的 `answered` 条件含 `!sentBySessionId`，助理发出的答复无法结算开着的 AskUserQuestion。
- `notices` 按会话合并（`CoalesceNotices`），队列中的行只记录文本，`flush` 时不检查条目状态；`maintainNeedsYou` 在 `NotifyPendingItem` 入队时即调用 `MarkPendingItemNotified`（既有行为，见「限制」）。
- `question.Detail` 对审批有值（`AgentQuestion.detail`，Worker 的 `commandApproval` 等构造），`pendingItemsFromEvent` 只复制了 `Approval`。

### 改动

1. **outcome 与理由**：`store.PendingOutcomeAssistantClosed = "assistant_closed"`；`store.PendingItem` 新增 `closeReason`（≤1000 字符）；`store.ClosePendingItem(ctx, user, id, reason)` 经共享的 `resolvePendingItem` 写入。`resolveNeedsYou` 有 `answer` 时仍为 `assistant_answered`；否则（含仅理由、裸关闭）为 `assistant_closed`。`ResolvePendingItem` 的签名不变（13 个调用点）。
2. **理由作为无答复的答复**：新增 Go `agentQuestionNoAnswerText(reason, questions)`，产生与答复信封相同外形的条目，每个等待中的问题一条，带 `"noAnswer":true` 与 `"reason"`。`resolveNeedsYou` 的 `reason` 路径经 `sendMessageForMCP` 发送（与答复同路径，信封不被 `answerWaitingQuestion` 改写）。Worker 侧（`packages/protocol`、`codex-questions.ts`、`claude-questions.ts`、`claude-turn-controls.ts`）：无答复条目结算开着的提示（Codex 为 decline，Claude 为 deny），且不算作已接收，理由仍以消息进入回合；Claude 的答复信封不再因 `sentBySessionId` 被挡在提示之外。
3. **过期通知**：`notices` 的行带 `key`（条目 id）与 `due`（发送时仍开着才发）。`addLine` 入队时检查一次，`flush` 发送前再检查；同一 `key` 的待发行替换而非重复。`NotifyPendingItem` 与 `notifyChannelItem` 使用 `addLine` 与 `stillOpen`。`add` 签名不变。
4. **审批详情**：`store.PendingItem.Detail`（≤1200 字符，取自 `question.Detail`，仅审批）在 `pendingItemsFromEvent` 创建时保存。网页在开着与已解决的卡片中以等宽、截断的块显示（去掉 ``` 围栏行）。

### 检查

在 CanWendeMac-mini（共享租约）上：

- `go test ./internal/httpapi -run 'NeedsYou|Resolve|Pending|Question|Notice|Approval|Responsibilit|NoAnswer|Bare|Answered'`：ok（23s）。
- `go test ./internal/personalagent/assistant -run 'Notices|Responsib|Helper|Stuck'`：ok。
- `go test ./internal/sqlitestore -run 'Pending'`：ok。
- `go vet ./internal/httpapi ./internal/sqlitestore ./internal/store ./internal/personalagent/assistant`：通过。
- `node scripts/audit-module-boundaries.mjs`：通过（0 个追踪违规，73 个 store.Store 方法）。
- `gofmt -l`（改动的 Go 文件）：通过。

Worker（共享租约在 byte-dev 上运行，Mac 沙箱拦截 `ps`，见下）：`session-steer`、`codex-boundary`、`codex-questions`、`claude-questions` 共 54 个测试通过；`--worker build` 通过。

Web：`--web test test/pending-items.test.mjs test/assistant-side-card.test.mjs` 通过；`--web typecheck` 通过；`audit:ui` 通过；`pnpm --filter @foundry/web build` 通过；`prettier --check` 通过。

### 测试

- Server：`TestNeedsYouBareResolveIsClosedNotAnswered`（裸关闭为 `assistant_closed`，不发消息）；`TestNeedsYouResolveAnswersOrGivesTheReasonToAWaitingHelper`（扩展：理由作为无答复信封发送，结果为 `assistant_closed` 且 `closeReason` 正确；答复仍为 `assistant_answered`）；`TestAgentQuestionNoAnswerTextNamesEachQuestionAndTheReason`；`TestApprovalKeepsWhatItAsksAbout`；`TestAssistantNoticesSkipItemsClosedWhileTheyWait`（过期行不发，同一 key 只发一次）。
- Worker：`session-steer` 中无答复信封在边界投递下立即进入回合；`codex-questions` 中无答复 decline 且不算已接收；`claude-questions` 中无答复 deny、答复信封在 `sentBySessionId` 时仍结算提示。
- Web：`assistant_closed` 显示「助理已关闭：理由」且不显示「助理替你决定」；无理由时仅「助理已关闭」；审批详情在开着与已解决的卡片中显示命令（无围栏行）；无详情的审批不变。

### 限制

- 过期通知的回归测试只在 `notices` 单元层面（`assistant` 包）。`httpapi` 层的集成测试被删除：`maintainNeedsYou` 在入队时即标记 `NotifiedAt`（既有行为），而测试夹具的 `tell` 失败，无法观察是否真的发送。
- `maintainNeedsYou` 在入队时标记 `NotifiedAt`，因此被丢弃的过期行仍显示为已通知。对用户不可见，但字段语义与 `NotifiedAt` 的注释不符；需要另立条目修正。
- 没有在真实 Codex 或真实 Claude 上验证；Worker 测试使用假的 app-server 与假的 SDK。
- `codex-stream.ts` 在 `take` 返回 false 的信封上记录「An answer to a question no open prompt holds was delivered as a message」，无答复信封即使已结算提示也会触发这条日志（误导，未改）。
- Claude 路径中未被接收的无答复信封仍带 `sentBySessionId` 前缀；Codex 路径已去掉。未对齐。
- Mac 沙箱下 Worker 测试因 `ps` 失败（与本改动无关，见 Worker 的检查说明）。
- 网页未在真实浏览器中检查（截断、等宽换行、深色主题）。详情中的行内反引号被去掉。
- 「已解决」标签与设计稿「已处理」的差异未改（验证报告中的次要项）。

### 验收（dev，e2e-alice）

1. 助理用 `needs_you resolve reason=…` 关闭一个等待中的帮手问题：已解决卡片显示「助理已关闭：…」，不显示「助理替你决定」。
2. 同一帮手（Codex，`clock.sleep` 循环）在几秒内收到无答复信封，并回复理由相关的内容，而不是等回合结束。
3. 只给 `resolve`（不带理由）关闭非等待条目：显示「助理已关闭」，不显示「助理替你决定」。
4. 审批条目（如 `approval_exec`）在开着与已解决的卡片中显示命令（等宽，可展开）。
5. 助理对已答复的问题，不再收到 `helper_question` 通知（留意 30–40 秒的窗口）。

## 2026-11-18 dev 验收记录（Agent 代验收，train 58–89）

- DEV-291 / 291b（e2e-alice，sess_1794970080647742570）：帮手的提问交给助理，助理作答；项的状态为 `assistant_answered` 并附答复；「已解决」显示「助理替你决定」。停止的助理在恢复时只收到一次被挂起的提问。
- DEV-291c（sess_1794991264014047343）：带理由关闭得到 `assistant_closed`，`closeReason` 为「不再需要」；帮手在其轮次结束前约 5 秒收到它；卡片显示「助理已关闭：不再需要」。审批卡片显示命令；无过期通知。
