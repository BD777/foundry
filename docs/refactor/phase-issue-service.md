# Issue 服务设计（工作底稿）

依据：[全景图](code-map.md)、[附录：Issue 与证据](code-map/issues-evidence.md)（测于 615b51d7，下文行号按 `main` @ 37677a57 重测）、[阶段 3](phase3-session-service.md)。目标：REST、飞书、会话令牌（MCP）三个入口走同一个 Issue 服务，规则只写一处；删除 Run 镜像（[遗留清单](legacy-inventory.md) A20、D9 留到本阶段）。模式照 `internal/sessions` + `httpapi/session_ports.go`。路径省略 `apps/server/internal/`。

## 现状

`httpapi` 里 Issue 相关的 13 个生产文件共 1533 行，挂在 `*Server` 上 30 个方法、`*DaemonHub` 上 7 个、`*daemonConnection` 上 3 个（httpapi 生产代码合计 38299 行、714 个 `*Server` 方法）。store 侧的 Issue 方法散在三个接口里：`Store`（`store/store.go:191-197,228-230`）、`IssueExecutionStore`（:123）、`EvidenceStore`（`store/evidence_store.go:16`，含创建、澄清、合同）。

| 操作 | REST                                                                                                   | 飞书（`httpapi/feishu_issues.go`）                                                                                 | MCP / 设备                                               |
| ---- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| 创建 | `issues_http.go:21`：选项校验、`ensureIssueGit`（:41）、客户端幂等键，只调 `projectionsChanged`（:50） | `StartIssue` :25：`issueRuntime` 选运行时，无 Git 检查，键 = hash(ws,user,goal)（:30），`issues.created`，立即澄清 | —                                                        |
| 澄清 | `evidence_clarification.go:32` → `queueClarification` :73                                              | :76 → 同一个 `queueClarification`，代拟 ChangeReason                                                               | 结算 `issue_clarification.go:27`                         |
| 确认 | `issue_contracts.go:70`：全程持锁，`evidenceChanged` + `projectionsChanged`（:105-106）                | `ConfirmIssue` :108：拒绝"澄清回复中"（:120），`issues.updated`                                                    | —                                                        |
| 回答 | `issue_questions.go:37`（权限 `issueCreatorOr`，`routes.go:107`）                                      | :63，权限 `mayDecide` :158（同一规则重写）                                                                         | `ask_person` → `askPersonForMCP` `issue_questions.go:16` |
| 反馈 | `issues_http.go:54`：状态预检（:77）→ `checkIssueRetry`（:81-90）→ `projectionsChanged`                | :93：直接 `RequestIssueChanges`，`issues.updated`                                                                  | —                                                        |
| 放弃 | `issue_abandon.go:8`：预检（:23）→ `checkIssueRetry`（:27）→ `issues.updated`                          | —                                                                                                                  | —                                                        |
| 读   | `handleList/GetIssue`                                                                                  | 话题播报直接读 store（`feishu/issues.go:100`）                                                                     | `list_issues`/`get_issue` `mcp_issues.go:41,192`         |
| 执行 | —                                                                                                      | —                                                                                                                  | `issue_execution.go:28,47,69`（开始、镜像事件、结算）    |

## 缺陷与分歧（读代码核实；"疑似"表示未复现）

