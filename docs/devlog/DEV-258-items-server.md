# DEV-258 事项（服务端）：负责人、摘要、归档与回看

2026-11-16。本人要求把「你的清单」与「正在执行」合成一份「事项」：每件事有负责人、助理维护的摘要、时间线、帮手与归档，结束满 7 天自动归档，并能回看一段时间做了什么。本项是服务端与助理工具部分；Web 见 DEV-259。

状态：已部署 dev（train18/19-20261117）；Agent 代验收（2026-11-17，范围见验收记录）；已合入 main（PR #273）。

## 问题

1. 侧栏两份列表重叠：「你的清单」（`pa_items`）和「正在执行」（`pa_tasks`）里会出现同一件事，本人分不清复选框的含义。
2. 清单没有负责人、摘要和归档，结束的事项一直留在列表里；也读不出「这周做了什么」。
3. 助理派出帮手时不能挂到事项下；`update_list` 不能归档或恢复。

## 调查

- 设计依据 `.foundry/briefs/dev258-259-items.md`（原则：助理决定，Foundry 只记录事实并执行纯时间规则；不新增提示词块与通知）。
- 存储、REST 与归档级联已由前序提交在工作树中完成（`store/personal_agent_list.go`、`sqlitestore/personal_agent_items.go`、`httpapi/personal_agent_items.go`）。读代码时发现两处不一致：
  - 重新打开归档事项（`status: open`）时，存储会清掉归档并记 `restored` 事件，但 REST 只在 `archived` 字段给出时才计算并恢复帮手会话，所以帮手仍保持归档。
  - 摘要、负责人与 `origin` 在助理工具里没有写入路径；`origin` 从未被赋值。
- 频道来源没有文本匹配：轮次的结构化来源是 `store.SessionInput.ChannelOrigin`（DEV-234 / DEV-246），`scope.Turn` 即当前输入。

## 修复

- `personalagent/assistant/list.go`：
  - `update_list` 增加 `archive` / `restore` 操作，以及 `owner`、`summary`（≤1500 字，替换）。`summary` 与 `owner` 不需要原话；文字、时间、提醒与状态仍需要。
  - 新增 `saveItem`：所有写入（REST 编辑、助理更新、归档、恢复、重新打开）共用同一条归档 / 恢复路径。重新打开归档事项等同于 `archived=false`，会恢复归档时一并归档的帮手会话；单个会话恢复失败则留在归档中并记日志。
  - `add` 的 `origin` 取自当前轮次的 `ChannelOrigin`（频道名或会话名、来源、请求人、消息 id），网页轮次记为 `web`；请求人是该轮次最后一条非助理自己发出的消息。
  - `read_list` 改为分页：`status`、`owner`、`from` / `to`（按更新时间 `[from, to)`）、旧的 `closedSince`、`includeArchived`（默认不含）、`limit`（默认 20，最多 50）、`offset`，返回 `nextOffset`。每件事只含文字、时间、负责人、状态、摘要、较短原话（≤200 字）与帮手状态，不含事件与计划。
  - `HelperItem`：`create_session` 的 `itemId` 必须是本助理的事项、未归档、状态为 open；否则返回带原因的工具错误。
  - 日报（`DigestFacts`）改用同一页查询（`ClosedSince`），按页读完；归档事项不进日报。
- `store/personal_agent_list.go`、`sqlitestore/personal_agent_items.go`：页查询增加 `view=all`、`status` 过滤与 `IncludeArchived`；归档视图外默认排除归档。
- `store/sessions.go`、`sessions/lifecycle.go`、`sessions/service.go`、`httpapi/session_ports.go`：`CreateAgentSessionInput.AssistantItemID`（服务端设置，不对外）经策略钩子传给 `RecordTask`，创建帮手时直接写入 `pa_tasks.item_id`，`helper_started` 事件由存储写入。派发路径（`dispatch_item`）仍在创建后经 `linkOperation` 挂接，不变。
- `httpapi/personal_agent_items.go`、`personal_agent_ports.go`：REST 编辑改为调用助理的 `EditItem`（记为本人）；归档与恢复端口带 `recordAs`，清扫记为 foundry。
- `httpapi/mcp_sessions.go`、`mcp_personal_agent.go`：`create_session` 的 `itemId` 与 `read_list` 的新参数。
- `httpapi/mcp_tools.json`：`update_list`、`read_list`、`create_session` 的描述与参数形状（`create_session` 描述仍在目标集合的 5500 字符预算内，实际 5470）。
- 提示词：`skills/assistant-memory-and-list/SKILL.md`、`skills/assistant-handoff/SKILL.md` 各增加几行（事项、帮手挂到事项、摘要保持最新、关闭与归档、用 `read_list` 回看）；版本 `2026-11-16.7`，`prompt_test.go` 登记新摘要 `e696ec17…`。`system.md` 未改。
- `docs/personal-agent.md`：§6「本人的清单」改为「事项」，工具表两行改写。

## 部署与版本

未部署。未提交。未触碰 `apps/web`、`packages/protocol`、`contracts/`。
Prompt version `2026-11-16.7`（待部署时记录 Server build）。

## 检查

在 CanWendeMac-mini 的共享 compute 租约（`lease_7bbd1d363a9e2fc3828a`，已释放）上运行 `scripts/remote-check.sh --tree <worktree>`：

