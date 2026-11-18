# DEV-295 本人回复丢失：Codex 异步提问的回答被静默丢弃

状态：根因已用代码与 dev 数据确认；修复已通过远端 Worker、Web、Server 检查；补丁 `/tmp/DEV-295.patch`；已部署 dev（2026-11-18）；Agent 代验收（2026-11-18，范围见验收记录）；已合入 main（PR #278）。

## 问题

2026-11-18 dev（e2e-alice）：Codex 帮手 `sess_1794971370673300067`（gpt-6-astra）用 `request_user_input_async` 提问「测试文件叫 a.txt 还是 b.txt？」（03:09:52Z）。助理以 `needs_you hand_over` 转给本人，待办 `pnd_f3e55cef-…` 归本人处理。本人在「等你处理」卡片上回复两次（03:11:41、03:12:03）。

- `chat_queue_items` 两条都是 `state=sent`、`sent_session_id=<帮手>`、`delivery=''`、`maybe_sent=0`。
- 帮手的事件流里没有任何 `Steered into active turn` 事件，`session_inbox` 也没有对应行。
- 帮手一直说「选择仍待确认」，待办在 03:17:42 被 `auto_resolved`（同一秒前后有「Session canceled」），没有 `answer`。

答复被确认「已发送」，却从未进入帮手的回合。

## 调查

### 假设：提问 id 不一致（已排除）

- 待办 `messageId` 为 `01a1eca1-…/call_7aa501bc…`；事件流里提问消息的 id 同样是 `<输入 id>/call_7aa501bc…`，所以运行时的原生 id 是 `call_7aa501bc…`。
- 卡片与待办回复都取 `messageId` 最后一段（`call_7aa…`）。信封里的 `questionItemId` 是 `["request_user_input_async","call_7aa…",0]`，Worker 的 `parseAgentQuestionReply` 解析出的 id 与之一致。
- 所以 id 在三处（Web 卡片、Web 待办回复、Server `nativeQuestionID`）都一致，问题不在 id。

### 真正原因：边界保留（boundary）+ 没有等待中的提问 → 回答被挂起，回合结束时丢弃

1. 网页的「等你处理」回复与问题卡片都以 `steer: true` 入队。Server `enqueueChatMessage` 对 steer 固定使用 `store.DeliveryBoundary`（`chat_queue.go`：「into the running turn at its next step boundary」）。
2. Worker 的 Codex 转向回调（`codex-stream.ts`）先调用 `thread.answerQuestion`（即 `CodexQuestionGate.take`）。`take` 只在 Codex 通过服务器请求（`item/tool/requestUserInput`）**等待**时才接受回答。
3. `request_user_input_async` 是异步提问：契约 `contracts/…` 中 `Questions` 的注释写明「without waiting (Codex request_user_input_async; Delivery is then "async")」，它不挂起回合，因此没有等待中的条目，`take` 返回 false。
4. 回调随后走 `options.delivery === "boundary"` 分支，`CodexBoundaryHold.hold()` 挂起这条消息，并**立即向 Server 确认成功**（`steerChatQueueItem` 收到 nil，把队列项标记为 `sent`）。
5. 挂起的消息只在工具边界（`toolItemTypes` 中的 `item.started` / `item.completed`）或 15 分钟上限时投递。帮手的 `sleep` 步骤不在该类型集合内，所以边界没有打开。
6. 03:17:43 帮手被取消，`boundary.close()` 清空挂起项，**没有任何记录、通知或错误**。事件流里因此没有 steer 事件。

该行为在现有测试中被当作设计断言：`codex-boundary.test.mjs` 原来写着「one held at the turn's end stays undelivered」。

### 其他路径的检查

- 守护进程 → 执行宿主 → host-child → `steerActiveSession`：只是透传，没有吞掉消息；成功确认只可能来自回调返回成功，而挂起分支正是返回成功而不记录的分支。
- Claude：没有边界分支。`steerClaudeTurn` 对非回答消息总是推入输入流（`runtime.input.push`），不存在静默丢弃；回合不在运行时明确报错（`not accepting steer input`），由 Server 作为失败处理。**未改动 Claude**。

## 修复

### (a) 不丢弃：没有打开的提问接受的回答，立即作为普通用户消息投递

