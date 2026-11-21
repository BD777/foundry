# DEV-324 事项账本：事项有归属（home），Workspace 里的会话可以认领事项，帮手的信号按事项投递

2026-11-21 起。状态：已部署 dev（2026-11-21 04:48），Agent 实测通过（见下）；待本人验收、22:00 后提交 PR；D 试点已开始。

## 问题

- **事项和 Workspace 的关系不清楚。** 有的事项先于 Workspace 出现，有的跨多个 Workspace，有的不需要 Workspace，有的会长出一个新 Workspace。11-19 的草案让每个 Workspace 自带事项库，这几种情况都放不进去。
- **两套事项并存，互不知道。** 助理有 `pa_items`；foundry 仓库自己有 roadmap 和 DEV 编号。
- **帮手报告按父会话投递，父会话归档后报告直接丢弃**（`httpapi/child_reports.go`：`"the parent is archived"`）。本人常用的做法是开编排会话、用完归档，所以这个问题现在就会发生。

## 调查与决定

- 对比 Persona（nwverse/persona）和业界方案：`.foundry/reports/item-vs-workspace-20261120.md`。
- 方案：`.foundry/reports/item-ledger-plan-20261121.md`。
- 本人决定（2026-11-21）：
  1. 每人一本账本，事项的 home 可以为空。
  2. Workspace 不分 area / project，有没有终点只由事项表达。
  3. 本人在 Workspace 里直接开的编排会话可以认领事项。全局助理和 Workspace 范围的编排会话是同构的，只是范围不同。

## 切片

| 切片      | 内容                                                                                                                                                                              | 会话                                                                                                 | 状态                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 Server | home 字段（从 `plan.workspaceId` 迁移）、touches（读时推出）、holder 与认领；普通会话在本 Workspace 范围内可用 `read_list` / `update_list`；改归属；`create_workspace fromItemId` | `sess_1795192523516903349`；brief：`.foundry/briefs/dev324-a1-item-home-server.md`                   | 完成：定向测试在 CanWendeMac-mini 通过（sqlitestore、personalagent、httpapi 定向集、builtinskills、foundry-skill）；编排者已审 diff                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| A2 Server | 帮手信号按事项投递：先给 holder，不可达时给助理对话，再不行就排队，不丢弃                                                                                                         | `sess_1795194283343318639`；`dev324-a2-routing.md`（另含告警风暴根因、Workspace 会话的帮手可挂事项） | 完成：`assistant.SignalTarget` 统一五类信号（turn 报告、告警、转达提问、监督通知、needs_you 帮手提问），顺序 holder → 跟进任务的会话 → 信号原收件人 → 助理最新对话 → 排队（`pa_item_signals`，认领时或 5 秒检查投出）；Workspace 会话的帮手经 `pa_item_helpers` 挂事项（不进 `pa_tasks`）。告警风暴根因：失败轮次的告警发给「唤起本轮的会话」，父子互相唤起，失败轮次重排已带消息导致累计包；修复：只由 Foundry 消息唤起的轮次不发告警，同子会话同代码的待投告警合并计数。新测试 `TestItemHelperReportWaitsForTheNextHolder`、`TestItemHelperReportsToTheLiveHolder`、`TestQuotaFailuresDoNotStormAlerts`，回归通过 |
| B Web     | 事项页按 Workspace 筛选；Workspace 页显示事项；显示 holder                                                                                                                        | `sess_1795194285334979737`；`dev324-b-web.md`                                                        | 完成：事项详情「归属」（负责的工作区可改、也涉及、跟进的对话）、列表按工作区筛选、工作区概览「事项」面板；`plan.workspaceId: ""` 可清空 home（Server 小改动 + 测试）；去掉旧计划编辑器里重复的项目选择。Web typecheck、`items-ui.test.mjs` 13/13、生产构建、`audit:ui` 通过；scratch stack（live DB 副本，e2e-alice 合成事项）浅/深 × 1440/390 共 32 项检查通过，截图 `.foundry/attachments/dev324-b/`                                                                                                                                                                                                              |
| C Worker  | 把事项只读投影到 home 的 `.foundry/items/<id>.md`                                                                                                                                 | `sess_1795194287262723456`；`dev324-c-projection.md`                                                 | 完成：只投影 W 所在设备主人本人的事项（编排者审阅后要求收窄）；定向 Go 测试（`TestPersonalAgentItemChangesNameTheirHomes`、`TestItemFileRendersFactsAndSections`、`TestItemFilesFollowTheirHome`）与 Worker `workspace-file-write.test.mjs` 8/8 通过；已知限制：帮手状态只在开始/结束时刷新                                                                                                                                                                                                                                                                                                                         |
| D 试点    | foundry 的新工作建成 `home = foundry` 的事项                                                                                                                                      | 本编排会话                                                                                           | 已开始：第一个事项 `pai_ef8faed0638c4a37a2085a219f3a98c7`（DEV-324 本身），home=foundry，由本编排会话认领                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## 集成补丁

