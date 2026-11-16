# DEV-248 助理侧栏：等你处理的计数与页面一致、没处理的消息可「不再处理」

2026-11-16。本人截图（`.foundry/attachments/20261116/att_dmwes6621x7y_0_image.png`）与三处反馈：

> needs you 面板里没有东西，这里也写着 All 0，但里面有一项，古怪。
> unprocessed message 没法删掉，那个消息我不打算 resume 的。
> your list 是什么逻辑？

状态：已部署 dev（train12-20261116）；Agent 代验收（2026-11-16，范围见验收记录）；已合入 main（PR #271）。本项仅以定向测试、web typecheck 与合成数据截图验证，未做真实检查。

## 问题

1. 助理首页侧栏显示「Needs you · this assistant 1」，同一行的「All 0」，但全局「等你处理」页没有这一项：一项
   「dev8 的 7378473609 有 2 个文…」（ccm-omh-integration）只在侧栏出现，两处计数互相矛盾。
2. 「Unprocessed messages」里失败的消息只有 Retry / 查看上次尝试，本人不打算再处理时无法从卡片移除。
3. 「Your list」与「What I'm doing」里出现同一件事，需要说明来源、关闭方式和两者差异（本项只解释，不改行为）。

## 调查（#1）

只读打开 `~/.foundry/server/foundry.db` 的副本（不改动）：

- 那一项是 `pnd_d621a689-5258-4bc9-b1bd-b29e13948da6`，`user=windeng`，`workspace=ws_56c549f3…`（ccm-omh-integration），
  `session=sess_1793268219911889038`，`source=question`，`handler=person`，`assistant_id=''`，创建于 2026-10-29。
- 它的会话在 2026-11-01T14:39:45Z 被归档：`chat_archives` 同时有 `id:sess_1793268219911889038` 和
  `native:codex:01a1871d-…` 两个键。
- 全局页（`handleListPendingItems`）在 `session.ArchivedAt != ""` 时 `continue`，所以 `open=0`；
- 助理卡片（`assistant.PendingFor`）只按权限包列 open 项、再筛 `handler=person`，**没有检查会话是否仍可见**，所以是 1。
- 因此不是 handler 判断错：该行确实是人的事项（创建于 DEV-236 之前，旧 Foundry 按 10 分钟截止交给本人），
  只是它所在的对话三天后被归档；**两个查询的范围/过滤不一致**才是根因。用新查询在只读副本上复核：
  原始 open 行 1 条，可见会话的 open 行 0 条。

## 改动

### 一个查询、一个「需要人处理」的定义

- `sqlitestore` 新增 `ListVisiblePendingItems`（`apps/server/internal/sqlitestore/pending_items.go:490`），与
  `ListPendingItems` 共用 `listPendingItems`（:494）；`visible` 时排除会话已归档或已删除的项
  （复用 `archivedSessionSQL` / `visibleAgentSessionSQL`），没有会话的账号/连接器项保留（:517）。
- 助理卡片 `assistant.PendingFor` 改读它（`apps/server/internal/personalagent/assistant/needs_you.go:30`）。
- 全局页及其 `open` / `assistantOpen` 计数改读同一个方法（`apps/server/internal/httpapi/pending_items.go:504`）。
  两处现在对「哪些项需要人处理」只有一个定义；等待助理处理的项仍按 handler 过滤，不会显示成「Needs you」。

### 点击事项改为新标签页

- 侧栏事项行改为真正的链接：`ContextLinkRow`（`apps/web/src/components/ui/context-card.tsx:168`），
  指向 `pendingHref()`（`apps/web/src/lib/in-app-navigation.ts`），`target="_blank"`、`rel="noopener"`
  （`apps/web/src/features/personal-agent/assistant-side-card.tsx:153`）。标题行的「All」仍在原页打开。

### 没处理的消息可以「不再处理」

- 复用既有的 `cancelled` 收件箱状态：它本来就是一次重试后旧尝试留下的状态，队列不再投递，卡片不再显示。
- `pa_inbox` 新增 `dismissed_by` / `dismissed_at`（幂等迁移），记录是谁、何时放弃这条消息。
- 新的 store 方法 `DismissPersonalAgentInbox`（`apps/server/internal/sqlitestore/personal_agent_inbox.go:280`）：
  校验当前 revision；`dispatching` 或仍可能成功/在跑的投递拒绝；其余标记 `cancelled`，保留原文和失败结果。
- 服务层 `DismissInbox`（`apps/server/internal/personalagent/assistant/inbox.go:430`）；现有 action 端点按
  `action=dismiss` 分派（`apps/server/internal/httpapi/personal_agent.go:407`），没有新增路由。
- 卡片在 Retry 旁加「不再处理」（英文「Don't process」），失败和等待中的消息都有；成功后该项立即从卡片消失。

### #3 只解释，不改

见下节。

## 「Your list」的逻辑（#3）

- **来源**：`pa_items`（`apps/server/internal/sqlitestore/personal_agent_list.go:23`）。只有助理的 `update_list`
  会写它（`apps/server/internal/personalagent/assistant/list.go:58`，`add` :69、`update` :80）；写入的 text / when /
  at / remind / status 必须引用本人在当前对话里说过的话（`QuoteGrounded`，:158），助理自己的任务可以
  `item.taskId` 关联（:132-137）但不算本人的话。
- **谁添加/关闭**：助理添加和更新；本人在首页勾选完成/取消完成（`apps/web/src/features/personal-agent/use-assistant.ts:228`）、
  编辑（`apps/server/internal/httpapi/personal_agent.go:524`）、删除（:537）。关闭时 `ClosedAt` 在 store 里打时间戳
  （`apps/server/internal/sqlitestore/personal_agent_list.go:188-190`）。助理也可以把事项标成 done，但必须带完成证据
  （`list.go:165-177`），单独的会话结束不算。
