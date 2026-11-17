# DEV-279 通道回合：处理中表情等本人答复，已取消的消息结清

2026-11-18。来源：`.foundry/reports/assistant-review-20261117-channel.md` D7 / D5 遗留 / D12。状态：已部署 dev（2026-11-18）；Agent 代验收（2026-11-18，范围见验收记录）；已合入 main（PR #TBD）。

## 问题

1. **占位回复「我确认一下再回复你」**：通道 `AGENTS.md` 要求助理把事交给本人后在对方那边回这句话；本人希望这个「已经在处理」的意思由聊天里的处理中表情（OnIt）承担，而不是发一条没有信息量的消息。但 OnIt 现在只跟回合与它启动的 helper 走（DEV-268），回合结束、交接（`needs_you` 的 `hand_over`）还开着时表情就没了。
2. **取消的回合收件箱条目停在 `delivered`**：`inbox_9c2cb2f…` 是 `status=delivered, result_status=canceled`，既不是 resolved 也不是 dismissed；取消是「这一轮不跑」的决定，不该再作为「未处理的消息」留在那里等本人重试。
3. **OnIt 加/移除没有持久记录**：所有交割的 `actions_json` 都是 null，表情调用只在失败时写一条审计，事后无法逐条确认加过、按时移除。

## 改动

### OnIt 等本人的交接

- 通道 runner 新增端口 `HandOver(assistantID, inboxID)`：该消息的收件箱条目所跑的那一轮助理，是否有**本人还没答复**的交接事项（见下方「修复」：按轮次而非按会话判定）。读取失败按「仍开着」处理，和 `Working` 一样宁可多留不撒谎。
- `settleAcks`（`channels/context.go`）移除表情的条件从「回合与后代会话都结束」改为「回合与后代会话都结束，**且**那一次交接已答复或忽略」。本人答复时通道会话会有新的回合，表情在这一轮回完前继续保留；答完、回完才移除。
- Web 通道设置里表情的说明同步为新的时机（中英两版）。`channels/openlark/AGENTS.md` 的占位回复不改，作为文本交给编排者应用。

### 结清取消回合的收件箱条目

- `assistant.recordInboxResult`：`canceled` 的回合把条目结为 `resolved`（`result_status=canceled`），失败的仍保持 `delivered/execution_failed` 等本人重试。
- 旧版本留下的 `delivered + canceled` 由 `recoverInboxResults` 一次结清（`UnresolvedPersonalAgentInboxResults` 现在也选出这类行），不用读会话回执。
- `inboxEntryNeedsPerson`：`resolved` 的条目不再算「未处理」，所以取消的消息不会在「等你处理」里出现。通道里的视图不变：`applyInboxStatus` 仍按 `result_status=canceled` 把交割记为 failed/canceled。

### OnIt 的持久记录

- `message_channel_deliveries` 新增 `ack_added_at`、`ack_removed_at`（RFC 3339，空串为未发生）。加表情成功时写前者（`handOver`），移除成功时写后者（`settleAcks`）。
- 通道最近消息的 `actions` 从交割本身补出 `reaction_added` / `reaction_removed` 两条，带时间；Web 两个语言补了标签。不再依赖网关审计（表情本来就不走网关）。

## 检查

远端（byte-dev，`scripts/remote-check.sh`，均通过）：

- `--go ./internal/channels -run 'TestAck|TestHandOver|TestThreadParticipant|TestOtherParticipants'`：ok（6.3s）。
- `--go ./internal/personalagent/assistant -run 'TestInbox|TestRecover|TestChannelOrigin'`：ok（1.0s）。
- `--go ./internal/httpapi -run 'TestInbox|TestFailed|TestUnprocessed|TestPending'`：ok（27s）。
- `--go ./internal/sqlitestore -run 'TestMessageChannelReadPagesAndOrigins|TestMessageChannelConversationCount|TestInboxConcurrentCapture|TestInboxLeaseCAS|TestInboxExplicitRetry|TestInboxDismiss|TestInboxResolvedFailure'`：ok（3.6s）。
- `--sh 'pnpm --filter @foundry/web build'`：生产构建通过（20.1s）。

新增定向测试：

- `TestAckStaysWhileThePersonHasTheHandOver`：回合结束、交接开着时表情留下；交接读完失败时也留下；交接结束才移除；交割记录两个时间。
- `TestInboxResultSettlesCanceledTurns`：completed/canceled → resolved，failed → delivered/execution_failed。
- `TestRecoverSettlesAnOldCanceledAttempt`：旧行一次结清，之后不再出现在未结清列表。
- `pending_inbox_test` 增加「settled stopped attempt 不再需要本人」一条。

## 验收步骤（dev，合成数据）

