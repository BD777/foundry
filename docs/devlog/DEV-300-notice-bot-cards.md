# DEV-300 通知本人：Foundry 飞书机器人卡片

状态：已实现，已在远端运行 Go / Web 检查（结果见「检查」）；已部署 dev（2026-11-18）；待本人验收；已合入 main（PR #278）。

依据：本人 2026-11-18 决定。第一版 OpenLark 自聊文本通知（以本人身份发送）被否：「如果是这种程度的通知，那不如没有这个通知」。改为内置 Foundry 飞书机器人（已配对的飞书应用「Foundry」）以交互卡片发送。设计见 `.foundry/reports/needs-you-redesign.md` §7。

## 问题

- 待本人处理的事项（提问、审批、交接、助理提问）经 DEV-294 进入 `personnotice`，但唯一的投递目标是 OpenLark 自聊，且纯文本。
- 飞书内置机器人已有卡片按钮与回调（`personal_agent_cards.go`），但没有通知类卡片，也没有通知的回答路径。

## 做法

- **内置 sink `builtin:feishu`**（`feishu/notice.go`）。核心仍不认识任何连接器：
  - `Send` 把通知以 Card JSON 2.0 发到本人与助理的配对私聊；
  - `Refresh` 在通知状态变化后更新卡片（已处理 / 已在别处处理）。
- **卡片**（`feishu/notice_card.go`）：
  - 头部：类型（需要你决定 / 需要你批准 / 助理问你 / 交给你处理）· 助理名 · 项目名；
  - 正文：问题、至多 3 行背景（交接说明、帮手问题上下文、助理提问）；审批的操作以代码块呈现并截断；
  - 按钮：每个选项一个，回调值 `{foundry, op: notice_answer, noticeId, option}`；
  - 补充说明：表单输入框与发送按钮，回调值 `form_value.reply`；
  - 「在 Foundry 打开」：`open_url` 按钮，指向 `/pending?item=<id>`；
  - 正文不含 URL，不产生链接预览。
- **回调**（`personal_agent_cards.go` 的 `card.action.trigger` 分支新增 `notice_answer`）：
  - 沿用既有的配对本人检查（非配对本人、群聊按钮直接拒绝）；
  - 在后台 goroutine 中结算，回调 3 秒内即返回；结算后用 `PatchCard` 原地更新卡片。
- **唯一结算路径**（`httpapi/person_notice_items.go`）：`settleNoticeReply(ctx, notice, reply, sourceID)` 是本人在通知会话中回复与卡片按钮/补充说明的共同入口。先以比较交换把通知由 sent 改为 answered，再按项的来源结算。第二次点击（双击）在比较交换处失败，不再结算。
- **卡片所需的事实**（`feishuNoticeDesk.NoticeFacts`）：助理名取 `assistants`，项目名取工作区名，背景取项的摘录或交接说明，审批操作取连接器写入的 `Operation`。
- **按卡片与人校验**（`feishuNoticeDesk.AnswerNotice` / `noticeOfPress`）：通知的 `ProviderMessageID` 必须等于回调所在卡片，且通知的人与助理与回调一致；否则拒绝。
- **状态变化的卡片刷新**：
  - `store.PersonNotice` 没有新字段，`person_notices` 增加 `card_stale` 列（新库在建表时加入，旧库由 `addPersonNoticeCardStaleColumn` 通过 `pragma_table_info` 补列，幂等）；
  - 改为 superseded 或 answered 时置 `card_stale = 1`（`SupersedePersonNotices`、`AnswerPersonNotice`，以及 `savePendingItem` 关闭项时的直接 UPDATE）；
  - `personnotice.Dispatcher.Pump` 调用 `refreshStale`，对实现 `Refresher` 的 sink 调用 `Refresh`，成功或超过一小时后清除标记（`ClearPersonNoticeRefresh` 以状态比较，状态已变则不清）。
- **设置**：
  - `builtin:feishu` 作为 `connectorInstanceId` 的哨兵值保存在 `notify.sinks`（已有结构，无迁移）；
  - `listPersonalAgentNotifyInstances` 仅在本人已配对（`WSManager.HasNoticeChat`）时列出该项，排在最前，标记 `recommended: true`，标签「Foundry 飞书机器人」；
  - 保存时若选择机器人但未配对，返回 `feishu_not_paired`；
  - 入队时（`noticeTargetOf`）未配对则不入队，不产生永久失败的通知；
  - `sendPersonalAgentTestNotice`（`assistant_settings notify_test` 与设置页测试按钮）对该哨兵值同样生效；测试通知无 `ItemID`，卡片不带回答控件。
- **Web**（`settings-notify.tsx`）：机器人项显示「（推荐）」；选中机器人时隐藏自聊发现（不询问自聊会话 ID）；OpenLark 自聊选项保留，非默认。

## 检查

