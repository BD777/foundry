# DEV-324 事项账本：事项有归属（home），Workspace 里的会话可以认领事项，帮手的信号按事项投递

2026-11-21 起。状态：准出标准 E1–E7 全部在 dev 上通过（Agent 自验，见「准出记录」）；已合入 main（PR #287 `c403c414`、#288 `ac4e72b9`、#289 `ed6731d3`）；dev 为 Server `5bdd4e24e1dc` / Web `94480578b2b159df` / Worker `0.5.7-dev.379`；本人委托 Agent 在本人浏览器里代验收，1–4 步于 2026-11-22 全部通过（见「本人验收」）；验收中发现的事项页 404 已修复（PR #291）。

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

在 dev 的真实浏览器里做，约 10 分钟。事项都已关闭，工作区概览的「事项」面板只列进行中的事项，所以那里是空的属正常。

1. **事项详情：** 打开 `https://dev.foundryapp.app/assistant/items/pai_ef8faed0638c4a37a2085a219f3a98c7`。
   预期：状态「已完成」，归属 foundry；「决定」一节按时间列出本人的决定，每条下有本人原话，「交还旧会话」那条划掉并标「已被取代」；「计划」里有完成标准 E1–E7 与完成依据；时间线有「决定：…」、认领与换人认领、帮手开始和结束。
2. **试点事项：** 打开 `…/assistant/items/pai_873966fdbca14196bc4549343462790d`（CHAT-6）。
   预期：已完成，3 条完成标准，3 条完成依据（帮手会话、构建、dev 实测）。
3. **新对话只靠事项接手：** 在 foundry 新开对话，不给 id，只问「DEV-324 事项账本这件事现在什么状态？我做过哪些决定？还有什么没做？」。
   预期：它自己找到事项（`read_list` 或 `.foundry/items/`），说清 E1–E7 已通过、在等验收，列出决定（含被取代的那条），说出遗留限制。
4. **记一条决定：** 在同一对话里说一句真实的决定并让它记成 DEV-324 的决定。
   预期：事项详情的「决定」多一条，带你刚说的原话。
5. **告诉 Agent 结果**（或批注不对的那一步）。

## 本人验收（Agent 代验收，2026-11-22）

- **来源：** 本人 2026-11-21 在编排会话 `sess_1795070602621900991` 里委托：「你直接cua我macbook看我的chrome吧，交给你了。你可以把这个端到端验证也纳入到你的 loop 工作中」。由 Agent 用 computer-use 在本人 MacBook（`dev_ca742456…`）的 Chrome、本人账号下按上面 1–4 步执行。这不是本人亲手测试。
- **第 1 步首次失败（本人发现）：** 本人打开事项页得到「Couldn't load items / Couldn't load this item: not found」。DevTools 里看到页面先按默认助理读到 200，随后切到「记住的助理」ByteWork（`asst_fe7f…`）再读同一事项得到 404。根因：本人有两个助理，事项页跟着当前选中的助理走，与本人「每人一本账本」的决定不一致；e2e-alice 只有一个助理，所以此前的浏览器验收与复现都没碰到。修复：账本路由（`/api/personal-agent/items…`）列出本人所有助理的事项，按 id 在本人任一助理下读、改、删事项；助理路由不变；事项页与工作区概览改读账本。测试 `TestItemsPageReadsThePersonsLedger`，items-ui 测试改到账本路由；PR #291。部署 dev：Server `f73c29d2a319`、Web `91ee8dadd9734e16`。
  - 部署时的一次失误：第一次从不含别的会话（`sess_1795100030479769617`）未提交的 ASC 改动的 worktree 构建 Server，把对方 17:35Z 部署的 `asc-apps-nested-read` 替换掉约 2.5 分钟；17:41Z 改从共享树（含对方改动，文件 hash 已核对）重建并部署，已告知对方。
