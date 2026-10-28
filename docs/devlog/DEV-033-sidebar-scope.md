# DEV-033：侧栏全局与 Workspace 作用域重排

## 问题与结论

2026-10-21，用户指出顶部 device + workspace 看起来控制了下面所有导航，但 Assistant 与管理页面实际是全局的。根因在呈现层：`FoundrySidebar` 在全部导航前渲染 `workspaceSelector`，品牌下又显示 `workspaceName`；移动端还把分组摊平并隐藏标题。

当前布局按用户后续明确反馈修正为：Workspace（选择入口与 Overview / Issues / Chats 连续置顶）；一条在展开/收起均可见的分隔线；全局 Assistant 及其设置；全局管理。初次版本曾把 Assistant 放在最前，以下保留首轮记录，最新实现与部署见文末跟进。品牌不再重复工作区；折叠顶部语言/主题/展开功能键使用紧凑的独立按钮组。Assistant settings / 助理设置明确对象，Members 仍仅管理员可见，Account 对所有登录成员可见。

## 实现边界

- 共享 `SidebarNavSection` 新增稳定 `id`、组内 `header` slot 与提示用 `scopeLabel`。App 层仅把真实工作区选择入口放入 `workspace` 组；角色菜单按稳定 id 合成。简单模式没有 Workspace 组，因此不会出现该选择器。
- 工作区入口保持一个共享 Button、一个 Tab 停靠点和向前箭头，仍进入 `/locations`。没有新下拉菜单、重复导航树或 DOM 搬移。名称截断时，焦点／悬停提示提供完整工作区、真实设备及离线／移除状态；没有设备时不虚构默认设备。
- 折叠桌面保留工作区选择入口，全局与工作区项的提示明确范围。Tab 与方向键可遍历组内选择器和所有入口，Home / End 到首尾。
- 移动端沿用实际已有的横向导航，不新建抽屉。平级组保留标题，标题在所属组内粘附；侧栏自身原生滚动取代访问 Radix 私有 viewport 的样式和 `!important`。桌面折叠样式只在宽屏生效，回到宽屏保留原偏好。
- 没有修改路径、query、后退、workspace scoped view 集合或数据请求契约。全局 URL 上保留的 workspace query 仍是返回上下文，不是全局数据过滤器。没有修改设备生命周期规则；继续消费原有设备投影和 `isRemovedDevice`。
- 固定源基线为 `foundry-dev031-compact`，保留 DEV029 授权修复、DEV030 Services / Dialog 和 DEV031 Usage 紧凑布局。DEV028 和其他未准出源码没有从 main 整树带入。后续仅按 DEV032 的固定 Web manifest 叠加其已验路径；组合验收发现的 Memory 只读问题由原 owner 修复后，以不可变 `web-source-manifest-verified.json` 再次精确叠加。

## 验证记录

合成浏览器夹具使用真实 AppSidebar、AccountsGate、WorkspacesFeature、route sync 与 workspace event handler，只替换账户及工作区数据和加载结果，不修改实际账号、设备或工作区。

- 新增 scope 回归：无 workspace 的全局入口、selector 组归属、简单模式、成员／管理员菜单、翻译后稳定组标识、Issues 选中与 badge / live count、离线／移除历史和方向键。
- 更新已有 location 浏览器组件回归的 accessible name 查询，以接受当前上下文信息。
- 真实 Chromium 矩阵：1440 / 1280 桌面、390 窄屏，亮暗主题、中英文、展开／折叠、480 短高度、空工作区、无设备、离线长名称、移除历史、简单模式；键盘可到达全部入口，整页无意外水平溢出。
- 移动导航本身有意横滚，与整页溢出分别测量。Desktop 侧栏 262px，折叠 64px；移动端不继承 64px。实际导航高度与可达性记录在 `measurements-0.json` 和 `measurements-6.json`。
- 完整定向检查的类型检查、格式检查和 10 项 UI 审计通过；18 个相关 Web 测试文件中 145/146 初次通过，唯一失败为新键盘测试环境缺少 ResizeObserver。补齐浏览器模拟后，侧栏／工作区／路由／标题共 36 项复验全部通过。夹具最初的 disconnected 枚举和数组判空问题也已修复。
- 追加移动端键盘高度变化回归：仅跨越宽度断点才自动显示当前导航，避免输入时拉回页面顶部；真实 Chromium 高度从 844 改为 520，scrollY 维持 500。
- 固定候选的 10 项 UI 审计另行通过；保留原有 3 项布局债务，没有新增债务。

