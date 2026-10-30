# DEV-098 · 聊天页右侧面板恢复为浮动卡片

状态：已修复，dev Web 已部署（`871c74cf41b6aa0e`）；Agent 自验通过；人工验收待确认；未提交。

来源：本人 2026-10-30 反馈：“右边的 panel 从悬浮变成了常驻，为啥做了这种改动？我还是更喜欢之前的 UI 效果。”确认选项时选择“恢复原样，我喜欢原样那样滚动，而不是把整个卡片撑满高度”。会话 `sess_1793340379980455775`。

## 原因

[DEV-078](DEV-078-chat-panel-layout.md) 修的是类名冲突：“画面”查看器的根元素也叫 `.fdy-chat-screen`，导致整个聊天页多了内边距，高度也只到内容那么高。只改类名就能修好。但 DEV-078 同时把右侧 Context / Changes 的浮动卡片（首版起的设计）改成了贴边侧栏，≤1360 px 的抽屉也改成了贴边，还在审计里锁死了侧栏样式。这超出了本人当时提的问题，属于没被要求的视觉改动。

## 修复

- `apps/web/src/styles/20-chat-thread-and-context.css`：`.fdy-chat-context-rail` 恢复为 `padding: 18px 18px 20px 0`、`overflow-y: auto`，去掉左边线和背景；`.fdy-chat-context-card` 恢复边框、24 px 圆角、`--fdy-panel` 背景和浮层阴影。卡片按内容定高，内容超出时整张卡片在 rail 里滚动（原样）。
- `apps/web/src/styles/90-responsive.css`：≤1360 px 的抽屉恢复为距边 12 px 的浮动卡片，`translateX(12px) scale(0.985)` 动画、卡片 `max-height: 100%` 并在卡片内部滚动。
- 保留 DEV-078 的真正修复：查看器类名 `.fdy-chat-screen-viewer`、`style-source.mjs` 按 `@import` 顺序读取样式、“同一类名被两份样式表设置不同 `display`”的检查，以及 `.fdy-chat-thread-layout` 的 `position: relative`（让抽屉以对话区为定位基准，从标题栏下方 12 px 开始，不盖住标题栏）。
- `apps/web/scripts/audit-v3-layout-contract.mjs`：把锁死贴边侧栏的契约改为锁住浮动卡片（rail 内边距、卡片边框/圆角/背景/阴影、卡片不得设定高度；抽屉 12 px 内缩），以免以后再被改掉。

与 DEV-078 之前的 CSS 对比：这两条规则除注释外完全相同。

## 自验

- 真实 dev（不拦截，线上 `871c74cf41b6aa0e`），e2e-alice，只读打开 DEV-048 合成工作区的已归档会话 `sess_1793202140770104457`，在 1920×1000、1430×880、1430×520、1280×800（抽屉）、390×844（抽屉）× light/dark 共 10 种组合下测量：
  - 宽屏：标题栏下沿 45 px，卡片上沿 63 px（18 px 间距）、右侧 18 px，卡片高 623 px（按内容），24 px 圆角，有阴影；文档不滚动。
  - 1430×520：rail `scrollHeight` 661 > `clientHeight` 475，整张卡片在 rail 中滚动，与原样一致。
  - 1280 抽屉：卡片距对话区上沿和右边各 12 px，带关闭按钮；390 宽同样是浮动卡片。
  - 10/10 卡片圆角 24 px 且有阴影。截图在 `.foundry/attachments/20261030/dev098/`（不入库）。
- `scripts/check-changed.sh --files`（3 个文件）：prettier、Web tsc、`audit:ui` 12 项全部通过。

## 部署

- 2026-10-30 14:10（北京）`scripts/deploy-web-dev.sh`：`992d80038c6faa45` → `871c74cf41b6aa0e`，从共享工作树构建（已上线的 DEV-095/096/097 Web 改动 + 本项）。回滚入口 `~/.foundry/server/releases/dev098-web/previous-20261030T061020Z`。只改 Web。

## 验收步骤（人工）

1. 宽屏（>1360 px）打开有 Changes 的聊天：右侧是带圆角和阴影的浮动卡片，离标题栏和右边各约 18 px，卡片高度跟内容走。
2. 把窗口压矮，或展开较多文件：整张卡片随右侧区域一起滚动，而不是卡片撑满高度后在里面滚。
3. 窗口缩到 1360 px 以下，点标题栏右侧的面板按钮：浮动卡片抽屉从右侧滑出，四周留 12 px，右上角有关闭按钮。
4. 聊天页本身上方和右侧没有多余空白（DEV-078 的修复仍在）。
5. light/dark 各看一次。

## 时间线

- 2026-10-30 本人反馈；查明来源为 DEV-078 的额外视觉改动；本人选择恢复原样。
- 2026-10-30 14:10 部署 dev Web `871c74cf41b6aa0e`，在线复验 10/10 通过。剩余：人工验收；提交待定。