1. **已核实：飞书重复 `/issue` 复活旧 Issue。** 幂等键是 `sha256(ws,user,goal)`（`feishu_issues.go:30-32`），幂等账本永久保存且先回放（`sqlitestore/evidence_records.go:129-140`）。同一账号在同一 Workspace 再发同样的目标，拿到的是第一次创建时的 Issue 快照（可能已接受或已放弃）；运行时选择变了则报 idempotency conflict。旧快照随后被 `issues.created` 广播（:36），新话题被绑到旧 Issue（`feishu/issues.go:65`）。应改用飞书消息 id 做键。
2. **已核实：飞书反馈跳过重试检查。** REST 的反馈和放弃都先调 `checkIssueRetry`（`issues_http.go:81-90`、`issue_abandon.go:27`）；Worker 在这一步停掉预览，并对已集成或有挂起验收的候选 `assertMutable`（`packages/worker/src/issue/issue-environment-rpc.ts:95-100`、`issue-environments.ts:106-117`）。飞书（`feishu_issues.go:93-102`）跳过这一步，结果是预览不停；有挂起验收的候选会被重新排队，执行到 `prepareIssueEnvironment`（`issue-environments.ts:98`）时抛错，Issue 变成 blocked/system_error，而不是当场返回 409。
3. **已核实：飞书建 Issue 不检查 Git。** REST 建 Issue 前调 `ensureIssueGit`，飞书不调。没有 Git 的 Workspace 里，澄清和确认都能走完，到执行时 Worker 抛 `needsGitMessage`（`issue-environments.ts:54-57`）→ blocked/system_error，而飞书话题里没有初始化 Git 的入口。
4. **规则分歧，后果疑似（竞态）：澄清回复中途确认。** 只有飞书拒绝（:120）。REST 和 store `ConfirmContract` 都不检查，Web 的确认按钮也不看 `replying`（`apps/web/src/features/issue-detail/contract-confirmation-card.tsx:32`）。迟到的回复对 `Run == nil` 且仍是 pending 的 Issue 施加 `ClarificationReplied`（`sqlitestore/evidence_clarification.go:258`），已确认的 Issue 会退回 blocked/needs_input。只在认领没有马上发生时（例如容量满）出现。
5. **已核实（影响轻）：通知路径分叉。** REST 的创建、反馈、存草案、确认只调 `projectionsChanged`（`issues_http.go:50,93`、`issue_contracts.go:66,106`），不经过 Issue 观察者（`events_issues.go:46-51`：飞书话题、待办、Workspace 摘要）。飞书侧的同类操作走 `issues.updated`。结果：在 Web 上保存的草案，飞书话题不会出现"草案已更新"；摘要和待办要等执行开始时才刷新。REST 创建也不发 `issue_created`。
6. **已核实（影响轻）：执行被计两次。** `runningDeviceTurns`（`sqlitestore/device_removal.go:85-92`）把执行会话和它的 run 行各算一次，删除设备时提示的"运行中轮次"因此翻倍；Workspace 删除前的活动检查（`sqlitestore/sqlitestore.go:263`）也一样。疑似：结算失败只记日志（`issue_execution.go:93`），这样的 run 行永远停在 running，会一直挡住 Workspace 删除。
7. **疑似（潜在）：锁的键不一致。** 大多数路径按 `issue.ID` 加锁，但 `issue_abandon.go:16`、`issue_questions.go:49`、`evidence_clarification.go:20`、`evidence_routes.go:303,317` 按路径参数加锁，而 `GetIssue` 也接受短 id（`sqlitestore/issues.go:20`）。用 `ISS-n` 调用时两边互不阻塞；store 事务仍然串行，Web 目前只传 `iss_` id。

规则重复（不是缺陷，搬家时并成一处）：状态预检重复了 `IssueLoop`（`issues_http.go:77` 对 `sqlitestore/issues.go:112`，`issue_abandon.go:23` 对 :167，又对 `store/issue_loop.go:58,60`）；澄清消息校验（`evidence_clarification.go:42` 对 `sqlitestore/evidence_clarification.go:37`）；选项校验（`issues_http.go:32` 对 `sqlitestore/issues.go:40`）；"按版本号找合同"有三份列表扫描（`feishu_issues.go:187`、`mcp_issues.go:221`、`evidence_routes.go:121`），而 store 里已有未导出的 `contractByRevision`（`sqlitestore/issue_contracts.go:13`）；消息路由有两份，顺序不同（`feishu_issues.go:60-103` 对 `apps/web/src/features/issue-detail/issue-conversation.tsx:50-70`，Web 识别状态提问，且先澄清后回答问题）；首轮澄清由飞书在服务端发起（:41-46），Web 则在详情页挂载时由客户端发起（`use-issue-contract.ts:186-200`），不打开详情页的 Web Issue 永远不会开始澄清。

## Run 镜像

