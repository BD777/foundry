# DEV-110 · Web 界面视觉改版（参考 beautifului.dev）

状态：已实现并已部署 dev Web（构建 `feda616b390d0503`）；测试、审计与真实浏览器自验通过；提交与 PR 待 22:00（UTC+8）后；待人工验收。

## 问题

本人希望 Web 界面更好看，以 https://www.beautifului.dev/（MIT，复制粘贴式组件，AI 原生界面）为参考（2026-11-02）。审计当前界面的结论：

- 浅色是冷灰蓝、深色是暖棕，两套主题像两个产品；导航栏与会话列表同色，三层之间没有层次。
- 没有字号、圆角、阴影的刻度：约 20 种字号、约 12 种圆角写死在各样式表里，改一处带不动全局。
- Agent 的工作（思考、工具步骤）是一整行平铺文字，标签与值不分；卡片边框叠阴影；选中态是色块加左侧竖条。
- 设备列表里“已共享给你”的徽标被撑成整行灰条；Issue 看板最后一列被裁；`!important` 与 Radix 私有包装盒的补丁共 4 处。

## 方向（本人 2026-11-03 选定）

“方案 2 的表面 + 方案 1 的步骤”：

- 表面三层：导航栏直接落在画布色上（不画边框）；其余内容放进一张圆角“页面”（一圈环 + 柔和阴影）；列表在页面内用更浅一档的面板，与内容之间只有一条细线。
- 选中态一种：浅色/深色下都是“抬起的白色药丸”（一圈环），悬停只是淡灰填充，二者并排可区分。
- 提示栏浮在对话之上（环 + 深而柔的阴影）。
- 强调蓝只用于主按钮、焦点环、链接（及少量已有的状态标记）。
- Agent 的工作：一条导引线，单行步骤，加粗标签 + 弱化的等宽值徽标 + `+13 −41` 差异文字；没有每步一张卡片。

## 实现

- 令牌（`styles/tokens.css`）：浅色/深色成对的新调色板（对比度由 `audit:style-invariants` 检查）；刻度 `--fdy-text-2xs…2xl`、`--fdy-radius-xs…xl/pill`、阴影 `--fdy-ring/--fdy-shadow/--fdy-panel-shadow/--fdy-shadow-floating/--fdy-shadow-sheet/--fdy-shadow-prompt/--fdy-shadow-accent`、选中态 `--fdy-selected-surface/--fdy-selected-ring`、值徽标 `--fdy-chip-*`、动效 `--fdy-duration/--fdy-ease-out`、等宽字体 `--fdy-font-mono`；强调色令牌 `--fdy-brass*` 改名 `--fdy-accent*`。
- 机械归一：所有样式表的 `font-size`、`border-radius` 改用刻度令牌（615 + 222 处），原生等宽字体栈统一为 `--fdy-font-mono`。
- 图元：`app-shell`（画布 + 页面、导航选中药丸，窄屏保持顶栏条带并去掉页面圆角）、`action-row`（侧栏行选中为抬起药丸）、`panel`、`button`、`message-composer`（环代替“边框 + 阴影”叠用）、新图元 `DiffStat`（`components/ui/diff-stat.*`）。
- 会话：步骤列表导引线、单行步骤、工具步骤值徽标（`data-kind="tool"`）、`processToolDiff`（`chat-process-display.ts`：由工具入参里的 old/new 文本或整文件内容数出增删行数，用现有的 `diff` 依赖）；浮动提示栏；用户消息去掉边框。
- Issues 与设备：看板卡片与设备行改为“环 + 阴影”卡片（去掉边框叠阴影）；列数徽标；设备行里被撑开的徽标（过期的 `.fdy-device-list-row > span:first-of-type` 规则）已删。
- 清理：`ScrollArea` 改为原生滚动容器，由 `direction`（`vertical` 默认、`horizontal`、`both`、`none`）决定哪根轴滚动，不再用 Radix 与它的内联样式，因此 4 处 `!important` 与对 Radix 私有包装盒的改写全部删除；移除依赖 `@radix-ui/react-scroll-area`（含 `vite.config.ts` 分块与 `pnpm-lock.yaml`）。`audit:css` 新增：禁止 `!important`、`font-size` 必须用刻度令牌、`border-radius` 必须用圆角令牌；`design-palette.json` 按新调色板重建（114 → 58 色）。
- 保持不变：`letter-spacing` 仍为 0（参考站用 -0.01em，但 `audit:css` 既有规则要求为 0）；未新增字体依赖（Mac 上系统字体 SF 与参考站的 Inter 接近）。
- 文档：`apps/web/src/ARCHITECTURE.md` 增加“令牌、不写死数值”与“表面”两条。

## 自验