证据目录：`/tmp/dev033-evidence/`；截图目录：`.foundry/attachments/dev033/`。原始问题截图为 `.foundry/attachments/20261021/att_dmae7fmr4qh3_0_image.png`。完整桌面、窄屏、长名称、折叠及失败态截图均按场景命名。

## 首次发布与验收

2026-10-21 18:08（北京时间）已发布并完成 Agent 验收：

- Web **`42beb69cdbb454c6`**，index SHA-256 **`786f6a72da0caac5f8644f86f9cdd1f8104c56213609656471f4756d078bd649`**。公网 HTTP / version.json、磁盘产物与认证浏览器的 build meta 一致。
- 配套 DEV032 Server PID **1806348**，实际已加载 SHA-256 **`fb96a556f670c5696469b18ec029275c90f8603a8940d0ff1b19a180b0d337b8`**，health ok。该 Server 由 DEV032 owner 独立发布，本项 Web 发布前后 PID / hash 未变。
- Worker 保持 **`0.5.7-dev.49.g84aed61.local.1792570873`**，release pointer SHA-256 `9215ebfc83c704f4b34aae053adf7610276d499ddfff9caa669877a9cd63cbb9`，未更新或重启执行 host。
- 最终固定候选的 typecheck、生产构建、40 项组合测试和 10 项 UI 审计通过。候选 `~/workspace/foundry-dev033-release`，19 个自有代码/测试路径和 DEV032 13 项已验 Web 增量之外，2,006 个基线文件逐一核对未变。报告另行归档，不参与浏览器包。
- 复用已登记的 `e2e-alice`：66 步线上命令覆盖全局导航、workspace query 保留、后退/刷新、空工作区、普通成员权限、亮暗与 390px 页面；追加真实折叠入口/键盘提示及手机忽略桌面折叠偏好检查。浏览器错误为 0，整页无意外横溢。管理员和简单模式使用合成账号夹具验证，未修改真实账号的权限或界面偏好。
- 显式发布保留全部旧 assets，原 index / version 在 `/tmp/dev033-evidence/rollback/`；自动 publisher 仍禁用。构建与发布前后磁盘均大于 14 GiB 可用。

关键证据：`source-manifest.json`（继承 `/tmp/dev032-evidence/web-source-manifest-verified.json`）、`deployment.json`、`build-release.log`、`combined-tests.log`、`ui-audit-release.log`、`live-final.json`、`live-collapse.json`、`production-preview.json`，均在 `/tmp/dev033-evidence/`。线上前后图为 `live-before.png` / `live-after-desktop.png`；另有 `live-after-dark.png`、`live-after-mobile.png`、`live-no-workspace.png` 与 `live-collapsed.png`，均在 `.foundry/attachments/dev033/`。

组合验收已复用 DEV032 隔离实例（`127.0.0.1:32032`，测试用户 `dev032`，integrations off），只读核验 Devices / Where it works / About me。额外发现已移除 Memory 根仍发起读取并显示原始 `device_removed`，已交 DEV032 owner 修复；最终冷刷新复验无原始错误，迁移／重建／新增等源操作禁用，元数据刷新可用，保留原 Workspace 名称。证据为 `memory-readonly-smoke.json` 与 `combined-memory-readonly.png`（SHA-256 `28b402a71057e0686ba9f4d68b981b14d41de2076b48ca657d238e16d4974692`）。该截图在等待宽度动画稳定、侧栏实测 262px 后重新拍摄并查看；首次过早拍摄的过渡帧没有作为验收依据。触控模拟通过 Chromium 原生 touchStart / touchMove / touchEnd 将导航从 0 滚至 1198px，Account 可见，整页无横溢。

本项按 2026-10-21 父会话转交的用户 Agent 自验准出授权，关闭上述已验证的侧栏范围；这不是用户亲自操作验收。源代码与报告交单一联合集成 owner，联合 CI / 合入仍待其完成，本文不声称已 commit / merge。移动端保留横向导航；既有 3 项布局审计债务未扩展。后续 DEV031 新的 Usage 标题对齐反馈由原 owner 独立处理，以本次完整候选为基线，不回退侧栏或 DEV032。

