# DEV-139 加载状态放在它等待的区域里

## 当前状态

| 环节            | 状态   | 说明                                                                                        |
| --------------- | ------ | ------------------------------------------------------------------------------------------- |
| 问题理解 / 调研 | 已完成 | 见“调研”“规则”                                                                              |
| 代码            | 已完成 | 仅 Web，见“改动文件”；worktree `feat/loading-states`（基于 `origin/main` 0c19251c），未提交 |
| dev Server/Web  | 已部署 | Web `6a2b0cf1610243e3`（2026-11-06 04:22 UTC+8，原 `012c4c3b320c5a62`）；Server 不涉及      |
| Worker 更新     | 不涉及 | 无 Worker 改动                                                                              |
| Agent 自验      | 已完成 | 单测、check-changed、scratch 栈真实 Chromium（接口延迟注入），见“检查”                      |
| 人工验收        | 待确认 | 见文末；未提交                                                                              |

## 问题

2026-11-06 本人反馈（附 dev 截图）：会话侧栏“Chats”标题和搜索框之间有一行“◌ Loading groups…”，没有左内边距，还把列表往下推。本人要求：加载应当套在下面整个列表元素里面，作为列表自己的加载状态；参考业界与 Beautiful UI 的做法；举一反三检查其他加载。

#205 恢复的 DEV-113 改动已把这一处换成标题旁的小转圈，但首次加载时列表区仍先显示未分组的会话、再跳成分组，加载并不在列表里。

## 调研

- Beautiful UI（github.com/slev12397/beautiful-ui，`44a274e`）：没有“在标题和内容之间插一行加载文字”的写法。`AgentScreen` 连接中是在卡片自己的框里居中一个转圈加一行说明；`TaskRows` 的转圈在行内；`LoadingState` 是给长时间智能体工作的像素格加闪光文字和计时，`role="status"`；减弱动效时停止动画、文字仍可读。
- GitHub Primer · Loading（primer.style/product/ui-patterns/loading）：指示器放在“最接近它所代替的内容”的位置；大区域用骨架、居中于区域；少于 1 秒不显示；替换为内容时避免布局跳动；区域上设 `aria-busy`，用常驻的 `role="status"` 播报，一组骨架只播报一次。
- NN/g · Skeleton Screens 101（nngroup.com/articles/skeleton-screens）：少于 1 秒不需要指示器，快速闪一下反而更糟；整块列表/页面加载用骨架，单个模块用转圈；超过 10 秒用进度。
- shadcn/ui Skeleton / Spinner（ui.shadcn.com/docs/components/skeleton、/spinner）：Skeleton 只是一个按内容形状设尺寸的块；Spinner 带 `role="status"` 与 `aria-label`，组合进 Button、Item、Empty 使用。
- Radix Themes Skeleton（radix-ui.com/themes/docs/components/skeleton）：骨架保留被替换内容的尺寸，加载结束不跳动。
- Apple HIG · Progress indicators / Loading：尽快显示内容（含缓存的旧内容），加载时不阻塞其他操作，指示器放在一致的位置。

## 规则

1. 首次加载列表或页面：在列表自己的框里放骨架行（`Skeleton`），形状和内边距与真实行一致；图标加标题的行用 `variant="items"`（树用 `compact`）。
2. 首次加载对话框正文、面板或小区块：在该正文里放 `LoadingState`（`layout="block"` 居中）。懒加载的对话框，回退显示同标题、同尺寸的对话框，等待放在正文里。
3. 已有内容时的刷新或保存：保留内容，在区域标题旁放带标签的 `Spinner label="…"`，或让刷新按钮变忙（`busy`；图标按钮的图标换成转圈，尺寸不变）；不插入把内容推开的行，不换成骨架。
4. 提交中：按钮 `busy`。
5. 独立指示器（`LoadingState`、`Skeleton`、带标签的 `Spinner`）前 300 ms 透明但占位（`animate-loading-appear`），快速返回不闪；减弱动效时只停转圈和扫光。
6. 等待中的区域设 `aria-busy`；指示器是 `role="status"`，名称写明等的是什么，一处等待只有一个播报。

## 修复