执行会话（role `issue_execution`）的状态被抄到 Issue 的 `Run` 上，`Run` 的 id 就是会话 id。每个执行事件存四份：`agent_session_events`、`run_events` 行、`runs.payload_json.events`、`issues.payload_json.run.events`（`sqlitestore/daemon.go:481-510`，由 `daemon_session_inbound.go:76-79` → `issue_execution.go:47` 触发），并作为 `issue_run_event` 推给浏览器。另外 `acceptance_artifacts` 表和 `issue.artifact` 存一份产物（`daemon.go:573,585`）。

- 没人读的：`run_events`、`acceptance_artifacts`（只在删除和种子数据里出现）、`issue.artifact`、Web 的 `features/runs`（只被 `styles.css:103` 引入 CSS）、Steer 标签被抄成 Issue 消息（`daemon.go:502`）。
- 有人读的：`runs` 表——`getRun` 用于幂等（`daemon.go:423,533`）和对齐（`evidence_alignment.go:32`）；`ListRuns` → `fieldRuns`（`foundry_data.go:410`）→ Web 的历史对话（`issue-transcript.ts:19-24`）；还有缺陷 6 的两处计数。`issue.run.events` 和 `issue_run_event` 用于 Web 对话（`issue-transcript.ts:76`、`app/projections/issues.ts:80`、`use-issue-environment.ts:98`）。
- 保留：`Issue.Run` 作为 Issue 指向当前执行的指针，字段只留 `id`、`status`、`runtime`、`environmentId/Revision`、`executionCwd`、`error`、`startedAt/completedAt`。它必须留在 Issue 行里：`expectedRunId` 并发令牌（`sqlitestore/issues.go:118,171`、`issue_environment.go:52`）、7 处"运行中"守卫、证据登记（`evidence_registration.go:81`）都要在同一事务里检查它。幂等改为"`issue.Run.ID` 等于会话 id 就什么都不做"；结算对不上当前 Run 时，改为原样返回、不报错。

## 目标：`internal/issues`

```go
// Package issues is an Issue's lifecycle as every entry reaches it: REST,
// the Feishu desk and session tokens. Each mutation locks the Issue by its
// canonical id, lets the store decide, then tells Events.Updated (viewers,
// then observers) and, when the Issue may run, Devices.ClaimReady. It does
// not know HTTP, MCP or the device wire; a refusal is a Refusal (same shape
// as sessions.Refusal). It must not import httpapi.
func New(st Store, events *Events, ports Ports) *Service

Create(ctx, by Actor, in store.CreateIssueInput, o CreateOptions) (store.Issue, error) // o: RequestID, InitializeGit
Clarify / RetryClarification(ctx, by, issueID, …, requestID) (store.Issue, error)
SaveDraft / Confirm / Discard(ctx, by, issueID, …, requestID) (store.IssueContract, error)
Answer(ctx, by, issueID, questionID, text) (store.Issue, error)
Continue(ctx, by, issueID, message, expectedRunID) (store.Issue, error)   // with Devices.CheckRetry
Abandon(ctx, by, issueID, expectedRunID) (store.Issue, error)             // with Devices.CheckRetry
AskStatus(ctx, issueID, message, requestID); Ask(ctx, sessionID, q)       // ask_person
Message(ctx, by, issueID, text, key) (Receipt, error) // the one router: clarify | answer | continue
Get / List / Summary(ctx, issue)  // Summary: contract at its revision, latest verdict per criterion, review
Observer() sessions.ChangeObserver; Settle(ctx, session, execution, clarification)
Lock(issueID) func(); MayDecide(issue, userID, role) bool
```

