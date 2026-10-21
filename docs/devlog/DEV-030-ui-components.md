# DEV-030 Services 卡片与共享 UI 用法整改

## 结论与范围

2026-10-21 已修复并部署 dev Web `f74abfdf92de463d`，Agent 自验通过本项范围。Services 使用共享 Panel、PanelHeader、EmptyState、Button、RowMenu、Alert、Dialog，桌面 22px / 窄屏 16px 内边距与同页卡片一致；三个实际入口均保留。Git repositories 的空态也统一为有标题和说明的 EmptyState。

真实浏览器另外发现并修复了公共 Dialog 的嵌套层级问题：Services 弹窗里的共享服务确认框曾被父弹窗遮罩盖住。修复位于组件自身 DOM/CSS 边界，不添加调用者深穿选择器、`!important` 或测量 DOM 后修改样式。

用户通过统筹会话授权 Agent 自验准出与正常 dev 部署（2026-10-21，本项委派消息）；以下为 Agent 验证，不代表用户本人已试用。源码保留在共享 main 工作树，由 DEV-023 唯一集成 owner 纳入联合 CI/PR；本项未单独提交或合并。

## 根因证据

| 项目            | 修复前证据                                                                                                                                     | 判断                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Services 外容器 | 公开 build `fed228382535f4f1`，DOM 中相邻 Workspace status / Git repositories padding 均 22px，Services Panel 为 0px                           | Panel 默认只提供表面/边框，调用方遗漏内容布局；并非浏览器缩放或偶发 CSS 缓存 |
| Services 内容   | `fdy-workspace-services`、`fdy-workspace-service-row`、`fdy-workspace-service-heading` 在源码没有样式；线上 computed display=block、gap=normal | 缺少组件所属 CSS，标题/说明/动作/空态全部自然流贴边                          |
| 刷新            | 没有 busy/disabled，成功轮询只 setItems，不清旧 load error                                                                                     | 错误可能长期残留；读取与控制错误需要分别保存                                 |
| 嵌套确认        | sectioned Dialog overlay/content z-index=100/101；RowMenu compact 确认=80/81                                                                   | 确认框已存在并取得焦点，但被父层盖住，Cancel 鼠标点击被 overlay 拦截         |

截图：`.foundry/attachments/dev030/before-desktop.png` 与 `after-desktop.png`。两张均为 e2e-alice 的合成 Workspace、1440×1100、devicePixelRatio=1；不是用户私人页面。

## 实现

- WorkspaceServices 自己负责 Panel + Header + 内容布局；Overview 移除外层重复包装。Dialog 通过明确的 `embedded` prop 复用无边框内容，实际检查内部 Panel 数量为 0、内容 padding=0，外层 Dialog 负责留白。
- 说明缩为一句；跨设备访问不迁移进程等执行边界保留在服务详情中。无权限时有只读说明，管理动作仍由原权限和 `workActions` 决定。
- 列表用平面 article 分隔，标题与状态文字可换行；长中英标题、命令参数、服务标识可折行。状态不只靠颜色，正在提交、等待回执和错误均有文字。
- 前台刷新显示忙碌并禁用按钮；后台轮询不使按钮闪烁。读取错误与控制错误分离，成功读取清理旧读取错误，不抹掉失败控制及重试入口。慢请求与轮询共用进行中的读取，旧 Workspace 响应不会覆盖新 Workspace。
- 控制仍使用原 expectedRevision / expectedReferenceRevision / idempotencyKey。浏览器实测失败重试沿用同一幂等键；仅服务器回执/观测确认才更新真实状态。
- Dialog 每个 Portal 使用组件自有 `.fdy-dialog-layer` 堆叠上下文；整个后打开的层（遮罩与内容）覆盖前层。布局只负责排版，菜单仍通过既有 portal 显示在 Dialog 上方。公共 API 不变，无动态 inline style 或新增审计豁免。

## 同类有界审计

对 workspaces 7、devices 26、external-accounts 15、personal-agent 22 个 TSX 文件进行了 class/CSS 对应及 raw 控件模式扫描；随后人工核对下列布局和共享组件调用。静态扫描不代表逐页面视觉验收。