- **复验（本人 Chrome，Web `91ee8dadd9734e16`）：**
  1. 事项详情：通过。归属 foundry；6 条决定带原话、第 5 条划掉标「Superseded」；完成标准 E1–E7、完成依据可见。
  2. CHAT-6：通过。Done，3 条完成标准、3 条依据。
  3. 新对话 `sess_1795282990691768399`（本人浏览器里新开，Limen opus high，不给 id）：通过。先读 devlog，再 `read_list`、读 `.foundry/items/pai_ef8f….md`；答出状态、6 条决定（指出被取代的一条）与遗留项，并指出两处需要收尾（devlog 已知限制里「删除设备不记事件」已过时，已删除；macbook Worker 未更新，已更新）。
  4. 在同一对话里由 Agent 输入本人先前在编排会话里写过的原话，让它记成决定：它用 `op decide` 记下「端到端验证也纳入 Agent 的 loop 工作，由 Agent 自己做」，原话核对通过；本人浏览器的事项详情出现第 7 条决定（11/22 01:47）。注：这句原话是本人写的，但由 Agent 代为输入到新对话里。
- **结论：** 1–4 在本人浏览器里全部通过。

## 试点发现

1. `read_list` 不返回 `revision`，而 `update_list op:update` 要求带上它。Agent 只能猜（本次猜 1 恰好对了）。已修：`read_list` 的事项视图加了 `revision`，工具描述写明要把它传给 `update_list`，测试 `TestWorkspaceSessionKeepsItsWorkspaceItems` 增加了断言（byte-dev 上 remote-check 通过）。2026-11-21 05:03 部署 Server `4277cf08a9f7`，构建 `.foundry/builds/dev324b-20261120T210118Z`，回滚用 `foundry-server.pre-dev324b`。实测 `read_list` 返回 `revision: 2`。
2. 编排会话自己建的事项，`origin.kind` 记成 `web`。这是因为这个会话是本人从网页开的，事实上没有错，但看不出事项是在会话里建的。观察中，暂不改。

## 准出标准（事项基座整体；本人 2026-11-21：「你这个loop的目标要以准出为导向」）

每条都在 dev 上验证，证据写在本节下面的「准出记录」。全部通过，事项基座才算完成。

| #   | 标准                                                                                                                                                                            | 怎么验                                                                                                                                    | 状态                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | 换会话不丢：挂在事项上的帮手，父会话归档后报告送到 holder；换了 holder 送到新 holder；holder 不在时送到助理对话；都不可达时排队，下一个认领者收到                               | dev 实测前两条；后两条按设计不在真实账号上强造（会把报告投进本人的助理对话），由定向测试 `TestItemHelperReportWaitsForTheNextHolder` 覆盖 | **通过**：父会话归档后送到 holder（11-21 04:57）；换 holder 后送到新 holder（11:07）；排队两条由定向测试覆盖                                                     |
| E2  | 只靠事项接手：全新会话只被告知「继续 X」，自己找到事项，只读事项文件就说清目标、做到哪、下一步、完成标准、本人的决定                                                            | 只读验证会话按固定提示自评，**≥ 8/10**，缺失清单里没有这五项                                                                              | **通过**：4/10（10:18）→ 8/10（11:03）                                                                                                                           |
| E3  | 决定有记录：本人的决定逐条记下原话，原话核对不过就拒绝，后来的决定可以取代前面的；事项文件和 Web 都能看到                                                                       | 定向测试 + dev 上真实记一条、取代一条，看文件与 Web                                                                                       | **通过**：服务端与文件（11:00）；Web 三组画面（11:16，`.foundry/attachments/dev324d`、`dev324e`）                                                                |
| E4  | 做完有依据：事项有完成标准；没有证据不能标完成；完成标准和证据并排可见                                                                                                          | 定向测试 + dev 上一个真实事项从开到关                                                                                                     | **通过**：完成标准进事项、文件与 Web 并排显示；dev 上无证据标完成被拒（11:40）；3 个真实事项带证据关闭                                                           |
| E5  | foundry 试点真实可用：至少 3 个真实的 foundry 事项走完「建 → 换会话 → 关」                                                                                                      | 事项页与时间线                                                                                                                            | **通过**：`pai_8739…`（CHAT-6）、`pai_5175…`（时区）、`pai_7fa5…`（设备删除）三个真实事项：本会话建项 → 各自的帮手会话接手干活 → 验证后带证据关闭（11:09–11:41） |
| E6  | 不破坏已有的：CI 全绿合入 main；dev 部署后健康；Worker 全部在线设备更新                                                                                                         | CI、`/healthz`、`update_worker status`                                                                                                    | **通过**：PR #287、#288、#289 CI 全绿合入 main；各次部署后 `/healthz` 200；在线 6 台设备 Worker `.379`（macbook 离线）                                           |
| E7  | 守住哲学：没有新增往 Agent 里注入的引导（只有文件投影与技能里的一次性说明）；语义判断（建不建事项、算不算做完、记不记决定）都留给 Agent，Foundry 只校验原话、revision、证据存在 | 审 diff                                                                                                                                   | **通过**：逐个切片自查，见准出记录                                                                                                                               |

