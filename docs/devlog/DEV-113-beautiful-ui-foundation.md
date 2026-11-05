# DEV-113 · Web 以 Beautiful UI 为组件与样式基础

状态：进行中。第 1 步（Tailwind v4 与设计令牌）已实现，部署记录见下；其余步骤未开始。

## 决定

本人批准（2026-11-04）：以 Beautiful UI（https://github.com/slev12397/beautiful-ui，MIT © 2026 Shane Levine，与本仓库 Apache-2.0 兼容）作为 Web 的组件基础，shadcn/ui 补它没有的部分（对话框、弹层、菜单、提示、输入、选择、勾选等）。AGENTS.md 同步改为：组件库可以替换或新增，只要通过它的公开 API（props、variants、slots、className、自带的主题令牌）定制，不改它的内部 CSS 或私有 DOM，不用 `!important`。

## 步骤

1. Tailwind v4 与它的令牌作为唯一令牌来源；逐个评估它拉进来的依赖，不需要的丢弃。
2. 换 `components/ui` 里的原子（Button、Chip、SegmentedControl、Switch、StatusPill、ValuePill、Shimmer、ProgressRing、StreamText、TextRow），让所有页面一起提升。
3. 对话（思考、工具步骤、任务、提示栏、代码、表格）。
4. Issue 的契约确认与问题（ApprovalCard）。
5. 侧栏与其余页面，随区域迁移删除被取代的样式表。

每步验证后立即部署；提交与合并只在 22:00–09:00（UTC+8）。

## 第 1 步：基础

- Tailwind CSS v4（`@tailwindcss/vite`）取代 v3（原先只服务 Streamdown）；删除 `tailwind.config.ts`、`postcss.config.js` 与 `autoprefixer`；Streamdown 的语义颜色（background、border、muted、primary、sidebar、red-*）改在 `foundation.css` 的 `@theme` 里映射到同一套令牌。`tailwind-merge` 加入 `cn()`。
- `styles/foundation.css`：Beautiful UI 的浅色/深色令牌（surface、canvas、inset、ink 三档、line、accent、green/orange/red 及 tint、tooltip、smooth 分层阴影 `--shadow-xs…lg` 与 hairline/btn/card/raised/overlay 组合）、`@theme` 映射、`dark` 变体指向 `[data-theme="dark"]`。字体仍用系统字体栈（Mac 上的 SF 与 Inter 接近，不引入字体依赖），`letter-spacing` 仍为 0。
- `styles/tokens.css`：`--fdy-*` 角色全部改为引用基础令牌（一处取值）；状态文字色在基础色上与 ink 混合以保持 4.5:1 对比；暗色下的 `ink-faint`、`on-accent` 单独调整。混色一律在 oklab 中进行（在 oklch 中混合会因色相插值让橙色变绿）。
- 审计：`audit-style-invariants` 现在读取基础与角色两张表，能解析 oklch 与 oklab/oklch 混色，继续检查 AA 对比度；`audit-v3-layout` 把 `foundation.css` 与 `tokens.css` 同样当作主题表；`design-palette.json` 不变（基础表不含十六进制）。
- `THIRD_PARTY_NOTICES.md` 记录 Beautiful UI 与 shadow-plugin 的 MIT 声明；`apps/web/src/ARCHITECTURE.md` 的 Styling 增加“基础”一条。
- 依赖评估（只评估，未引入）：Beautiful UI 的组件只依赖 react、class-variance-authority、clsx、tailwind-merge；`motion`、`@central-icons-react`（付费）、`iconoir-react`、`glimm`、`liveline`、`@web-kits/audio` 只被其站点壳或个别展示组件使用，不引入；图标继续用 lucide-react；`shadow-plugin` 的阴影数值内联进 `foundation.css`。

## 第 2 步：原子

