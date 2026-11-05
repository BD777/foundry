# DEV-138 待处理：每条只说它要你做什么，一个主操作

状态：已部署 dev（Web `012c4c3b320c5a62`）；单测与 UI 审计通过，scratch（线上 DB 副本）真实浏览器自验通过；未提交；待本人验收。

## 问题

本人原话：“这个 Pending 实在是太凌乱了……元素也不要过于堆叠，让人一眼看下去不知道该干嘛。”随后补充：对话里“等你处理”条一样堆叠，应做成一个可复用组件，两处一起修。

原截图（`pending-before.png`、`chat-pending-bar.png`）中的问题：

- 每条都并排 4–5 个文字按钮（Reply / Show context / Open message / Done / Dismiss），真正该做的事不突出。
- 失败与提问长得一样：彩色药丸 + 原文；失败把原始报错当标题（“You've hit your weekly limit …”、“This chat uses foundry_codex_provider_llm_gateway, but your current provider is openai …”）。
- 选项、操作、时间挤在同一行；“RECOMMENDED”全大写夹在按钮里。
- 分组是卡片里再套分割的卡片；对话内条目展开后 3 条全量堆叠，占掉输入框上方大半高度；下方还有一行裸文本按钮“1 timer(s)”。

## 设计

一条从上到下读：做什么 → 是什么、何时 → 唯一主操作。

- 标题：它要你做的事。提问是问题本身；已识别的失败是平实的说法（“Usage limit reached”“This chat needs the provider it started with”），下一行写修法（“Resets Nov 6, 2pm … Continue the chat after that, or choose another model…”）；原始报错收进菜单“Show the error”。未识别的失败仍以报错首行为标题。
- 类型用图标形状 + 色调（问号气泡 / 警示圆 / 手 / 钥匙）区分，不只靠颜色；类型名、时间、“Seen 3 times”合成一行弱化元信息。
- 主操作只有一个：提问的选项就是主操作，点一下即发送（原先要再点 Send），推荐项为填充按钮，标“· Recommended”（正常大小写）；不加勾号，勾号读作“已选”；失败为“Fix in chat →”；账号为“Open Connectors”；纯回复类为“Reply”。可以回复的条目在主操作旁保留“Reply”作为次要操作。
- 其余（打开原消息、上下文、原始错误、标记完成、忽略、重新打开）收进每条右上角一个“…”菜单（共享 `RowMenu`，shadcn DropdownMenu），按钮可聚焦、accessible name 为“More for “<标题>””；没有只在 hover 才出现的操作。
- 分组：对话标题 + 工作区作为卡片上方的小标题，“Open chat →”同一行；一组只有一层卡片面。
- 对话内“等你处理”：同一组件的 `compact` 密度，一次显示一条，“1 of 3”前后切换，最高 40vh，输入框保持空间。
- “1 timer(s)”改为 `ChatWorkCountNote`：图标 + 文本 + 右箭头，accessible name“1 timer: open the context panel”，与上方等你处理条同一内缩；en/zh 用真正的复数键。
- 首次加载按 DEV-139 规则改为列表卡片内的骨架行；已有列表时刷新不替换内容。

失败分类（`pendingFailure`）只读 Web 已有的 `title`/`excerpt`，服务端不变：用量/速率上限（含重置时间）、对话与当前提供方不一致、磁盘满、执行宿主中断、步数上限，其余为 `other`。

## 代码

- `apps/web/src/features/pending/pending-item-card.tsx`：共享条目组件（`density`、`where`）。
- `apps/web/src/features/pending/pending-model.ts`：`pendingFailure`、`pendingPrimary`。
- `apps/web/src/features/pending/pending-feature.tsx`：分组标题外置、单层卡片、骨架加载。
- `apps/web/src/features/pending/pending-chat-bar.tsx`：compact 单条 + 步进器。
- `apps/web/src/features/chat/thread/chat-thread-notices.tsx`、`chat-surface.tsx`：`ChatWorkCountNote`。
- `apps/web/src/components/ui/icon-box.tsx`：新增 `error`、`warn` 色调。
- `apps/web/src/i18n/locales/{en,zh-CN}/{pending,chat}.ts`；`apps/web/test/pending-items.test.mjs`。

## 验证

- `pnpm typecheck` 通过；`test/pending-items.test.mjs` 13 项通过（新增：失败分类与主操作、失败条目标题/修法/菜单中的原始错误、对话条一次一条与步进、推荐项为填充按钮且一键发送、菜单项顺序）。
- `pnpm audit:ui` 全部通过（含 state-layout、feedback、buttons、native-controls、copy）。
- scratch 栈 `pendredesign`（线上 DB 副本，`FOUNDRY_INTEGRATIONS=off`；仅在副本里重置了本人账号密码以便看到本人真实的 5 条待处理）：Pending 页宽屏浅色/深色、390 px 窄屏、键盘打开“…”菜单、推荐项聚焦与 hover 不移动内容；对话页等你处理条收起/展开、深色、窄屏、640 px 矮视口输入框仍可见。截图见交付说明。

## 部署

- 2026-11-06 04:14（UTC+8），基于 origin/main `0c19251c`（含 #205、#206、#208）rebase；按编排会话意见去掉推荐项的勾号（勾号读作“已选”），保留填充与“· Recommended”。
- 持 `/tmp/fdy-deploy.lock`：`git diff origin/main --binary` 经 `git apply --check` 后应用到 `~/workspace/foundry`；`fdy-heavy pnpm typecheck` 通过，`pending-items` 13 项通过；`fdy-heavy` 下 `VITE_API_BASE_URL= vite build`，`scripts/deploy-web-dev.sh` 发布 `012c4c3b320c5a62`（上一版 `6921bdbbb8112a76`，回滚副本 `~/.foundry/releases/dev138-web/previous-20261105T201457Z`），脚本确认入口资源逐字节一致、同源 API 返回 JSON。仅 Web，无 Server/Worker 变更。
- scratch 栈 `pendredesign` 已停止并删除。部署后的线上页面未用本人账号登录复核（无本人凭据），以 scratch 上同源码的浏览器验证为准。

## 限制

- 失败分类是对报错文本的匹配；新的提供方报错措辞会落到 `other`（仍显示原文首行），需要时再加规则。
- 选项一键发送后不可撤回（与原先在输入框里点 Send 等价，只少一步）。

## 验收步骤

1. 打开「待处理」：每条第一行是要你做的事；提问下方选项中推荐项为蓝色填充、带“Recommended”；失败条目显示“Usage limit reached”/“This chat needs the provider it started with”及修法，不再是原始报错。
2. 点某条右上角“…”：出现 打开原消息 / 显示上下文（或 查看原始错误）/ 标记完成 / 忽略；只用键盘 Tab 到“…”按 Enter 也能打开。
3. 点一个选项：立即作为你的回复发到该对话（引用原问题），条目变为已回复。
4. 进入有多条待处理的对话，点输入框上方“等你处理 · N”：只展开一条，右侧“1 of N”可切换；输入框仍在可视区。
5. 有定时任务的对话：输入框上方显示“1 timer ›”，点击打开右侧上下文面板。
6. 切换深色模式和窄屏重复 1–4，布局不重叠、hover 不移动内容。
