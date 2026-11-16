# DEV-259 「事项」Web：侧边卡片、事项页与回顾

状态：已部署 dev（train18/19-20261117）；Agent 代验收（2026-11-17，范围见验收记录）；已合入 main（PR #273）。DEV-255（共享 FinishedFold）同此状态。

本人的原话（2026-11-17 00:xx UTC+8 转述，见 `.foundry/briefs/dev258-259-items.md`）：

> 按你建议做，然后还是需要有个 archive 的逻辑，对于事项来说也是。archive 的东西可以回头 review 或者整理，然后要记录一下每个事项相关的 summary 的上下文，还有它的时间……

## 1. 做了什么

- **侧边卡「事项」**（`features/personal-agent/items-card.tsx`）替代「你的清单」与「正在做的事」。助理主页只把 `PersonList` + `TaskList` 换成 `ItemsCard`。
  - 标题带进行中数量，「全部 ›」进入事项页；最多 6 行，其余在「全部」里。
  - 人的事项行带复选框（打勾 = 完成）；助理的事项行按状态显示：执行中转圈、等你回答的问号、空闲的小点。
  - 次行写明谁在做、在做什么：「你 · 下班后」「助理 · ccm-omh-integration 执行中 · 2 小时前」「来自 OpenLark · 张三」。
  - 「已结束 N」是今天结束的事项（FinishedFold，默认收起）；「其他执行 N」是不属于任何事项的助理执行：进行中的直接显示（行首有状态标记，等待电脑上线时写明等什么），已结束的收进折叠。
- **事项页**（`/assistant/items`，`items-page.tsx`，无侧边栏新入口）：
  - 顶部：进行中 / 已结束 / 归档 三个视图；时间范围（今天 / 本周 / 上周 / 本月 / 全部 / 自定义）；搜索。范围只作用于已结束与归档；回顾页也有范围选择。
  - 列表按最后更新的日期分组。行内有标记、标题、负责人与状态、更新时间；来源标签只在渠道来源（如 OpenLark · 张三）时显示，放在时间下方；网页与自聊不显示。
  - **加载更多**：列表每页 50 条，按响应里的 `nextOffset` 取下一页，底部显示「已显示 N 项，共 M 项」，没有固定上限。
  - 详情（`items-detail.tsx`）：
    - 标题可编辑；「完成 / 不做了 / 重新打开 / 归档 / 恢复」；来源与原话；
    - 时间：短日期加相对时间（如「11/13, 12:37 PM 3 days ago」），完整时间放在悬停提示里；
    - 摘要（复用 `MarkdownContent`）；执行（每个执行链接到其会话，新标签页打开）；
    - **计划**：恢复 `person-list-plan.tsx` 的编辑器（搬入后只改了三处：根节点接受 `className`；编辑按钮用默认尺寸、`secondary`、靠左；去掉了旧行上的「完成决定」提示句及其文案键），在事项仍是进行中且有计划时可编辑：人可选路由（项目、执行者）与依赖，保存时发送 DEV-258 的 `plan` 选择；
    - 时间线：每个事件一行，「时间 · 谁 · 发生了什么」；
    - 区块标题用 `Subheading`（group 尺寸）。
    - 「…」菜单：**改为我来做 / 改为助理来做**（负责人切换不再是像标签页的分段控件）、**让助理继续**（沿用旧清单行菜单里的动作，发送同一条提示）、**删除…**（带确认）。
  - 回顾（`items-review.tsx`）：计数（新增、完成、进行中、不做了）与按状态分组的事项；有摘要的事项才显示摘要首行；「复制为 Markdown」；「请助理写成总结」发送一条人的消息，然后回到助理主页。
- **旧清单代码已删除**：`PersonList`、`TaskList`、`person-list-model`、旧列表的读写与 API（`listPersonalAgentList`、`updatePersonalAgentListItem`）、`person-list.test.mjs`；i18n 的 `list`、`tasks` 块。**保留**：`person-list-plan.tsx`（计划编辑器，已恢复）、`planning` i18n 块。
- **i18n**：`personalAgent` 命名空间中英同步（`items.*`、`planning.*` 恢复）；`shell.views.assistantItems` 中英同步。
- **深色主题**：没有代码改动。应用在 `<html>` 上设置 `data-theme`（`index.html`、`use-shell-preferences.ts`），`:root` 的 `var()` 链在深色下正确解析。之前看到的「白底」是临时 harness 只在包裹元素上设置主题造成的假象（见第 5 节）。

