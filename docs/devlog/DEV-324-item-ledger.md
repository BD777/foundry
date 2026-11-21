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