- `--go ./internal/httpapi -run 'TestAssistant|TestThePersonEditsTheirList|TestRemindersAndTheDailyDigest|TestNoDigestWithoutNews|TestPersonalAgent|TestItemOrigin|TestReadListPages|TestCreateSessionItemId|TestMCPGenericToolDescriptions|TestItemSweep'`：全部通过，除 `TestMCPGenericToolDescriptionsStateContractsWithoutWorkflowPolicy`（目标描述合计 5519 > 5500）。已把 `create_session` 的 `itemId` 句子压短，重跑 `TestMCPGenericToolDescriptions|TestAssistantToolDescriptions|TestAssistantRoleAndTools` 通过。
- 新增测试（均在 `httpapi`）：
  - `TestPersonalAgentItemReopenRestoresItsHelpers`：重新打开归档事项时帮手恢复，`restored` 事件各一条（事项一条、帮手一条）。
  - `TestAssistantKeepsItemOwnerSummaryAndArchive`：摘要超长被拒、归档未结束事项被拒、帮手运行时归档被拒、归档与恢复、重复归档返回 `unchanged`、负责人与摘要变化进时间线。
  - `TestReadListPagesFiltersAndStaysConcise`：默认页、归档过滤、负责人、时间范围、`closedSince`、分页与 `nextOffset`、非法参数、结果不含事件与计划。
  - `TestCreateSessionItemIdTiesTheHelperToAnOpenItem`：未知、已结束、已归档的事项被拒；打开的事项挂上帮手并有 `helper_started`。
  - `TestItemOriginRecordsTheChannelMessageThatStartedTheTurn`：频道轮次的 `origin`。
- `--go ./internal/personalagent/prompt ./internal/personalagent/assistant -run '…'`（提示词版本、前言、黄金文件、预算与 `TestItemSweep`）：通过。
- `--go ./internal/sqlitestore -run 'TestPersonalAgent'`：通过。
- `--sh 'go vet ./internal/store ./internal/sqlitestore ./internal/sessions ./internal/personalagent/... ./internal/httpapi'`：通过（先修复了一处测试中的旧签名调用）。
- gofmt：本次改动的 Go 文件通过。

## 迁移

本项无新的数据库迁移。依赖本分支中未提交的前序存储改动（同一工作树）：`pa_items` 的 `owner`、`summary`、`archived_at`，`pa_item_events`，`pa_tasks.item_id`。部署前需确认这些迁移随同一构建发出。

## 限制

- Worker 的 `foundry item` / `foundry list` 命令仍只映射旧参数，不能设置负责人与摘要，也不能用新的读取过滤；`packages/worker` 未改。
- `read_list` 仍返回 `operations`（最近最多 200 条派发操作），这是旧行为，会占用上下文；建议之后单独收窄。
- `origin` 只区分网页与频道；`self_chat` 没有结构化字段，未设置。
- 通过 `update_list` 归档被拒时，审计记为 `failed`（拒绝在 `Apply` 阶段返回），不是 `refused`。
- 归档时单个帮手会话失败会留在归档中并记日志，工具回答中不显示。
- 完成（`done`）仍需要计划证据（既有规则）；助理关闭事项时可用 `dropped`，或先写 `plan.evidence`。
- 日报的行顺序改为按更新时间倒序（内容不变）；日报不含归档事项。
- 只跑了定向测试，没有全包或全量回归；批次检查留到合并时。

## 验收（部署后由本人执行）

1. 在助理对话说「下班后回猎头的微信消息」。助理会记一件事项；用 `GET /api/personal-agent/items` 能看到它，`origin.kind` 为 `web`，`owner` 为 `person` 或 `assistant`。预期：有 `summary`（助理写的，可能为空，之后会更新）。
2. 让助理派一个帮手去处理该事项（`create_session` 带 `itemId`，或 `dispatch_item`）。预期：`GET /api/personal-agent/items/{id}` 的 `helpers` 里出现该会话；`events` 含 `helper_started`。
3. 在频道里让助理记一件事（如飞书群里的请求）。预期：该事项的 `origin.kind` 为 `channel`，`origin.requester` 为请求人的显示名。
4. 助理把事项标为 `dropped`，然后归档（`update_list` `archive`）。预期：归档成功，`archivedAt` 有值；若帮手仍在运行，预期返回错误「no helper of it is running」。
5. 用 `PUT /api/personal-agent/items/{id}` 发送 `{"status":"open"}` 重新打开归档事项。预期：`archivedAt` 清空；归档时一并归档的帮手会话恢复（会话列表中不再是归档状态）；时间线有一条 `restored` 事件（事项）和每个帮手会话一条。
6. 让助理回答「这周做了什么」（`read_list` 带 `from` / `to`）。预期：只返回本周更新过的事项；每件事没有 `events` 与 `plan`；超过 20 件时有 `nextOffset`。
7. 结束满 7 天的事项（提醒任务每分钟扫描时）归档：`GET /api/personal-agent/items?view=archived` 能看到它，时间线记 `archived`，`actor` 为 `foundry`。预期：不早于 `closedAt` 之后 7 天。

## 相关

- 设计：`.foundry/briefs/dev258-259-items.md`（工作区外）
- 上一项：[DEV-253 编排者按需拉取子会话进度](DEV-253-orchestration-progress.md)
- 同一条线（Web）：DEV-259，待本项的契约与服务端部署后开始

## 验收记录（Agent 代验收，2026-11-17，dev 真实浏览器，e2e-alice）

- 编排会话在 dev 上实测事项：打勾完成、已结束标签、归档 → 恢复 → 重新打开（时间线事件随之出现）、回顾、分页均正常。