- `codex-stream.ts`：回答信封未被任何打开的提问接受时，直接 `applySteer`，不进入边界挂起；并通过 `processLabels.notice` 发出说明「An answer to a question no open prompt holds was delivered as a message.」（这是「为什么」的日志）。
- `codex-boundary.ts`：`close()` 返回回合结束时仍未投递的挂起消息，而不是静默清空。
- `codex-stream.ts`：回合结束时，对每条未投递的挂起消息发出 `Notice`（warning）：「A message held for a tool boundary (<id>) did not enter the turn before it ended, so it was not delivered.」

### (b) 运行时 id 一致

- `packages/protocol/src/agent-question-reply.ts`：新增 `nativeQuestionItemId(messageId)`（取最后一段），作为唯一的 Web 实现。
- `apps/web/src/features/chat/thread/transcript-adapters.ts`（卡片 `questionItemId`，原第 239 行）与 `apps/web/src/features/pending/pending-model.ts`（`pendingReplyText`）改用该函数。
- Server 的 `nativeQuestionID`（Go）与 Worker 的 `nativeItemId` 规则相同，保持不动（跨语言没有共享代码，靠测试钉住）。

### (c) 回答记录（DEV-291）

- 查阅 `pendingReactions.SessionEventRecorded`：`steeredIntoTurn` 事件带信封时，`answerTextOf` 取出答案，发送者为空（本人）时记录 `answeredBy: person`。chat_queue 的 steer 成功后会记录该事件，因此路径相同。现有测试 `TestAnsweredItemKeepsItsAnswerAndWhoGaveIt` 覆盖了这段（事件由测试直接构造）。修复后事件会真正到达，这条路径才会被触发。

## 改动文件与删除行

以下为相对基线（HEAD `e03dfd61` + 共享树当时的未提交改动）的差异，补丁 `/tmp/DEV-295.patch`。

| 文件                                                           | 删除行 | 说明                                       |
| -------------------------------------------------------------- | ------ | ------------------------------------------ |
| `packages/worker/src/session/runner/codex-stream.ts`           | 2      | 回答直接投递；回合结束报告未投递的挂起消息 |
| `packages/worker/src/session/runner/codex-boundary.ts`         | 3      | `close()` 返回未投递消息                   |
| `packages/protocol/src/agent-question-reply.ts`                | 0      | 新增 `nativeQuestionItemId`                |
| `apps/web/src/features/chat/thread/transcript-adapters.ts`     | 1      | 使用 `nativeQuestionItemId`，新增导入      |
| `apps/web/src/features/pending/pending-model.ts`               | 2      | 使用 `nativeQuestionItemId`，导入改为多行  |
| `packages/worker/test/codex-boundary.test.mjs`                 | 2      | 断言 `close()` 返回挂起的 `kept`，标题改写 |
| `packages/worker/test/session-steer.test.mjs`                  | 0      | 新增 2 个回归测试                          |
| `apps/web/test/pending-items.test.mjs`                         | 0      | 新增回复 id 测试与导入                     |
| `apps/server/internal/httpapi/codex_async_question_id_test.go` | 0      | 新文件：运行时 id 与信封一致               |
| `docs/devlog/DEV-295-person-reply-lost.md`                     | 0      | 本文件                                     |

合计删除 10 行、新增 312 行（`git diff --numstat` 为准）。基线为 DEV-293 落地后的共享树（tree `d20d271c`）；补丁对该树 `git apply --check` 通过。

## 检查

基线：HEAD `e03dfd61` + 共享树当时的未提交改动（DEV-293 落地前）。DEV-293 落地后，补丁重新基于新共享树，并重跑了 Web 待办测试与 typecheck。远端运行器 byte-dev（`res_309405e6874f83ccd87c`），日志在 `/tmp/remote-check-*.log`。

- Worker `session-steer.test.mjs`：22/22 通过（含 2 个新测试）。
- Worker `codex-boundary.test.mjs`：6/6 通过。
- Worker `codex-questions.test.mjs`：10/10 通过。
- **红测**：把 `codex-stream.ts` 还原为 HEAD 后，`session-steer` 中两个新测试失败（`not ok 10`、`not ok 11`），其余 20 个通过，证明测试确实复现了问题；修复后恢复通过。
- Web `pending-items.test.mjs`：通过（含新测试「a question's reply names the runtime's call id」）。
- Web `agent-questions-thread.test.mjs`：通过（卡片 `questionItemId` 仍为 `call_7`）。
- Web typecheck：通过。
- Web build（`remote-build --web`）：通过，SHA256SUMS 校验通过。
- Server `go test ./internal/httpapi -run 'Question|Pending|ChatQueue|Answer'`：`ok`（约 62 s）。