- `Button`：改用 Beautiful UI 的按钮样式（胶囊、按压缩放、填充变体的内高光），保留 Foundry 的变体与尺寸名；`fdy-button*` 只作测试与布局的钩子，不再带样式。`components/ui/button.css` 只剩图标/文字子元素与忙碌光标；`!important` 不再出现（尺寸 `inline` 靠 `twMerge` 覆盖 `inline-flex`）。
- `Badge`（状态胶囊）、`SegmentedControl`（胶囊轨道 + 选中凸起，选中态来自 Radix `data-state`）改用 Tailwind 变体，删除 `badge.css`、`segmented-control.css`。
- 新增 `Chip`（等宽值徽标，用于工具步骤的名称与路径）、`Shimmer`（运行中的标签闪光，减弱动效时静止），替换对话过程里的手写闪光与值徽标样式。
- 删除 `base.css` 中的 `button, input, textarea { font: inherit }`（Tailwind 的重置已做同样的事；未分层的规则会压过工具类，让按钮字号失效）。
- 暂未采用：`Switch`、`StreamText`、`ProgressRing`、`EntityChip`、`ValuePill`、`TextRow`（目前没有对应的现有组件，等对应区域迁移时再引入）。

## 第 3 步：对话

- 3a 代码块与表格：外观改为 Beautiful UI 的 CodeBlock / RecordsTable——一圈 hairline 环加柔和阴影的卡片、代码块带 36px 页眉（语言 + 复制/下载，常显，不盖住内容）、等宽 12px 正文、行号槽；表格是带环的滚动盒，表头吸顶，单元格 hairline，数字等宽对齐，行悬停淡填充；表格工具栏在表顶上方保留的一行里，悬停与键盘焦点时显示，无悬停设备常显。仍只通过 Streamdown 公开的 `data-streamdown` 钩子与主题令牌定制（Streamdown 的整卡由 `[data-streamdown]` 规则压平，未覆盖其私有类）。
- 3b/4 提问与契约确认：Agent 提问卡（等待回答时）与 Issue 的契约确认卡改为 ApprovalCard 的样子——抬起的白色卡片（`--shadow-md`）加一圈强调环，选项行带单选，操作为胶囊按钮；已回答或已假定的提问保持安静的 inset 底。测试页 `test/question-gallery.html` 渲染三种状态。

## 第 5 步：一套组件系统（2026-11-04）

目标：Web 只剩一套组件与一套令牌——`components/ui` 里的 Beautiful UI（外观）与 shadcn/ui（行为，基于 Radix），Tailwind v4 + `foundation.css` / `tokens.css`；功能页与共享部件只用这些组件加 Tailwind 工具类，不再有自己的样式表。

- **样式表**：89 张（约 19,265 行）全部转换并删除；`apps/web` 里剩下 3 个 CSS 文件：`src/styles.css`（入口，12 行）、`src/styles/foundation.css`（529 行）、`src/styles/tokens.css`（190 行），共 731 行。测试夹具的 10 张小样式表也一并转成工具类。Streamdown 不需要任何自己的样式表（见下）。
- **新审计** `audit:component-system`：任何其他 `.css` 文件、选择 `fdy-*` 类的规则、`!important` 修饰、`text-[Npx]`/`rounded-[Npx]`、原始或默认色板颜色、选择 `fdy-*` 的工具类变体、`outline-none` 与 `focus-visible:outline-*` 并用（会让焦点环消失）、`font-[inherit]`（只设字体族）、以及悬停/聚焦/按下时改变布局的工具类，都会失败。`legacy-css.json` 过渡清单已删除。
- **组件及来源**（`components/ui`）：
  - Beautiful UI 外观：`Button`、`Badge`（StatusPill）、`Chip`、`Shimmer`、`SegmentedControl`、`MetaPill`（ValuePill）、`InfoRow`（TextRow）、`CodeBlock`、`RecordsTable`、`Trace`/`ProgressMeter`/`Loading`、`MessageComposer`（PromptBar）、`AppShell`（SidebarNav）、`DiffStat`。
  - shadcn/ui（Radix）行为：`Dialog`、`DropdownMenu`、`ContextMenu`、`Popover`、`Tooltip`、`Command`（cmdk，斜杠菜单与路径选择）、`Alert`、Sonner 提示（`toast.tsx`，应用的 `toast/useToast` 接口不变）。
  - Foundry 自有（纯 Tailwind，无外部来源）：`ManagementRow`、`RowCard`、`ActionRow`、`Panel`/`SectionPanel`、`FormField`/`ButtonRow`/`CheckLabel`、`MemberRow`、`Disclosure`、`DividedList`、`Identity`、`CommandLine`、`FileTree`、`SetupFlow`/`SetupChecklist`、`TerminalBlock`/`FileDiff` 等。
  - 对话：`markdown-blocks.tsx` 通过 Streamdown 公开的 `components` 映射替换段落、标题、列表、引用、行内代码、链接、代码块（`pre`）与整张表格（`table` 及各部分）；表格的复制/下载是 shadcn 菜单，全屏是 Radix Dialog。Mermaid 由 Streamdown 自己的 `code` 组件渲染（其渲染器未导出），只通过它合并的 `className` 重置外边距与卡片底色；图片、5–6 级标题保持 Streamdown 原样。