- `scripts/check-changed.sh --files <全部改动>`：prettier、`tsc`、67 个相关 Web 测试文件、13 项 `audit:ui` 通过；`pnpm test` 全量 1008 项通过。新增测试：`scroll-area.test.mjs`（原生容器、方向、`DiffStat`），`chat-process-display.test.mjs` 增加 `processToolDiff` 两项。
- scratch 栈（本人库副本；`scratch-admin` 加入全部工作区；合成 Issue ISS-107…114；浏览器里把设备状态改写为在线以渲染看板与提示栏，Server 不变）的真实浏览器检查，1440×900 与 390 宽，浅色/深色：对话（忙碌，含工具步骤与思考）、聊天列表、Issues 看板与详情、设备、工作区、模型提供方、助理、对话框；悬停与选中并排可区分（浅/深）；键盘 Tab 焦点环；折叠侧栏；看板滚到末尾卡片完整。截图见本次 PR 说明与 `.foundry/attachments/ui/final/`。

## 部署

2026-11-03 由 DEV-107 session 按“完成 = 已部署，提交不挡部署”从本工作树（基于 `main` `1d4bdcf3`，未提交）构建并用 `scripts/deploy-web-dev.sh` 部署到 dev Web：构建 `feda616b390d0503`（此前为 `c46db7f04bacf74b`；旧版 `index.html` 与 `version.json` 存于 `~/.foundry/server/releases/dev110/previous-20261103T065043Z`）。部署后核对入口资源一致、API 返回 JSON，并以 e2e-alice 在真实浏览器中浅色/深色打开 `/chats`、`/issues`、`/devices`、`/workspace`、`/resources`，无控制台错误；截图在 `.foundry/attachments/ui/live/`。回滚：把上述目录里的 `index.html` 与 `version.json` 拷回 `/var/www/foundryapp-dev`。

2026-11-03 增量部署（均由本工作树的改动经共享集成树 `foundry-int` 构建，部署锁 `/tmp/fdy-deploy.lock`）：

- `ac2b9cdf1825eba0`：会话右侧上下文卡片左边缘缺失的修复（滚动容器 `.fdy-chat-context-rail` 把卡片外圈的环裁掉；左侧留 4px，窄屏浮层改由卡片自己滚动）。
- `78104b64bd61b6b6`（与 DEV-107 批次合并构建）：统一重绘，所有页面标题改用 `PageHeader`/`SectionHeader`，同一页面宽度与间距，卡片与弹层“环代替边框”，`audit:css` 新增“可见边框 + 环阴影”“带边框的卡片盒”两条规则，表格与代码块的工具栏改为悬停/键盘焦点时显示（触屏常显），不再盖住内容。
- `e0db0796d5d322c5`：对话框与十余个卡片式容器去掉边框改为环；部署后用 e2e-alice 在真实浏览器核对 `/devices`、`/members`、`/connectors/feishu` 深色无控制台错误。
- `7aa9b46a25f197ba`：设备页“模型与账户 › 模型提供方”两段之间补上间距（`.fdy-access-panel`），“Manage model providers →”改为链接样式不再缩进；模型提供方页的“Providers”小标题改用 `SectionHeader`。部署后 e2e-alice 真实浏览器核对 `/model-providers`、`/devices` 无控制台错误。
  回滚：把对应 `previous-…` 目录里的 `index.html` 与 `version.json` 拷回 `/var/www/foundryapp-dev`。

## 已知限制

- 工具步骤的 `+n −m` 只在 Server 保存了完整工具入参时出现：Server 会把长入参截断（实测 Write 整文件内容在约 1.6 KB 处截断，JSON 不完整），这时不显示差异。截图里的 `Edit … +13 −41` 一行是注入的演示行，真实数据中的出现取决于入参长度。要让所有编辑步骤都有差异，需要 Server/Worker 在截断前算好增删行数并随步骤带上（另立事项）。
- 工作区页面的“当前”行仍是“填充 + 已选徽标”两种标记（既有设计，未改）。
- 窄屏下导航仍是顶部条带，选中同样是抬起药丸；未做新的移动端布局。

## 人工验收

1. 打开任一会话：左栏（导航）、中栏（列表）、右侧内容三层可区分，列表与内容之间只有一条线；选中的导航项与聊天行是白色抬起药丸，悬停另一项是淡灰填充，二者能一眼分清（浅色与深色都看）。
2. 展开“已思考/调用了工具”：步骤沿一条导引线排成单行，工具步骤右侧是灰色等宽值徽标，没有每步一张卡片；输入框浮在对话之上。
3. 打开 Issues：看板卡片是环 + 柔和阴影，最后一列滚动后完整；设备页“已共享给你”是小徽标，不再是整行灰条。
4. 切换深色、把窗口缩到手机宽度：层次与选中态保持，导航为顶部条带。
