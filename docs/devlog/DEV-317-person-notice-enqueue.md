# DEV-317 助理交给你的问题没有通知：无卡片交接绕过通知队列，通知去处按助理解析

状态：已修复并通过远端定向测试；已部署 dev（仅 Server，train 99，Server 880685f29d68）；部分由 Agent 代验收，具体范围与证据尚未记入本文件；待本人验收。

## 问题

2026-11-19 05:19:42Z，OpenLark 频道会话 `sess_1795058295835254279` 里一个帮手的问题被助理用 `needs_you op hand_over` 交给本人（哪一批 AutoRun 重跑）。生成的待处理项 `pnd_84982b79-93c0-4a34-af36-3e009667b3d3` 为 open，`notified_at` 为空；`person_notices` 表在 dev 上从未有过行。本人没收到卡片，只看到频道里没有 AI 回复。

## 调查（只读）

1. **设置是否保存**：保存了，但在另一个助理上。
   - 本人有两个助理（`assistants`，owner `user_598c0c16…`）：
     - `asst_abe30eaf728ffeab…`：`is_default=1`，`notify.sinks = [{connectorInstanceId: "builtin:feishu", kinds: [question, approval, hand_over, ask]}]`，2026-11-18T13:21:13Z 保存。
     - `asst_fe7f432bb78f4207…`（ByteWork）：`is_default=0`，`settings_json` 里没有 `notify` 键。
   - 简报里说 `asst_fe7f` 是默认助理，与库不符。
   - 该频道会话（`message_channel_sessions`）和待处理项都属于 `asst_fe7f`。
2. **`savePendingItem` 与 `EnqueueNotice`**：`savePendingItem` 只把关闭项的通知标为 superseded，从不入队。入队只发生在 `queueItemNotice`，经 `recordPendingItem`（`store.RecordPendingItem` + `noticeAboutItem`）或 `handPendingItem` 调用。
   - 这个待处理项的键是 `handover:<helper>:<input>`，只由 `mcp_needs_you.go` 无卡片分支写入。该分支直接调用 `s.store.RecordPendingItem`，绕过了 `recordPendingItem`，因此从不调用 `queueItemNotice`。
   - 即使调用了，`personNoticeKind` 对 `question` 来源还要求 `MessageID != ""`；无卡片项没有 `messageId`，也不会得到通知。
   - 同一路径的较早一项（03:22Z，已 done）同样没有 `MessageID`、没有通知。
3. **日志**：`~/.pm2/logs/foundry-server-error.log` 中 2026-11-18 至 11-19 没有 `person notice` / `notice` 相关行（11-19 00:10–00:30 窗口里只有慢请求）。`queueItemNotice` 在无 sink、无种类时直接返回、不记日志，所以没有日志是符合代码的。
4. **默认助理**（`asst_abe30`）自 13:21Z 保存设置后没有新建任何待处理项，因此没有机会入队。

## 根因

- **代码（本项直接原因）**：无卡片交接分支绕过了通知队列；且通知种类的判定要求 `MessageID`，无卡片问题即使入队也会被丢弃。
- **配置**：通知设置存在于默认助理上，而问题属于 ByteWork。`queueItemNotice` 只读问题所属助理的 sink，为空即静默返回。
- 13:21Z 的测试卡片按 DEV-300 设计不带 `ItemID`、不写 `person_notices`，不是这次漏发的原因。

## 修复

1. **无卡片交接（上一版）**：`mcp_needs_you.go` 无卡片分支改为调用 `handOverWithoutCard`，经 `store.RecordPendingItem` 写入，并在 `changed` 时调用 `queueItemNotice`。`personNoticeKind` 对「已交接、无 `MessageID`」的问题给出 `hand_over`。
2. **通知去处按人解析（本次）**：`queueItemNotice` 经新函数 `noticeSinksOf` 取 sink：
   - 问题所属助理有自己的 `notify.sinks`，用它们；
   - 否则用本人默认助理的 sinks；
   - 两者都没有，或没有默认助理，则跳过并记日志。
   - 通知的 `AssistantID` 取 sink 所属助理（`personnotice.Route.AssistantID`，空则仍取问题的助理）。原因：内置飞书 sink 按 `notice.AssistantID` 找配对私聊并发卡片；sink 属于默认助理，所以通知必须经默认助理的私聊发出。
   - 内置飞书的 `noticeTargetOf` 改为查 sink 所属助理的私聊。
