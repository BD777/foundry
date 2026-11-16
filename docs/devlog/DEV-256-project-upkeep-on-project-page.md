# DEV-256 项目维护放进项目页；助理只保留自己的记忆整理

状态：已部署 dev（train18/19-20261117）；Agent 代验收（2026-11-17，范围见验收记录）；已合入 main（PR #273）。

## 问题

本人在 ByteWork 的 Web 对话里看到三条「Foundry notice · 项目维护：6 个项目共 8 条修改建议…（链接到默认助理的设置）」，回复都是「没有新情况」。本人的判断：「几个 background 跑的功能，几个 upkeep，它们的信息应该独立放在别的地方，不应该在这个 session 里。」

事实：这些 notice 来自 DEV-252 之前（最后一条 15:41 UTC+8，DEV-252 之后不再推送）。残留的根因是：项目整理（`governance`：项目的目的、`AGENTS.md`/`README` 的修改建议）按 `assistant_id` 存在 `pa_maintenance` 里，在默认助理的设置 →「维护」里审阅；但它不属于任何助理。

## 设计（编排会话已批准，含以下决定）

- 项目维护属于项目：在项目页（工作区概览）审阅，仅拥有者可见，与助理是否运行无关。
- 助理只是执行者：`assistant_id` 记录最近一次运行。删除助理不删除项目审阅与建议修改；审阅运行时解析本人当前的默认助理，不同则改绑；没有默认助理时保持等待，原因 `no_default_assistant` 显示在项目面板上。
- 待确认 = 未决的建议修改（冲突也算未决）。已应用的不计。
- 等你处理：每人每个项目一项（`project_upkeep`），标题是项目名，文案「<项目>：N 条修改建议待确认」，唯一动作「打开项目」，链接到项目页。
- 记忆整理（`memory`，人与各助理的记忆层）仍在助理设置里。
- 任何项目维护状态都不进入对话；助理需要时自己读 `.foundry/upkeep.md` 与项目文件。
- 不做数据迁移：现有 `governance` 行直接按工作区可见。

## 实现

Server：

- `store/pending_items.go`：新来源 `PendingSourceProjectUpkeep`；`PendingItem.Count`（按条数计数的项，如项目维护的未决建议数），随 payload 保存，更新时复制，参与同一性比较。
- `httpapi/pending_upkeep.go`（新）：`reconcileUpkeepPending`，随等你处理列表读取时对账（与 DEV-254 的收件箱项同一模式）。
  - 项 key：`upkeep:<人>:<项目>`，按人区分，因为项目由成员共享，项 key 不带人会互相覆盖。
  - 事件（episode）：仍有未决建议的最新审阅 ID。新审阅 → 新事件；已关闭的项遇到同一事件保持关闭。
  - 计数：未决建议数；项目名为标题，首条未决建议的理由作摘录。
  - 关闭（`done`，`auto_resolved`，`decided`）：未决数归零、项目归档、或本人不再拥有该项目。
- `sqlitestore/personal_agent_maintenance.go`：`ListReviewingWorkspaceMaintenance`（本人全部处于 `review` 的 `governance` 审阅，新的在前）。
- `httpapi/pending_items.go`：列表读取时先对账项目维护，再对账收件箱。
- `httpapi/workspace_upkeep.go`、`routes.go`、`personal_agent.go`：（同前）项目维护的 owner 路由；删除助理侧的补丁路由。
- 删除助理侧栏的维护行：`store/personal_agent.go` 的 `Maintenance` 字段与 `PersonalAgentMaintenanceWaiting`，`personalagent/assistant/assistant.go` 的 `maintenanceWaiting` 与调用，`packages/protocol/src/personal-agent.ts` 的 `maintenance` 与类型。

Web：

- `features/pending/upkeep-item-card.tsx`（新）：项目维护的等你处理卡片，图标 `FilePenLine`，标题 `upkeep.title`（按人数选单复数），一行说明，按钮「打开项目」（`navigateAppRoute({ view: "workspace" }, workspaceId)`）。
- `features/pending/pending-item-card.tsx` 分派到该卡片；`pending-model.ts` 的 `pendingPrimary` 对该来源返回 `none`；`api/pending.ts` 的 `PendingSource` 与 `count?` 字段。
- `features/personal-agent/assistant-side-card.tsx`：删除 `MaintenanceWaitingSection`（含 `SlidersHorizontal` 与协议类型的导入）；`assistant-home.tsx` 删除 `maintenance` 的传递与渲染。
- `features/personal-agent/settings-maintenance.tsx`：只显示本助理的「记忆整理」（同前）。
- i18n（中/英）：`pending` 的 `source.project_upkeep` 与 `upkeep.*`；`personalAgent` 删除 `home.maintenance.*`（侧栏已无用途）；`maintenance.title/description/boundaries` 改为记忆整理文案，新增 `maintenance.reasons.no_default_assistant`；`workspaces.upkeep.*`。