1. 在任一通道会话里让助理把一件需要本人决定的事交到「等你处理」（`needs_you` `hand_over`）：触发消息上的处理中表情应保留到本人答复或忽略为止，而不是回合结束就消失。
2. 在「等你处理」里答复或忽略该事项：表情随后移除（若助理还要回一轮，表情保留到那轮回完）。
3. 由编排者取消一轮通道回合（或在助理会话里停止当前回合）：其收件箱条目应为已结清，不在「等你处理」中出现「执行失败/已取消」的消息。
4. 打开通道「最近消息」：相关消息的 `actions` 里能看到「加上了处理中表情」「移除了处理中表情」及时间。

## 局限

- 交接判定只认 `outcome=handed_over` 的开放事项；Foundry 自己升级的（停机/离线）事项不算交接，表情按旧规则随回合结束移除。
- 表情调用的「部分成功」仍按整批判定：一次调用里个别消息失败时，整批都记失败、都不标记 `ack_added_at`；下一条消息的巡检不会补加。
- 通道视图与「最近消息」的渲染组件当前不在本仓库的 Web 里（只有 API 与文案），`reaction_*` 两条会在渲染恢复后直接可用。

## 修复：只看本轮的交接（DEV-279b）

### 问题根因

`settleAcks` 的交接判定是按**会话**（会话加它启动的后代）查「还有没有本人未答复的交接」。通道会话是一个长期会话，同一会话的每一轮都共用这个判定：早前某一轮留下的交接事项，会让此后**所有**消息的处理中表情都留着，直到本人答复那件旧事。实际现象：18:01Z 一轮交出两件事（正确保留）；18:06Z 的新消息在 18:08Z 已完整答复，表情仍留着（`ack_held=1`，`ack_removed_at` 为空）。

### 改动

- 判定改为按**轮次**：交接事项记录「交出它的那一轮的输入」。`needs_you hand_over` 写入时记录调用方当前轮的输入（`scope.Turn.ID`）：新建条目的 `HandedInputID`，以及对已有条目的 `HandPendingItem(..., inputID)`。字段存在 `pending_items.payload_json`（与已有的 `handedAt` 同样只在 payload 里），**不加迁移**。
- 通道端口改为 `HandOver(assistantID, inboxID)`：先用 `GetPersonalAgentInbox` 读出该消息收件箱条目**实际运行的输入**（`entry.InputID`，不另行推导），再查 `OpenHandOverForInput(inputID)`：只有这一轮交出、且本人未答复的事项才让表情留着。
- 旧数据：修复前交出的事项没有轮次记录，不匹配任何消息。部署后，这些旧交接所在轮次的表情会在下一次巡检时移除（一次性影响，见局限）。

### 检查

- `go vet ./internal/store/ ./internal/channels/`：通过（exit 0）。
- `go test ./internal/channels/ -run 'Ack|HandOver'`：全部 PASS（含新增 `TestAckOfALaterTurnIgnoresAnEarlierHandOver`：同一会话两条消息，第一轮留交接，第二轮无交接 → 第二条表情移除、第一条保留；本人答复后第一条也移除）。
- 变异检查：把判定换回会话级（任何开着的交接都保留所有表情），新用例失败，报 `the answered message kept its reaction for an earlier turn's hand-over`；已还原。
- `go test ./internal/sqlitestore/ -run 'OpenHandOver|Visible|Pending'`：PASS，含新增 `TestOpenHandOverIsScopedToItsTurn`。
- httpapi：见远端检查记录。

## 时间线

| 日期       | 事项                                                                                                                                                                                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-17 | 线上验证：一个已答复的消息表情仍留着（`dlv_ada517d9b20764453443360b`，`ack_held=1`）。原因：交接判定按会话，不按轮次。DEV-279b 修复（按轮次记录 `HandedInputID`，端口改为按收件箱条目）。                                                                                                                                               |
| 2026-11-18 | 编排者检查（e2e-alice，train 55 起）：交接（18:01Z）保留表情，待处理事项结果为 handed_over，无占位回复；train 55 之后，已答复的消息 `dlv_ada517d9…` 在 19:13:32Z 失去表情（DEV-279b 修复的依据）。                                                                                                                                      |
| 2026-11-18 | 编排者新一轮检查：已答复的消息 `7709224023464348940` 在回复后 14 秒内失去表情（释放半段通过）。保留半段（交接期间仍保留表情）仍在运行，结果由编排者另报；本节不声称该半段已通过。                                                                                                                                                       |
| 2026-11-18 | 编排者完整检查（train 55 之后）：只有回复的自聊消息 7709224023464348940 在 14 秒内失去表情（释放半段）；本人一轮中交给本人一件事项的消息 7709225634450427124 → 待办 pnd_77aee880…（handedInputId 已记录，outcome handed_over，19:33:15Z），其表情保留（交割 dlv_a6027a84…，ack_held 1，19:36:58Z 仍在），未发占位回复（保留半段通过）。 |
