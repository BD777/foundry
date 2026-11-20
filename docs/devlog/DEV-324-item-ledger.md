# DEV-324 事项账本：事项有归属（home），Workspace 里的会话可以认领事项，帮手的信号按事项投递

2026-11-21 起。状态：进行中，A1（Server）切片在实现，未部署。

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

| 切片      | 内容                                                                                                                                                                              | 会话                                                                               | 状态   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| A1 Server | home 字段（从 `plan.workspaceId` 迁移）、touches（读时推出）、holder 与认领；普通会话在本 Workspace 范围内可用 `read_list` / `update_list`；改归属；`create_workspace fromItemId` | `sess_1795192523516903349`；brief：`.foundry/briefs/dev324-a1-item-home-server.md` | 实现中 |
| A2 Server | 帮手信号按事项投递：先给 holder，不可达时给助理对话，再不行就排队，不丢弃                                                                                                         | 等 A1                                                                              | 未开始 |
| B Web     | 事项页按 Workspace 筛选；Workspace 页显示事项；显示 holder                                                                                                                        | 等 A1 的接口                                                                       | 未开始 |
| C Worker  | 把事项只读投影到 home 的 `.foundry/items/<id>.md`                                                                                                                                 | 等 A1                                                                              | 未开始 |
| D 试点    | foundry 的新工作建成 `home = foundry` 的事项                                                                                                                                      | 等 A1 到 C 部署                                                                    | 未开始 |

## 验收步骤（部署后补全）

待 A1 和 A2 部署后填写。