- `Actor` = `store.ActorRef` + `UserID` + `Via`（`""` 或 `"feishu"`）。REST 由 `humanActor` 构造，飞书由 `feishuActor` 构造。
- `Ports.Devices`：`Connected`、`Git(ctx, ws, initialize)`（来自 `issue_git.go`）、`CheckRetry`（`issue_environment.go:123`）、`Dispatch`（澄清会话）、`ClaimReady`（`DaemonHub.DispatchReady`）。`Ports.Roles`：`Role(ctx, userID, workspaceID)`（来自 `feishu_issues.go:162`）。
- `Store` 由 `store.Store`、`EvidenceStore`、`IssueExecutionStore` 组合，再加上导出的 `ContractByRevision`。状态预检用新增的 `Issue.Allows(event)`，store 和服务共用这一份 `IssueLoop`。
- `Events` 是从 `events_issues.go` 原样搬过来的，观察者及其顺序不变（飞书、待办、摘要，`server.go:313`）。
- 留在 httpapi：路由表与权限（`issueCreatorOr` 改调 `issues.MayDecide`）、请求解码、环境/Steer/取消/预览/候选审阅的设备代理（`issue_environment.go`，同时实现 `Devices` 端口）、认领循环（`issue_claims.go`，按连接执行）、MCP 的文本格式（`mcp_issues.go` 的 view 与 label）、新增的 `issue_ports.go`。证据（verify/review/accept/materials/export，约 1000 行）本阶段不搬，改用 `svc.Lock` 和 `Events`。
- 飞书：`feishu.WSManager.Issues IssueDesk` 显式注入（同 `PersonalAgents`），删掉 `m.dispatcher.(IssueDesk)` 类型断言（`feishu/issues.go:35`）。`StartIssue` 增加消息 id 参数。

## 步骤（每步单独合入、单独验证）

1. **原地修缺陷 1–4。** 飞书键改用消息 id；飞书反馈调 `checkIssueRetry`；飞书建 Issue 前做 Git 检查（需确认：没有 Git 时拒绝并提示"先在 Web 创建以初始化 Git"，还是直接初始化）；store `ConfirmContract` 在 `replying` 时拒绝，删除飞书那份检查，Web 按钮加上 `replying` 判断。测试：新增 `TestFeishuSameGoalTwiceStartsTwoIssues`、`TestFeishuFeedbackRunsTheRetryCheck`、`TestFeishuIssueNeedsGitLikeTheWeb`（`httpapi/feishu_issues_test.go`），`TestConfirmWaitsForTheClarificationReply`（`sqlitestore/evidence_clarification_test.go`）；回归 `TestFeishuThreadDrivesAnIssueAsTheBoundAccount`、`TestAGroupThreadFollowsAnIssue`、`TestIssueInAWorkspaceWithoutGitNeedsConfirmation`、`TestAbandonEndpointRetainsIssueAndRejectsAcceptance`，以及 Web 的 `issue-contract-controller.test.mjs`。
2. **删除 Run 镜像**（Server、protocol、Worker、Web 一次交付，同时修掉缺陷 6）。按上一节瘦身 `Run`；`DROP TABLE runs, run_events, acceptance_artifacts`，从两处计数里删掉 runs 那一项。Web 的对话改为 `issue.messages` 加上该 Issue 各次执行会话的对话（`listIssueSessions` + 现有 `/api/agent-sessions/{id}/conversation` 与会话事件流；Steer 气泡由 `transcript-adapters.ts` 识别）。Worker 不再发送 `artifact`，`RunTransport` 改用会话事件类型。测试：改写 `TestIssueRunReplayAndRetryHistory` 为 `TestIssueExecutionReplayAndRetry`，改写 `TestIssueSteerPersistsOnceAndCanceledIssueCanContinue`（不再抄出消息）；更新 `TestEveryTableNamingAnOwnerIsOwned`、`TestDeleteWorkspaceLeavesNothingOfItsIssuesRunsOrSessions`；给 `TestRemovingConnectedDeviceAsksBeforeStoppingTurns` 加断言"执行只算一次"；回归 `TestReconnectRecoversAnOrphanedIssueExecution`；Web 的 `issue-transcript.test.mjs`、`foundry-data-projection.test.mjs`、`issue-environment-updates.test.mjs`；Worker 的 `issue-steering.test.mjs`。
3. **建包并搬生命周期。** 搬 `issues_http.go`、`issue_abandon.go`、`issue_questions.go`、`issue_contracts.go`、`evidence_clarification.go`、`issue_execution.go`、`issue_clarification.go` 的结算部分和 `events_issues.go` 的逻辑；handler 只剩解码、调用、编码。所有变更统一通知 `Updated`（修缺陷 5），锁统一按规范 id（修缺陷 7），删除重复的状态、选项、消息预检。测试：新增 `issues/service_test.go` 的 `TestEveryMutationTellsObserversOnce`、`TestShortAndLongIDShareTheLock`，以及 `store/issue_loop_test.go` 的 `TestIssueAllowsFollowsTheLoop`；httpapi 现有 Issue 测试保持全绿（除上面列出的以外不改断言）。
4. **飞书走服务。** 注入 `IssueDesk`；`feishu_issues.go` 只剩适配（身份、URL），路由逻辑进 `Service.Message`，顺序保持飞书现行顺序。测试：步骤 1 的飞书测试，以及 `feishu/issues_test.go`。
5. **MCP 走服务。** `list_issues`/`get_issue`/`ask_person` 改调 `List/Get/Summary/Ask`；删除 `issueContractView`、`evidenceRecords`、`currentDraft`、`currentIssueContract` 四份重复。测试：`TestIssueToolsReadIssuesWithinReach`、`TestExecutionAsksThePersonThroughFoundryTools`、`TestClarificationTokenOnlyReads`。
6. **（需确认，属行为变更）Web 改用服务端路由与首轮澄清。** 新增 `POST /api/issues/{id}/messages` → `Service.Message`，状态提问的判断移到 Go，只保留这一份（删除 `issue-language.ts:74`）；`Create` 在服务端发起首轮澄清，Web 删除挂载时的自动发起，保留手动重试。测试：`issue-conversation.test.mjs`、`issue-language.test.mjs`，新增 `TestMessageRoutesLikeTheWebDid`。