集成会话 `sess_1795205582297610224`，brief：`.foundry/briefs/dev324-integrate.md`。

- **删除 Workspace 时，事项回到收件箱。** 删除 Workspace 时，归属它的事项清空 home，每个事项记一条 `rehomed`（actor foundry）。这些事项如果正由该 Workspace 的会话跟进，一并释放，记 `released`。测试：`TestDeletedWorkspaceRehomesItsItems`。
- **Workspace 会话的帮手进入事项视图。** 经 `pa_item_helpers` 关联的帮手，出现在事项的帮手列表、touches、REST 详情和投影文件里。帮手开始、结束时分别记 `helper_started`、`helper_ended`。测试：`TestLinkedHelpersAreTheItemsHelpers`、`TestWorkspaceHelperShowsOnItsItem`。
- **修了 C 带进来的回归。** 原来设备每次重连，都要对每个 Workspace 发一次 `list_workspace_tree`。现在只查放过事项的 Workspace。测试：`TestItemFilesAskOnlyWorkspacesItemsLivedIn`。
- **合并后的整批检查全部通过：**
  - `generate-contracts --check`
  - 合同审计、模块边界审计
  - `prettier --check`（改动文件）
  - Go 定向：sqlitestore、personalagent、sessionalerts、builtinskills；httpapi 分四批跑
  - 改动包的 `go vet`
  - Web：typecheck，`items-ui.test.mjs` 13/13，生产构建，`audit:web-ui`
  - Worker：`workspace-file-write`、`foundry-skill` 共 13/13

## 部署

- **构建：** `.foundry/builds/dev324-20261120T203718Z/`，base `7df58eb4`，diff sha256 `8b5c2000…`，source manifest sha256 `d782b215…`。
- **数据库备份：** `~/.foundry/server/backups/foundry-20261121-pre-dev324.db.gz`。用 sqlite 在线备份，`integrity_check` 结果为 ok，`pa_items` 34 行。
- **2026-11-21 04:48 `deploy-dev.sh`：**
  - Server `0f58d47a2881`。SIGHUP 交接，新 pid 接管；回滚用 `foundry-server.pre-dev324`。
  - Web `b1913055daad7c68`。原来的 `a576901d96be4366` 存在 `releases/dev324/previous-*`。
  - Worker 包 `.1795207038`。回滚用 `release.json.pre-dev324`。
  - 脚本报告「新源码不含 live 源码」。逐个核对过，被替换的文件全部在 DEV-324 的 diff 里，没有覆盖别人已上线的改动，之后才加的 `--replaces`。
- **设备：** sg-chaos 用 `update_worker` 更新，20:49:07Z 成功，在线，版本为 `.1795207038`。21:04Z 又更新了另外五台，全部成功，在线，版本 `.1795207038`：byte-dev（21:04:21Z）、byte-dev-sg（21:04:19Z）、limen-canada（21:04:35Z）、CanWendeMac-mini（21:04:37Z）、cottoncpp（21:04:58Z），原版本都是 `.374.gaa552d8c.…1795094247`。macbook 当时离线，没有更新，等它上线后再更新。

## 决定与完成标准切片（2026-11-21）

- **问题（试点 E2 基线 4/10）：** 新会话只读事项文件接手时，缺本人的决定、完成标准；进展与证据两节为空，信息都挤在摘要里；摘要过时。
- **做法：**
  - 本人的决定是时间线里的 `decided` 事件（只追加；`update_list op decide`：decision、本人原话 quote、supersedes），原话按 `stated` 同一规则核对，不在本对话本人的话里就拒绝；会改变事项含义，所以 revision 前进。
  - 完成标准放进计划：`plan.acceptance`（≤ 12 条，每条 ≤ 300 字）；写计划时不带它就保留原有的，`[]` 清空。没有证据不能标完成是原有规则，不变。
  - 事项文件增加「决定」（带 id，被取代的划掉）与「完成标准」两节；文件头写明 claim 会替换 holder、decide 记决定。
  - Web：事项详情增加「决定」一节，计划显示完成标准，时间线显示决定。
  - 技能：foundry 与助理清单技能写明「让下一个会话只靠事项就能接手」：计划各字段保持最新、决定用 decide、摘要只放上下文。
