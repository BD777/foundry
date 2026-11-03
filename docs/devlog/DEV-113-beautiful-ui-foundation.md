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

## 验证

- `check-changed`（prettier、tsc、audit:ui）与全量 `pnpm test`（977 项）通过；真实浏览器（scratch 栈，本人库副本）对比聊天、Issues、设备等页面浅色/深色/窄屏，层次与选中态不变，颜色按新令牌重绘。

## 部署

（每次部署在此追加：构建号、时间、回滚目录。）