- **Done today**：只显示 `status=done` 且 `closedAt` 晚于本地当天 0 点的事项（`apps/web/src/features/personal-agent/person-list-model.ts:19-32`；
  本地日起点 :11）。不是「最近 24 小时」，也不是服务器时区。
- **What I'm doing**：`pa_tasks`（`apps/server/internal/sqlitestore/personal_agent.go:63`）里的助手任务，不是清单事项。
  助理启动一个 helper 会话时 `RecordAssistantTask` 写任务（`apps/server/internal/httpapi/session_ports.go:92` →
  `assistant.RecordTask`）；卡片显示 active（queued/running/asking）以及最近 24 小时内结束的任务
  （`apps/web/src/features/personal-agent/assistant-model.ts:447-463`，`task-list.tsx:46-108`）。每行可打开 helper 会话或单独停止。
- **为什么同一件事出现两次**：`dispatch_item` 成功后会把它创建的 helper 任务写回事项的 `item.TaskID`
  （`apps/server/internal/personalagent/assistant/operations.go:353-359`）；首页再把任务标题换成关联事项的原文
  （`apps/web/src/features/personal-agent/assistant-home.tsx:185-194`），事项行也有「helping」链接
  （`apps/web/src/features/personal-agent/person-list.tsx:336`）。所以「查 llm-gateway 最近一次部署」既是本人清单里的完成项，
  也是这次请求对应的 helper 任务：前者是**要做的事和结果**，后者是**助理实际派出去的工作**。
- **建议**：不要合并，改清楚两者的角色即可。清单是助理对本人请求的跟踪（有些事项没有任务，例如纯记录/提醒）；
  任务是执行单元（有些工作不来自清单，例如后台/定时/频道工作）。最小改法是把「What I'm doing」改成
  「Helpers / Work in progress」这类执行语义，并在任务行注明「为清单事项 X 执行」；清单行保留结果和完成时间，
  用已有的「helping」链接跳到执行会话，避免两处重复同一标题让人以为是两件事。

## 验证

- Go 定向测试（CanWendeMac-mini）：
  - `./internal/sqlitestore -run 'TestInbox|TestVisiblePendingItems'` PASS；
  - `./internal/httpapi -run 'TestNeedsYou|TestAssistantInbox'` PASS；
  - `./internal/personalagent/assistant` PASS。
  - 新增 `TestNeedsYouAndThePersonListHideItemsOfGoneSessions`：卡片与可见列表为 0，原始查询仍有该行；
  - 新增 `TestVisiblePendingItemsHidesArchivedSessions`：同一行在有归档标记后被可见查询排除，无会话的账号项保留；
  - 新增 `TestInboxDismissCancelsAHeldMessageAndRecordsWho`：失败项变 `cancelled`、记录 dismissed_by/at、重复调用幂等、
    旧 revision 与 dispatching 状态被拒。
- Web：`tsc -p tsconfig.json --noEmit` PASS、`test/i18n.test.mjs` PASS（CanWendeMac-mini）；
  `pnpm audit:ui` 全部 audits PASS（本机）。
- e2e（scratch stack 从本 worktree 构建，e2e-alice + 合成行，浅色 1440×1100，deviceScaleFactor 1）：
  - 合成数据：2 条 open 项——一条指向 `sess_1794517142738224301`（ws_4e5616b1，2026-11-12 已归档），
    一条指向未归档的 `sess_1794173366864468910`；1 条失败的 `pa_inbox` 消息。
  - 修复前的「1 vs 0」由本人截图（`.foundry/attachments/20261116/att_dmwes6621x7y_0_image.png`）与只读副本上的
    “raw open=1 / visible open=0” 复核共同证明；
  - `dev248-side-card-after.png`：卡片「等你处理 1」、全局 `pageOpen=1`，`cardTitles` 只有未归档的那条；
    数据库里仍是 2 条 open（归档那条被可见查询排除），两处计数一致；
  - 事项链接属性为 `href=/pending`、`target=_blank`、`rel=noopener`；Playwright 点击后新开
    `http://127.0.0.1:49041/pending`；
  - `dev248-side-card-after-dismiss.png`：点击「不再处理」后「没处理的消息」整段消失（`dismissButtonsAfter=0`），
    其余卡片内容不变；
  - dismiss 后的 `pa_inbox` 行：`status=cancelled`、`revision=3`、`result_status=failed`（保留失败原因）、
    `dismissed_by=user_2d0a1449-…`、`dismissed_at=2026-11-16T06:37:44.236394047Z`。

## 验收步骤

1. 打开一个有归档会话遗留 open 项的助理页：侧栏「Needs you」与「All」计数一致，归档项不显示；活跃会话里的项两处都显示。
2. 侧栏点一条「Needs you」事项：在新标签页打开 `/pending`，原页不跳转。
3. 「Unprocessed messages」里失败或等待中的消息：Retry 旁有「不再处理」；点击后该项从卡片消失。
4. 数据库/接口确认该消息 `status=cancelled` 且记录 `dismissed_by`、`dismissed_at`。
5. 「Your list」「Done today」「What I'm doing」行为不变（本项未改 #3）。

## 限制

- 归档/删除会话的 open 项只是**不再显示**，没有自动改成 resolved；它们此前在全局页也一直不显示，本轮不改写历史数据。
- 「不再处理」在 `dispatching` 或投递仍可能成功时拒绝（需要等这次尝试结束），避免把正在跑的回合藏起来。
- DEV-236 之前由旧截止逻辑交给本人的项仍是 `handler=person`；本轮不重新判断历史项的归属。
