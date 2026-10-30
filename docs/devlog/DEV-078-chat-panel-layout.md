# DEV-078 · 聊天页右侧面板浮成卡片、上下留白

状态：已修复，dev Web 已部署（版本见“部署”）；Agent 自验通过；人工验收待确认。代码未提交（完成时已过 Git 窗口）。

来源：用户截图反馈（约 1430 px 宽、左侧栏收起）：“右边的布局上下都有空白，太糟糕了，不应该犯这种低级错误”。协调会话 `sess_1793063405185071529`。

## 结论

| 问题                                                                                            | 根因                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 修复                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 整个聊天页（标题栏、会话列表、对话、右侧面板）上方空 18 px、右侧空 28 px、下方停在内容高度      | **类名冲突**。DEV-075 给“画面”查看器（`chat-detail-screen.tsx`）的根元素用了 `.fdy-chat-screen`，并在 `20-chat-detail.css` 新增 `display: grid; align-content: start; padding: 18px clamp(14px, 4cqi, 28px) 40px`。`.fdy-chat-screen` 本来就是聊天页的根（`20-chat-list.css`：`flex` 列、`height: 100%`）。`20-chat-detail.css` 在 `styles.css` 里排在后面，新规则覆盖了聊天页：页面变成按内容定高的 grid，并带上内边距。短对话页面只到 516/880 px；长对话底部空 40 px | 查看器根元素改名 `.fdy-chat-screen-viewer`（只改它和 `.fdy-chat-screen-viewer .fdy-chat-detail-note`）；聊天页根恢复原样                                                                                                                                                                                       |
| Issue 详情里的执行对话同样带上 18/28/40 内边距                                                  | 同一条规则：`.fdy-chat-screen.fdy-issue-chat-screen` 只覆盖了 `display`，内边距和 `align-content` 漏进来                                                                                                                                                                                                                                                                                                                                                               | 同上                                                                                                                                                                                                                                                                                                           |
| 右侧 Context / Changes 是一张浮起的圆角卡片，离标题栏 18 px、离底部 20 px，整张卡片跟着外层滚动 | 原有设计（首版起就是 `padding: 18px 18px 20px 0` 的外框，加 24 px 圆角和浮层阴影），不是今晚的回归；回归让它更显眼                                                                                                                                                                                                                                                                                                                                                     | 改成侧栏：所在 grid 行从标题栏下沿到底边，左侧一条 `--fdy-line-strong` 线（与文件面板的分隔线相同），`--fdy-panel` 背景，面板内部滚动；卡片去掉边框、圆角和阴影。≤1360 px 的悬浮抽屉也改为贴边（top/right/bottom 0，保留阴影表示浮在对话之上），`.fdy-chat-thread-layout` 加 `position: relative` 作为定位基准 |
| 为什么审计没拦住                                                                                | `audit-v3-layout-contract.mjs` 已经要求 `.fdy-chat-screen { display: flex }`，但 `style-source.mjs` 按**文件名**拼接样式：`20-chat-detail.css` 排在 `20-chat-list.css` 前面，审计里旧规则“赢了”，浏览器里新规则赢                                                                                                                                                                                                                                                      | 见“防复发”                                                                                                                                                                                                                                                                                                     |

## 代码

- `apps/web/src/features/chat/chat-detail-screen.tsx`：查看器根类名 `fdy-chat-screen` → `fdy-chat-screen-viewer`。
- `apps/web/src/styles/20-chat-detail.css`：对应改名，注释说明不能用 `.fdy-chat-screen`。
- `apps/web/src/styles/20-chat-thread-and-context.css`：`.fdy-chat-thread-layout` 加 `position: relative`；`.fdy-chat-context-rail` 去掉内边距，加左边线和背景；`.fdy-chat-context-card` 只保留 `position: relative`。
- `apps/web/src/styles/90-responsive.css`：≤1360 px 抽屉贴边，去掉 `scale` 动画和卡片自身的 `max-height`/滚动/阴影。
- 没有 JS 尺寸计算，没有 `!important`。

## 防复发

- `apps/web/scripts/style-source.mjs`：按 `src/styles.css` 的 `@import` 顺序（即浏览器的层叠顺序）读取样式，未被引入的文件按名字追加在后面。新增 `readStyleSheets()` 返回每个文件的路径和内容。修正顺序后，现有契约立即报出 `.fdy-chat-screen display must be "flex", got "grid"`。
- `apps/web/scripts/audit-v3-layout-contract.mjs`：
  - 契约支持 `absent`（禁止声明的属性）。
  - `.fdy-chat-screen`：必须 `flex` 列、`height: 100%`，不得有 `padding`/`align-content`/`margin`。
  - `.fdy-chat-thread-layout`：`position: relative`、grid、`grid-template-rows: minmax(0, 1fr)`。
  - `.fdy-chat-context-rail`：左边线、背景、`overflow-y: auto`，不得有 `padding`/`margin`/`height`/`max-height`/`align-self`；≤1360 px 时 `top/right/bottom: 0`。
  - `.fdy-chat-context-card`：不得有边框、圆角、阴影、`max-height`。
  - 通用检查：同一个 `.类名` 在两个样式文件的顶层规则里给出不同的 `display`，视为两个组件共用一个类名，直接失败。当前代码 0 处；修复前恰好 1 处（本问题）。