- `components/ui/loading.tsx`：`Spinner` 增加 `label`（成为 `role="status"`、名称仅供读屏）；`Skeleton` 增加 `variant="items"` 与 `compact`；三个独立指示器加 300 ms 延迟出现。`styles/foundation.css` 增加 `--animate-loading-appear` 与关键帧。
- `components/ui/button.tsx`：`size="icon"` 的按钮忙时只显示转圈，不再把转圈加在图标旁边撑出按钮。
- 会话侧栏（`features/chat/list/chat-thread-view.tsx`、`use-chat-layout.ts`）：首次读分组时列表区显示 6 条骨架行、`aria-busy`，不再先显示未分组的会话；之后的重读与保存是标题旁的带标签转圈。`useChatLayout` 新增 `loaded`（本工作区分组读到过一次，含缓存）。
- 工作区文件树（`components/workspace/workspace-directory-browser.tsx`）：首次读取为紧凑骨架行；点刷新时保留树、刷新按钮变忙，不再把整棵树换成转圈。
- Cloudflare 区域（`features/external-accounts/cloudflare-connector.tsx`）：首次发现为骨架；“刷新区域”“更多”各自变忙，列表不被上方插入的加载行推动。
- 设备技能页（`features/devices/device-skills.tsx`）：加载前不再整页空白，改为骨架。
- 技能比较对话框懒加载回退（`components/skills/skill-compare-loading.tsx`，`device-skills.tsx`、`skill-promotion-dialog.tsx` 使用）：原来在页面顶部插入一块居中加载，现在是同标题对话框，等待在正文里。
- 会话上下文用量（`features/chat/context/chat-account-usage.tsx`）：刷新时刷新按钮显示转圈，原来只是变灰。

## 检查

- 单测 `test/loading.test.mjs`（3 项，新增一项：带标签 Spinner 是唯一 status、items 骨架每行两条、图标按钮忙时只剩转圈、三种指示器都带延迟出现类）。
- `scripts/check-changed.sh`（13 个文件）：tsc、86 个相关 Web 测试、`audit:ui` 15 项（含 `audit:state-layout`、`audit:component-system`）通过；prettier 只报当时的 devlog 草稿，已格式化。之后改了骨架颜色和“无工作区”判断，`loading.test.mjs` 复跑通过。
- 真实 Chromium（headless），e2e-alice，工作区 `ws_0fa0d09c…`（4 个分组）。浏览器内把 `/api/chat-layout` 的应答拖延 7 秒以看到首次加载，只读、不写服务器：
  - 修复前：dev（Web 为 #205 版本，标题旁转圈），只读 GET。
  - 修复后：scratch 栈 `loading139`（dev DB 副本，`FOUNDRY_INTEGRATIONS=off`，经 `fdy-heavy` 构建），验后已 `down`。
  - 浅色 / 深色 × 1280 / 420 宽：骨架在列表框内，左右与搜索框、会话行对齐；读完后换成分组，搜索框与标题不移动。
  - 读屏树：列表里只有一个 `status: 正在加载分组…`；修复前首次加载时列表区是空的，或先显示未分组的会话、读完再跳成分组（见截图）。
  - 延迟：骨架挂上时 opacity 0，300 ms 后为 1。
- 自验中发现并修正：浅色下骨架条用 `--line`（oklch 0.946）在列表底色 `--inset`（0.979）上几乎看不见，改用 `--line-strong`（0.912）；未选工作区时不读分组，原逻辑会一直显示骨架，改为只在有工作区时等待。
- 部署：持 `/tmp/fdy-deploy.lock`，把本分支相对 `origin/main`（0c19251c）的 diff `git apply` 到 `~/workspace/foundry`（其中带 #209 Pending 未提交改动，README 行手工加入），在该 checkout 经 `fdy-heavy` 跑 web typecheck 与 `vite build`，`scripts/deploy-web-dev.sh` 发布 `6a2b0cf1610243e3`（入口资源一致、API 同源 JSON）。回滚：`~/.foundry/server/releases/dev139/previous-20261105T202245Z`。部署后 e2e-alice 真实 Chromium 复查 dev：浅/深 × 1280/420 首次加载均为列表内骨架、一个 `status: 正在加载分组…`，读完换成分组。
- 未覆盖：文件树、Cloudflare、设备技能页、比较对话框回退、用量刷新按钮只有类型检查与组件测试，没有逐个做浏览器截图；没有用真实读屏软件（只看了 Chromium 的无障碍树）。

## 审查表

“结论”：符合 = 与规则一致不改；已修 = 本项修改；他人 = 文件由其他会话在改，已通知；保留 = 有出入但有理由不改。行号为 `origin/main` 3d073ffb。

