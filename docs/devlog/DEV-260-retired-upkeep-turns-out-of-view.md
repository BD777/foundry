# DEV-260 退役的维护通知回合不再出现在助理对话里

状态：已部署 dev（train18/19-20261117）；Agent 代验收（2026-11-17，范围见验收记录）；已合入 main（PR #273）。

## 问题

本人反馈：每次打开 Assistant 的 Chat 页面，都看到维护、Upkeep 信息在那里狂轰乱炸。

只读排查（`file:/home/windeng/.foundry/server/foundry.db?mode=ro`，2026-11-16）：文本以 `[Foundry] 项目维护：` 开头的用户输入共 19 条，分两类：

- 12 条（2026-11-15 20:07 至 2026-11-16 03:04 UTC）的事件上没有 `metadata.inputSource`（DEV-246 之前写入）。其中 11 条在 ByteWork 会话，1 条在另一个助理的家会话（见「迁移命中」）。
- 7 条（2026-11-16 04:02 至 07:41 UTC）的 `inputSource.kind = "foundry_notice"`，没有子类型，都在 ByteWork 会话。

`foundry_notice` 同时被 reminder、digest、proposal 结果、helper 提问、设备回线、operation、supervision 通知使用，结构上分不出维护通知。所以本项先给通知加上 `noticeKind`，再迁移旧数据。

## 方案

A. 结构化类型（未来通知）：`AgentSessionInputSource` 新增 `noticeKind`（`contracts/models/sessions.yaml`，由 `node scripts/generate-contracts.mjs` 生成 Go、TS 与 JSON Schema）。`tell()` 必须传入类型，7 个调用点分别是 `reminder`、`digest`、`proposal_outcome`、`helper_question`、`device_back`、`operation`、`supervision`（常量在 `store/sessions.go`）。`upkeep` 是退役类型，只由迁移与视图使用。

B. 一次性、有记录的迁移 `migrateRetiredUpkeepNotices`（`sqlitestore/retired_upkeep_notices.go`）。

- 记录机制：仓库里原本没有通用的「已执行迁移」记录（旧的 `applied_migrations` 已在 schema 里删除，其余都是幂等的每次启动步骤）。本项新增最小的一张表 `data_migrations(name, version, applied_at)` 和 `runDataMigration`（`sqlitestore/data_migrations.go`）：同名同版本已记录则跳过；执行与记录写在同一事务里，失败则不记录、下次启动重跑。这张表是第一个使用者。
- 执行内容：只写 `payload_json` 的 `$.metadata.inputSource`，用 `json_patch` 合并进 `{kind: "foundry_notice", noticeKind: "upkeep"}`，其他字段保留。不删除事件。
- 匹配条件（全部满足）：
  - 用户输入（`$.message.kind = 'user'`），且 `$.message.text` 以下列前缀之一开头。前缀取自 DEV-238 的 `apps/server/internal/personalagent/assistant/maintenance.go`（`git show 3bccf73d:…/maintenance.go`，`upkeepNoticeTexts` 与 `upkeepNoticeText` 的拼接）：`[Foundry] 项目维护：`、`[Foundry] 项目摘要：`、`[Foundry] Project upkeep:`、`[Foundry] Project summaries:`；
  - 来源是 `foundry_notice` 且尚无 `noticeKind`，或者根本没有来源（DEV-246 之前）；
  - `created_at` 的前 19 个字符（UTC，精确到秒）`< 2026-11-16T08:10:00`。DEV-252 于此后上线并停止推送；最后一条维护通知是 07:41 UTC。比较只用字符串，不用 `julianday`：SQLite 的 `julianday` 在不同构建下对亚毫秒的比较结果不一致；
  - 所在会话是某个助理的家会话，按结构判定（与 `store.Conversation` 的条件一致）：会话的 `workspace_id` 是某个助理的 `home_workspace_id`，且该助理的 `owner_user_id` 等于会话的 `createdByUserId`；会话没有父会话（`parent_session_id = ''`），角色为空或 `personal_agent`，来源不是 `agent`、`verification` 或 utility 来源。

C. 视图规则（Web）：`features/personal-agent/assistant-model.ts` 的 `withoutRetiredUpkeepTurns()` 隐藏 `noticeKind === "upkeep"` 的输入行，以及它之后、到下一条输入之前的回答。只读结构化字段，不读文本。助理页 `assistant-home.tsx` 在 `placeProposals` 之前应用。若隐藏的行带有会话起点标记，标记交给其后第一条可见行。事件不删除。助理的原生会话转录没有改动，因此助理的上下文不变。