- **检查：** 新测试 `TestPersonalAgentItemDecisionsAppendAndSupersede`、`TestWorkspaceSessionRecordsDecisionsAndAcceptance`、`TestItemFileListsDecisionsAndAcceptance`；httpapi 整包（CanWendeMac-mini，525 s）通过；Web typecheck、`items-ui.test.mjs` 13/13；契约、模块审计、prettier、gofmt。
- **CI 发现的两处 DEV-324 遗漏（已修，PR #287）：** `read_list` 的测试仍认为不该有 `revision`（试点有意加上）；没有助理时日报读事项页被拒（`digestItems` 改为空）。教训：合入前跑 httpapi 整包，不只定向测试。
- **部署 2026-11-21 10:55（UTC+8）：** 构建 `.foundry/builds/dev324c-20261121T025028Z`（base `c403c414` + 本切片）；Server `f3f1ca640179`（回滚 `foundry-server.pre-dev324c`）、Web `1f3241e5cd93122b`（原 `b1913055daad7c68` 在 `releases/dev324c/previous-*`）、Worker `0.5.7-dev.379.g0c403568`。替换前逐个核对：与 live 不同的 27 个文件全在 DEV-324 之后的改动里。设备：sg-chaos、byte-dev、byte-dev-sg、limen-canada、CanWendeMac-mini 已更新；cottoncpp 更新中；macbook 离线。
- **设计取舍：** 不把「派活的一方不能自己验收」做成硬规则（完成仍由 Agent 判断，Foundry 只强制「没证据不能完成」）；独立核验作为技能里的建议（只读 verification 会话对照完成标准）。

## Agent 实测（2026-11-21 04:55–04:57，真实 dev，本人账号，foundry 工作区）

1. 本会话（`sess_1795189068394754005`，本人在 foundry 里开的编排会话）在新的 Worker 上运行，工具清单里出现了 `read_list` / `update_list`。
2. 用本人 11-21 的原话新建事项 `pai_ef8faed0638c4a37a2085a219f3a98c7`（「DEV-324 事项账本：事项基座做好并在 foundry 试点」）。home 自动设为 foundry，原话核对通过。这也是 D 试点的第一个真实事项。
3. `claim` 成功，holder 为本会话。
4. 约 2 秒后出现 `foundry/.foundry/items/pai_ef8f….md`，frontmatter 与各节齐全。该文件已被 `.git/info/exclude` 排除。
5. 派出子会话 P（`sess_1795208133641713390`），P 再用 `create_session itemId` 派出帮手 H（`sess_1795208140280086711`，`sleep 90`）。H 开始后，文件的帮手一节和时间线出现 `helper_started`。
6. H 运行期间把 P 归档。20:57:15Z H 完成，报告送到了本会话，注明「works on item … that this session follows」。修复前，这份报告会因为 `the parent is archived` 被丢弃。
7. H 结束后，文件里 H 的状态变为 done，时间线多了 `helper_ended`。P、H 两个会话都已归档。

## 验收步骤（本人）

1. **事项详情：** 打开 dev 的「事项」页，找到「DEV-324 事项账本：事项基座做好并在 foundry 试点」。
   预期：详情里的「归属」显示负责的工作区为 foundry，跟进的对话是本编排会话；时间线里有创建、开始跟进、帮手开始和结束的记录。
2. **Workspace 概览：** 打开 foundry 工作区的「概览」。
   预期：「事项」面板的「归属这里」一组里有这条事项，点击后进入事项详情。
3. **改归属：** 在事项详情点「更改」，把它移到「助理的收件箱」，再改回 foundry。
   预期：时间线出现两条归属变化；`foundry/.foundry/items/` 里的文件先消失，改回后又出现。
4. **列表筛选：** 在事项列表用「全部工作区」下拉框选 foundry。
   预期：只剩归属或涉及 foundry 的事项。
5. **（可选）编排会话的用法：** 在 foundry 新开一个对话，让它认领一个事项、派出帮手，然后归档这个对话，再新开一个对话认领同一个事项。
   预期：帮手的报告送到新对话，没有丢失。

## 试点发现

1. `read_list` 不返回 `revision`，而 `update_list op:update` 要求带上它。Agent 只能猜（本次猜 1 恰好对了）。已修：`read_list` 的事项视图加了 `revision`，工具描述写明要把它传给 `update_list`，测试 `TestWorkspaceSessionKeepsItsWorkspaceItems` 增加了断言（byte-dev 上 remote-check 通过）。2026-11-21 05:03 部署 Server `4277cf08a9f7`，构建 `.foundry/builds/dev324b-20261120T210118Z`，回滚用 `foundry-server.pre-dev324b`。实测 `read_list` 返回 `revision: 2`。
2. 编排会话自己建的事项，`origin.kind` 记成 `web`。这是因为这个会话是本人从网页开的，事实上没有错，但看不出事项是在会话里建的。观察中，暂不改。

## 准出标准（事项基座整体；本人 2026-11-21：「你这个loop的目标要以准出为导向」）

每条都在 dev 上验证，证据写在本节下面的「准出记录」。全部通过，事项基座才算完成。