| 位置                                                                                                                                                                                         | 等待的区域           | 原做法                                           | 结论 | 说明                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `features/chat/list/chat-thread-view.tsx` 分组                                                                                                                                               | 会话列表             | 标题旁转圈，列表先按未分组显示再跳成分组         | 已修 | 首次：列表内骨架；之后：标题旁带标签转圈                                                                                                                                       |
| `components/workspace/workspace-directory-browser.tsx:393`                                                                                                                                   | 文件树               | 居中转圈；刷新时整棵树换成转圈                   | 已修 | 首次：紧凑骨架；刷新：保留树，刷新按钮忙                                                                                                                                       |
| `features/external-accounts/cloudflare-connector.tsx:576`                                                                                                                                    | 区域列表             | 列表上方插一行加载，推动列表；“更多”也触发它     | 已修 | 首次：骨架；刷新 / 更多：各自按钮忙，列表 `aria-busy`                                                                                                                          |
| `features/devices/device-skills.tsx:134`                                                                                                                                                     | 设备技能页           | 读完前整页空白                                   | 已修 | 行骨架                                                                                                                                                                         |
| `features/devices/device-skills.tsx:142`、`components/skills/skill-promotion-dialog.tsx:136`                                                                                                 | 比较对话框（懒加载） | 页面顶部插入居中加载块，对话框之后才出现         | 已修 | 同标题同尺寸对话框，等待在正文                                                                                                                                                 |
| `features/chat/context/chat-account-usage.tsx:163`                                                                                                                                           | 用量区块刷新         | 刷新按钮只变灰，没有可见的进行中                 | 已修 | 刷新按钮 `busy`（区块原已 `aria-busy`）                                                                                                                                        |
| `components/ui/button.tsx`                                                                                                                                                                   | 图标按钮忙           | 转圈加在图标旁，按钮变宽                         | 已修 | 图标按钮忙时转圈取代图标                                                                                                                                                       |
| `features/pending/pending-feature.tsx:103`                                                                                                                                                   | 待处理列表           | 居中转圈                                         | 他人 | 已发给 Pending 重设计会话：列表内行骨架                                                                                                                                        |
| `features/chat/context/chat-context-card.tsx`                                                                                                                                                | 上下文卡片           | 无自己的加载指示，数据到前各区块不渲染           | 他人 | 符合；无需改，未通知                                                                                                                                                           |
| `features/external-accounts/device-held-connector.tsx`                                                                                                                                       | 设备持有连接器       | 首次骨架                                         | 他人 | DEV-140（`foundry-connectors-picker`，未上 dev）：先显示上次结果；后台刷新时“再检查”按钮忙、设备列表 `SectionPanel aria-busy`、行内“正在检查 · 上次读取 …”，不加行；符合规则 3 |
| `features/chat/thread/chat-transcript-history.tsx:71`                                                                                                                                        | 对话记录             | 记录区顶部居中一行转圈加文字，含 10 秒“仍在加载” | 符合 | 就在记录区里，替代内容；有重试                                                                                                                                                 |
| `features/chat/detail/*`（面板、差异、截图、设备文件）                                                                                                                                       | 详情面板正文         | 正文里 `LoadingState block`                      | 符合 | 规则 2                                                                                                                                                                         |
| `features/chat/archive/chat-archive-dialog.tsx:226`                                                                                                                                          | 对话框正文           | 正文里行骨架                                     | 符合 |                                                                                                                                                                                |
| `components/workspace/workspace-services.tsx:194`                                                                                                                                            | 服务列表             | 首次行骨架，刷新按钮忙                           | 符合 |                                                                                                                                                                                |
| `components/workspace/workspace-path-picker.tsx:159`、`components/agent-runtime/model-combobox.tsx:175`                                                                                      | 弹出列表             | 列表为空时列表内一行加载                         | 符合 | 已有选项时只在刷新按钮上 `aria-busy`                                                                                                                                           |
| `components/skills/skill-catalog-list.tsx:253`、`skill-compare-dialog.tsx:252/288/294`                                                                                                       | 列表 / 对话框正文    | 区域内骨架 / 加载                                | 符合 |                                                                                                                                                                                |
| `features/external-accounts/*` 其余骨架（connectors 页、飞书、工作区连接器、授权对话框）                                                                                                     | 列表 / 正文          | 首次骨架                                         | 符合 |                                                                                                                                                                                |
| `features/issue-detail/*`、`features/resources/*`、`features/skills/*`、`features/skill-library/*`、`features/agent-defaults/*`、`features/channels/*`、`features/personal-agent/settings-*` | 列表 / 面板          | 首次骨架                                         | 符合 |                                                                                                                                                                                |
| `features/personal-agent/assistant-gate.tsx:48`                                                                                                                                              | 助理页               | 页面内居中加载                                   | 符合 |                                                                                                                                                                                |
| `features/profiles/device-account-defaults.tsx:129`                                                                                                                                          | 模型字段             | 字段下一行加载，刷新时也出现                     | 保留 | 该文件由 Model providers 标签页会话在改；行在字段说明位置，不推开列表                                                                                                          |
| `features/profiles/device-providers.tsx:196`                                                                                                                                                 | 设备模型服务检查     | 列表后一行“正在检查 …”                           | 保留 | 是行内检查状态，不是列表加载；同上，文件在别的会话                                                                                                                             |
| `features/issue-detail/criterion-result-card.tsx:66`、`issue-evidence-panel.tsx:123`                                                                                                         | 验证进行中           | 卡片内一行状态                                   | 保留 | 是操作进度，不是数据加载                                                                                                                                                       |
| `features/skill-library/*` 行内“处理中”、`resources/resource-backends.tsx`、`device-sign-in`、连接/授权对话框步骤                                                                            | 操作进度             | 行内 / 步骤内 `LoadingState`                     | 符合 | 操作进度放在操作处                                                                                                                                                             |
| `components/ui/status-indicator.tsx` / `app/app-notices.tsx`                                                                                                                                 | 整个应用             | 侧栏品牌位，1.5 秒后才显示                       | 符合 | 已有延迟                                                                                                                                                                       |
| 各处按钮 `busy` / `aria-busy`（约 60 处）                                                                                                                                                    | 提交                 | 忙按钮                                           | 符合 | 规则 4                                                                                                                                                                         |
| 行状态转圈（会话行处理中、上下文子任务、安装清单）                                                                                                                                           | 行状态               | 行内图标                                         | 符合 | 是状态，不是加载                                                                                                                                                               |