## 迁移命中（只读干跑，19 条）

干跑在只读打开的 live DB 上执行，WHERE 与迁移一致。全表 920,896 行的 `created_at` 均为 UTC `Z` 格式。满足事件级条件的候选为 19 条，全部通过家会话判定，因此家会话判定没有排除任何一条。

命中的 19 条全部是 `[Foundry] 项目维护：` 前缀，分布在两个家会话：

- `sess_1794542612133670581`（ByteWork 会话，助理 `asst_fe7f432b…`）：18 条。
- `sess_1794761923996513314`（助理 `asst_3fc8b4a2…`，owner `user_2d0a1449…`，工作区 `ws_4e5616b1…`）：1 条，即下表第一行。它是另一个助理的家会话，同样是 DEV-238 发出的维护通知，按同一规则标记。

### 7 条：来源为 `foundry_notice`

| input event id                           | created_at（UTC） | 强制回复 response_stream（created_at）          |
| ---------------------------------------- | ----------------- | ----------------------------------------------- |
| evt_01a1e285-9533-70cc-880d-0ad648dacbfa | 04:02:47          | 04:03:22                                        |
| evt_01a1e28a-26d1-79f9-a533-3ebb66acd302 | 04:07:47          | 04:07:57                                        |
| evt_01a1e2db-244d-770b-8f65-832c506d49b4 | 05:36:14          | 无                                              |
| evt_01a1e2df-abd3-7def-b2a4-4e15e4524435 | 05:41:11          | 05:41:25                                        |
| evt_01a1e32b-8549-7532-84a6-8ea77a0bbd24 | 07:04:02          | 07:04:48（前有 waiting_for_device_online 事件） |
| evt_01a1e330-1934-7817-a111-bb11c09ccb2c | 07:09:02          | 07:09:14                                        |
| evt_01a1e34d-9600-7b9c-ba38-35224dfc00f5 | 07:41:15          | 07:41:36                                        |

### 12 条：无来源（DEV-246 之前）

- evt_01a1e0d2-a17d-784c-adaf-d723d0dbd609（11-15 20:07:42，会话 `sess_1794761923996513314`，另一个助理的家会话）
- evt_01a1e0d2-a65d-792f-bc61-8a16315eea5a（20:07:43）
- evt_01a1e0d7-3ed1-787b-96ae-cded05c85ec3（20:12:45）
- evt_01a1e0f4-00f1-7212-b606-e894dbb77d8a（20:44:09）
- evt_01a1e100-aef3-7613-8b87-167a3d70f9e4（20:58:00）
- evt_01a1e105-4336-721f-8ef1-1fd55f0c4d78（21:03:00，回答 21:03:17）
- evt_01a1e11e-57a1-7c34-85a5-dba55e1c7eb8（21:30:24，回答 21:30:55）
- evt_01a1e122-ed26-7e42-9bb9-e8d45496bb93（21:35:24）
- evt_01a1e16e-8d72-7eca-90e4-e455c659807b（22:58:01，回答 22:58:58）
- evt_01a1e173-22d8-7694-be6b-252edc28b4f7（23:03:01，回答 23:03:13）
- evt_01a1e24b-cca3-75c2-93e6-31207b6ee163（02:59:40）
- evt_01a1e250-56ad-78a9-b643-5e4488cfaf7e（03:04:38）

回答的事件 id 形如 `evt_sess_<会话>_<inputId>_response_stream`，`<inputId>` 为输入事件 id 去掉 `evt_` 前缀。

### 残余风险

没有结构依据能区分「无来源的维护通知」与「本人在家会话里输入的同样文本」。本项没有逐条核对这 12 条是否都是机器发出的：它们的文本都是 DEV-238 的整行维护文案，但只有 4 条（21:03、21:30、22:58、23:03）确认有对应的助理回答。若本人确认过没有人在家会话里输入过这类文本，这一风险可以忽略。

## 验收步骤

