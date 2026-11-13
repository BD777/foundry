# DEV-214 助理页右侧栏改成 chat 那样的卡片

## 状态

已合入 main（PR #267）。

## 问题

本人（2026-11-13，sess_1794464313271186377 转述）：「Assistant 侧边栏这个东西有点看不懂，他的 UI 也有点丑。不如也做成像 chat 的侧边栏那样的卡片如何？」截图里：

- 「Needs you · 3」两行只写「邓灿文」，第三行副标题是一串 `sess_…` id。
- 「Saved requests that need attention」用保存的原话「你好」当大标题，下面是整段 provider 报错（`API Error: Request rejected (429) · upstream account quota …`），一个整宽胶囊按钮，一个居中的链接。
- 「Your list」「What I'm doing」为空时各占一段说明句。

## 根因

- **「邓灿文」**：不是消息通道的转交，而是两条 `source=account` 的权限更新事项（`account-scopes:xacc_…`，`rule=feishu`，`context=feishu-cli v1.44.0`）。这类事项的 `title` 存的是账号名，needs-you 页靠 `pending:item.accountScopes` 拼成「重新授权 邓灿文：feishu-cli v1.44.0 需要新增 N 项权限」。助理首页的 `OverviewOf`（`personalagent/assistant/assistant.go`）只下发 `{id,title,where}`，Web 直接显示原始 `title`。
- **id 副标题**：`where` 是事项所在对话的标题；那条对话（ccm-omh-integration）的标题来自首条消息，原文就是「sess_1793189579694075630 sess_1793262362249887906 这两个session以及他们的sub …」。
- **报错墙**：收件箱条目只有 `resultError` 原文，没有分类；Web 原样显示。

## 修复

Server

- `store.PersonalAgentNeedsYouItem` 改为内嵌完整 `PendingItem`（标题所需的 source / rule / eventId / context / excerpt / failure 字段）加 `from {kind,name,detail}`。`from` 在 `assistant/needs_you_card.go` 里生成：助理自己的对话、帮手（`HelperOf`）、消息通道（通道名 + 私聊对方 / 群名，取自该会话的投递记录）、普通对话（去掉 Foundry id 的标题 + 项目名）、Issue、项目、个人事项。`withoutIDs` 按 `apps/web/src/lib/foundry-ids.ts` 的边界规则去掉 `sess_/iss_/pnd_/dev_/ws_/native_` id。
- `GET /api/personal-agent/inbox`（及 `/api/assistants/{id}/inbox`）每条带 `resultFailure {category, resetAt}`，复用失败轮次事项的 `classifyTurnFailure`；「in 12h34m」按该条目的 `updatedAt` 起算。

Web

- 把 chat 右侧卡片的部件从 `features/chat/context/chat-context-parts.tsx` 移到共享的 `components/ui/context-card.tsx`（新增卡片外壳 `ContextCard`、`ContextHeading` 的 `action` 槽、`ContextRowIcon` 的 `tone`），chat 改为从这里引用，外观不变。
- needs-you 标题规则从 `features/pending` 移到 `lib/pending-display.ts` 的 `pendingTitle`，needs-you 页和助理首页共用。
- 助理首页右栏改为一张卡片，四段：「等你处理」（计数、最新 3 行、「全部」）、「没处理的消息」（仅非空时出现；一行原因如「1 条消息没处理：模型额度用完，12:02 后可重试」，原话作为淡色摘录，原始报错收在「详情」里，「重试」「查看上次尝试」）、「你的清单」、「正在做的事」（行 + 状态词 + 停止图标按钮）。空段收成一行「标题 · 暂无/没有」。

## 验证

树：`~/workspace/foundry-deploy203p2`（DEV-203 phase 2 部署快照，8f394c91 + 其改动）+ 本项文件，补丁 `/tmp/dev214-handoff/dev214.patch`（sha256 前缀 `8f0039f77c6a7547`，32 个文件，对当前快照 `git apply --check` 通过）。CanWendeMac-mini 离线，远程检查改在 macbook compute。