## 实施状态（2026-11-02，未提交）

| 步骤                   | 状态               | 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 缺陷 1–4             | 已改               | 键 = `feishu-issue-<消息 id>`；飞书反馈与 REST 共用重试检查；缺陷 3 按本人决定自动初始化 Git（与 Web 同一个 `ensureIssueGit`，卡片说明"已为工作区初始化 Git"，失败带 Worker 原因）；`ConfirmContract` 在 `replying` 时拒绝，Web 确认按钮看 `controller.replying`。新测试 `TestFeishuSameGoalTwiceStartsTwoIssues`、`TestFeishuFeedbackRunsTheRetryCheck`、`TestFeishuIssueSetsUpGitLikeTheWeb`、`TestConfirmWaitsForTheClarificationReply`，去掉修复后均失败             |
| 2 删除 Run 镜像        | 已改               | `runs`/`run_events`/`acceptance_artifacts` 在 `coreSchema` 里 `DROP TABLE IF EXISTS`（同 `agent_session_tokens` 先例）；`Run` 瘦身；Worker 不再发 artifact、`RunTransport.appendEvent` 用会话事件；Web 对话改读执行会话（`use-issue-executions.ts`，最近 20 次，事件流跟随）；`features/runs`、`timeline-item`、`IssueRunTimeline` 删除，`runs.ts` 只留仍在用的 phase/status 文案。新测试 `TestARunningExecutionIsOneTurn`（缺陷 6）、`TestIssueExecutionReplayAndRetry` |
| 3 `internal/issues`    | 已改               | `Service`（Create/Clarify/RetryClarification/AskStatus/SaveDraft/Confirm/Discard/Answer/Continue/Abandon/Ask/Message/Summary/Settle/Observer/Lock）、`Events`、端口 `Devices`（`httpapi/issue_ports.go`）；所有变更走 `Updated`（缺陷 5），锁按规范 id（缺陷 7），状态预检用 `Issue.Allows`。新测试 `TestEveryMutationTellsObserversOnce`、`TestShortAndLongIDShareTheLock`、`TestIssueAllowsFollowsTheLoop`                                                             |
| 4 飞书走服务           | 已改               | `WSManager.Issues` 注入 `issueDesk`，删除类型断言；`feishu_issues.go` 只剩身份、权限与回执文案                                                                                                                                                                                                                                                                                                                                                                           |
| 5 MCP 走服务           | 已改               | `get_issue` 用 `Summary`，`ask_person` 用 `Ask`；删除 `evidenceRecords`、`currentDraft`，`currentIssueContract` 改为 `ContractByRevision`                                                                                                                                                                                                                                                                                                                                |
| 6 服务端路由与首轮澄清 | 已改（本人决定做） | `POST /api/issues/{id}/messages` → `Service.Message`，状态提问正则只在 Go（`TestStatusQuestionsInEitherLanguage`、`TestMessageRoutesLikeTheWebDid`）；`/clarify`、`/conversation/status` 删除；`Create` 发起首轮澄清（`TestCreateStartsClarifying`），Web 删除挂载时自动发起，欢迎语旁保留手动开始按钮                                                                                                                                                                   |