1. Conductor 备份 DB，部署 dev。启动后只读查询：`SELECT count(*) FROM agent_session_events WHERE json_extract(payload_json,'$.metadata.inputSource.noticeKind')='upkeep'` 应为 19（上表全部）；`SELECT name, version FROM data_migrations` 应含 `retired-upkeep-notices | 1`。
2. 再次重启服务：计数仍为 19，`data_migrations` 不变（迁移已跳过）。
3. 打开 ByteWork 助理页（会话 `sess_1794542612133670581`）：18 条维护输入及其回答不显示；其余输入（reminder、digest、proposal 结果、helper 提问等）照常显示。另一助理（`asst_3fc8…`）的家会话隐藏 1 条。
4. 新的维护类通知（`noticeKind` 为 digest、reminder 等）不被隐藏。

## 验证

- Go：`sqlitestore/retired_upkeep_notices_test.go`（`TestRetiredUpkeepNoticesMigrationRunsOnceAndMatchesOnlyAssistantHomeUpkeepInputs`）：在文件库上播种旧数据，清掉记录后启动 → 迁移一次；之后插入的同类输入在再次启动时保持不变（跳过）；覆盖四种前缀、截止秒边界（08:09:59.999999999 匹配，08:10:00 与 08:10:00.5 不匹配）、已带其他 `noticeKind`、无来源、本人输入、`kind:session` 输入、子会话、他人会话、`agent` 来源、`issue_execution` 角色、非家工作区；匹配行的 `payload_json` 解码为 `inputSource{kind: foundry_notice, noticeKind: upkeep}`，消息文本不变。`data_migrations_test.go` 覆盖 `runDataMigration`：同版本只跑一次、新版本再跑、失败不记录。
- Web 测试（`test/assistant-retired-upkeep.test.mjs`，4 项）：隐藏退役回合及其回答；reminder、旧的无子类型通知、本人与其他会话输入保持可见；隐藏行携带的会话起点标记交给后续可见行；仅有输入、尚无回答的退役通知也被隐藏。
- 契约：`node scripts/generate-contracts.mjs` 只改了 5 个生成文件（均为新增 13~14 行）。
- 远端结果：见下方「远端结果」。

## 远端结果

在 CanWendeMac-mini（`res_c5f59206bda2897c47c7`，共享租约，工作树 `work/dev260` 的未提交改动）上运行：

- 第一版迁移的 SQL 报错：`SQLStringList` 已带括号，模板又加了一层，产生 `row value misused`，导致所有开库失败。已改为直接使用该列表，之后复跑通过。
- `go test ./internal/sqlitestore/... ./internal/store/...`：通过（sqlitestore 28.9 s）。
- 三项新测试按名运行：`TestRetiredUpkeepNoticesMigrationRunsOnceAndMatchesOnlyAssistantHomeUpkeepInputs`、`TestRunDataMigrationAppliesEachVersionOnce`、`TestRunDataMigrationRecordsNothingWhenApplyFails`：通过。
- 上一轮（迁移记录化之前）的 `pnpm typecheck`（protocol、worker、web）、`pnpm --filter @foundry/web audit:ui`、`pnpm audit:openapi`、`pnpm audit:contract` 通过；之后 TS 代码没有改动。
- Web 定向测试 `assistant-retired-upkeep`、`personal-agent`、`assistant-side-card`、`assistant-conversation-order`：55/55 通过。
- 之前的记录：任务说明中的 `pnpm audit:ui` 不存在；根脚本名为 `audit:web-ui`，Web 脚本名为 `audit:ui`，本项使用的是 `pnpm --filter @foundry/web audit:ui`。

## 限制

- 没有做真实浏览器截图。视图规则只有单元测试与定向测试覆盖；真实页面截图需要 scratch 栈或 e2e-alice 合成数据，留给验收前执行。
- 迁移只在启动时执行一次；之后只有一次记录查询，不再扫描事件表。
- 残余风险见「残余风险」。
- 环境：主检出 `~/workspace/foundry` 的 `node_modules` 有失效链接（`prettier`、`typescript`、web 的若干包指向已删除的 `foundry-commit-1116`），本 worktree 改用 `pnpm install --offline --frozen-lockfile` 重装。未改动主检出，修复留给主检出的所有者。
- 不部署，不提交。

## 验收记录（Agent 代验收，2026-11-17，dev 真实浏览器，e2e-alice）

- 编排会话在 dev 上实测：退役的维护通知回合不再出现在助理对话里；一次性迁移在 dev 部署时执行。
