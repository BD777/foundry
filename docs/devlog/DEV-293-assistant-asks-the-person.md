# DEV-293 助理向本人提问：`needs_you ask`，答复回到发问的会话（切片 2+3）

- 状态：已部署 dev（2026-11-18）；Agent 代验收（2026-11-18，范围见验收记录）；已合入 main（PR #278）。切片 1（责任方路由）见 [DEV-291](DEV-291-responsible-party-routing.md)。
- 设计：`.foundry/reports/needs-you-redesign.md`（§2、§3.2 的 `needs_you ask` 行、§3.4、§4、§6）。
- 文档：`docs/assistant-orchestration.md` §h「提问（DEV-293）」，`docs/personal-agent.md` §12 与工具表。

## 问题

助理没有「需要本人回答」的路径。`tell` 不回答，`hand_over` 只能转交已有的项或帮手在正文里提的问题，助理要问本人只能在聊天里问（本人可能没在看），或用会卡住助理的原生提问卡片（G2）。

## 改动

### 1. `needs_you op=ask`（`httpapi/assistant_questions.go`，`mcp_needs_you.go`）

- 参数：`question`（一句话，必填，至多 600 字）、`options`（可选，2–4 个，每个 1–80 字）、`sessionId`（默认当前会话）。不接受 `itemId`。
- 只能用于助理自己的会话（首页、消息通道），与 `tell` 同一范围；帮手和其他会话被拒绝（403）。
- 立即返回 `{"asked": …}`，助理不等待。

### 2. 条目（`pending_items`，来源 `assistant_question`）

| 字段                | 值                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `source`            | `assistant_question`（`store.PendingSourceAssistantQuestion`）                                             |
| `handler`           | `person`（`handledBy` 为本人）                                                                             |
| `assistantId`       | 发问的助理                                                                                                 |
| `sessionId`         | 发问的会话（首页或消息通道会话）                                                                           |
| `title` / `excerpt` | 问题（标题取首行；摘录即问题本身）                                                                         |
| `options`           | 选项                                                                                                       |
| `key`               | `flow.Key("assistant_question", 用户, 会话, 问题)`：同一会话的同一未结问题只保留一项（`occurrences` 累加） |

### 3. 答复：`POST /api/pending-items/{id}/answer`（正文 `{text}`）

本人答复条目的唯一入口（DEV-294 的其他渠道也会走它）。只限本人（`personOnly`），带 `Idempotency-Key`：同一键、同一正文的重复请求回放第一次的结果；同一键不同正文返回 409（幂等层的冲突）。

- 条目不是未结的：409（`this item is already <state>`）。条目不存在：404。正文为空：400。
- `assistant_question`：答复经收件箱送到发问的会话，然后条目记为 `state=done`、`outcome=person_answered`、`answer`（去首尾空白后的答复原文）、`answeredBy=person`，响应是条目本身（200）。
- 其他种类：409「answer this item in its conversation」，本切片不接。它们的答复路径本来就在各自的会话里（问题走会话的队列，连接器写入走 `decide`，等等），复用它们需要各自改造，本切片不做。
- 答复的投递细节：
  - 消息：`personalagent.AnswerFrame(标题, 答复)`，即 `[Foundry] the person answered your question "问题".` 加 `\nTheir answer:\n` 加答复原文。框架部分是 Foundry 的，分隔行之后是本人的原话。
  - 收件箱：`requestedDelivery=boundary`，`inputSource = {kind: foundry_notice, noticeKind: question_answer}`。空闲时开始一轮，运行中在下一个边界送达，离线时排队。
  - 收件箱的发送方是发问的会话本身。收件箱只接受会话发来的消息，服务器发出的答复没有别的发送方。`sentBySessionId` 因此指向会话自己；`inputSource` 说明它是本人答复的转达。之所以不用 `sessionService.Send`：它同步等待设备，设备离线时返回 504，而输入可能已经入队，重试会投递两次。
  - 收件箱 id 由条目 id 确定（UUID5），即使重试也不会投递两次。
- 这条答复的输入不结算该会话里本人自己的其他问题（`pendingReactions` 的 Queued 与 Steered 分支跳过 `question_answer` 来源）。

### 4. 本人的原话（`personalagent/memory.go`，`assistant/memory.go`）

答复是本人写的，所以记忆把它当作本人的原话，框架不算。