- **依赖**（`knip` 检查）：新增 `sonner`；移除 `@radix-ui/react-toast`；保留 shadcn 组件用到的 Radix 包与 `cmdk`；没有引入 `motion` 等 Beautiful UI 站点专用依赖。
- **版式规则**（对话区，按用户反馈）：表格、代码块、Mermaid、图片、引用块上下各 1.5em；表格工具栏常显、在卡片内表头行末（给最后一个表头单元留出位置）；正文与列表项行高 1.65，引导段落与其后的列表间距 0.5em。
- **过程中发现并修复的回归**（均已上线）：`Button` 的 `inline` 尺寸丢了对齐/换行/选择；`bare` 变体变成胶囊并在按下时缩小；`SelectMenu` 的 `strong` 字重（`font-[inherit]` 只设字体族）；`Button`/`SegmentedControl` 的 `outline-none` 让所有键盘焦点环消失；行/卡片类按钮继承胶囊圆角（现在显式用 `rounded-md/lg` 加 `active:scale-100`）。
- **回归验证方法**：基线截图（31 条路由 × 浅/深色 × 1440/390）逐区域对比；另有计算样式对比（每个可见元素的布局与样式属性，按 DOM 路径与文本配对），它抓到了像素对比看不出的字重、对齐与焦点环问题；胶囊行检测（高 >40 或宽 >150 的胶囊按钮）。

### 第 5 步的构建

- `425391d2`：primitives A（app-shell、字段、面板、告警、加载等 20 张）与 B（对话框、菜单、弹出层、提示、Sonner、选择、文件树等 12 张）；含 `bare` 变体修复。
- `872d6420`：键盘焦点环修复（`Button`、`SegmentedControl`）。
- `7d120dbd`：对话（9 张）、聊天（9 张）、Issues（8 张）三个区域。
- `cf761dae`：对话版式（行高 1.65、引导段落、表格工具栏不盖表头线）。
- `df353d0f`：设备、工作区/技能/资产、连接器/账号/设置等其余区域，以及夹具、文档、依赖清理——此后只剩 3 个 CSS 文件。

### 限制

- 未在真实浏览器里逐一验证的状态：工作区目录浏览器（只出现在聊天详情面板）、技能比较/晋升/版本选择对话框、草稿列表、带数据的知识库、部分忙碌/错误态；单元测试覆盖其标记。
- Mermaid 图的控件仍由 Streamdown 渲染；代码块没有语法高亮（Shiki 插件从未安装，与迁移前一致）。
- 少数文本行高有亚像素差异（账号提示、共享页），共享页个别块位移 2px。
- 测试夹具页（feedback、chat-files、chat-history 等）转换为工具类后只做了类型检查，没有逐页在浏览器里重新打开。

### 验收（人工）

1. 键盘 Tab 走过设备页、聊天列表：每个按钮都有 2px 强调色焦点环。
2. 聊天里发一条含表格、代码块、Mermaid、图片、引用的回答：框架块上下间距相等；表格工具栏常显且表头下的细线完整；段落行距舒展，引导段落紧贴其后的列表。
3. 设备页、工作区页的整行按钮悬停/聚焦是圆角矩形而不是椭圆，按下不缩小。
4. 重命名设备/分组、删除分组对话框居中，有遮罩，Escape 关闭，焦点回到触发处；右下角提示（Sonner）出现、可关闭。
5. 设置 → 账号、模型提供方、连接器的各个对话框与列表外观与之前一致。

## 验证

- `check-changed`（prettier、tsc、audit:ui）与全量 `pnpm test`（977 项）通过；真实浏览器（scratch 栈，本人库副本）对比聊天、Issues、设备等页面浅色/深色/窄屏，层次与选中态不变，颜色按新令牌重绘。

## 部署

2026-11-04：