与设计不同之处：没有 `Ports.Roles`，权限仍在入口检查，规则只有 `issues.DecisionRole`/`MayDecide` 一份（`routes.go` 的 `issueDecision()` 与飞书都调它），`Message` 用 `Actor.Role` 判断回答问题；没有 `Get`/`List`（只会是透传）；路由顺序为 状态 → 已结束 → 回答 → 执行中 → 澄清（有待确认草案时，取 Web 的条件）→ 反馈。行为变化：执行中 Web 不再在客户端识别状态提问，消息按 Steer/排队处理；`TestEvidenceWritesThatChangeTheIssueAreAnnounced` 改为接受 `issue_created`/`issue_updated` 作为通知。scratch 栈（本人 DB 副本，迁移删表无误）端到端：REST 建 Issue 即发起首轮澄清（真实 Claude 未登录，失败卡片与"再问一次"正常）；mock 运行时 确认 → 执行 → `/messages` 状态提问与反馈 → 第二次执行，详情页对话里两次执行都在。未做：真实模型的澄清与执行、飞书话题实测、Steer 气泡实测；`packages/worker/scripts/verify-issue-loop.mjs`、`verify-concurrent-workspace.mjs` 本来就调用已删除的接口，未动。

## 删除清单

Server 侧：`RunEvent`、`AcceptanceArtifact`、`Issue.Artifact`、`CompleteIssueInput.Artifact`、`ListRuns`、`AppendRunEvent`、`getRun/saveRun/saveRunEvent/saveArtifact`（`sqlitestore.go:1187-1260`），三张表（`schema.go:139,148,180`）及其索引、删除和种子数据中的条目，`appendIssueExecutionEvent` 及其钩子和 `sessionTarget.executionIssue`，`browserevent.IssueRunEvent`，`fieldRuns`，Go 合成的"Interrupted execution"产物（`issue_execution.go:73-86`）。httpapi 侧：`mayDecide`、`userHasRole`、`issueInBoundWorkspace`、`currentDraft`、`issueContractView`、`evidenceRecords`、`currentIssueContract`、`events_issues.go`。Web 侧：`features/runs/**`（783 行）、runs 投影、`mergeIssueRun`、`applyRunEvent`、i18n `runs.ts`。Protocol 侧：`RunEvent`、`AcceptanceArtifact`、`Run.events`、`Issue.artifact`。预计 httpapi 生产代码约 −900 行，`*Server` 方法约 −22 个。

## 风险与验证

- 步骤 2 跨四层：历史对话从一次读取变成每次执行一个请求，执行很多的 Issue 要限量或分页。旧数据（会话化之前的 run 历史）直接丢弃，不做兼容。
- 步骤 3 统一通知后，飞书话题会多出 Web 侧变更的卡片（例如草案更新），这是有意的；观察者顺序由测试锁定。`CheckRetry` 是设备 RPC，现在 REST 在持锁期间调用它，搬家时保持这一点，并加超时。
- 步骤 1 第 4 项和步骤 6 改变 Web 行为，需要在真实浏览器里验证（确认按钮在回复中禁用；消息路由不变）。
- 每步：相关包全量测试、`scripts/check-changed.sh`。第 2、3、4 步加 scratch 栈端到端：Web 建 Issue → 澄清 → 确认 → 执行 → 反馈 → 第二次执行 → 接受，对话里两次执行都在，Steer 也在；在飞书话题里走同一条链路；从执行会话调用一次 `get_issue`。