文档：`docs/assistant-orchestration.md` 增加「项目维护与记忆整理的归属」段，并更新项目整理行。

测试新增与更新：

- `httpapi/pending_upkeep_test.go`（新）：`TestUpkeepUndecidedCountsOnlyChangesNotYetSettled`（已应用不计、冲突与未应用计入、驳回归零）；`TestProjectUpkeepIsOneNeedsYouItemPerEpisode`（一项、计数 2、重复读取不改写、决定后关闭、新审阅新项）。
- `httpapi/personal_agent_project_upkeep_test.go`（新）：`TestProjectUpkeepRunsOnTheCurrentDefaultAssistant`、`TestProjectUpkeepWaitsWhenThePersonHasNoDefaultAssistant`。
- `sqlitestore/personal_agent_maintenance_test.go`：`TestProjectUpkeepSurvivesItsExecutorAndIsReadByWorkspace`。
- `test/pending-items.test.mjs`：`a project's suggested changes are one item…`（卡片文案、单个按钮「打开项目」）。
- `test/assistant-side-card.test.mjs`：删除维护行的用例。
- 更新既有测试到新接口或新链接（同前列表），以及 `TestMemorySortFirstRunIsOnceAndSurvivesAStoppedDefault`、`TestMemoryReviewReadsOneVault`。

## 验证

全部在 CanWendeMac-mini 上运行，远端 checkout 为 `41e94582` 加最终 DEV-254 与本补丁：

- Go httpapi：`-run 'TestUpkeepUndecided|TestProjectUpkeep|TestPending|TestInbox|TestFailedInbox|TestTurnFailure|TestMaintenance|TestGovernance|TestUpkeepFacts|TestAnOfflineTarget|TestArchivedTargets|TestFailedReviews|TestMemory'`：ok（20.4s）。
- Go sqlitestore：`-run 'TestPending|TestProjectUpkeep|TestMaintenance'`：ok。
- Go personalagent/assistant：`-run 'TestUpkeep|TestDueDigestFacts|TestMaintenance'`：ok。
- Web typecheck（`tsc --noEmit`）：PASS。
- Web 测试（6 个文件：`pending-items`、`assistant-side-card`、`personal-agent`、`workspace-overview-access`、`assistants-web`、`i18n`）：79 个测试，78 通过，0 失败，1 跳过（`pending-items` 中按 Issue 显示/隐藏的特性开关变体，既有写法，二选一执行）。
- Web `pnpm audit:ui` 全部通过；prettier --check（改动的 web、protocol 文件）：通过。
- `dev256.patch` 在最终 DEV-254 之上：`git apply --cached --check` 通过，应用后与工作区树一致。

过程中由这些检查抓出并修正的问题：

- Go 测试 `TestProjectUpkeepIsOneNeedsYouItemPerEpisode`：第一次保存后未取回新 revision，二次保存报 `personal agent record changed`。是测试问题，不是产品问题，已改为接收保存返回值。
- Web 类型：`PendingSource` 联合类型缺少 `project_upkeep`；侧栏残留未使用的 `ContextRow` 导入。
- i18n 测试：英文 `title_one` 缺少 `{{count}}` 占位符，与中文不一致，已补齐。
- 早先已修正：项目维护客户端路径缺 `/api` 前缀；`DeleteAssistant` 引用不存在的 `job_id`；设置页使用不存在的 i18n 键；`TestUpkeepFactsAreWrittenNotSent` 期望旧链接；预览测试测已移走的界面。
- main `41e94582` 上已有的 `test/assistants-web.test.mjs` 失败已单独修复（不在本补丁内，见 `dev256-assistants-web-menu-settle.patch`）：行菜单在菜单关闭时才执行所选动作，测试同步查询对话框，修正为点击后 `settle()`。
- Go 测试 `TestMemoryUpkeepIsOneNeedsYouItemPerAssistant` 两次失败，都是测试问题：两层放在同一工作区时，后一次审阅按既有规则取代前一次（统计只剩 1 条）；助理名为空时标题回退为助理 ID。测试改为两层分置两个工作区，并与回退规则对齐。
- 记忆整理等你处理项的定向检查：httpapi targeted（含 `TestMemoryUpkeepIsOneNeedsYouItemPerAssistant`）ok；sqlitestore、web typecheck、web 测试（79 个，78 通过，1 跳过）、audit:ui 与 prettier 均通过。