## 验收

在 dev（部署后）：

1. 打开“对话”，浏览器 DevTools 的 Network 设为 Slow 3G，刷新页面。预期：标题和搜索框位置不动，搜索框下方列表区里是几条灰色占位行（左边一个方块、右边一条），左右边距与会话行一致；读完后占位行换成分组和会话，标题和搜索框不跳。浅色、深色都看得见占位行。
2. 网络恢复正常后刷新。预期：几乎不出现占位行（300 ms 内读完不显示）。
3. 拖动一个会话换分组。预期：标题“对话”旁短暂出现小转圈，列表不被推动。
4. 打开对话右侧的工作区文件，点刷新按钮。预期：文件树保留，刷新按钮里转圈；首次打开时是紧凑占位行。
5. 设备 → 技能，在 Slow 3G 下打开。预期：读完前是占位行，不是空白页。点“比较”：对话框立刻打开，正文里转圈，代码加载完换成比较内容。
6. 读屏（VoiceOver / NVDA）进“对话”首次加载：读出一次“正在加载分组…”。

## 改动文件

- `apps/web/src/components/ui/loading.tsx`、`apps/web/src/components/ui/button.tsx`、`apps/web/src/styles/foundation.css`
- `apps/web/src/features/chat/list/chat-thread-view.tsx`、`apps/web/src/features/chat/list/use-chat-layout.ts`
- `apps/web/src/components/workspace/workspace-directory-browser.tsx`
- `apps/web/src/features/external-accounts/cloudflare-connector.tsx`
- `apps/web/src/features/devices/device-skills.tsx`、`apps/web/src/components/skills/skill-promotion-dialog.tsx`、`apps/web/src/components/skills/skill-compare-loading.tsx`（新）
- `apps/web/src/features/chat/context/chat-account-usage.tsx`
- `apps/web/test/loading.test.mjs`
- `docs/devlog/DEV-139-loading-states.md`（新）、`docs/devlog/README.md`

截图：`$FOUNDRY_WORKSPACE/.foundry/attachments/dev139/`（`compare-wide.png`、`compare-narrow.png` 与各单张），不入库。