最终代码（含适配器重构与协议类型补充）上，远端 CanWendeMac-mini（共享租约，`remote-check`，树为 `~/workspace/fdy-dev300`）全部通过：

- `gofmt -l` 与 `go vet ./internal/feishu ./internal/httpapi ./internal/personnotice ./internal/sqlitestore ./internal/store`：通过；`node scripts/audit-module-boundaries.mjs`：通过（`feishu` 不再导入 `personnotice`，见下）。
- `go test ./internal/feishu -run 'Notice|HasNoticeChat|Answered|Card|Feishu'`：通过。
- `go test ./internal/personnotice`：通过（含 `refresh_test.go`：superseded 后刷新一次、失败重试、一小时后放弃）。
- `go test ./internal/sqlitestore -run 'Notice|Pending|Migration'`：通过。
- `go test ./internal/httpapi -run 'NoticeCard|NoticeSinkID|PersonNotice|Notice|Notify|AssistantSettings|Feishu|Card'`：通过（含 `TestNoticeCardPressSettlesOnce`：另一人、另一卡片、无此选项的按钮被拒绝；第二次按钮不重复结算）。
- `pnpm test`（单文件 `test/assistant-settings-notify.test.mjs`）：11/11 通过（含新增的「机器人排在最前、标为推荐、不询问自聊」）。
- `pnpm typecheck`：通过。

过程中的失败（已修复，未保留在结果里）：审计把 `feishu → personnotice` 判为违规，改为 `httpapi` 中的 `feishuNoticeSink` 适配器；两处旧测试期望（`builtin:feishu` 不解析、项结算后关闭）按新语义更新；英文 locale 下断言改为「推荐|recommended」；协议 TS 类型补 `recommended`。

卡片样例（由当前卡片构造器生成）：`.foundry/attachments/20261118/dev300/`（问题、审批、助理提问、已回答）。

## 限制

- **卡片发送与首次回答之间的窗口**：通知在 `sending` 状态下收到按钮回调时，`AnswerNotice` 不结算，卡片显示「没能记下这次回答」。用户再点一次即可。
- **项在通知 sent 之后被关闭**：`savePendingItem` 只把 `queued`、`sent` 转为 superseded；`sending` 的通知由其发送结束后再处理。这种情况下卡片要等下一次按钮按下才更新。
- **补充说明**对审批是更多信息，不是决定（沿用 DEV-294d）；对问题则是回答。
- 配对检查只在保存设置与入队时做；解除配对后，已入队的通知会在发送时以瞬时失败重试，超过一小时后不再刷新卡片。
- 「是否提醒本人」未实测（同 DEV-294）。机器人消息的提醒行为需在 dev 上由本人确认。
- 没有提交，没有部署，没有在飞书中发送真实卡片（需部署后由编排器发送测试通知）。
- `httpapi` 中「列表包含机器人」的断言未写成测试：需要完整的助理路由夹具。配对为真时的列表由 `feishu` 包的 `HasNoticeChat` 测试覆盖，列表过滤由代码审阅覆盖。

## 验收步骤（部署 dev 后）

1. 确认本人已在助理设置中配对飞书机器人（与助理的配对私聊可用）。
2. 助理设置 → 入口与通知 → 通知你：下拉第一项为「Foundry 飞书机器人（推荐）」。选择并勾选四种类型，保存。预期：保存成功，不出现 `feishu_not_paired`。
3. 点「测试」（或 `assistant_settings notify_test`，`connectorInstanceId: builtin:feishu`）。预期：配对私聊收到一张蓝色卡片，标题含「需要你决定」，正文含 `[测试] Foundry 通知联调`，无按钮，有「在 Foundry 打开」（若有链接）。
4. 让助理提一个带两个选项的问题。预期：卡片含两个选项按钮与补充说明输入框；`person_notices` 中记录 `sink_id = builtin:feishu`、`state = sent`。
5. 点选项一：预期卡片原地变为「已处理：你选了 …」，无按钮；助理会话收到回答。
6. 对另一条通知，在网页待办中先回答：预期其卡片原地变为「已在别处处理」（最迟约 10 秒内）。
7. 对审批类通知，在补充说明中输入文字：预期卡片显示「已记为补充说明 … 还没有决定」，按钮仍可用。
8. 人工观察：机器人卡片是否提醒本人（未实测）。

## DEV-300b：通知资格、open_id 首次发送与配对（2026-11-18）

### 前提更正

- 初版假设「本人的 open_id 已经通过群配对路由绑定」不成立。群配对（`handlePairCommand` 群分支）原先不记录发送 `/pair` 者的 open_id，库里两条群路由的 `peer_open_id` 为空。
- 现在群配对记录发送者的 open_id（`PeerOpenID`）。该 open_id 来自发送配对码的那次消息，是配对的依据。
- 已有群路由没有这个字段，由 `backfillGroupPeers`（连接时后台执行，只处理 `PeerOpenID` 为空的群路由）回填：群内用户成员**恰好一人**时，该用户即路由的人，日志记 `person derived from its single user member (current membership, not the pairing message)`。多人群不回填。回填依据的是当前成员关系，不是配对消息本身，群配对后有人加入或离开会影响结论。

