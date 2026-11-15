# DEV-236 助理就是范围更大的 Orchestrator：通用 send_message、去掉 Foundry 的判断、频道归属

状态：已部署 dev（train1-20261116）；Agent 代验收（2026-11-16，范围见验收记录）；已合入 main（PR #269）。

2026-11-16 E2E（`sess_1794776456356919583`，第 2 轮）：helper 提问 → 助理 `send_message` 回答 → helper 继续，未生成 needs_you。

## 问题

本人（2026-11-16）把 needs_you 定成助理的输出而不是帮手的输出：帮手的提问、阻塞或审批先到助理，助理能答就答、帮手继续；只有助理也决定不了的才整理成 needs_you 交给人。

设计研究（`sess_1794765448749632375`）最终定下方向：助理不是第二套编排系统，而是今天的 Foundry Orchestrator 加上更宽的范围。它应当用同一组通用原语（`send_message`、`create_session`、turn_end 报告），按范围、executor 默认、报告目标和预算主体做参数化，而不是助理专属的机制。

审计（`sess_1794760081207959789`）和实测暴露的断点：

1. 帮手的提问转达到助理后，转达文本让助理用 `send_message`，但助理角色被 `mcp_sessions.go` 直接拒绝；唯一允许的 `dispatch_item` 还要另造一条回答送达路径。
2. Foundry 替助理做判断：10 分钟没确认就把项交给本人、停止助理时把项全部交出去、按回答末尾的“?”判定“在提问”、任何 `Blocked` 都算“在提问”。
3. 消息通道通知在 `memory.go` 里整段算本人的话：群里别人说的正文可以成为 `update_list` 的引文或 `remember` 的来源。

## 改动

- **助理可用 `send_message`**：删掉 `mcp_sessions.go` 里对助理角色的拒绝。准入走通用路径：`controlledSession` → `agentScope`，而 `agentScope` 对助理会话按 `permission.Resolve`（权限包）收窄，所以它只能给权限包允许的工作区（以及自己所在的工作区）里的会话发消息。`boundary` / `interrupt` / `turn_end` 三种投递都可用。停在提问上的帮手由既有的 `answerWaitingQuestion` 包成回复信封送达；协理不需要另造一条送达路径。
- **删掉 Foundry 的判断**：
  - 10 分钟截止与自动交接：删除 `PendingAssistantDeadline`，`pending_items` 写记录、合并、重新打开时都不再设截止；`maintainNeedsYou` 只发到达通知，不再交接、不再补提醒；`needs_you op list` 不再写确认（确认只为旧截止服务）。
  - `endsWithQuestion`：回答以“?”结尾仍只是一个完成的回合，由助理读结果决定。
  - “任何 `Blocked` ⇒ asked”：`followTask` 不再把 `sessions.Blocked` 记为 asking、也不再发“在等回答”的通知；静默、卡住、连不上模型服务仍以事实通知保留，完成通知暂不变。
  - 停止开关不再把助理的项交给本人（那也是 Foundry 替助理做判断）；项留在助理处，恢复后继续。
- **频道归属（G7）**：`PersonWords` 识别 `[Message channel: …]` 通知，只返回 `sender is the person: yes` 的消息块正文（`text` / `text without trigger` / `trigger`）；读不出的通知返回“不是本人的话”。
- **工具与技能文本**：`needs_you` 描述去掉 10 分钟截止、提醒和“列表即确认”，写明项一直是助理的、直到 `hand_over` 或 `resolve`；`assistant-handoff` 写明助理可以用 `send_message` 回答或继续帮手（它的 prompt 就是答案），`needs_you` 只放自己决定不了的事，卡片写清卡点、已试过的、2–4 个选项和推荐、沉默时的默认。prompt 版本 `2026-11-16.2`。
- **文档**：`docs/assistant-orchestration.md` §h 的 handler 表、状态图、解决/没有到时判断/停下/send_message 准入/归属说明同步；`docs/personal-agent.md` 的监督事件一句去掉“以提问结束”，写明 Foundry 不判断提问、不把 blocked 当在等回答。

