# DEV-292 等你处理：谁交上来、为什么要你，助理替你决定的项

状态：web 切片已实现并通过本地与 Mac mini 检查；已部署 dev（2026-11-18）；Agent 代验收（2026-11-18，范围见验收记录）；已合入 main（PR #278）。答复原文由 Server 切片 DEV-291 写入项的 `answer`（≤1000 字符）与 `answeredBy`；web 已接入这两个可选字段，Server 上线前「助理替你决定」下只显示标记。

来源：`.foundry/reports/needs-you-redesign.md` §3.5（2026-11-18 本人批准）；现状依据 `.foundry/reports/needs-you-current-state.md` §5.1。截图：`.foundry/attachments/20261118/dev292/`（未提交）。

## 问题

1. 「已处理」里，助理替本人决定的项（`outcome = assistant_answered`）和本人自己答的项看起来一样，本人无法一眼知道是谁决定的。
2. 助理交来的项，`note`（「为什么要你」）以普通 `text-xs` 文字显示，无截断，不醒目。
3. 助理首页「等你处理」只有数字，看不到是哪几件事。

## 调查

- 项的载荷（`apps/server/internal/store/pending_items.go:129-226`，web 类型 `apps/web/src/api/pending.ts`）已有 `handler`、`note`、`handedReason`、`handedAt`、`outcome`，足够做 1 和 2。`outcome` 的写入点：`httpapi/pending_items.go:107-114`、`:160-167`（助理以回答回复问题时记 `assistant_answered`），`httpapi/mcp_needs_you.go:112`（`resolve`）。
- **答复原文当前没有存。** 项上只有问题的原话（`excerpt`）、问题上下文（`context`，问题本身）和所在消息（`messageId`）。助理给出的答复只在帮手的会话记录里。web 无法从项上显示「它替你回答了什么」，本切片不编造。写入由 DEV-291 负责（见下）。
- 首页数据：`PersonalAgentNeedsYouItem` 内嵌 `PendingItem`，所以 `/api/personal-agent` 的 `needsYou.items` 已经带 `id`、`title`、`sessionId`、`messageId`；web 类型只声明了其中一部分。
- 侧栏/首页不能 import `features/pending`（feature 之间不互相引用），因此「打开条目」改走 app 壳：`assistant-home` 发 `pending.item` 事件，`app/active-view.tsx` 在 `pending.list` 里按 id 找到条目，交给 `openPendingItem`（已从 `features/pending/index.ts` 导出）。
- 元信息行「助理 · 名字」的来源：`pending-model.ts` 的 `pendingOrigin` 取 `item.assistantName`，为空时用 web 的「默认助理」。服务端 `httpapi/pending_items.go:497` 直接传助理的 `Name`，未命名助理为空串。因此，真实界面对未命名助理显示「助理 · 默认助理」，不会出现「助理 · 助理」；那是 fixture 把名字设成「助理」造成的。

## 修复（仅 web）

- `api/pending.ts`：`PendingItem` 增加可选的 `answer?: string` 与 `answeredBy?: "assistant" | "person"`（DEV-291 的字段）。
- `pending-item-card.tsx`：
  - 助理交来的项（`handedReason = assistant`）显示为一个 `bg-panel-soft` 块：「助理：」加 `note`，`ClampedText` 三行截断、可展开。`note` 与标题相同（`hand_over` 由标题生成）时只显示「把这件事交给了你。」，不重复标题。无 `note` 时同样显示这句。
  - `assistant_stopped` / `assistant_offline` 仍用同一块显示原因；`assistant_timeout` 保持原来的灰色一行（既有测试依赖）。
  - 已解决且 `outcome = assistant_answered` 的项：标题下显示 `Badge`「助理替你决定」；有 `answer` 时其下用 `ClampedText` 两行截断、可展开显示答复原文；有 `sessionId` 时显示「打开对话，查看或回复」按钮（`openPendingItem`，定位到原消息）。没有 `answer` 时卡片与之前完全相同。本人自己答的项没有标记。
- `assistant-side-card.tsx`：「等你处理」行保留（链接，新标签，数字为本人待办数）；其下列出最新三条标题，每条是 `ContextRow` 按钮，点击发 `pending.item`。长标题单行截断，完整标题在 `title` 属性中。
- `assistant-events.ts`、`assistant-home.tsx`、`app/active-view.tsx`：新事件 `pending.item`。
- `i18n/locales/{zh-CN,en}/pending.ts`：新增 `item.handedByAssistant`、`item.assistantDecided`、`item.openAssistantAnswer`。

## Server 字段（DEV-291，本切片未改）

DEV-291 会在 `store.PendingItem` 上写入 `answer`（≤1000 字符）与 `answeredBy`（`assistant` | `person`）。web 端只读这两个可选字段，无需再改结构。写入点仍是 `httpapi/pending_items.go:107-114`、`:160-167` 与 `httpapi/mcp_needs_you.go:112`。

## 验证