清理回执 `cleanup.json` 确认本次 5333 / 5334 / 5335 验证服务与 9333 浏览器端口均已关闭，临时浏览器 cookie 已清空；公共 Server / 用户服务未停止，数据库与回滚文件保留。

验收入口：打开 dev 任一全局页面，应先见独立 Assistant，再见包含位置入口的 Workspace，最后是全局管理；进入位置页浏览/返回不改变工作区，只有明确 Switch 成功才同时更换设备与工作区。窄屏可以横向滚到全部分组，组标题保持可见。

## 用户反馈跟进：Workspace 置顶与单图标选择器（2026-10-21）

用户明确认为初版不够好看，要求 Workspace 回到最上方，用横线分隔下方全局功能，收起时也保留线条；随后明确要求去掉设备名旁的第二个 Monitor 图标。

本轮将 Workspace 选择器与 Overview / Issues / Chats 放成导航第一组。共享 `SidebarNavSection.dividerBefore` 在其后渲染同一个边界元素；桌面展开/收起均为横线，窄屏沿用横向导航并将边界转为竖线。简单模式不存在 Workspace，也没有孤立的边界线。Assistant 和 Manage 保持全局、平级、可达。

选择器仍是一个 Button：单一 Folders 主图标、工作区名主行、设备名次行和右箭头。两行文字与下方导航文字使用同一左边缘；图标、两行文字整体和箭头通过 grid 的三列居中对齐，不用位移或补偿缩进。行距缩为 2px，正常双行入口约 46.5px 高。设备名称和离线/移除状态保留，完整工作区与设备信息仍可通过焦点/悬停提示读取。Overview 改用 LayoutDashboard 图标，使收起后的选择入口和概览入口明确不同。

冻结源基线为 `~/workspace/foundry-dev029-async`（Web `9a3d8d1e2d827097`），继承最新 DEV029 异步授权、DEV032、DEV031 Usage 对齐和 revision 9。本轮只有 7 个代码/测试路径的精确增量；其他 2,036 个基线文件逐一核对未变。候选 `~/workspace/foundry-dev033-top` 仅用于 Web 发布，没有从 main 抓取其他 owner 的新改动。

验证证据在 `/tmp/dev033-top-evidence/`：

- `check.log`：7 路径格式、Web typecheck、8 个相关测试文件、全部 10 项 UI 审计通过。
- `build.log`：冻结候选 typecheck 和生产构建通过。
- 14 个真实 Chromium 场景使用**仅生产 CSS**（移除 Vite 样式后加载实际产物），覆盖中英亮暗、展开/收起、长名称、390px、简单/空工作区、短高度和键盘遍历。`measurements-0.json`、`measurements-7.json`、`measurements-13.json` 记录分隔线、对齐、实际图标及溢出数据。短高度的原生滚动条会缩窄可用宽度，线条仍为可见的 1px 边界，不用固定宽度来绕过滚动布局。
- `interactions.json`：提示包含工作区和设备，方向键/Home/End、取消、明确 Switch 和后退通过；无障碍检查无违规。
- `live-final.json`、`live-divider.json`：独立 e2e-alice 公网验证的 build meta、Workspace 首组、可见分隔线、双行文字对齐、第二行零图标、折叠不同图标、完整提示、亮暗/390px、空工作区及路由/后退/刷新。未改变真实账号权限或偏好，浏览器错误为 0。

2026-10-21 20:52 发布 Web **`3b98a29002d2840d`**，index SHA-256 **`079dcabb9d7411acc10ddf0bc3299e9acf5a5c0d45426f0f7a81581b63c837ba`**。公网 HTTP、version.json、磁盘与认证浏览器一致。Server PID **1840661** / loaded SHA **`3b6403643063afff677888c6b2c568aebfa09add25ca312bd12807363b2f142a`** 未变；Worker **`1792579126`** / pointer **`264c61395b300b0ad4445b9e8027e17d547d6ac6f5a8e0dd8adae59202523720`** 未变。旧 assets 保留，原 index/version 回滚副本在本轮证据目录；auto-publisher 未启用，构建前后磁盘保持大于 11 GiB 可用。