## 2. 接口与数据

- 列表：`GET /api/assistants/{id}/items?view=open|finished|archived&from&to&q&limit&offset`，`limit` 默认 50、最多 200，按 `nextOffset` 翻页。
  - 事项页：每个标签一个分页列表，时间范围放进 `from` / `to`（`[from, to)`，按最后更新时间）。
  - 卡片：`view=open`（`limit=200`，用于计数与找出执行，仍是一次读取）；`view=finished&from=今天 0 点`，再在客户端按 `closedAt` 过滤为今天结束的。
- 详情：`GET …/items/{id}`（`item` 与 `events`）。
- 编辑：`PUT …/items/{id}`，字段 `text` / `owner` / `status` / `archived` / `plan` 与 `revision`。`plan` 是 `PersonalAgentItemPlanChoice`（`route`、`workspaceId`、`dependencies`），服务端合并进计划；进展、下一步、证据仍由助理写。
- 删除：`DELETE …/items/{id}`（204；不存在时 404）。
- 运行记录：`GET …/operations`，计划编辑器用它显示最近一次执行的结果。
- 回顾：`GET …/items/report?from&to`。
- 「其他执行」：当前用 items 的 `helpers[].sessionId` 推导哪些助理执行已属于某个事项；`PersonalAgentTask.itemId` 已在合同中，尚未切换过去。

## 3. 与 brief 的偏差与取舍

1. **计划只在有计划时显示**：编辑器挂在 `item.plan` 上，没有计划的事项详情里没有计划区。DEV-258 说明人的选择会为无计划的事项开一个计划（进度为 `inbox`），但 Web 目前不提供入口；需要时再加。
2. **「其他执行」**：进行中的执行直接显示，只把已结束的收进折叠。整组折叠会把正在跑的执行藏起来。
3. **时间范围只作用于已结束与归档**。「进行中」始终是全部未结束的事项，因为一条三周前建的待办不应因为选了「今天」而消失。回顾页的范围与事项页相同，「进行中」标签下回顾读全部。
4. **回顾的「全部」**以 `1970-01-01` 至 `2100-01-01` 为界；周从周一开始。
5. **「请助理写成总结」**通过 `capturePersonalAgentInbox` 发送一条可见的人的消息（文案：「帮我总结一下 {范围} 的事项」，全部时为「帮我总结一下全部事项」），与助理主页的输入框走同一条投递通道；发送后回到助理主页。
6. **「让助理继续」**保留在详情菜单里：旧清单行菜单有这个动作，删掉就少了一个人的能力。发送的是旧的同一条提示（`planning.continuePrompt`），发送后回到助理主页。
7. **卡片的执行查找仍是一次 `limit=200` 的读取**：超过 200 个进行中事项时，「其他执行」的判断可能漏掉部分执行。事项页的列表已改为分页，不受影响。

## 4. 依赖与合并顺序

1. DEV-258 合同补丁（含计划选择的版本，`/home/windeng/workspace/foundry-dev258/.foundry/dev258-contract.patch`）。
2. DEV-255 FinishedFold 补丁（`/home/windeng/workspace/dev255-finished-fold.patch`）。
3. 本补丁：`/home/windeng/workspace/foundry-dev259/.foundry/dev259-web.patch`（不含 1、2 的文件；合并前在 `HEAD` 上按 1→2→3 顺序验证可干净应用）。

## 5. 验证