### 解析与资格

- `pairedDirectChats`：本人的 p2p 路由（不变），是卡片与发送的常规路径。
- `openIDTargets`：绑定到本人、记录了 `PeerOpenID` 的路由（p2p 或群），解析到本助理且助理接私聊。
- `NoticeChatReason`（设置列表与保存检查用）：有 p2p 路由 → 可用；有 open_id 路由且未被拒 → 可用；全部被飞书拒绝 → `feishu_not_reachable`；没有 → `feishu_not_paired`。
- `HasNoticeChat`（入队用）：原因不是 `feishu_not_paired` 即入队。被拒的人仍入队，由发送时以永久失败结束（见下）。

### 首次发送

- 没有 p2p 路由时，`noticeByOpenID` 用 `SendCardToOpenID`（`receive_id_type=open_id`，响应中的 `chat_id`）发送。
- 成功后 `BindFeishuDirectChat` 把返回的会话记为本人的 p2p 路由：应用同上，工作区为助理主工作区，`PeerOpenID` 为该 open_id。此后的发送、卡片更新，以及卡片按钮的「配对本人」检查（`chat.stored.PeerOpenID`）都走常规路径。
- 路由写入与 `BindFeishuChat` 共用 `routeFeishuChat`。
- 飞书返回 230013（机器人对该用户无可用范围）或 230029（已离职）：返回 `ErrUserNotReachable`，通知以永久失败结束（`personnotice.Permanent`），并把 `feishu_not_reachable` 记在路由的 `open_id_error` 列上（新列，旧库由 `addFeishuOpenIDErrorColumn` 补列）。下一次成功发送清除该记录。

### 文案

- 未配对：「需要在飞书私聊机器人发一次配对码。」（zh-CN）；英文：「Send the pairing code once in a Feishu direct chat with the Foundry bot.」。
- 不可达：「机器人无法在飞书里给你发消息：你不在该应用的可用范围内。」（zh-CN）；不含配对指引。

### 限制

- 飞书接口按 SDK 类型实现：群成员 `im/v1/chats/:chat_id/members`（`member_id_type=open_id`），消息 `im/v1/messages?receive_id_type=open_id`，响应含 `chat_id`，230013 为不可达。文档页面在本环境不可读，**未在线上实测**；成员列表所需 scope 未核对（需要 `im:chat.members:read` 或同类权限）。机器人是否出现在成员列表中未核对；若出现在用户列表则计数偏多，回填会失败而不误判。
- 回填依据当前成员，见「前提更正」。
- 多人群无法推出人员，设置显示「需要在飞书私聊机器人发一次配对码」，需要本人在私聊中发码一次。
- 主动卡片（助理提问 `TellPerson`、提案卡片）仍只走已有的 p2p 路由；首次发送只在通知路径实现。若需要，另行把 `sendAssistantCard` 收敛到同一函数。

### 检查（CanWendeMac-mini，共享计算租约，树 `~/workspace/foundry-dev300b`）

- `go test ./internal/feishu -run 'Notice|HasNoticeChat|Card|Feishu|Pair|OpenID|Backfill'`：ok。含 `TestNoticeChatReachesThePersonThroughAGroupOpenID`、`TestFirstNoticeByOpenIDRecordsTheDirectChat`、`TestFirstNoticeReportsAPersonOutsideTheAppsScope`、`TestGroupPairingRecordsTheSendersOpenID`、`TestBackfillDerivesThePersonOfASingleUserGroup`、`TestBackfillLeavesAGroupWithSeveralUsersUnderived`。
- `go test ./internal/httpapi -run 'NoticeBot|NoticeInstances|Notify|AssistantSettings|Feishu'`：ok。
- `go test ./internal/sqlitestore -run 'Feishu'`：ok。
- `go vet ./internal/feishu ./internal/httpapi ./internal/sqlitestore ./internal/store`：通过。
- `gofmt -l`：无输出。
- web：`--web typecheck` 通过；`test/assistant-settings-notify.test.mjs` 通过；`remote-build --web` 通过（SHA256SUMS 校验）。

### 验收（部署 dev 后）

1. 助理设置 → 通知你：机器人项的状态与原因符合上文。
2. 显示「需要在飞书私聊机器人发一次配对码」：在与机器人的单聊里发送助理工作区的配对码。预期：刷新后机器人可选。
3. 机器人可选后触发一条通知。预期：若尚无私聊，卡片由 open_id 发出，`feishu_bot_routes` 中新增一条 `p2p` 路由（`peer_open_id` 为本人的 open_id）；之后的通知进入该私聊。
4. 被飞书拒绝的人：通知以永久失败结束，设置显示「无法在飞书里给你发消息」。