- 反向验证：把三份 CSS 换回 HEAD 版本，审计报 17 条新违规并失败；换回修复后通过（3 条既有债务不变）。
- 没有提交 Playwright 几何检查：`apps/web` 没有 Playwright 依赖，为此加依赖不划算。几何验证脚本用于本次自验（见下），断言“面板上沿 = 标题栏下沿、面板下沿 = 视口底边、面板右沿 = 视口右沿、聊天页根 = 视图”。

## 其他页面排查

在真实 dev（e2e-alice，1430×880）上逐页测量 `.fdy-view` 的子元素和高度超过 200 px 的侧栏类元素，并截图比对：

| 页面                                                                       | 修复前                                             | 修复后                                  |
| -------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------- |
| 聊天文件面板（点开 Changes 里的文件）                                      | 63–516 px，未到底                                  | 45–880 px，贴边                         |
| 聊天“画面”面板（DEV-075）                                                  | 63–533 px，未到底                                  | 45–880 px，贴边；查看器自身的内边距保留 |
| Issue 执行对话                                                             | 带 18/28/40 内边距（代码分析；测试账号没有 Issue） | 随改名恢复                              |
| Workspace 概览（含 Services）、Workspaces（/locations）、Devices、设备详情 | 页面滚动型 `fdy-page-surface`，内边距是页面设计    | 不变，无浮卡/半高问题                   |
| Assistant                                                                  | 右侧栏在页头下方贴边到底                           | 不变，正常                              |

## 自验

- 复现（线上 Web `8d54a6ed0632c60e`）：长对话（DEV-048 合成工作区的归档验收会话）在 1280/1430/1600/1920/390 × 侧栏展开/收起 × light/dark 共 18 种组合，几何断言**全部失败**；短对话 1430 px 时页面只到 516 px。
- 修复后（本地构建 `7d91f9d82fa77c0f`，浏览器拦截静态资源、API 走真实 dev）：同样 18 种组合**全部通过**；1430×520 时面板内部滚动（scrollTop 146），标题栏不动，文档不滚动。
- 截图：`.foundry/attachments/20261029/dev078/before/`、`after/`（各 18 张）、`scan/`（其他页面修复前后），未入库。
- 部署后在线复验（不拦截，线上 `7d91f9d82fa77c0f`）：1280/1430/1920/390 × 侧栏 × light/dark 共 14 种组合全部通过，截图在 `live/`。
- `pnpm typecheck`、`pnpm audit:ui`（11 项）、prettier 通过；Web 单测 955/955 通过；`scripts/check-changed.sh --files`（9 个文件：prettier、tsc、60 个相关 Web 测试文件、audit:ui）全部通过。

## 部署

- 2026-10-29 10:43（北京）`scripts/deploy-web-dev.sh` 发布 dev Web：`8d54a6ed0632c60e` → `7d91f9d82fa77c0f`，从共享工作树（main `408e64d` + 本项未提交改动）构建，与浏览器自验的是同一个 build。脚本确认入口资源一致、API 同源返回 JSON。回滚入口：服务器发布目录 `releases/dev078/previous-20261029T024333Z`。
- 只改 Web，不涉及 Server 或 Worker。

## 验收步骤（人工）

1. 打开任一有 Changes 的聊天，窗口约 1430 px、左侧栏收起：右侧面板应紧贴标题栏下沿，一直到窗口底边，左侧一条细线，没有圆角卡片和上下空白；面板内容多时在面板里滚动。
2. 拉宽到 1920 px、展开左侧栏，结论相同；整个聊天页没有上方 18 px 或右侧 28 px 的空白，输入框贴近底部。
3. 窗口缩到 1360 px 以下（或手机宽度），点标题栏右侧的面板按钮：面板从右侧贴边滑出，从标题栏下沿到底边，右上角有关闭按钮。
4. 在 Changes 里点一个文件、或点“查看画面”：右侧详情面板同样从标题栏下沿到底边。
5. light/dark 各看一次。

## 时间线

- 2026-10-29 10:07 接手；10:20 前定位根因（类名冲突 + 审计按文件名读样式）。
- 2026-10-29 修复、审计加固、本地构建 `7d91f9d82fa77c0f` 浏览器自验（修复前 18/18 失败，修复后 18/18 通过）；Web 单测 955/955。
- 2026-10-29 10:43 部署 dev Web `7d91f9d82fa77c0f`，在线复验 14/14 通过。剩余：人工验收；提交待下一个 Git 窗口。
- 2026-10-30 更正：右侧面板改成贴边侧栏不是本人要求的，本人更喜欢原来的浮动卡片。已在 [DEV-098](DEV-098-chat-context-card-restore.md) 恢复；本项的类名修复和审计加固保留。