## 记忆整理的等你处理项

本人要求：记忆层的修改建议不能只藏在设置里，要和项目维护一样进入等你处理。

- 每个助理一项（`memory_upkeep`，key `memory_upkeep:<人>:<助理>`）。标题是助理名，文案「<助理名>：N 条记忆整理建议待确认」，唯一动作「打开记忆整理」，打开该助理设置的 `activity` 区段（记忆整理面板所在处）。
- 计数：该助理两层记忆（人的层与它自己的层）的审阅中尚未忽略的建议数。事件是最新一次审阅；忽略全部审阅后关闭，新审阅开新一项。
- 实现：`httpapi/pending_memory.go`（新，对账模式同项目维护，复用 `pendingOpenKeysOf` 与 `pendingExcerptLimit`）；`store.ListReviewingMemoryMaintenance`；Web 的 `MemoryUpkeepItemCard` 与项目卡片共用 `UpkeepRow`。
- 既有规则需要注意：新的记忆审阅会把同一工作区里处于 review/complete/failed/dismissed 的旧记忆审阅置为 superseded（`sqlitestore` 的 enqueue）。两层若位于同一工作区，只有最后一次运行的那层留在等你处理里。两层各自的工作区由调用方决定，需要在 dev 上核对。

## 验收步骤（人工，dev 部署后）

1. 有待确认修改建议的项目：等你处理页出现「<项目>：N 条修改建议待确认」，「打开项目」进入该项目页。
2. 在项目页应用或不处理全部建议后，刷新等你处理页：该项消失。
3. 助理侧栏不再显示「维护」行；记忆层有待确认的建议时，等你处理出现「<助理名>：N 条记忆整理建议待确认」，「打开记忆整理」进入该助理设置的记忆整理面板。
4. 该项目有新一轮审阅并产生建议时，等你处理页出现新的一项。
5. 亮/暗/窄屏与键盘下的项目维护面板和等你处理条目（编排会话检查）。

## 剩余动作

1. 真实浏览器检查（编排会话，部署后于 dev 上，e2e-alice 合成数据）：项目页「项目维护」面板，以及等你处理的「项目维护」条目。
2. 未部署，未提交。

## 限制

- 旧回合显示的清理属于 DEV-260，不在本条范围。
- 冲突的建议修改只能先「不处理」整条审阅再由人重新处理，无单条解决入口（与改动前一致）。等你处理的项只能在项目页关闭，没有列表内的单条动作。
- 记忆层的修改建议不再出现在侧栏，改由等你处理按助理汇总（见「记忆整理的等你处理项」）；审阅本身仍在助理设置的记忆整理里完成。
- 等你处理项在读取列表时对账，不推送；列表刷新后才出现或关闭。
- 记忆审阅按工作区互相取代（既有行为，保留）：新的记忆审阅会把同一工作区里处于 review/complete/failed/dismissed 的旧记忆审阅置为 superseded。两层若位于同一工作区，只有最后一次运行的那层计入「记忆整理」等你处理项。dev 上目前只有 e2e-alice 有记忆审阅（按家工作区区分），本人的助理尚无记忆审阅，因此未观察到此情况。
- 记忆整理的 sorting 记录（记忆页的「建议共享」，带确认/忽略）不在本条范围，作为后续项。
- 过程事故：rebase 到最终 DEV-254 时，误删了三个未纳入备份的新文件（`pending_upkeep.go`、`pending_upkeep_test.go`、`upkeep-item-card.tsx`）。已依据会话内容重建，并以上述定向检查确认。

## 验收记录（Agent 代验收，2026-11-17，dev 真实浏览器，e2e-alice）

- 编排会话在 dev 上实测：等你处理显示项目维护项「<项目>：N 条修改建议待确认」与记忆整理项，「打开项目」打开项目面板；维护分组修复随 train 19 上线并在 dev 验证。