### 准出记录

（每条通过时补：日期、构建版本、会话或截图、结论；时间均为 UTC+8）

- **E5（11-21 11:09–11:41，Server `5bdd4e24e1dc`）**：三个真实 foundry 事项，本会话建项（本人原话「该重构的重构，该优化的优化」）、写好完成标准并认领，各派一个挂事项的帮手（Limen opus high，各自 worktree），派活消息只说「先读你的事项文件」：
  - `pai_873966fd…` **CHAT-6**（帮手 `sess_1795230582285444941`）：根因是旧原生会话的后台任务完成从没被记下，会话换原生会话后设备看不到它们、永远报 unknown；按 Worker 的「换原生会话前必须没有进行中的后台任务」这一事实，读工作列表时收尾为 stopped。dev 上部署会话名下 open 工作 0，`work_1cc39d2a…` 变 stopped。
  - `pai_51751644…` **事项文件时间按本人时区**（帮手 `sess_1795230585199568772`）：dev 上重写的事项文件证据与时间线为「2026-11-21 11:40 UTC+8」，`updated` 仍是 RFC 3339；操作通知里的 CST 同时改为 UTC 偏移（同一个格式化器）。
  - `pai_7fa5e11c…` **删除设备记事件**（帮手 `sess_1795230588040336287`）：设备 purge 与删除 Workspace 共用 `detachItemsFromDeleted`。只验到定向测试（真实 purge 路径），dev 上没有为此删除真实设备。
  - 三个帮手的报告都按事项送到了本会话（holder）；本会话审 diff、合并、跑 httpapi 整包（523 s）与 sqlitestore、personalagent 定向测试、部署后逐条对照完成标准，带证据关闭并 release。
- **E4（11-21 11:40）**：CHAT-6 事项在没有证据时标 done 被拒（「record completion evidence before marking an existing item done…」）；带上帮手会话、构建与 dev 实测三条证据后关闭。事项文件与 Web 里完成标准与证据并排可见（E3 Web 截图）。
- **E3 Web（11-21 11:16，Web `94480578b2b159df`）**：e2e-alice + 合成数据（只拦截两个合成事项的 GET），1440 浅/深、390 浅三组：决定按时间升序、被取代的划掉并标注、长文本夹住可展开、完成标准与依据为带小标题的圆点列表、时间线行有全文 title、空事项显示「还没有记下本人的决定。」、console 0 报错。初验发现的三处排版问题（列表无分隔、时间线截断无全文、390 宽原话缩进不齐）和一处分组间距已修并复验。截图 `.foundry/attachments/dev324c`、`dev324d`、`dev324e`。
- **E6**：PR #287（`c403c414`）、#288（`ac4e72b9`）CI 全绿合入；各次部署后 `/healthz` 200；Worker `0.5.7-dev.379` 在 sg-chaos、byte-dev、byte-dev-sg、limen-canada、CanWendeMac-mini 上，cottoncpp 也已在 `.379`（11:4x 复核）；macbook 离线，上线后再更新。E5 批次 PR #289（`ed6731d3`）CI 全绿合入。
- **E7**：新增的都是确定性的东西（`decided` 事件、`acceptance` 字段、原话核对、证据存在校验、按事项投递、文件投影、时区渲染、收尾规则）；没有新增往 Agent 里注入的引导，指导只在技能里各写一次；建不建事项、记不记决定、算不算做完都由 Agent 判断。
- **E1 换 holder（11-21 11:04–11:07，Server `f3f1ca640179`）**：本会话派出挂在事项上的帮手 H（`sess_1795230271702186855`，`sleep 150`），H 运行期间新会话 S2（`sess_1795230274844808389`）`claim` 了事项（`replaced` = 本会话）。H 结束后，报告送到了 S2（S2 回答「S2 收到：sess_1795230271702186855「E1 实测帮手 H（换 holder）」」），本会话没有收到 H 的报告；S2 随后 `release`，本会话重新认领。H、S2 已归档。
- **E2（11-21 11:03，Server `f3f1ca640179`）**：同一固定提示，全新只读会话（Limen opus high）自评 8/10，原话「目标、进展、下一步、完成标准、决定这五项都齐了；上面缺的都是执行层面的状态」。基线（10:18）缺的 9 条里，决定、完成标准、进展/证据为空、内容过时、认领约定都已补上；剩下的缺口：E1–E7 逐条状态、分支与 PR 现状、试点事项清单、旧会话收尾结果、设备更新现状、时区不统一。这些是负责人该维护的执行状态（语义内容，归 Agent），不加机制，由本会话在事项上补齐。
- **E3 服务端与文件（11-21 11:00，Server `f3f1ca640179`）**：本会话用 `update_list op decide` 记下本人 6 条真实决定（原话核对通过），第 6 条 `pie_cf631166…` 取代第 5 条 `pie_6c51eebd…`；事项文件「决定」一节按时间列出、被取代的一条划掉并注明取代者。编造的原话（「不用验收，直接合入」）和漏了一个字的原话都被拒绝（「not recorded: the quote is not in anything the person wrote in this conversation」）。另：把仍在运行的本会话当作 session 证据被服务端拒绝（「completion evidence must point to a completed current input」），符合设计。