| 路径/组件                                                                                                                         | 检查结果与处理                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `features/workspaces/workspace-overview.tsx`                                                                                      | Services 唯一未加内容布局的 Panel 已修；repositories 空态改为共享 EmptyState。status/repository 原有 padding 保持                                                                        |
| `features/workspaces/workspace-row.tsx`                                                                                           | Services 按钮仍可在全局 Workspaces 打开，无 Switch/选择语义改变；公开页面实测                                                                                                            |
| `features/chat/chat-context-work.tsx`                                                                                             | Manage in workspace 仍打开同一 Services Dialog；合成真实组件实测，无卡片套卡片                                                                                                           |
| `features/devices/device-settings.tsx`、`device-labels.tsx`、`device-resources.tsx`                                               | section/grid/gap 已有所属样式；扫描到的 heading/yours/detected 是 aria id，不是缺失 CSS class；未修改设备/资源业务                                                                       |
| `features/devices/detected-profiles-panel.tsx`                                                                                    | 当前无产品引用；旧容器有 `.fdy-local-daemon > .fdy-panel` 留白规则。未将无入口旧组件当作当前复现缺陷进行重构                                                                             |
| `features/external-accounts/{app-row,device-held-connector,workspace-connectors-feature,workspace-device-connectors}.tsx`         | 外层 section 与空态已有样式和公共控件。`fdy-xacc-app-only` 为附加标记，基础 `fdy-xacc-row` 仍提供布局；不更改 Connector 身份语义                                                         |
| `features/personal-agent/{assistant-setup,assistant-settings,settings-style,settings-rules,settings-entry,settings-activity}.tsx` | PA setup 有 22px/24px padding；无自有 CSS 的 segments/sections 附加在 SegmentedControl 上，activity-when 同时具有 muted。PA owner 独立只读复核确认，无新增已证实布局缺陷；未修改 PA 文件 |
| `components/ui/dialog.{tsx,css}`                                                                                                  | 真实嵌套确认缺陷已修；额外回归顶层 RowMenu、Services 内嵌套确认、Connector 授权弹窗                                                                                                      |

没有批量替换成熟卡片、添加全局 Panel 默认 padding，或重设计设备/Connector/PA 页面。

## 验证证据

固定候选 `/home/windeng/workspace/foundry-dev030-release` 的检查：

- Web typecheck 通过；6 个定向测试文件共 **40/40** 测试通过（包含服务请求恢复/慢请求共享/旧工作区隔离、workspace access、session work、workspace facade、skill promotion 和 connection assignment）。
- 10 项 UI 审计通过；V3 layout 审计保留既有 3 项 tracked debt，没有新增豁免。
- 本报告 Prettier 通过。总表 README 的全文件 Prettier 仍要求重排 20–36 行的其他事项表格；本项仅更新 DEV030 行，保留并发 owner 内容，交统一集成时格式化。该文档格式项不影响已发布 Web。
- 主工作树定向 `scripts/check-changed.sh --files ...` 已执行；最初 2 个类型错误修正后通过。Dialog 增量再次检查通过；最终固定候选重新 typecheck、测试、审计和生产构建通过。
- 真实浏览器矩阵：空态、有服务、超长中英标题、命令详情、只读、断线、读取失败→刷新恢复、提交失败→刷新仍保留错误→幂等重试→等待回执；亮/暗、中/英、1440px/390px。全部控制请求由合成 fixture 拦截，没有停止真实持久服务。
- 键盘：菜单由 Enter 打开；服务详情由 Enter 展开；顶层 compact Cancel 回原菜单；sectioned→compact 的鼠标 Cancel/Stop 可达；Escape 只关当前子层并回菜单，再 Escape 回 Services 入口。聊天入口 Dialog 内无 Panel 重复包装。
- Connector 合成授权弹窗可见、链接/复制按钮可达、Escape 回 Authorize and use here。未发起真实第三方授权。
- 公开 dev：meta、`version.json`、公网 index SHA 和主 JS/CSS 内容哈希与本次产物一致；Services 与邻卡桌面均 22px、窄屏 16px，无横向溢出。公开 Overview axe 38 passes / 0 violations / 0 incomplete。视觉结论来自实际截图，axe 只作补充。