| # | 标准 | 怎么验 | 状态 |
|---|---|---|---|
| E1 | 换会话不丢：挂在事项上的帮手，父会话归档后报告送到 holder；换了 holder 送到新 holder；holder 不在时送到助理对话；都不可达时排队，下一个认领者收到 | dev 实测前两条；后两条按设计不在真实账号上强造（会把报告投进本人的助理对话），由定向测试 `TestItemHelperReportWaitsForTheNextHolder` 覆盖 | 父会话归档后送到 holder：已过（11-21 04:57、11:0x）；换 holder：待验 |
| E2 | 只靠事项接手：全新会话只被告知「继续 X」，自己找到事项，只读事项文件就说清目标、做到哪、下一步、完成标准、本人的决定 | 只读验证会话按固定提示自评，**≥ 8/10**，缺失清单里没有这五项 | **通过**：基线 4/10（11-21 10:18 UTC+8，`sess_1795227439976768811`）→ 8/10（11:03，`sess_1795230108562042022`，Limen opus high） |
| E3 | 决定有记录：本人的决定逐条记下原话，原话核对不过就拒绝，后来的决定可以取代前面的；事项文件和 Web 都能看到 | 定向测试 + dev 上真实记一条、取代一条，看文件与 Web | 服务端与文件：通过（11-21 11:00）；Web：浏览器验收中 |
| E4 | 做完有依据：事项有完成标准；没有证据不能标完成；完成标准和证据并排可见 | 定向测试 + dev 上一个真实事项从开到关 | 实现中 |
| E5 | foundry 试点真实可用：至少 3 个真实的 foundry 事项走完「建 → 换会话 → 关」 | 事项页与时间线 | 1 个进行中 |
| E6 | 不破坏已有的：CI 全绿合入 main；dev 部署后健康；Worker 全部在线设备更新 | CI、`/healthz`、`update_worker status` | DEV-324 主体 PR #287 CI 修复中 |
| E7 | 守住哲学：没有新增往 Agent 里注入的引导（只有文件投影与技能里的一次性说明）；语义判断（建不建事项、算不算做完、记不记决定）都留给 Agent，Foundry 只校验原话、revision、证据存在 | 审 diff | 每个切片合入前自查 |

### 准出记录

（每条通过时补：日期、构建版本、会话或截图、结论；时间均为 UTC+8）

- **E2（11-21 11:03，Server `f3f1ca640179`）**：同一固定提示，全新只读会话（Limen opus high）自评 8/10，原话「目标、进展、下一步、完成标准、决定这五项都齐了；上面缺的都是执行层面的状态」。基线（10:18）缺的 9 条里，决定、完成标准、进展/证据为空、内容过时、认领约定都已补上；剩下的缺口：E1–E7 逐条状态、分支与 PR 现状、试点事项清单、旧会话收尾结果、设备更新现状、时区不统一。这些是负责人该维护的执行状态（语义内容，归 Agent），不加机制，由本会话在事项上补齐。
- **E3 服务端与文件（11-21 11:00，Server `f3f1ca640179`）**：本会话用 `update_list op decide` 记下本人 6 条真实决定（原话核对通过），第 6 条 `pie_cf631166…` 取代第 5 条 `pie_6c51eebd…`；事项文件「决定」一节按时间列出、被取代的一条划掉并注明取代者。编造的原话（「不用验收，直接合入」）和漏了一个字的原话都被拒绝（「not recorded: the quote is not in anything the person wrote in this conversation」）。另：把仍在运行的本会话当作 session 证据被服务端拒绝（「completion evidence must point to a completed current input」），符合设计。


## 下一步（本人 2026-11-21：按建议，先试点再补决定与证据）

1. 试点：foundry 的新工作建成事项；专门验证「新会话只读事项文件接手」，找出事项文件缺什么。
2. 决定记录：只追加的决定列表（原话核对沿用 `stated`）。
3. 证据与验收：完成标准、Worker 采集的证据、派活的一方不能自己验收、独立判定。

## 已知限制

- 帮手状态只在开始和结束时刷新到文件，中间从运行变成等待之类的变化不会反映。
- 经 `pa_item_helpers` 关联的帮手只用于显示和投递：不会阻止事项归档，事项归档时也不会归档这些帮手会话，不进入日报。
- 删除设备时会清空 home 和 holder，但不记事件。
- 设备离线期间删除的事项：如果所在 Workspace 没有别的事项，旧文件要等下次那里有事项变化时才会清理。
- 一个已经开着的会话，要到它下一轮运行在新 Worker 上时，才能拿到事项工具。
- 额度用尽导致的失败仍按 30 分钟的节奏重试。本人 2026-11-21 决定不改：「实在耗尽了，我来处理呗。」