## 下一步（本人 2026-11-21：按建议，先试点再补决定与证据）

1. 试点：foundry 的新工作建成事项；专门验证「新会话只读事项文件接手」，找出事项文件缺什么。
2. 决定记录：只追加的决定列表（原话核对沿用 `stated`）。
3. 证据与验收：完成标准、Worker 采集的证据、派活的一方不能自己验收、独立判定。

## 后续事项（2026-11-22，按事项跑）

本人 2026-11-22 定：「派活的一方不能自己验收」「Worker 自动采集证据」都不做成硬规则（原话「先按你的建议做吧。」，记为 DEV-324 第 8 条决定）；继续拿事项基座做真实工作（「也按你的建议做吧，继续推进。」）。两件都建成 foundry 事项、写好完成标准、由本会话认领，各派一个帮手（Limen opus high），合在 PR #292。

- **帮手状态实时进事项**（`pai_552c2748…`，帮手 `sess_1795318921383149025`）：两类帮手（助理的 `pa_tasks`、工作区会话的 `pa_item_helpers`）共用一条状态规则：设备未就绪为 queued，回合停在未答的提问上为 asking，其余跟会话；「提问还在等回答」的判断从 httpapi 移到 `sessions/questions.go`（一份），超时或被打断的提问不再算在等。只有状态变化时只刷新投影，不记时间线事件；状态不变什么都不做。行为变化：停在未答提问上的帮手算进行中，它的事项此时不能归档。dev 实测（Server `f40d1a1d660f`）：帮手提问后事项文件显示「— asking」、时间线没有 `helper_ended`；回答后变为「— done」，只记一条 `helper_ended`。已带证据关闭。限制：Codex 运行中的异步提问显示为 running；Web 在下一次会话事件时才重载。
- **后台命令的完成不再只靠快照**（`pai_0df69f32…`，帮手 `sess_1795318929651020302`）：根因是 `AgentSessionStateEvents` 只在有子 agent 启动事件时才返回任务的结束（#120 加的过滤），后台命令的结束全被丢掉，只能靠只留最近 20 个已结束任务的快照。修复：状态事件保留后台命令的结束；`taskEndReactions` 在结束事件入库时就导入；结束事件能为快照里已没有的任务建立或补全条目，快照写明的结局优先，已记下的结束不覆盖（657 条用户停止的命令不会翻成 failed）；Worker 在结束事件里带 SDK 的 `taskStatus` 与 `exitCode`。CHAT-6 的收尾规则保留作兜底。dev 实测（Server `f40d1a1d660f`、Worker `.384`，会话 `sess_1795322672736780141`）：后台跑 `sleep 5; exit 7`，之后又有 43 个后台任务结束，期间没有任何人读工作列表；最后读到条目 `work_630cc8b6…` 为 failed、`exitCode` 7、`endedAt` 04:44:48Z（真实结束时刻，来源 SDK task lifecycle）。第一次实测中途读过工作列表，不算数，已作废重跑。已带证据关闭。限制：旧 Worker 的结束事件不带退出码；已结束的任务仍显示停止动作（原有行为）。