## 验收步骤（dev）

1. 在 dev 上部署修复后的 Worker（Codex 运行时），在 e2e-alice 的聊天中启动一个 Codex 会话，让它调用 `request_user_input_async` 提一个带选项的问题（例如「a.txt 还是 b.txt？」）。
2. 助理按既有流程把问题转给本人（待办出现在「等你处理」）。
3. 在问题卡片上选择一个答案并提交。
4. 预期：
   - 几秒内会话事件中出现 `Steered into active turn`，其 detail 为回答信封；
   - 出现 `An answer to a question no open prompt holds was delivered as a message.` 的通知；
   - 会话继续，不再说「选择仍待确认」；
   - 对应待办变为已回复，`answer` 为所选答案，`answeredBy` 为 `person`。
5. 对照组：在待办卡片上回复同一问题，预期结果相同。
6. 若回合在挂起消息投递前结束，预期会话中出现 `A message held for a tool boundary (…) did not enter the turn before it ended` 的通知（不再静默）。

## 限制

- **挂起消息的回合结束丢失仍未根治**：普通（非回答）的边界 steer 若在回合结束前没遇到工具边界，仍不会被投递，队列项已被标记为 `sent`。本次只让它**可见**（通知），没有改为重新排队到下一回合。需要单独的修复：回合结束时把未投递消息交回 Server 重新排队。
- **已由 DEV-295b 修复**：此前回答信封会解决会话内所有开放的可回答待办（不按 id 过滤）。见下节。
- **Claude 未改动**：已审查 `steerClaudeTurn`，非回答消息总是推入输入流，不存在静默丢弃；未新增 Claude 专门测试。
- **与 DEV-293 的衔接**：DEV-293（train 64）落地后，`pending-model.ts` 新增 `pendingReplyRoute`，待办回复路由变化。本补丁已基于落地后的共享树重新生成，`pendingReplyText` 的 question 分支仍走聊天信封，未改为 `/answer`。`pending_items.go` 与 `use-pending-items.ts` 本补丁未改动。
- **未在 dev 上做真实浏览器端到端**：本修复仅在远端测试与构建中验证，验收步骤见上。

## DEV-295b：回答信封只结算它指名的问题

依据：编排器批准（train 66 之后的后续项）。挂起消息的回合结束重排队不在本项内，单独处理。

### 问题

`pendingReactions` 对任何 steer 事件都调用一次 `resolve`，`MessageID` 为空，所以同一会话里所有开放的可回答待办都被同一答案结算。一个回答信封只指名一个问题，其余问题应保持开放。

### 做法

- `httpapi/pending_items.go`：steer 事件带回答信封（可解析）时，按信封中每个条目的 `questionItemId`（JSON 数组第二项）分组，对每个被指名的 item 用 `resolution.MessageID` 单独结算，答案为该 item 的条目答案（按序、换行连接）。无信封或信封无法解析的普通 steer 仍按会话级结算，行为不变。
- 新增 `answersByItem`、`replyItemID`（同文件）。存储层 `MessageID` 过滤已有（按 `messageId` 的最后一段匹配），未改存储。

### 检查

- `go test ./internal/httpapi -run 'Question|Pending|Answer'`（byte-dev）：`ok`，约 54 s。
- 新增 `TestAnswerEnvelopeSettlesOnlyTheItemItNames`（两个开放问题，回答较早者，只结算它，`answer` 为 `Blue`、`answeredBy` 为 `person`，另一问题仍开放）与 `TestPlainSteerAnswersEverySessionQuestion`（普通 steer 结算两个问题）。
- `gofmt -l` 对两个改动文件无输出。
- `go vet ./internal/httpapi`：见本节末尾的记录。

### 限制

- 信封指名的 id 若没有匹配的开放 item，则该答案不结算任何 item（不回退到会话级结算）。这是有意为之：回退会重新引入「一个答案结算所有问题」。正常路径中 id 由同一来源生成，应当匹配。
- 答案按 `questionItemId` 第二项分组；非字符串形式的 `questionItemId` 视为无法解析（当前生成端只产生字符串形式）。

## 2026-11-18 dev 验收记录（Agent 代验收，DEV-295 / 295b）

- sess_1794976754894981930：卡片回复在 1 秒内送达正在运行的帮手；只结掉被指名的那个问题。