- `PersonWords`：`foundry_notice` 且 `noticeKind=question_answer` 的输入，返回分隔行之后的答复原文；没有分隔行或答复为空则不算。其他服务器通知仍不算本人的话。
- 助理的 `personSaid`（逐条取本人的话）原来不把 `inputSource` 传给 `PersonWords`，只用 `TimerFire` 与 `SentBySessionID` 判断，所以它会把这类输入当成不是本人的。现在两个分支都从事件的 metadata 取 `inputSource`。对已有的来源（`person`、`channel`、其他通知）结果不变。
- 测试：`personalagent/memory_answer_test.go`。

### 4a. 答复不与其他消息合并（DEV-293b，`sessions/inbox.go`）

收件箱在会话空闲时，把所有到期的消息合成一轮（`mergedInboxInput`）。答复是本人的原话，不能进合并的一轮，否则来源变成 `session`，记忆也不再把它当作本人的话。`turnBatch` 改为：到期消息里有答复时，这一轮只带这一条答复；其余消息留到下一次检查，答复的那一轮结束后各自成轮。答复的输入保持 `foundry_notice` / `question_answer` 来源。测试：`httpapi/session_inbox_answer_test.go`（同一个答复与另一条被扣留的消息，产生两个输入；答复保留来源）。负面对照：去掉这一分支后，测试失败，答复被合并进「Foundry held 2 messages …」。

### 5. 撤回（`needs_you resolve` 带 `itemId`）

- 只对自己的未结问题：只给 `resolve`（不带 `answer`/`reason`），条目记为 `state=done`、`outcome=withdrawn`，不投递任何消息。
- 带 `answer`/`reason` 或用 `hand_over`，被拒绝（400）；已答或已撤回的，返回 409。

### 6. 契约（`contracts/models/pending_items.yaml`）

新增 `PendingItemAnswerInput { text }`。生成物：`packages/protocol/src/contract.gen.ts`（+6 行，TS 类型）、`packages/protocol/src/contract-schema.json` 与 `apps/server/internal/store/contract-schema.json`（各 +10 行）、`apps/server/internal/store/pending_items_gen.go`（新，Go 模型）。生成器在带 git 的临时副本里运行（基准提交不含本模型），oasdiff 结论：「no breaking changes to 14 x-stored schemas against HEAD」。本模型没有 `x-stored`。

### 7. 提示词（`personalagent/prompt/system.md`，版本 `2026-11-17.2`）

编辑现有句子（见上一版），本次没有改动：「Only the person's answer to a question you asked (needs_you ask) is their decision: act on it.」。`agentsFileBudget` 为 9500（见上）。

### 8. 工具说明（`httpapi/mcp_tools.json`，`needs_you`）

增加 `ask`（枚举值、`question`、`options`），说明「不阻塞，答复以一条消息回到本会话」；`resolve` 的说明写清单独使用时撤回自己的问题。

### 9. 网页（`apps/web`）

- `api/pending.ts`：`answerPendingItem(id, text, idempotencyKey)`，`PendingOutcome` 增加 `withdrawn`，`PendingSource` 增加 `assistant_question`。
- `features/pending/pending-model.ts`：`pendingReplyRoute(item)` 返回 `issue` / `answer` / `chat` / `none`；`pendingStatusKey(item)` 对撤回的问题返回 `outcome.withdrawn`，其余返回 `state.<state>`。
- `features/pending/use-pending-items.ts`：`reply` 按 `pendingReplyRoute` 分派。`answer` 路由调用新接口（`crypto.randomUUID()` 作幂等键）；`chat` 路由仍是原来的队列请求，`pendingReplyText` 只用于它。
- `features/pending/pending-item-card.tsx`：已解决时的状态文字用 `pendingStatusKey`（撤回的显示「已撤回」/「Withdrawn」）；`assistant_question` 的图标。选项按钮原样调用 `reply`，所以选项也走新接口。
- 国际化：`outcome.withdrawn`，`source.assistant_question`（中英）。
- 测试：`test/pending-items.test.mjs` 增加两项。路由与状态键的单元检查；助理的问题的选项按钮 POST 到 `/api/pending-items/{id}/answer`，正文为 `{text}`，且没有发到会话里。

## 网页与其他客户端