- **事项提为全局一级入口**（`pai_f7e137aa…`，帮手 `sess_1795345084117637413`，PR #293）：侧栏全局区「助理 → 事项 → 等你处理 → 助理设置」（完整与简洁界面），路径 `/items`、`/items/<id>`，旧 `/assistant/items…` 改写到新路径；按「全部 / 助理收件箱 / 工作区」筛选，`?in=` 单向同步（打开时读一次，之后只写）；工作区概览的事项区跳到带该工作区筛选的事项页；列表接口加 `inbox=true`（与 `workspace` 互斥）。验收中发现并修了三处：home 等于助理自己工作区的旧事项哪个筛选都看不到（写入时规范成 `""`，一次性迁移 `item-assistant-home-inbox`；`""` 在助理工作区的会话里也算本工作区）；深色侧栏选中比悬停暗（只改深色 `--fdy-selected-surface`）；工作区未加载完就显示「你看不到的工作区」（加载中显示「正在加载…」）。dev 实测（Web `d4708b76…`，再 `511f0330…`；`sess_1795346281386599727`、`sess_1795350097818232585`，e2e-alice + 合成 GET）全部通过。
- **Needs you 收窄并挂到事项**（`pai_6acd7999…`，帮手 `sess_1795345081979850339`，PR #294）：dev 库开着的 20 条里 9 条回合失败（同会话重复、两三周未关）、8 条资料整理建议；代码里没有模型提取，唯一的猜测是正则扫命令输出。改为只收卡在本人身上的请求：删掉输出正则（只留原生 `permission_denied`，迁移 `retired-pending-sources` 关闭旧条目）；同会话新失败取代旧的，会话归档/删除后由已有清理任务关闭；资料整理建议移出列表与计数（项目概览的维护面板、助理设置 → 动态仍可处理）；条目按会话确定性地挂到事项（帮手所属事项，或只持有一个开着事项的 holder；持有多个则不挂），Needs you 显示「事项：…」（单独一行），事项列表「等你：N」、详情列出等你条目。dev 实测（Server `c9b3c501c947`）：迁移已跑，库里没有开着的输出类条目与同会话重复失败，9 条旧失败被清理关闭；真实与合成数据下链接与计数正确。限制：同一根因的失败合并条目仍逐个列出会话；`needs_you` MCP 列表还不带 itemId；GitHub scope 的「去授权」快捷入口随正则一起去掉。
- **Worker 的 Claude hook 回调全部报失败**（`pai_76ae5b54…`，帮手 `sess_1795347107243623838`）：编排时发现每次 hook 都有「Hook callback hook_N failed … treated as empty」告警（本会话自 11-21 16:41 起约 820 条）。根因：Worker 的观察型 hook（work-tool 的 Pre/PostToolUse、定时器的 PostToolUse/Stop/UserPromptSubmit、后台任务 Stop）返回 `undefined`，CLI 要求答复是对象；2.1.311 只写 stderr，2.1.323 起变成告警事件。这些 hook 都不做放行/拒绝决定，副作用在返回前已执行，所以没有守卫失效、无安全影响。修复：hook 表加类型（答复必须是对象）、每个回调返回 `{}`，新测试遍历所有注册的 hook。dev 实测（Worker `.388`，`sess_1795350103743027869`）：Bash、Write、删除三步后 38 个事件 0 条告警，文件改动记录正常。

## 已知限制

- 经 `pa_item_helpers` 关联的帮手只用于显示和投递：不会阻止事项归档，事项归档时也不会归档这些帮手会话，不进入日报。
- 设备离线期间删除的事项：如果所在 Workspace 没有别的事项，旧文件要等下次那里有事项变化时才会清理。
- 一个已经开着的会话，要到它下一轮运行在新 Worker 上时，才能拿到事项工具。
- 额度用尽导致的失败仍按 30 分钟的节奏重试。本人 2026-11-21 决定不改：「实在耗尽了，我来处理呗。」
