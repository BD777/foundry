# DEV-071 统一提示：去掉顶部整宽横幅，分成临时 / 常驻 / 就地三类

## 当前状态

| 环节            | 状态   | 说明                                                                                     |
| --------------- | ------ | ---------------------------------------------------------------------------------------- |
| 问题理解 / 调研 | 已完成 | 盘点全部提示面，对照 Material 3、Carbon、Atlassian、Primer、Radix/shadcn、Apple HIG      |
| 代码            | 已完成 | 未提交（编排会话在 22:00–09:00 窗口统一提交）                                            |
| dev Web 部署    | 已完成 | 见“部署”                                                                                 |
| dev Server      | 不涉及 | 只改 Web                                                                                 |
| Worker 更新     | 不涉及 |                                                                                          |
| Agent 自验      | 已完成 | 单测、audit:ui、check-changed、真实浏览器（light/dark × 1280/390、键盘、读屏标签、断连） |
| 人工验收        | 待确认 | 步骤见文末                                                                               |

## 问题

用户 2026-10-28 反馈（截图）：右侧内容区顶部常有一条整宽的 “Local API is not reachable” 提示，挤占页面、很难看。要求：提示不放在那个位置；用统一组件；需要常驻的和会自动消失的分成两种组件；先调研业界与组件库的做法再实现。另查 2026-10-29 00:00（北京时间）前后 dev.foundryapp.app 出现这条提示的原因。

## 00:00 那条 “Local API is not reachable” 的原因

结论：**误报，而且会一直挂着**。服务器没有重启，也没有长时间不可达。

- 服务器日志（服务器本地时区 UTC−4）：最后一次重启是 09:11 的 SIGHUP 交接（北京 21:11），之后到 12:07（北京 00:07）都没有重启、`listening`、panic 或 `database is locked`。11:55–12:05 只有常规的 1–3 s 慢请求（`session-work`、`codex/inspect`），没有超过 30 s 的。12:00 整点的日志切分（pm2 logrotate）不会重启进程。nginx 日志无权读取，无法确认浏览器侧那次请求的具体结果。
- 触发条件（`app/use-workspace-data.ts`）：任何一次后台读取失败（网络抖动、浏览器挂起后恢复、30 s 的 `backgroundReadTimeoutMs` 超时），`readLatestData` 的 catch 都会把 `apiState` 置为 `fallback`，`AppNotices` 随即在页面顶部插入横幅，没有任何宽限期。
- 为什么挂着不走：只有下一次**成功的**读取才会把状态改回 `connected`。事件流（SSE）一直开着或断线续传（resume）时不会触发读取（设计上续传无需重读），所以只要失败的那次读取之后没有新的读取，横幅会一直显示，即使服务器早已正常。
- DEV-062 的重试（`fetchThroughRestart`）只对“代理返回的 502/504 HTML 或启动中 503”生效；`fetch` 本身抛错（浏览器侧断网、挂起）或 30 s 超时不在其中，所以不能避免这次误报。
- 文案也不对：线上是远端服务器，不是“本地 API”。

修复（随本条一起上线）：

1. `fallback` 状态下每 4 s 重读一次（`fallbackRetryMs`；隐藏标签页不重试，切回时立即读），第一次成功就清除状态。
2. 只有持续 8 s 的失败（`unreachableGraceMs`）才显示常驻状态；一次抖动后很快读成功，用户什么也看不到。
3. 文案改为 “Can't reach the Foundry server · retrying / 连接不上 Foundry 服务器 · 正在重试”。

## 调研