- `f7263115027f450c`：第 1 步（Tailwind v4 + 令牌）；PR #188。
- `4e5e502b1486d542`：第 2 步（Button、Badge、SegmentedControl、Chip、Shimmer）。
- `8bd297510786f28e`：第 3a 步（代码块与表格）。
- `80a58363f0dc58ae`：第 3b/4 步（提问卡与契约确认卡），与 DEV-107 session 的 Server `b7af7efc` 一起由集成树部署；第 2、3a、3b 合在一个 PR 中。
- `40a2128eb31988c8`：文本输入框由边框改为 hairline 环（悬停加深、聚焦为强调环），在 DEV-107 的 Server `49b66a99` / Web `2e071582` 之上单独部署。

- `90b4b2da06f5ff5c`：修第 2 步的回归——`Button` 的 `inline` 尺寸（正文里的文件路径与行内链接，18 处）迁移时丢了旧样式表的 `text-align: start`、`justify-content: flex-start` 与断行规则；`<button>` 按 inline-block 排版，路径放不下时独占一行并按浏览器默认居中。现补回对齐、断行，字重随正文、可选中复制、按下不缩放。验证：同一列表结构在真实浏览器中对比旧/新 CSS（旧：`text-align: center`，换行后居中；新：左对齐）；全站扫描（e2e-alice 9 个页面及聊天、Issue，1440 与 390 宽）未发现其他换行后居中的按钮，静态检查所有允许换行的按钮规则均有对齐。

- `cf0eb3b2c7a2c12c`：消息附件按 Codex/ChatGPT 的样式重排（本人反馈"文字跟图片的 padding 怪"）：发送的消息里，图片是 80 px 圆角方块、文件是带图标/名称/大小的紧凑条，排成一行放在气泡上方并与气泡同侧对齐，气泡只放文字；只有附件的消息不再出现空气泡；输入框和排队消息用同一组件（可移除的带 ×）。缩略图改走共享图片缓存的 `preview`（≤40 KB），原先直接以 `<img src>` 加载原图，打开大图时又下载一次。验证：真实浏览器渲染真实消息列表，方块 80×80、与气泡右对齐且在其上方；每张图 preview 只取一次，打开灯箱不再取 preview、只取一次原图；390 宽无横向溢出；亮/暗。

- `05a17354b09b2ccd`：会话画面（Screen）面板改用 yet-another-react-lightbox 的 Inline + Thumbnails 插件（与预览灯箱同一库，无新依赖），本人反馈"缩略图都裂了""切换时高度闪来闪去"。缩略图裂：底部缩略条请求 96 px `placeholder`，没有 ffmpeg/sips 的设备（byte-dev 等 4 台）生成不了；缩略条与行内画面缩略图改用 `preview`（≤40 KB）。高度跳：舞台改为固定尺寸，切换时先显示已加载的 preview、原图到达后替换，只为当前画面取原图（邻近画面只用 preview）。另修两处：库的主题变量原来写在 `className` 上，内联模式没有 portal 而未生效（灯箱同样），改由 `styles.root` 设置；画库挂载时上报当前画面被当成"手动选择"而停止跟随最新，现只把不同画面视为选择（`tool-frames` 测试发现）。验证：真实浏览器渲染真实 ScreenDetail（7 张宽/高不同的画面），切换高度恒定、切换后立即有图、请求无重复、原图只取看过的；亮/暗；`tool-frames` 测试改写为验证同样的跟随/返回最新/预览请求。

- `88b16d8f4aeef0fc`（2026-11-05）：输入框边缘被外层裁掉（本人反馈，"编辑模型提供方"对话框）。根因：`40a2128e` 起输入框边框是盒外的 1 px 环（聚焦 4 px），而对话框里又套了一层无内边距的滚动容器，环在其边缘被裁；同类还有对话框 compact 主体的单行 `minmax(0,1fr)`：内容高于对话框时溢出该行，滚动区不含底部留白，最后一个字段/按钮底边被裁（"连接飞书账号"）。修复：compact 主体改为内容高度的行，主体是对话框里唯一的滚动层，留白计入滚动区；去掉提供方对话框、设备授权连接对话框与 `SkillDialogBody`（技能对比、提升、仓库来源、添加仓库）里多余的内层滚动。验证：变更文件检查（tsc、17 个 Web 测试、`audit:ui`）；新写的扫描脚本（每个带外环元素的环是否超出最近裁剪祖先的可滚动区，含字段聚焦环，页面与从页面打开的对话框，1440/390 宽，e2e-alice 18 个页面）修复前 2 处真实问题，部署后 0；真实浏览器"新建模型提供方"聚焦名称框时四边与聚焦环完整，滚到底部提示框边框完整。