前后图在 `.foundry/attachments/dev033-top/`：`live-before.png`（实际运行 `9a3d8d1e2d827097`）、`live-after-desktop.png`、`live-after-collapsed.png`、`live-scope-tooltip.png`、`live-after-mobile.png`；中英亮暗及长名称的生产样式图也按场景保留。已在正常尺度查看完整页面，不以放大裁图或审计结果替代视觉验收。

这次按用户明确修正合同及原有 Agent 准出授权完成实现和自验；不称用户已经审美确认。精确 manifest 与回执交 PA 的唯一联合 Git/CI 流程，本文不声称源码已合入。

## 同轮追加：折叠顶部功能键组（2026-10-21）

用户进一步要求语言、主题和展开三个功能键在折叠时像 tag group 一样靠近，并与下面的菜单键区分。本轮采用紧凑纵向按钮组，语义仍是普通按钮和可访问的 `group`，不是标签或多选控件。

- 折叠时容器为 40×104px，使用现有 `paper-raised` 颜色和 12px 圆角，无额外边框或阴影；三个按钮各为 32×32px，组内无额外间隙，外侧 4px 内边距。与下方导航保留间距，Workspace/global 分隔线继续存在。
- 共享 SelectMenu 的 icon 模式通过明确公开的 `--fdy-select-icon-size` CSS API 接受尺寸，默认仍为 26px；只有折叠工具组设为 32px。不访问其私有 DOM 来改尺寸，不压缩成三列。
- 工具组有中英可访问名称，保留各按钮 title / aria 与原有 focus、disabled 和菜单语义。展开和窄屏保持原横向布局及默认尺寸。

冻结候选为 `~/workspace/foundry-dev033-tools`。聚合 manifest `/tmp/dev033-tools-evidence/source-manifest.json` 的 before 统一相对 DEV029 async 基线，包含本轮 Workspace 置顶及工具组全部 11 个代码/测试路径，报告另行归档；其他 2,032 个基线文件未变。前一阶段 `foundry-dev033-top` / `3b98a29002d2840d` 保留为历史快照。

主树检查 typecheck / 10 UI 审计通过；选出的测试有两例被其他正在实现的 WorkspaceServiceTunnels 代码影响（undefined.find），已通知集成 owner，未从主树混入该未验代码。冻结候选的 37 项侧栏/路由/工作区测试全部通过，包括这两例；最终格式、typecheck、生产构建和 10 项 UI 审计通过。一处 CSS 空行的格式问题已在最终格式检查前修复。不将主树并发工作描述成已通过全仓测试。

14 个生产 CSS 场景再次验证：中英亮暗、展开/收起、长名称、390px、简单/空工作区和短高度。实测所有折叠功能键均为 32px、组高 104px；展开/移动端仍为 26px，透明横向工具栏。浏览器实际操作语言菜单 Enter / Escape、Tab 焦点返回、主题切换、键盘展开/收起、进入位置选择器、导航方向键及后退。没有选择语言项或修改真实账号偏好。

最终 Web **`8577a1b9c462b8ca`**，index SHA-256 **`30e536b579628bf81b10f05b3c140b70a5c96e40d754c38f1e84bb7ee365ffcf`**。从前一阶段 `3b98a29002d2840d` 显式发布，公网 HTTP / version.json / 浏览器 meta 一致。Server PID1840661 / `3b640364…` 和 Worker1792579126 / pointer264c6139… 均保持不变。旧 assets 和两阶段回滚 index/version 均保留。

最终证据目录 `/tmp/dev033-tools-evidence/` 包含 `build.log`、`format-final.log`、`format-ui-final.log`、`measurements-0.json`、`measurements-7.json`、`interactions.json`、`deployment.json`、`live-final.json` 和 `live-divider.json`。最终图在 `.foundry/attachments/dev033-tools/`，包括 `live-after-desktop.png`、`live-after-collapsed.png`、`live-tools-dark.png`、`live-after-mobile.png`。本轮仍仅交唯一集成 owner 做联合 CI / 合入。

最终清理回执 `cleanup.json` 确认 5337/5338/9337 验证端口已关闭，浏览器 cookie 已清空，公共 Server/Worker 未变；数据库、WAL 与回滚文件未删除。收尾时磁盘可用约 10.14 GiB，后续构建需继续遵守磁盘门。