| 来源                                                                                                                                                                                                       | 要点                                                                                                                                                                        | 对本项的采用                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [Material 3 Snackbar](https://m3.material.io/components/snackbar/guidelines)；[Material Banner（M2）](https://m2.material.io/components/banners)                                                           | Snackbar：底部、短暂、自动消失、最多一个动作。Banner：重要且持续、需要用户处理；M3 已不再提供 Banner 组件                                                                   | 临时反馈用底部 toast；不用页面横幅                       |
| [Carbon Notification](https://carbondesignsystem.com/components/notification/usage/)                                                                                                                       | Toast（时效性、不打断）、Inline（放在相关内容旁，持续到解决）、Actionable（需要动作）分开；系统级的才用 banner                                                              | 三分法：toast / 常驻状态 / 就地 Alert                    |
| [Atlassian Flag](https://atlassian.design/components/flag/usage)、[Banner](https://atlassian.design/components/banner/usage)、[Section message](https://atlassian.design/components/section-message/usage) | Flag：角落浮层、事件反馈；Banner：仅限严重的系统级消息、一次一条；Section message：属于某个区块的说明                                                                       | 连接状态不配用 banner；区块说明用 Alert                  |
| [GitHub Primer：通知与消息](https://primer.style/product/ui-patterns/notification-messaging/)                                                                                                              | 优先就地显示；toast 对读屏和键盘不友好，只用于不影响操作的短消息，且必须能被键盘到达                                                                                        | toast 只放短反馈；保留 F8 定位、悬停/聚焦暂停、关闭按钮  |
| [Radix Toast](https://www.radix-ui.com/primitives/docs/components/toast)；[shadcn/ui Sonner](https://ui.shadcn.com/docs/components/sonner)                                                                 | 悬停、聚焦、窗口失焦时暂停计时；F8 热键；滑动关闭；Sonner 默认右下角堆叠                                                                                                    | 沿用已有 Radix Toast；位置按视图避开主要控件（见第二轮） |
| [Apple HIG Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts)                                                                                                                   | 警告框只用于需要决定的重要信息，少用                                                                                                                                        | 需要决定的继续用 Dialog                                  |
| 应用实例                                                                                                                                                                                                   | Google Docs 在文档标题旁用小图标/短文字显示 “正在尝试连接 / 离线”；Notion 在顶栏显示小的 “Offline” 标记；VS Code 用状态栏条目显示远端连接状态。都不插整宽横幅，也不推动正文 | 常驻状态做成应用框架里的小胶囊，详情放弹层               |

## 盘点与归类

| 提示面                                                                                       | 原位置                     | 类别                 | 处理                                                                                                    |
| -------------------------------------------------------------------------------------------- | -------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------- |
| `app/app-notices.tsx` “Local API is not reachable”                                           | 主区顶部整宽横幅           | 常驻全局状态         | 移入侧栏状态胶囊，8 s 宽限，自动重试，文案改正                                                          |
| 同上 “Offline — showing demo data”（演示模式）                                               | 主区顶部横幅               | 常驻全局状态         | 状态胶囊 “Demo data”                                                                                    |
| 同上 加载中 / 保存中（`shell-progress` 无限时 toast）                                        | 右上 toast                 | 常驻全局状态（进度） | 超过 1.5 s 的加载在状态胶囊显示 “Loading…”；删除无限时 toast                                            |
| `app/deployed-build.tsx` “A new version… Reload”                                             | 主区顶部横幅               | 常驻全局状态         | 状态胶囊 “Update”，弹层内 “Reload”                                                                      |
| `features/chat/chat-archive-banner.tsx` 已归档对话                                           | 对话标题下、消息上方的横幅 | 就地（阻止继续）     | 移到输入框位置，与对话列对齐；标题 “This chat is archived”，带 “Unarchive”                              |
| 已归档列表后台轮询失败（`archiveError` → “Could not update chat archive / Failed to fetch”） | 错误 toast                 | 不属于任何动作的结果 | 不再弹 toast（断连由状态胶囊说明；归档页内仍就地显示）；归档/撤销动作失败仍由 `useChatArchive` 弹 toast |
| Skills、Skill library 页顶部 `Alert`（保存/加载失败）                                        | 页面顶部整宽 Alert         | 动作结果（临时）     | 改为错误 toast（`ToastFeedback`）                                                                       |
| `components/ui/toast.tsx`（复制、归档 Undo、保存成功等）                                     | 右上角                     | 临时反馈             | 按视图放在避开主要控件的角落（第二轮），API 增加 `placement`                                            |
| `chat-thread-notices.tsx` 只读 / 线程提示、设备离线提示、后台任务与定时提示                  | 输入框位置 / 输入框上方    | 就地                 | 保持；只读提示与归档提示共用新的 `.fdy-chat-read-only` 列宽                                             |
| `issues/issue-notices.tsx` Worker 需要更新                                                   | Issue 输入框上方，与其对齐 | 就地                 | 保持（说明的是这个输入框为什么不能执行）                                                                |
| `devices/agent-runtime-update-notice.tsx` 运行时需要更新                                     | 设备账号行内               | 就地                 | 保持                                                                                                    |
| 设备、连接器、资源、成员、Personal Agent 等页面区块内的 `Alert`                              | 各区块内                   | 就地                 | 保持；`Alert`（tone × size）即统一的就地提示组件                                                        |
| 各处删除/停止确认                                                                            | Dialog                     | 阻断（需要决定）     | 保持                                                                                                    |

`NoticeLine` / `NoticeStack`（`.fdy-notice-stack`）已删除，主区顶部不再有任何提示容器。

## 设计与实现

三种组件，各有公开 API 和自己的样式表：

1. **临时反馈：`Toast`**（`components/ui/toast.tsx` + `toast.css`，Radix Toast）。右下角堆叠，最多 3 条；成功/信息 5 s、错误 10 s、带动作的不自动消失；悬停、聚焦、窗口失焦时暂停；F8 定位、Tab 到关闭按钮、滑动关闭。位置：底部有输入框的视图在右上角页头下方，其余页面在右下角，窄屏在顶部（第二轮修正，见下文）。
2. **常驻全局状态：`StatusIndicator`**（新增 `components/ui/status-indicator.tsx` + `status-indicator.css`）。
   - API：`items: StatusItem[]`（`id`、`tone: progress | info | warning | error`、短 `label`、完整 `title`、可选 `description`、可选 `action`），`iconOnly`。
   - 胶囊显示最严重一项的短标签；点击、Enter 或空格打开弹层（Radix Popover），列出全部状态和各自的动作；Escape 关闭，焦点回到胶囊。
   - 一个始终挂载的 `role="status"` 隐藏区域播报状态变化；胶囊的可访问名称包含全部状态。
   - 位置：侧栏品牌行。有状态时胶囊占用 logo 和 “Foundry” 名称的位置，高度与 logo 相同（28 px），所以出现、消失都不移动任何东西；折叠侧栏时只显示图标。由 `FoundrySidebar` / `SidebarBrand` 的 `status` 属性传入。
   - 状态来源：`app/app-notices.tsx` 的 `useAppStatus`（连接不上服务器 8 s 宽限、加载 1.5 s 宽限、新版本），`useSustained` 负责宽限。
3. **就地提示：`Alert`**（`components/ui/alert.tsx`，tone × size）。放在它说明的对象旁边。归档对话的提示从对话顶部移到输入框位置。

取舍：

- 常驻状态没有放在页面右上或底部角落：右上会遮住页面标题栏按钮，底部会遮住对话输入框；侧栏品牌行在所有宽度下都在，空间已经存在，不会推动正文。
- 品牌行宽度有限，胶囊只显示一个短标签，不显示 “+1” 计数；其余状态在弹层和可访问名称里。
- 后台轮询失败不弹 toast：它不是用户动作的结果，弹出来只会和状态胶囊重复。

## 验证

- 单测：新增 `apps/web/test/status-indicator.test.mjs`（严重度排序、live region 始终挂载、仅图标模式、`useSustained` 宽限与中断重计）；`chat-archive-review.test.mjs` 改为断言归档提示位于对话列内、不再弹后台读取错误。
- Web 全量单测：改动前 940/940，最终 942/942（新增 2 个）。
- `pnpm typecheck`、`pnpm audit:ui`（11 项）、`scripts/check-changed.sh --files <本项文件>` 通过。
- 真实浏览器（headless Chromium，独立临时 profile，复用 `e2e-alice` 登录 dev；页面与资源由本地构建经浏览器路由提供，API 走真实 dev；断连只在浏览器内中止 `/api/*` 请求模拟，不影响服务器）：
  - 1280 light、1280 dark（折叠侧栏）、390 light、390 dark：断开约 6.5 s（有一次读取失败）后恢复，状态胶囊**从未出现**；持续断开约 13.4 s 后出现 “Reconnecting…”；恢复后 1.8–3.8 s 消失。整个过程中 `.fdy-view` 与侧栏导航的 top 不变（1280：0 / 58 px；390：143 / 58 px），页面无位移；`.fdy-notice-stack` 不存在。
  - 键盘：聚焦胶囊按 Enter 打开详情，Escape 关闭后焦点回到胶囊；可访问名称 “Can't reach the Foundry server · retrying — show details”；live region 文本与之对应。
  - Toast：复制 → 右下角 “Copied”；悬停 7 s 不消失，移开后约 5 s 消失；F8 聚焦视口，聚焦期间 6.5 s 不消失，Tab 到 “Dismiss notification” 按 Enter 关闭。390 宽度下为底部全宽。
  - 动作 toast：在 DEV-048 合成工作区归档 “Reply exactly DEV048…”，出现 “Archived 1 chat… · Undo”，7 s 后仍在，点 Undo 显示 “Restored 1 chat”，该对话回到列表（最终状态与操作前一致）。
  - 已归档对话：提示位于输入框位置、与消息列对齐，含归档人/时间、“Unarchive it to continue.”、原生副本状态和 Unarchive 按钮。
  - 新版本：浏览器内把 `version.json` 改成另一个 build，标签页重新可见后胶囊显示 “Update”；同时断连时胶囊显示更严重的 “Reconnecting…”，弹层列出两项（Retry now / Reload）。
  - 中文：浏览器内把账号语言改为 zh-CN（只改响应，不改账号设置）：“有更新”、“正在重连…”、“连接不上 Foundry 服务器 · 正在重试”、“立即重试”、“重新加载”。
- 截图：`.foundry/attachments/20261029/dev071/`（不入库）。

## 部署

- 2026-10-29 01:31（北京）用 `scripts/deploy-web-dev.sh` 发布 dev Web：`b0ba3d5929f1811e` → `ce2e4fe1ec59fa5e`，从共享工作树（main `84426cc` + 本项未提交改动）构建，与浏览器自验的是同一个 build。脚本确认入口资源一致、API 同源返回 JSON。
- 回滚副本：`~/.foundry/server/releases/dev071-notices/previous-20261028T173127Z/`（原 index.html 与 version.json）；本次 dist 在同目录 `web/`。
- 部署后在真实站点（不经本地路由）复验：页面 build 为 `ce2e4fe1ec59fa5e`，API 只请求 `https://dev.foundryapp.app`，无 `.fdy-notice-stack`；浏览器内中止 `/api/*` 13.4 s 后出现 “Reconnecting…”，恢复后消失。

## 第二轮（2026-10-29，编排会话转达的人工反馈）

### 1. Toast 不能盖住主要控件

第一轮把 toast 放到右下角，在对话页会盖住输入框右侧（账号、模型、发送按钮）。用浏览器脚本统计各页面候选区域内的可交互元素（1280 × 800）：

| 区域                  | 盖住的控件                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| 右下                  | 对话：输入框、账号、权限、模型、发送；助理：输入框、发送；Workspaces 页列表行；Account：Sign out |
| 右上（页头下方 64px） | 对话、Issues、Resources、Skill library：无；Devices、Model providers、Connectors 页头按钮        |
| 左下                  | 助理输入框；Workspaces 列表行                                                                    |
| 390 宽顶部            | 所有页面只有品牌行的语言、主题按钮                                                               |
| 390 宽底部            | 对话、助理的输入框；部分页面列表行                                                               |

没有一个角落对所有页面都干净，因此按视图决定：`ToastProvider` 新增公开属性 `placement`（`"top" | "bottom"`，视口带 `data-placement`），`FoundryShell` 透传 `toastPlacement`，`app/navigation.ts` 的 `toastPlacementForView`：底部有输入框的视图（对话、助理、Issue 详情）放右上角页头下方（top 64px），其余页面放右下角；窄屏（≤860px）一律放顶部（只会暂时盖住品牌行的语言、主题按钮）。样式只在 `toast.css`。

### 2. 后台读取失败不弹 toast

第一轮截图里的 “Could not update chat archive · Failed to fetch” 来自修复前的构建。新构建在对话、助理、Devices、Resources、Skill library、Issues、Workspace 页各断连 22 s：状态胶囊出现，期间没有任何后台读取 toast。

同时发现 Skill library 每次打开都会弹出某个仓库上次每日检查失败的原文（npm 报错）toast：这是行的状态，不是动作结果。改为：仓库行内显示 “The last check failed / 上次检查失败” 的紧凑 Alert，原文放在可展开的诊断详情里；行内动作失败仍弹 toast。仓库列表读取失败改为在仓库区块内显示错误（此前会一直显示加载中）。

### 3. 加载状态统一为组件

新增 `components/ui/loading.tsx` + `loading.css`：

- `Spinner`：装饰性转圈（`aria-hidden`），旁边必须有文字说明。
- `LoadingState`：转圈 + 短标签，`role="status"`、`aria-busy="true"`；`layout="block"` 在区域内居中。用于动作、对话框、小区块的等待。
- `Skeleton`：占位条（`lines` / `rows`），标签只给读屏（视觉隐藏），`role="status"`、`aria-busy`。用于内容区。
- `Button` 新增 `busy`：转圈 + 保留的标签（“Saving…”）、`aria-busy`、禁止重复点击。
- `prefers-reduced-motion: reduce` 下转圈和扫光都停止（浏览器实测 `animation-name: none`）。状态胶囊的进度图标也改用 `Spinner`。

盘点（en/zh 两种语言里 “Loading / Checking / Reading / Scanning / Preparing / Fetching / 正在…” 的用处）与处理：

| 类别            | 位置                                                                                                                                                                                                                                                                                                               | 处理                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 内容区占位      | 归档对话框对话列表、Skill 目录列表、工作区服务、Issue 环境/证据/候选改动、设备标签/运行中的回合、Feishu/设备连接器/工作区连接器、资源清单/活动、Skill 对比索引/文件、仓库列表、仓库读取、Foundry skill、草稿、Personal Agent 知识库/活动/记忆/对话历史、工作区与渠道默认智能体                                     | `Skeleton`                                                                          |
| 动作/对话框等待 | 归档检查以外的确认中提示（证据检查、准则检查、服务商检查、Cloudflare 区域、授权开始/等待/重连、资源检查/安装/保存、仓库行处理中、推荐包添加中、模型下拉加载、路径选择器、目录浏览器、文件/差异/后台输出读取、对话分组读取/保存、Diff 查看器与对比加载、助理入口、工作区检查结果、Worker 更新步骤、账号默认值加载） | `LoadingState`（或 `Spinner` + 原有文字）                                           |
| 按钮挂起        | 归档、加载更早消息、重新检查状态/重新扫描、立即更新运行时、检查运行时、检查登录、检查账号、读取仓库、开始试用草稿、外部连接检查、检查全部                                                                                                                                                                          | `Button busy`（不能禁用焦点的外部连接检查按钮保持 `aria-disabled`，只加 `Spinner`） |
| 保留            | `agent-default-fields` 输入框 placeholder、Personal Agent 模型字段 hint（字段内说明文字，控件本身可用）；扫描按钮已有转动的刷新图标                                                                                                                                                                                | 不改                                                                                |

归档对话框（用户截图的例子）：检查期间正文是行骨架，“Checking chats and linked work…” 只作为读屏标签出现一次，页脚不再重复；主按钮显示 “Archive… / 归档…” 并禁用，检查完成后变为 “Archive 1 chat”，提交中为 busy 按钮 “Archiving…”。

### 4. Toast 垂直居中与 “X is responding.”

- 原因：关闭按钮 28 px 高，比一行文字（13 px × 1.5 ≈ 19.5 px）高，行高被按钮撑开，文字贴上、下方留白多。改为关闭按钮 `margin-block: -4px`、图标 `margin-top: 1px`：单行时文字上下各 13 / 13.5 px，图标、文字、关闭按钮中线一致（实测 87 / 86.8 / 87 px）；多行和带动作的 toast 以第一行对齐。状态弹层逐项检查无同类问题。
- “{{agent}} is responding.” 与离线时的 “{{device}} is offline. The message waits…” 两个发送后 toast 删除：这条 toast 只在对话页内发送时出现，对话本身已经显示运行中，离线时输入框上方已有设备离线说明，toast 只是重复。对应文案键已从两种语言中删除。

### 5. 仍看到顶部 “A new version… Reload” 横幅

旧构建 `b0ba3d5929f1811e` 的新版本提示就是顶部横幅，打开着的旧标签页在重新加载前仍运行旧代码。新构建的产物和源码里已没有 `fdy-notice-stack` 或 “Local API is not reachable”；在新构建上用浏览器把 `version.json` 改成另一个 build，只出现侧栏胶囊 “Update / 有更新”。

### 第二轮验证

- Web 全量单测、`typecheck`、`audit:ui`、`check-changed` 结果见时间线；新增 `test/loading.test.mjs`（LoadingState / Skeleton / busy Button 的角色与属性，`toastPlacementForView`）。
- 真实浏览器（新构建，本地产物经浏览器路由、API 走真实 dev，`e2e-alice`，DEV-048 合成工作区）：
  - 1280 light、1280 dark（reduced motion）、390 light、390 dark（reduced motion）：复制 toast 不与输入框重叠，toast 下方无任何控件（390 宽只盖住语言、主题按钮）；单行 toast 上下间距 13 / 13.5 px，三者中线一致。
  - 1280 两种主题：归档对话框检查期间显示骨架、主按钮 “Archive…” 禁用、加载文字只出现一次；归档后 “Archived 1 chat · Undo” toast 在右上，不盖输入框；Undo 后恢复，合成对话回到列表。
  - 断连约 18 s：只出现状态胶囊，没有后台 toast；恢复后胶囊消失。
  - reduced motion：`.fdy-spinner`、`.fdy-skeleton-bar` 的 `animation-name` 为 `none`。
- 截图：`.foundry/attachments/20261029/dev071/v2-*.png`（不入库）。
- 局限：页面视图（右下）未逐页触发 toast，依据是上表的区域统计；Issue 详情（右上）因合成工作区没有 Issue 未在浏览器中检查。

## 局限

- nginx 日志无权读取，00:00 那次浏览器侧失败的具体原因（网络抖动、挂起恢复或超时）无法确认；结论基于服务器日志无重启、无超长请求以及代码路径。
- “Loading…” 状态（加载超过 1.5 s）只在单测和代码层面验证，浏览器中未专门制造慢加载。
- 其余页面区块内的 `Alert` 未逐个改动，按“就地”归类保留。

## 验收步骤

1. 打开 https://dev.foundryapp.app/chats ，强制刷新一次。预期：页面顶部没有任何整宽提示；左上角是 logo 和 “Foundry”。
2. 在浏览器开发者工具 Network 面板选择 “Offline” 约 3 s 后恢复。预期：什么都不出现。
3. 再选择 “Offline” 并保持 15 s 以上。预期：约 8–15 s 后左上角 logo 位置变成黄色胶囊 “Reconnecting… / 正在重连…”，页面内容不移动；点它（或 Tab 到它按 Enter）显示 “Can't reach the Foundry server · retrying”、说明和 “Retry now”；Escape 关闭。
4. 恢复网络。预期：几秒内胶囊消失，logo 和 “Foundry” 回来。
5. 在任一对话里点消息的复制按钮。预期：右上角（页头下方）出现 “Copied”，不盖住输入框；文字、图标、关闭按钮在一条中线上；鼠标悬停时不消失，移开约 5 s 后消失。发送消息后不再弹 “… is responding.”。
6. 打开 https://dev.foundryapp.app/chats ，点左侧列表底部 “Archived”，打开一个已归档对话。预期：消息上方没有横幅；输入框位置显示 “This chat is archived”、归档时间和人、“Unarchive” 按钮，并与消息列对齐。
7. 切换深色模式、窄屏（约 390 px 宽）重复 3–5。预期：胶囊在顶部品牌行内；toast 在顶部全宽，不遮挡输入框。
8. 在对话列表右键一个对话选 “Archive”。预期：检查期间对话框里是灰色占位条，按钮显示 “Archive…” 且不可点，“Checking chats…” 文字不重复出现；检查完显示 “Archive 1 chat”。（若确认归档，用 toast 里的 Undo 恢复。）
9. 打开 https://dev.foundryapp.app/skill-library 。预期：不再弹出仓库检查失败的长 toast；检查失败的仓库行内显示 “The last check failed”，可展开看原文；加载期间是占位条而不是一行 “Loading…” 文字。
10. 若某个旧标签页仍显示顶部 “A new version… Reload” 横幅，重新加载一次。预期：之后新版本提示只出现在左上角胶囊里。

## 时间线

- 2026-10-29 00:10 前后（北京）：接手；查服务器日志确认无重启，定位误报与挂起原因。
- 2026-10-29：实现三类提示、迁移各提示面、自验（见“验证”）。
- 2026-10-29 01:31：dev Web 发布 `ce2e4fe1ec59fa5e`，部署后复验通过。剩余：人工验收；编排会话提交。
- 2026-10-29 02:00–02:40：第二轮（toast 位置、后台 toast、加载组件、toast 居中、删除 “is responding” toast、横幅核查）。Web 全量单测 944/944，`typecheck`、`audit:ui` 通过；浏览器自验见“第二轮验证”（构建 `dfbebb860c34112a`）。之后共享工作树里 DEV-073 正在修改 `app/projections/devices.ts`，`check-changed` 的一个用例（`issue-transcript.test.mjs`）因此失败，与本项文件无关，已告知 DEV-073。与 DEV-073 约定由其从共享工作树一起部署 dev Web，部署后本项在线复验。
- 2026-10-29 02:59：DEV-073 从共享工作树发布 dev Web `95d45cc1fa3ac9b5`（原 `ce2e4fe1ec59fa5e`，回滚副本 `~/.foundry/server/releases/dev073/previous-20261028T185928Z/`），包含本项第二轮全部改动；发布前 DEV-073 修正 `devices.ts` 合并问题，Web typecheck 与全量单测 948/948 通过。本项随后在真实站点（不经本地路由）复验：1280 light 与 390 dark（reduced motion）下复制 toast 不盖输入框、单行上下 13 / 13.5 px；归档对话框骨架 + “Archive…” 禁用、加载文字只出现一次；归档 + Undo 恢复合成对话；断连只出现状态胶囊、无后台 toast；reduced motion 下动画为 `none`。当前入口 bundle 中没有 `fdy-notice-stack` 或 “Local API is not reachable”。剩余：人工验收；编排会话提交。