- `f0b631808c4fac7f`（2026-11-05）：失败提示统一（本人反馈：会话列表"无法加载或迁移分组"提示难看，刷新时"Loading groups…"也难看）。`Alert` 按 shadcn/ui Alert 的结构：标题中等字重（原为粗体，长句整段加粗刺眼）、说明文字较弱、图标随尺寸缩放，标题与说明带 `data-slot`；约定页面与对话框里的失败都用 `Alert`，字段错误用 `FieldHint`，无须在页面上处理的操作失败用 toast。把各处自造的失败样式换成它们：工作区目录浏览、文件对比、技能缺失依赖、账号检查、后台任务输出、排队消息（改用 `FieldHint` 的 warning/error 语气而非覆盖颜色），`DetailMessage` 去掉 error 语气。会话列表：分组首次读取失败先按 0.5/1.5/5 s 重试（与转录加载同一做法，服务端重启时的一次失败不再常驻提示），仍失败才提示"无法加载对话分组"并给出次要按钮"重试"，与搜索框同一缩进，真实错误写入 console；加载/保存中由标题旁的小转圈表示（读屏有文字），不再插入一行把列表推下又弹回；删去已不存在的"迁移"文案。验证：变更文件检查（tsc、85 个 Web 测试、`audit:ui`）；真实浏览器在 dev 拦截 `/api/chat-layout`：一直失败时共 4 次请求后出现提示、左右缩进与搜索框一致、点"重试"后消失（亮/暗）；失败 2 次时自动恢复、不出提示；读取慢 4 s 时标题旁转圈、搜索框位置前后不变。限制：本人看到的那次失败的具体原因未留下（原代码吞掉了错误），按时间推测是 12:47 的 Server 重启。

- `11337d03d2024fff`（2026-11-05）：代码块（本人反馈：自己发的代码换行怪，下载/复制图标常驻占地方）。行号原为行内 `::before`，折行后的文字回到行号下方；改为每行两列网格（行号一列、代码一列），折行留在代码列。没有语言名时不再画只放图标的标题栏：操作按钮常驻右上角、脱离文档流（与 `RecordsTable` 的工具栏同一做法：表面色渐隐，首行预留其宽度，静止时不遮代码，滚动时代码从其下经过）；有语言名时仍在标题栏里。验证：`tsc`、`audit:ui`；组件 harness 渲染真实消息列表（用户气泡里的无语言代码块、回答里有/无语言的代码块，900/390 宽，亮/暗）：折行片段全部对齐代码列，图标不占行、不压首行文字，选中复制得到原文且不含行号。

- `f0115c5668a68287`（2026-11-05）：会话画面（Screen）面板横向溢出（本人反馈：右侧"回到最新"按钮与提示被截、竖图只显示左半）。根因：面板根网格的隐式列为 `auto`，被 yet-another-react-lightbox 缩略图条的最小内容宽度（5 张 × 96 px + 间距 ≈ 522 px）撑宽，超出部分被详情面板的 `overflow-x-hidden` 静默裁掉；`05a17354` 自测时 harness 里已出现同样溢出，我误判为 harness 问题。修复：根网格列改为 `minmax(0,1fr)`；缩略图条底部与两侧留 2 px，放得下聚焦环。同类扫描（新脚本：所有 `overflow-x: hidden/clip` 且内容宽于自身、非省略号截断的元素，e2e-alice 17 个页面 + 打开的聊天，1440/390 宽）另发现上下文卡片里带 `ml-7` 的 `Alert` 因 `w-full` 超出 8 px，改为 `w-auto`（与另两处带外边距的 Alert 一致）；修复后扫描 0 处。验证：harness 中 1100/390 宽，舞台宽度等于内容宽（464/359 px），网格无横向溢出；聚焦缩略图的环与容器底边留 2 px；变更文件检查通过。

回滚：把对应 `previous-…` 目录里的 `index.html` 与 `version.json` 拷回 `/var/www/foundryapp-dev`。