3. **跳过日志**：`person notice for item <id> skipped: <原因>`，原因为下列之一，不含内容：
   - `the item has no assistant`
   - `its assistant cannot be read: …` / `its assistant belongs to another person`
   - `neither its assistant nor the default assistant has notify sinks`
   - `its assistant has no notify sinks and the person has no default assistant`
   - `no notify sink takes kind <kind>`
4. **无卡片交接的通知只读（决定 2）**：`canAnswerFromNotice` 对无 `MessageID` 的问题给 `AllowFreeText=false`，回复经助理收件箱，由助理用 `needs_you resolve` 结算。已接受，记入此处。
5. **频道会话的回答退回收件箱（决定 3）**：既有行为，不改。`answerQuestionInChat` 拒绝频道会话（「the chat takes input only from its channel」），回复回到收件箱。

## 测试

- `TestNoticeUsesTheItemsAssistantsOwnSinks`（新）：问题所属助理有自己的 sink 时，用它的 sink，通知的助理是它自己。
- `TestNoticeFallsBackToTheDefaultAssistantsSinks`（新）：所属助理没有 sink，用默认助理的 sink，通知的助理是默认助理。
- `TestNoticeSkippedForAReasonIsLoggedWithoutContent`（新）：无助理、两者都无 sink、所属助理的 sink 不含该种类三种情况，各记一行带原因的日志；日志不含问题内容；不入队。
- `TestHandOverWithoutCardIsNoticedAndTakesNoReply`（新）：频道会话的帮手与首页会话的无卡片交接，都入队 `hand_over`，`AllowFreeText=false`，回复不被消费，问题仍 open。
- `TestAskingItemsOfHomeAndChannelChatsAreNoticed`（新）：首页与频道会话的 `question`、`ask`、已交接 `hand_over` 都入队，并按 sink 的种类过滤，允许回复。
- `TestPersonNoticeKindFollowsWhatTheItemAsks`：新增「无 `MessageID` 的已交接问题 → hand_over」。
- 既有：`TestAnOpenItemIsNoticedOnlyForTheKindsItsSinkTakes`、`TestUnsettledAnswerReopensTheNotice`、`TestOptionReplyAnswersAQuestionInItsChat`、`TestNeedsYouOneListWithTwoHandlers`，以及 `./internal/personnotice` 全包。

远端检查（CanWendeMac-mini，lease_1d2dabdb92efdeb2c2db，树 `~/workspace/foundry-dev317`）：

- `go test ./internal/personnotice` → `ok` 1.566s。
- `go test ./internal/httpapi -run '…'`（上述 10 个名称）→ `ok` 3.695s，日志无 `no tests to run`。
- 首次运行时，`TestNoticeSkippedForAReasonIsLoggedWithoutContent` 因同一用户第二个助理与第一个共用工作区而失败（`ErrPersonalAgentExists`，一个工作区只能有一个助理）；已改为每个助理独立工作区，之后通过。

## 限制

1. **没有默认助理的分支不可达**：`CreatePersonalAgent` 把本人的第一个助理设为默认，因此拥有助理的人必有默认助理。`noticeSinksOf` 对 `ErrNotFound` 的分支只能防御性存在，没有测试覆盖，这一点在简报中要求测试，但无法经存储接口构造。
2. **回退通知的卡片显示默认助理的名字**：为让飞书发送走对的私聊，通知的助理取默认助理；卡片中的「助理名」因此是默认助理的，问题的项目名仍是问题所在工作区。
3. **无卡片交接的通知只读**（决定 2）：本人回复经助理收件箱；网页上对该项的回答仍返回「请在对话中回答」（既有行为）。
4. **频道会话的问题**（决定 3）：通知回复会回到收件箱，既有行为。
5. 未做端到端 MCP 测试：通知会话需要真实的扩展实例（`noticeChatOf`），测试改用注入的 chat 查找。
6. 未向本人发送任何消息。

## 部署与验收（编排者部署后执行）

在 dev 用合成助理（非本人的助理）验证，不向本人真实聊天发送：

1. 默认助理配置 `builtin:feishu` 的 `hand_over` 种类，并有已配对的合成私聊；另建一个没有 sink 的合成助理（同一合成用户）。
2. 让该合成助理的帮手在回答里提问、不带卡片，然后调用 `needs_you op hand_over`。
3. 预期：`person_notices` 新增一行 `kind=hand_over`、`allow_free_text=0`、`assistant_id` 为默认助理、`sink_id=builtin:feishu`；`state` 经 `queued` 到 `sent`；待处理项 `notified_at` 有值。
4. 把默认助理的 sinks 清空再重复第 2 步：预期日志出现 `person notice for item <id> skipped: neither its assistant nor the default assistant has notify sinks`，且没有新行。