按最终范围**没有做**：intake 自动建项、Foundry 侧按根因去重、回答轮数上限、静默类别自动放行、10 分钟再提醒、停止助理的人员提示、`dispatch_item` 的平行回答送达。这些都替助理做了判断或与通用路径重复。

## 验证

- `go test ./internal/personalagent ./internal/personalagent/assistant ./internal/personalagent/prompt ./internal/sessions` 通过。
- `go test ./internal/httpapi -run 'TestNeedsYou|TestAssistantSendMessage|TestBlockedHelperIsNotReportedAsAsking|TestRetryingHelperIsNotReportedAsAsking|TestAssistantRunsCarryItsInstructionsAndTheTurnsContext|TestHelperNewsFollowsTheConversationThatSentItWork|TestChildQuestionIsRelayedAndAnsweredInPlainText'` 通过。覆盖：
  - `TestAssistantSendMessageStaysInItsScope`：权限包内的会话可发；包外（ws_bob）被拒（no session … that you can read）。
  - `TestAssistantSendMessageAnswersAWaitingHelper`：帮手停在提问 → 助理 `send_message` → 帮手收到 `<send_user_message_question_reply>` 信封、问题 id 和答案，继续下一轮。
  - `TestNeedsYouLeavesItemsWithTheAssistant`：扫描与读取都不改 handler、不写截止、不交接。
  - `TestNeedsYouStoppedAssistantKeepsItsItems`：停止后项留在助理处，没有 Foundry 自造的项。
  - `TestBlockedHelperIsNotReportedAsAsking`：普通 blocked 帮手不产生 asking 任务、不通知。
  - `TestAssistantRunsCarry...` 的提问结尾用例改为“完成通知 + 任务 done”，并断言没有 asking 任务；静默、卡住、连不上仍按事实通知。
  - `TestChannelNoticeKeepsOnlyThePersonsMessages` 与 `TestMemoryOriginComesFromThePersonsWords` 的频道用例：混合通知只取本人消息，其他人和读不出的通知都不算。
- 未做：真实设备/真实频道回合验证（已随 train1-20261116 部署，待验收）；没有改 Worker。

## 验收步骤（部署后）

1. 用 e2e-alice 的合成助理和一个合成帮手，让帮手以结构化提问结束回合。助理收到“Foundry question”通知后用 `send_message` 回答；帮手下一轮输入带 `<send_user_message_question_reply>` 信封并以答案继续；`pending_items` 里该问题为 `replied`、outcome `assistant_answered`。
2. 在同一助理的权限包里去掉一个工作区，让助理对那里的会话 `send_message`：应被拒绝（看不到该会话）；把工作区加回后可发。三种 delivery 都能发送。
3. 一个过期的 needs-you 项：等待 10 分钟以上，项仍是 `handler=assistant`、没有 `handed_reason`，也没有第二条提醒；`needs_you op list` 不写确认。
4. 让帮手以“Bars or lines?”结束：助理收到的是“完成了”通知，任务为 done，没有 asking 任务。
5. 让一个帮手进入普通 `blocked`（非模型重试）：助理不收到“在等回答”通知，任务不变成 asking。
6. 停止助理：项留在助理处，不出现新的本人项；恢复后助理继续处理。
7. 在混合频道（本人 + 其他人）让助理 `remember` 别人消息里的句子：应被拒绝为无本人出处；本人自己说的句子可以通过。

## 限制

- `assistant_timeout` / `escalated_timeout` 只保留用于读取旧数据；新代码不再写入。
- `create_session` 对助理仍然拒绝（本轮只放开了 `send_message`）；`dispatch_item` 仍是启动新帮手的路径。
- `pa_operations` 的 outbox、item/plan 授权和“一个工作区一个写者”仍是助理侧逻辑，尚未并到通用路径（设计研究的后续 slice）。
- 与 DEV-235 共用 `prompt` 包：本项只改 `assistant-handoff/SKILL.md` 并把版本升到 `2026-11-16.2`；若合并时版本冲突，重算 `promptVersions` 摘要并保留两边的文本。
- 补丁在独立 worktree `~/workspace/foundry-dev236`（分支 `work/dev236`，基于 `4e830ac6`）；已随 train1-20261116 部署，未提交。