截图目录 `.foundry/attachments/dev030/`：

| 文件                                                             | 场景                                           |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| `after-desktop.png`                                              | 公开 dev，同页相邻卡片，正常尺度               |
| `after-live-dark-mobile.png`                                     | 公开 dev，390px 暗色全页                       |
| `after-live-services-dialog.png`                                 | 公开 Workspaces → Services 空态弹窗            |
| `fixture-long-dark-mobile.png`                                   | 中英长标题，390px 暗色                         |
| `fixture-readonly-mobile.png`                                    | 只读，无服务操作菜单                           |
| `fixture-offline-dark-desktop.png`                               | 断线/状态待确认                                |
| `fixture-refresh-busy.png`                                       | 读取失败后的忙碌刷新                           |
| `fixture-control-error.png`、`fixture-pending-desktop.png`       | 控制失败及等待回执                             |
| `fixture-confirm-desktop.png`、`fixture-confirm-dark-mobile.png` | 修复后的共享确认可见且可交互                   |
| `fixture-chat-dialog.png`                                        | 聊天 Manage in workspace 入口                  |
| `connector-dialog-regression.png`                                | 公共 Dialog 的 Connector 调用者回归（合成 QR） |

可复用 fixture：`apps/web/test/fixtures/workspace-services.html`（参数 `scenario=empty/running/long/offline/pending/load-error/control-error/loading`、`view=locations/chat`、`readonly=true`、`theme=dark`、`lang=zh-CN`）。仅开发测试入口，未加入生产 bundle 路由。`window.servicesFixture` 可调整合成故障/延迟并检查控制请求。

## 发布与回滚

- 基线：DEV029 `/home/windeng/workspace/foundry-dev029-capabilities`（PA＋027＋029 capability delta），逐项核验 226 个基线文件；仅此前已记录的 DEV023 文档哈希漂移不影响代码。追加本项精确 12 文件 delta，不复制 main 全部 dirty，不含 DEV028 未验资源变更。
- 本项 source/base-after manifest：`/tmp/dev030-evidence/source-manifest.json`；固定独立产物 `/tmp/dev030-evidence/web-dist`；构建日志 `/tmp/dev030-evidence/build.log`。
- 前 Web `fed228382535f4f1` / index `905ee33980a3c48ea3dd4fd1234a9726364494a19a53934b852a688009771883`。
- 后 Web **`f74abfdf92de463d`** / index **`77334b17827f8b03f617acc7a21c94be4f2f8bc7d42396ad5ad54df7184c3945`**。
- 公网 JS `index-D916p2qa.js`、CSS `index-DWr23nTb.css` 与本地产物内容 SHA 一致（`/tmp/dev030-evidence/public-assets.json`）。显式先复制哈希资产、最后替换 index/version，未恢复自动 watch。
- 纯 Web 发布：Server PID **1659342** 与已加载 SHA `f9095d32…` 保持，health=ok；Worker **0.5.7-dev.49.g84aed61.local.1792566321** 与 release pointer hash 保持，未重启/重包。
- 部署回执 `/tmp/dev030-evidence/deployment.json`，上一版 index/version 保存在 `/tmp/dev030-evidence/rollback`，既有哈希资产未删除。构建前约 18GiB 可用，完成约 17GiB；未复制 DB 或 node_modules。

## 复验步骤与限制

1. 打开任意有权限 Workspace 的 Overview：Services 标题、简短说明、右侧刷新、空态留白应与邻卡一致；390px 时按钮自然换行。
2. 全局 Workspaces 的 Services 与聊天 Manage in workspace 应打开相同内容，无第二层卡片边框；只读用户能看状态但没有控制菜单。
3. 使用合成 fixture 打开共享服务菜单确认：确认框可见且能取消，Escape 只关当前层，返回触发按钮；控制失败可重试，等待回执不能冒充已停止。

本项未对真实用户服务执行停止、暂停或恢复。断线/失败/长标题等状态使用合成网络响应，未模拟真实 Worker 停机。PA/设备等同类静态审计之外不声称完成全站视觉重验；联合 CI/PR 由集成 owner 接续。