- 组件测试（`apps/web/test/pending-items.test.mjs`、`apps/web/test/assistant-side-card.test.mjs`）：
  - 交来的 200 字 `note` 显示为「助理：」加一个三行截断块；`note` 与标题相同时只显示「把这件事交给了你」；已解决的 `assistant_answered` 显示标记和「打开对话」按钮，点击后地址含 `message=msg_9`，`person_answered` 无标记。
  - 新增（follow-up）：300 字的 `answer` 显示在标记之下，为两行截断（`.line-clamp-2`），全文保留在文本中；没有 `answer` 的同类项没有截断块。
  - 首页最多列出三条标题、点击发出正确的 `itemId`，长标题在 `title` 属性中保留全文；无标题时只有计数行。
  - 本地结果：`pending-items` 31/31，`assistant-side-card` 5/5。
- Mac mini（`res_c5f59206bda2897c47c7`，`remote-check.sh`，lease `lease_eb084c2e1725b7cd5f8a`，批次结束后释放）：
  - `--web typecheck`：PASS（`tsc -p tsconfig.json`，日志 `/tmp/dev292-typecheck2.log`，`exit=0`）
  - `--web test` `pending-items.test.mjs` 31/0、`assistant-side-card.test.mjs` 5/0：PASS
  - `--sh 'pnpm --filter @foundry/web build'`：PASS，`✓ built in 14.97s`
- `audit:ui` 的 15 个脚本逐个运行（`pnpm audit:ui` 在此符号链接 worktree 中先触发 `pnpm install` 检查而中止，故直接运行脚本）：全部 exit 0（首次运行，follow-up 只改了 web 组件内部与类型，未重跑）。
- `prettier --check` 通过。
- 截图：临时 harness（已删除）在本地 Vite 中渲染真实的 `PendingItemCard` 与 `NeedsYouSection`，390px，浅色与深色，共 6 张：`open-light/dark`、`resolved-light/dark`、`home-light/dark`。fixture 助理名为「墨墨」；resolved 含一条 300 字答复与一条无答复的对照项。

## 限制

- 答复原文要等 DEV-291 上线才会显示；在此之前，「助理替你决定」只显示标记和打开对话按钮。
- 本人自己直接开的对话产生的项没有「交来」记录，只显示来源（`对话 · …`），不显示「助理：」块。这是有意的：没有人交来。
- 未命名助理在元信息行显示「助理 · 默认助理」（见调查）。这是 web 回退文案与服务端空名的组合；是否改为语言默认名「助理」需要决定，本切片未改。
- 助理首页的长标题单行截断，完整标题只在 `title` 属性中（悬停）。页面上的项卡片完整显示。
- 首页「等你处理」行的标题打开的是条目所在的对话（`openPendingItem`），与计数行（新标签打开 /pending）行为不同，这是为了让条目在原处可回复。
- 飞书卡片（§7）不在本切片内。
- 已部署 dev（2026-11-18）；补丁只包含 web 改动。

## 验收步骤

1. 助理交给你一件事（`hand_over`，带一句话）：在「等你处理」中，标题下出现「助理：」开头的块，超过三行时显示「显示全部」。
2. 标题与那句话相同的交接：块内只显示「助理：把这件事交给了你。」
3. 「已处理」切换到「已解决」：助理替你回答的项显示「助理替你决定」标记；DEV-291 上线后，标记下显示答复原文（超过两行时可展开）和「打开对话，查看或回复」按钮，点击后打开原消息。你自己回答的项没有标记。
4. 助理首页：「等你处理 · N」下列出最新三条标题；点击标题打开对应的对话或 Connectors；点击计数行在新标签打开「等你处理」。
5. 深色与浅色主题、390px 宽度：块、标记与答复原文可读，标题不溢出卡片。

## DEV-292b：问题回复走问题的信封

- 问题项（`source = question` 且有 `messageId`）的回复改用聊天问题卡的信封（`agentQuestionReplyText`），`itemId` 取消息 id 的最后一段，与卡片（`transcript-adapters.ts`）和 Server（`nativeQuestionID`）一致；其他项仍是引文加回复。
- 测试：较早的问题项回复带的信封名为该项的消息（`msg_old_42`），解析回来是同一问题的答案；旧实现下该项测试失败。
- 限制（Server）：当前 Server 按会话与时间关闭所有待答的问题项（`pending_items.go` 的 `resolve`），不按信封里的问题关闭。同一会话有两个问题时，回复一个也会关闭另一个。项上也没有问题序号（`Key` 不导出），信封固定为第 0 题。这两点需要 Server 切片补齐。

## 时间线

| 日期       | 事项                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-18 | web 切片实现与本地/Mac mini 检查完成；补丁 `/tmp/DEV-292.patch`。follow-up：接入 `answer`/`answeredBy` 类型与两行截断、300 字测试、截图改用真实风格的助理名。 |
| 2026-11-18 | Agent 代验收（DEV-292 / 292b，e2e-alice，sess_1794970080647742570）：桌面端首页前三项确认；助理答复的项显示「助理替你决定」（见 DEV-291）。                   |