- `pnpm typecheck`（CanWendeMac-mini，远端）：PASS。
- 定向测试（远端）：`items-model.test.mjs`（9）、`items-ui.test.mjs`（8）、`assistant-side-card.test.mjs`、`finished-fold.test.mjs`、`personal-agent.test.mjs`（37 项，其中恢复了三个计划编辑器测试，并把一个旧清单测试移植到事项详情）。
- `pnpm audit:ui`：全部通过；`prettier --check` 通过。
- 深色核对（临时 harness，主题同时设在 `<html>` 与外壳元素，与应用一致）：聊天输入框、设置字段、品牌色图标框在深色下正常（`r6-surfaces-dark.png`）。之前的 `before/after-surfaces-dark.png` 作废：它们是 harness 只在包裹元素上设置主题的结果，不反映应用。
- 截图（临时 harness，mock 事项接口；harness 不在补丁里）：
  - 事项页：`r7-items-light-normal.png`、`r7-items-dark-normal.png`（选中 i2，计划展开，来源标签在时间下）、`r4-items-light-menu.png`（「…」菜单，上一版构建，菜单本身本轮未变）、`r2-items-light-loadmore.png`（底部加载更多）、`r2-items-light-narrow-list.png`、`r3-items-light-narrow-detail.png`（390×844）；
  - 回顾：`r2-review-light-normal.png`、`r2-review-dark-normal.png`（带范围选择）；
  - 卡片：`r6-card-light-narrow.png`、`r6-card-dark-narrow.png`（`--full`，整张卡片）。
  - 路径在 `/tmp/dev259-shots/`。

## 6. 限制与待决定

- **真实应用未验证**：路由（卡片 → `/assistant/items`、URL 同步、窄屏返回）、计划保存与删除只经过类型检查与组件渲染，没在真实应用中点过；服务端未合入时没有真实数据。DEV-258 服务端与真实浏览器验收需要在合并后做。
- 列表每个标签的分页依赖服务端 `nextOffset`；页面只在底部提供「加载更多」，没有滚动自动加载。
- 「等你回答」标记由执行状态 `asking` 推导，没有查 needs_you 记录。
- 「其他执行」用 `sessionId` 推导，超过 200 个进行中事项时可能漏判（见第 3 节第 7 条）。

## 7. 验收步骤（待人工）

1. 助理主页：侧边卡出现「事项」，数字等于进行中的项数；点「全部 ›」进入事项页。预期：页面在 `/assistant/items`，侧边栏没有新入口。
2. 人的事项：点左侧方框。预期：项变为已完成，出现在卡片「已结束」折叠里，计数减一。
3. 助理的事项：有执行时显示转圈，次行写出执行名；需要回答时显示问号。预期：与 `helpers` 状态一致。
4. 详情：点「编辑」改标题并保存；「完成」「不做了」「重新打开」；已结束的项可「归档」，归档后出现在「归档」标签，可「恢复」。预期：时间线多出对应事件。
5. 「…」菜单：负责人在「改为我来做 / 改为助理来做」之间切换；「删除…」带确认，确认后项消失。
6. 计划：进行中且有计划的事项，计划区可以选择路由、项目与依赖并保存；已结束的事项计划只读。预期：保存后计划区反映新选择，进展和下一步不变。
7. 列表：超过 50 项时底部出现「加载更多」，点击后追加下一页，计数更新。
8. 回顾：选「本周」→「回顾」。预期：计数与分组对得上列表；「复制为 Markdown」得到 Markdown；「请助理写成总结」后回到助理主页，出现一条人的消息「帮我总结一下 11/10–11/16 的事项」。
9. 窄屏（宽度 860px 及以下）：列表选中一项后显示详情；「返回事项」回到列表。

## 8. 相关

- Brief：`.foundry/briefs/dev258-259-items.md`（UI 章节为规格），`.foundry/briefs/dev254-255-assistant-side-card.md`（共同规则）。
- DEV-258 服务端：`sess_1794845028078238606`；DEV-255 FinishedFold：`sess_1794844786866849326`。

## 9. 验收记录（Agent 代验收，2026-11-17，dev 真实浏览器，e2e-alice）

- 编排会话在 dev 上实测：侧边卡「事项」与首页「等你处理」行正常；事项页打勾完成、已结束标签（DEV-255 共享 FinishedFold）、归档 → 恢复 → 重新打开（时间线事件随之出现）、回顾、分页均正常。
- train 19 的三个修复（事项深链、维护分组、「待办」）已在 dev 验证。
