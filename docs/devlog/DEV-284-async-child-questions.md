# DEV-284 子会话的异步提问转达给创建者，创建者的回复即答案

2026-11-18 北京时间（案例时间为 UTC 2026-11-17 16:54Z，即北京时间 11-18 00:54）。来源：`.foundry/briefs/assistant-fixes-20261118.md` 的 DEV-284；编排会话 sess_1794903494975054964 派出的 Codex 子会话 sess_1794927790954851190。

状态：已部署 dev（2026-11-18）；Agent 代验收（2026-11-18，范围见验收记录）；已合入 main（PR #TBD）。

## 事实与案例

- 2026-11-18 16:54:06Z，子会话用 `request_user_input_async`（delivery `async`，DEV-063）提问，子会话继续工作。
- 父会话没有收到任何东西；本人 16:56:12Z 自己告诉它「你派出的这个 session 有东西要问你，你去回答」。
- 父会话 16:56:40Z 的回答作为普通 steer 送入（带 `sentBySessionId`），子会话的问题卡仍显示「Waiting for your answer」。
- 自 11-10 起，由 agent 创建的子会话共 7 次异步提问，都没有转达，也没有成为 Needs you 项。

## 根因

- `apps/server/internal/httpapi/session_questions.go` 的 `relayChildQuestion` 只接受 `delivery == next_turn`，异步提问直接返回。
- Worker 的 Codex 运行时只在 steer 没有 `sentBySessionId` 时把消息当作提问答案（`codex-stream.ts`：`!sentBySessionId && thread.answerQuestion?.(message)`）。父会话的答复带发送者，即使它就是问题信封，也没有被当作答案。
- 子会话的异步提问不会在 `waitingQuestion` 中被找到，所以父会话的纯文本回答不会被包装成答复信封。

## 修复

Server（`session_questions.go`）：

- `questionWaits(delivery)`：`next_turn` 与 `async` 都是等待答案的提问。`relayChildQuestion` 与 `waitingQuestion` 都使用它。
- 异步提问同样转达给创建者的收件箱。转达文本说明子会话「asks and keeps working; it reads the answer at its next step」，不再写「its turn ended」。助理作为父会话时的分支（助理已停止则不转达，`needs_you` 提示）保持不变。
- `questionAnswered`：子会话的事件中已有指向该问题的答复信封（人在子会话里先答，或创建者已答），则不转达。
- `nativeQuestionID` 抽出为共用函数，`agentQuestionReplyText` 使用它。

Worker（`runner/codex-stream.ts`）：

- 只有纯文本（无附件）、且能解析为答复信封（`parseAgentQuestionReply`）的 steer，才走答案路径：先交给 `answerQuestion`（有等待中的提问则由它消费）；否则以原始信封送入 Codex（不加发送者前缀），与 Codex 自己应用发送的答复格式一致。
- 人的答案路径不变；其他来自 agent 的消息仍带发送者前缀送入。

## 检查

- Server（byte-dev 租约 `lease_0784f6130fdd8b000287`，`scripts/remote-check.sh --go ./internal/httpapi -run 'TestAsyncChildQuestion|TestAsyncHelperQuestion|TestChildQuestionIsRelayed|TestRelayedApprovalCarriesThePlan|TestQuestionsToFollows|TestChildReport'`）：通过。
  - `TestAsyncChildQuestionIsRelayedAndAnsweredByParent`：异步提问转达，文本含 keeps working；父会话答复包装为信封；答复记录后，之后的消息是普通 steer。
  - `TestAsyncChildQuestionAnsweredByThePersonIsNotRelayed`：人先在子会话答了，不转达；父会话的文本不包装。
  - `TestAsyncHelperQuestionFollowsTheAssistantState`：助理已停止时不转达；运行中转达并带 hand_over 提示。
- Worker（byte-dev，`remote-check.sh --worker test`）：`session-steer.test.mjs`（含新增的 `a Codex steer from the session that created it answers a question as the envelope, unprefixed`）通过；`codex-questions.test.mjs` 10/10 通过；worker `tsc` 通过。
- gofmt 与 prettier 对改动文件通过。

## 文档

- `docs/assistant-orchestration.md` 的「帮手提问」一行补充异步提问与答复规则。
- 其他部分（`docs/personal-agent.md`、foundry skill）未改：没有描述异步提问的段落需要更新。

## 验收步骤（部署后，dev）

1. 用 e2e-alice 的合成数据，让一个 agent 创建的 Codex 子会话发起 `request_user_input_async` 提问。
2. 预期：创建者的收件箱在子会话提问后立即出现「Foundry question: … keeps working」，含子会话链接。
3. 创建者用 `send_message` 纯文本回答。预期：子会话的问题卡变为已回答，子会话继续并读取答案。
4. 另一次：人先在子会话里回答。预期：创建者不收到转达，问题卡为已回答。

## 限制

- 未部署 dev，未做真实环境（Codex 子会话）端到端验证；上述 Server 与 Worker 测试是本地/远端单元与集成层面的证据。
- 只有 Codex 的异步提问路径改动。Claude 的 next_turn 答复路径（`claude-turn-controls.ts`）未改。
- 「助理已停止」的分支只做了测试覆盖，没有在 dev 上观察。
- 未改 pending items：agent 创建的子会话（非助理帮手）的异步提问仍不产生人的 Needs you 项；它们以创建者的收件箱为准，这是现有设计。

## 时间线

| 日期       | 事项                                                                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-18 | Agent 代验收（编排者）：Codex 子会话 sess_1794939959128642820（gpt-6-luna）经 request_user_input_async 提问；转给父会话；父会话的回复「blue」以 `send_user_message_question_reply` 注入；子会话报告「answered: blue」。 |
