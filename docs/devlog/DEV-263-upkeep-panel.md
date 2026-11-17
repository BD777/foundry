# DEV-263 项目维护面板：层级、折叠与共用 Agent 长文组件

状态：已在 `apps/web` 实现并在 byte-dev 验证（typecheck、`audit:ui`、定向测试、真实浏览器截图）；已部署 dev（2026-11-17）；Agent 代验收（2026-11-17，范围见各自验收记录）；已合入 main（PR #274）。

## 问题

本人在 2026-11-17 看 workspace 概览的「项目维护」面板时截图反馈「ugly UI，这个问题犯了很多次了」。截图中：review summary 和每条 finding 都是无字号类的裸 `<p>`，比面板标题还大；每条 review 的全部内容一次展开，两三条叠成整屏文字墙；状态行、小标题、正文和按钮同一权重；内部引用原样显示 `AGENTS.md#通道的事实@6960ab19`；Retry / Dismiss / Open review conversation / Review file change 夹在段落之间；文件修改预览用两个裸 `<pre>`，而共享的 `components/ui/file-diff.tsx` 已存在。

同类问题此前出现在侧卡和未处理消息卡：模型生成的长文直接铺在面板里，没有限高、层级和披露。本项按根因处理，先抽出共用组件。

## 改动

### 共用组件

- 新增 `apps/web/src/components/ui/clamped-text.tsx`：
  - `text-sm`（`size="xs"` 时 `text-xs`）、`text-ink-muted`（即 `--ink-2`）、`whitespace-pre-wrap`、`wrap-anywhere`；
  - 默认 `line-clamp-3`，可选 1–6 行；
  - 溢出判断只用限高后的元素本身：`scrollHeight > clientHeight + 1`，不依赖 computed line-height；首帧、`document.fonts.ready` 之后、`ResizeObserver` 报告尺寸变化时都重测，展开状态下保留上一次结论，收起时再测；只有真正溢出才显示「展开 / 收起」；
  - 切换按钮带 `aria-expanded` 与 `aria-controls`；正文始终完整在 DOM 中，屏幕阅读器读到全文。
  - `ui.text.showMore` / `ui.text.showLess`（en / zh-CN）。
- `features/pending/pending-item-card.tsx`：原来的内联字符数判断 + `line-clamp-3` 改为 `ClampedText`（`size="xs"`），沿用 pending 自己的「Show all / Show less」文案。
- `features/personal-agent/settings-maintenance.tsx`（记忆整理）：就绪任务的首行改为 `text-sm` 标题行，summary 与 finding 分别用 `ClampedText`（3 行 / 2 行），不再有裸 `<p>` 长文。
- 检查过但没有改：`features/issue-detail/criterion-result-card.tsx` 的 verification summary 位于 Issue 详情卡内，每个模型字段都有独立的标题与正文层级，不是无字号的面板倾倒；本项不动 Issue 专区。

### 面板

`features/workspaces/workspace-upkeep.tsx` 重写：

- 头部：`PanelHeader` 的「项目维护」+ 计数 Badge；一行 `text-xs` 说明修改建议是什么（文案缩短到一行）。
- Reviews：`DividedList` 按 `createdAt` 倒序，最多 3 条，之后「查看全部 N 条」（展开后可收起）。
  - 每行：状态图标 + review summary 第一句（单行截断）+ `text-xs` meta（相对时间 · N 条建议 · 状态）；右侧 `RowMenu`：查看检查对话 / 重试检查 / 忽略。
  - 仅 `review` 且有 result 的行可展开；`complete` 等已结束 review 也可展开阅读。等待 / 失败的行只有一行，reason 在 meta 里，不展开。
  - 默认展开「最新一条仍待处理的 review」；其余收起。展开/收起是行内按钮（chevron 属于按钮），`aria-expanded` + `aria-controls`。
- 展开内容：summary 去掉行标题已经显示的第一句后用 `ClampedText`（单句 summary 不再重复、也不留空段）；「发现」为紧凑列表，每条 finding 2 行 + 引用 chips；「修改建议」每行是 mono 文件名、2 行以内的 reason 和右侧「审阅修改」按钮。
  - 引用解析：`AGENTS.md#通道的事实@6960ab19` → `AGENTS.md › 通道的事实`，丢弃 `@hash`（`workspace-upkeep-model.ts` 的 `sourceRef`）。
  - 「审阅修改」打开真实 diff 对话框（`Dialog` + 共享 `FileDiff`），底部「不处理 / 应用」；预览加载、失败重试、来源已变化（stale）都有明确提示；应用调用既有 `applyWorkspaceUpkeepPatch`，成功后刷新。
- 行菜单动作与旧面板完全相同的 API（`actOnWorkspaceUpkeep` retry / dismiss，`navigateToChat` 打开检查对话）。
- 新增纯函数 `firstSentence`、`summaryBody`、`sourceRef`（`workspace-upkeep-model.ts`）；`firstSentence` 支持无空格的中文句号，也不会在 `AGENTS.md`、`2.9 KB` 的句点处截断。
- 类型层级：面板内最大文字是 `h2`（20px），正文 `text-sm`，meta/小标题 `text-xs`，引用 chip `text-2xs`；面板内唯一强调色是计数 Badge。
- 「审阅修改」用 secondary：概览页的其他动作（Refresh status / Rescan repositories）也都是 secondary，主色只留给对话框里的「应用」，避免每个建议都抢过面板标题；这是对 brief 中 “primary button” 的一处有意取舍，记录在此供评审判断。
- 两种语言的文案在 `i18n/locales/{en,zh-CN}/workspaces.ts`（`upkeep.*`）与 `ui.ts`；面板仍是 owner-only。

## 验证

### 真实浏览器截图