- 远程（macbook）：protocol build、Worker tsc、`go vet`（assistant / store / httpapi）、`go test ./internal/personalagent/assistant -run TestWithoutIDs`、`go test ./internal/httpapi -run 'TestNeedsYou|TestInboxView|TestPersonalAgentInbox'`（含新的 `TestNeedsYouCardRowsSayWhatAndWhereWithoutIDs`、`TestInboxViewClassifiesTheFailedAttempt`）、Web `tsc --noEmit`、`audit:ui` 全部通过。
- Web 测试：macOS 上 7 个文件一起跑时报了一个 `Cannot read properties of null (reading 'textContent')`，输出被过滤、随后 macbook 离线，没能定位到文件；同一棵树在 sg-chaos 上逐个文件跑全部通过：assistant-side-card 6/6、person-list 8/8、pending-items 18/18、chat-context-folds 4/4、chat-session-status 7/7、personal-agent 36/36、assistants-web 8/8。已请车次负责人在其 Web 测试中包含这 7 个文件。
- 部署：按编排规则（2026-11-13）只由车次负责人 sess_1794555762602239151 部署，补丁已交付。车次 DEV-219（deploy203p2 + DEV-212/215/218/219/221）检查开始后才收到，按编排要求不进本车；负责人把补丁 rebase 到上线树，随下一车部署。
- **已上线**（2026-11-13 12:28 UTC，车次负责人 sess_1794555762602239151）：Web `17e800313131e760`（`/version.json` 已核对），Server `61f14d85234f4fb5…`。该车检查里这 7 个 Web 测试文件全部通过（6/8/18/4/7/36/8）。
- **线上 API**（e2e-alice，只读 GET）：`GET /api/assistants/{id}` 的 needsYou 行带 `from`（如 `{kind:"chat",name:"DEV-152 测试：本人自己开的对话",detail:"dev148-synthetic-workspace"}`、`{kind:"helper",…}`、`{kind:"assistant"}`），`GET …/inbox` 的失败条目带 `resultFailure`。
- **截图**（`.foundry/attachments/dev214/`，仓库外忽略目录）：`real-light.png`（e2e-alice 真实数据，1440×900 亮色）；`mock-light.png`、`mock-dark.png`、`mock-dark-bottom.png`、`mock-dark-narrow.png`（390×844）：用页面 init script 只替换 `GET /api/assistants/{id}` 与 `…/inbox` 的响应，内容按本人截图的形状合成：飞书私聊转交、`邓灿文` 账号权限更新、标题带 session id 的对话、429 额度失败的「你好」。没有写服务器数据、发消息或运行模型；登录只在临时浏览器会话中。
- **跟进补丁 v2（截图 + 编排评审，待下一车）** `/tmp/dev214-handoff/dev214-followup2.patch`（sha256 前缀 `6f25eb09a78fb9de`，9 个 Web 文件，替代 v1）：
  - 清单每项一行：勾选 · 标题 · 淡色时间（有提醒时加提醒徽标）· •••；「让助理接着处理」「详情与证据 / 收起详情」进菜单；「只记录」「已完成」不再占行，只有交给助理执行的进度、未完成或失败的执行、「我在帮忙 →」才出一行。
  - 没处理的消息：单条为「“你好” · 模型额度用完，23:02 后可重试」一行，下一行「重试 · 查看上次尝试 · 详情」；多条同因时上方一行汇总。
  - 「助理 · 助理」→「助理的对话」；本人主动停止的消息显示「处理被停止了」。
  - 检查：byte-dev-sg 上 protocol build、Web `tsc --noEmit`、`audit:ui` 通过（Mac mini 依赖安装两次失败）；sg-chaos 逐文件 assistant-side-card 7/7、person-list 8/8、personal-agent 36/36、assistants-web 8/8。
  - **v2 已上线**（2026-11-13 13:13 UTC，Web `9326a47256da2787`，Server `3a43614e0c038f59…`，车次 4；部署前检查 Web tsc、audit:ui、assistant-side-card 7/7、person-list 8/8、personal-agent 36/36、assistants-web 8/8）。截图 `v2-light.png`、`v2-light-bottom.png`、`v2-dark.png`、`v2-dark-menu.png`（清单行菜单：编辑 / 让助理接着处理 / 详情与证据 / 删除…）：整张卡片在 1440×900 下一屏放下，清单四项各一行，未处理消息一行原因 + 一行操作。截图中发现长标题被 40% 宽的时间标签挤成三行，v3 增量把时间标签改为 `max-w-24`。
  - 截图时误点了 e2e-alice 真实清单项「比较两份旅行行李清单」的文字（label 会勾选），立即取消勾选，经 API 核对状态仍为 open（只有 updatedAt 变了）。
  - 计数标注（v3 增量 `/tmp/dev214-handoff/dev214-followup-v2-to-v3.patch`，sha256 前缀 `3ac88d9245ad385d`，7 个文件，含上面的时间标签宽度；车次 5）：本人有两个助理（默认 + ByteWork），卡片计数（本助理可见）会与侧边栏（全部）不同。不同时卡片标题为「等你处理 · 这个助理 3」，链接为「全部 4 >」；相同时照旧「等你处理 4 · 全部」。全局数直接取侧边栏同一来源（`pending.list.open`，由 `ActiveView` 传给 `AssistantHome`）。byte-dev-sg 上 Web tsc、audit:ui 通过；sg-chaos 逐文件 assistant-side-card 8/8、person-list 8/8、personal-agent 36/36、assistants-web 8/8。
  - **v3 已上线**（2026-11-13 13:24 UTC，Web `41ae339dac57f691`，Server `298b10db…`；部署前 Web tsc、audit:ui、assistant-side-card 8/8、person-list 8/8、personal-agent 36/36、assistants-web 8/8）。截图 `v3-same-light.png`（计数一致：「等你处理 4 · 全部」）、`v3-scoped-light.png` 与 `v3-scoped-dark.png`（本助理 3、全部 4：「等你处理 · 这个助理 3 … 全部 4 >」）。截图只读，没有点清单项。
  - v4 增量（待下一车）`/tmp/dev214-handoff/dev214-followup-v3-to-v4.patch`（sha256 前缀 `8313a3ffdb811569`，仅 person-list.tsx）：`max-w-24` 后时间标签仍占独立一列，长标题仍折三行；改为跟在标题后的淡色后缀。person-list 8/8。
  - **v4 已上线**（Web `48d113c65278f6ff`，Server 不变 `298b10db…`；部署前 Web tsc、audit:ui、person-list 8/8、assistant-side-card 8/8）。截图 `v4-light.png`、`v4-dark.png`：长标题只折一次，时间标签作为淡色后缀；清单四项、整张卡片一屏可见。截图只读。
  - **v5 窄屏已上线**（Web `513bfbd73932d330`，与 DEV-217 设备页 Web 跟进同车；部署前 byte-dev 上 Web tsc、audit:ui、assistant-side-card 9/9、person-list 8/8、personal-agent 36/36、assistants-web 8/8）。1100px 以下不再是截断的定高条：对话上方一行摘要「等你处理 4 · 没处理 1 · 清单 4」（只列非空段，全空时「没有要你处理的事」），点开从右侧滑出整张卡片（`components/ui/dialog.tsx` 新增 `side="right"`，与已有 `left` 同构）。截图 `v5-390-light.png`、`v5-390-light-sheet.png`、`v5-390-dark.png`、`v5-390-dark-sheet.png`、`v5-900-light.png`（Esc 关闭后焦点回到摘要条，可见焦点框）、`v5-900-dark.png`。截图只读。
  - 计数：截图里卡片「5」与侧边栏「4」不一致来自合成数据（`open: 5` 是手写的）；真实数据下两者都是 4（`real-light.png`）。两者口径：侧边栏是本人全部待办，卡片是本助理可见范围（权限包内的项目和账号）；只有一个默认助理时相同。

## 验收步骤

1. 打开 dev 助理页（宽屏）：右侧是一张与 chat 右栏同样式的浮动卡片。
2. 「等你处理」行标题说明要做什么（如「重新授权 邓灿文：feishu-cli v1.44.0 需要新增 N 项权限」），副行是来源（「你的账号和设备」「ccm-omh-integration · 这两个session以及他们的sub …」），不出现任何 `sess_` id。点行或「全部」进入等你处理页。
3. 有失败的保存消息时：一行原因 + 淡色原话 + 「重试」「查看上次尝试」，「详情」展开才看到原始报错。
4. 清单、正在做的事为空时各只占一行。
5. 亮/暗主题都可用；窄屏（<1100px，如 390、900 宽）对话上方是一行摘要，点开从右侧滑出完整卡片，Esc 或 × 关闭后焦点回到摘要条。

## 局限

- 消息通道来源只取通道名和投递记录中的会话 / 发送人名；投递记录被清理后只显示通道名。