- 网页：`assistant_question` 的回复（选项或回复框）调用 `POST /api/pending-items/{id}/answer`，正文 `{text}`，带 `Idempotency-Key`。其他种类的回复不变。
- DEV-292b：问题条目的回复不要复用 `pendingReplyText` 去发到会话的队列，那是 `question` 的路径；`assistant_question` 必须走新接口。
- 飞书或其他渠道（DEV-294）：用同一接口，`text` 为本人的答复原文。

## 检查

在 `CanWendeMac-mini`（`res_c5f59206bda2897c47c7`，共享租约）上运行。Mac 在线，所以用它而不是 byte-dev（按 runner 顺序）。

- `go test ./internal/httpapi -run 'TestAssistantAsk|TestHelperCannotAsk|TestAnswerToAnAssistantQuestion|TestAnswerRefuses|TestAssistantWithdraws|TestNeedsYou|TestPending|TestMCP|TestAnswerTextOf|TestAnsweredItem|TestChildQuestion|TestHelperQuestion|TestQuestionWithout|TestMessageChannel|TestPersonalAgentMCP|TestAsyncHelperQuestion|TestRelayedApproval|Coverage|Auth'`：`ok  …/internal/httpapi  22.008s`。
- `go test ./internal/personalagent/...`：ok（`personalagent`、`assistant`、`flow`、`knowledge`、`prompt`）。
- `go test ./internal/sqlitestore -run Pending`：ok。
- `go vet ./internal/httpapi ./internal/store ./internal/sqlitestore ./internal/personalagent/...`：通过。
- `node scripts/audit-module-boundaries.mjs`：`Module boundary audit passed with 0 tracked violations and 73 store.Store methods.`
- 契约：`generate-contracts --check --base HEAD`：「no breaking changes to 14 x-stored schemas against HEAD」，`CONTRACTS_CHECK_OK`。生成物与契约一致。
- 网页：`typecheck` 通过；`test/pending-items.test.mjs` 与 `test/assistant-side-card.test.mjs`：41 个测试，40 通过，0 失败，1 跳过；`pnpm build`（protocol 先构建）通过。
- 本机 `go test ./internal/personalagent/prompt`：ok（版本摘要、AGENTS 预算、golden）。

自测中发现并修复：引入路径错误（`flow` 在 `personalagent/flow`）；收件箱需要发送方（改为会话自身）；`ResolvePendingItem` 不接受 `replied`（答复后的状态改为 `done`）；测试断言误把 `done` 条目当作未结；幂等的回放测试发送了不同的正文（正确地返回 409，测试已改）；`pendingStatusKey` 的类型过宽，`t()` 无法接受（改为收窄的模板字面量类型）。

## 验收（dev，e2e-alice）

1. 助理在首页提问（`needs_you ask`，带两个选项）：本人列表出现一条「助理的提问」，`handler=person`，同一问题再提一次只有一条。
2. 本人在网页该条目点选项，或在回复框答复：条目显示已处理，`answeredBy=person`，`answer` 为答复原文；首页会话收到一条 `[Foundry]` 的「the person answered your question …」，空闲时开始一轮，框架之后是本人的原话。
3. 助理用 `needs_you resolve`（只带 `itemId`）撤回未答的问题：条目显示「已撤回」，不产生消息。
4. 消息通道会话里同样提问，答复回到该通道会话。（未在 dev 上验证，见限制。）

## 限制

- 只有网页（选项或回复框）和 `POST /api/pending-items/{id}/answer` 能回答。飞书等其他渠道未接入（DEV-294）。
- 未在 dev 上做端到端验证。消息通道会话的答复路径与首页相同，但没有测试覆盖。
- 助理的家电脑离线时，答复排队，设备回来后送达；条目在送入收件箱时即已回答。
- 助理停止时，答复仍会送到发问的会话，但那一轮不会开始，直到恢复。
- 同一会话多条未结问题时，每条答复只对应它自己（条目 id 决定投递 id）。
- 网页尚未显示助理的问题的完整上下文（选项以外）；本切片只改了回复路由与状态文字。

## 2026-11-18 dev 验收记录（Agent 代验收，train 64–67）

- DEV-293 / 293b（sess_1794976754894981930）：助理发出带选项按钮的提问；本人点击按钮作答，项记为 `person_answered`，`answeredBy=person`；答复作为独立一轮。