临时 fixture（`test/upkeep-gallery.html/.tsx`，验证后已删除，不入库；旧面板截图另用 c8c8a35e 的组件副本）渲染同样的 workspace 概览页骨架（`PageSurface` + `PageHeader` + 状态的仓库面板）和同一份合成数据，`data-theme` 设在 `<html>` 上。数据按本人真实 review 的长度与形状：两条 review（3 条 / 2 条发现，每条 2–4 句，含 CJK 小节名）、一条等待、一条已结束；修改建议两条；另加一条未处理消息卡（长 excerpt）。截图用 1440 与 390 宽全页，浅色/深色。面板下方的「等你处理」说明行已删除：那行文字原本是 fixture 自造的，不是产品文案；面板只保留真实的 `pending.page.title`，两种语言都由产品文案提供。

- Before（origin/main c8c8a35e 的面板）：`old-{light,dark}-{1440,390}.png`
- After 收起 / 展开：`new-{light,dark}-{1440,390}-{collapsed,expanded}.png`
- 展开后的 diff 对话框：`new-light-{1440,390}-dialog.png`
- 中文 390：`new-light-390-expanded-zh.png`

路径：`/home/windeng/workspace/foundry/.foundry/attachments/20261117/dev263/`（不入库）。页面由 worktree 的 Vite dev server（`127.0.0.1:31984`）提供，验证后已停止。

### 自检

- 对照同页其余面板：页标题 24px > 面板 `h2` 20px > 行标题 14px 半粗 > 正文 14px > meta/小标题 12px；维护面板内没有比 `h2` 更大的文字，也没有字号丢失的段落。
- 间距与概览页一致：面板 `p-5.5` / `gap-4`，仓储面板行 `py-[13px]`，review 行 `DividedList cozy`（`py-2.5`），没有卡片套卡片。
- 动作都在行尾：每条 review 的「…」菜单、每条建议右侧的「审阅修改」；正文中不再夹按钮。
- 唯一强调色是顶部计数 Badge；状态另有图标形状与文字，不只靠颜色。
- 原始 `@hash` 引用消失；修改预览使用共享 `FileDiff`，与 Chat 的文件变更一致。
- 1440 / 390、浅色 / 深色、收起 / 展开、对话框逐张检查；390 宽时建议行仍保持「文件名 + 右侧按钮」，reason 可展开。
- 溢出按钮只在真正被截断时出现：1440 实测 summary 2 行（无按钮）、第三条 finding 2 行（无按钮）、`docs/agent-work.md` 的 1 行 reason（无按钮）；前两条 finding 需要 3 行（有按钮），未处理消息卡需要 4 行（有按钮）。

### 检查命令（byte-dev）

- `pnpm --filter @foundry/web typecheck` 通过。
- `pnpm --filter @foundry/web audit:ui` 全部通过（含 copy、component-system、state-layout、hints）。
- `node --import ./test/register-bundler-resolve.mjs --test test/clamped-text.test.mjs test/workspace-upkeep-model.test.mjs test/workspace-upkeep-panel.test.mjs test/pending-items.test.mjs test/personal-agent.test.mjs`：74 通过、1 跳过。
  - `clamped-text`：短文本无按钮；长文本出现按钮，`aria-expanded` 与 `line-clamp` 随点击切换；长文本改成短文本后重测会收起按钮。
  - `workspace-upkeep-model`：中文无空格句子、`AGENTS.md` / `2.9 KB` 的句点、summary body 去掉首句、单句 summary 无 body、引用解析。
  - `workspace-upkeep-panel`：默认只展开最新可处理 review；最多 3 行与「查看全部」；等待/失败行无展开；展开后 summary 从第二句开始；行菜单 retry/dismiss 的请求体；「审阅修改」preview 与 Apply 的 `reviewedHash`。
  - 既有 pending 与 personal-agent 测试随新控件更新后通过（personal-agent 的 preview 断言改到 portal 所在的 `document.body`，并补了 diff worker stub）。
- `prettier --check` 通过（改动文件）。

## 限制

- 截图来自临时 fixture 的合成数据与近似的页面骨架，不是 dev 数据库的真实 workspace；fixture 未入库。
- 390 宽时 diff 保持 480px 最小内容宽并横向滚动，截图中右侧会被对话框边缘裁切（不再按字符断行）；这是共享 `FileDiff` 在窄屏的既有行为。
- 行展开状态只在本次浏览内保留，刷新后回到「最新待处理 review 展开」。
- 已部署 dev（2026-11-17）；已合入 main（PR #274）；远程检查未做（本机 byte-dev 已跑全部检查）。
- 2026-11-17 编排评审后修正：溢出测量改为 `scrollHeight` / `clientHeight`（含 `document.fonts.ready` 与尺寸重测）、summary 不再重复行标题、截图 fixture 的「等你处理」说明文字删除；重拍 `new-dark-1440-expanded.png`、`new-light-1440-expanded.png`、`new-light-390-expanded-zh.png`。

## 验收步骤

1. 打开一个有维护 review 的 workspace 概览：面板默认只有一行行头；最新待处理 review 展开，其余收起；顶部计数 Badge 与「查看全部 N 条」正确。
2. 点任意 review 行标题或 chevron：该行展开、其他行收起；summary 与 finding 超过行数时出现「展开 / 收起」。
3. 点「审阅修改」：弹出共享 diff 对话框，浅色/深色、1440/390 均可读；来源已变化时显示警告且不提供「应用」；点「应用」后该建议状态更新。
4. 打开行尾「…」：查看检查对话 / 重试检查 / 忽略与旧版行为一致。
5. 切换中文：标题、发现、修改建议、展开/收起、查看全部、不处理等均为中文；面板文字均不大于「项目维护」标题。
