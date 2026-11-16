# DEV-254 等你处理：没处理的消息进入等你处理页，助理侧栏只留一行计数

2026-11-16。本人截图与反馈：

> 这个 needs you 到底怎么样关掉啊？……Open the last attempt 跟右边的 Details 居然没有垂直居中……整个卡片的布局都非常的让人难受……是不是这里就加一个数字的 Badge，然后跳转到那个页面就好了？毕竟这个侧边栏的空间比较少

状态：已部署 dev（train18/19-20261117）；Agent 代验收（2026-11-17，范围见验收记录）；已合入 main（PR #273）。

## 问题

1. 助理侧栏「等你处理」下逐条列出待办，侧栏空间不够；「Open the last attempt」与右侧「Details」没有在同一基线上。
2. 没处理的消息（失败或等电脑）只在侧栏「没处理的消息」卡片里，「不再处理」「重试」只能在助理页做；等你处理页与侧栏计数都看不到它们。
3. 同一次失败有两份表示：侧栏的未处理卡片，以及全局页的 `turn_failed` 项。

## 调查

- 待处理项来自 `pending_items` 表（`store/pending_items.go`：`RecordPendingItem`、`ResolvePendingItems`），由各来源在读取时 reconcile 写入（`pending_failures.go` 的 turn_failed、`pending_personal.go` 的账号与设备）。
- **失败的助理收件箱消息已经会产生一项 `turn_failed`**：会话终止失败时 `recordTurnFailure` 对任何会话都写一项，包括助理收件箱消息派出的会话（`pa_inbox.session_id`）。同一事件又出现在侧栏未处理卡片（`pa_inbox.result_status=failed`）。因此需要跳过收件箱回合的 `turn_failed`，并收敛已有的同类项。计划不变。

## 改动

### 服务端

- `httpapi/pending_inbox.go`（新）：需要本人处理的收件箱消息 = 尝试失败或被停止（`result_status` 为 failed/canceled），或 waiting 且不是会自行清除的原因（排除 `assistant_busy`、`receipt_unavailable`、`dispatch_unavailable`、`session_unavailable`）。每条消息一项，`key = inbox:<entry>`；`event` 按尝试区分（`inbox:<entry>:<session>` 或 `inbox:<entry>:waiting:<reason>`），因为 `RecordPendingItem` 对同一 event 的已关闭项保持关闭，同一条消息再次失败时必须是新 event 才会重新开项。消息不再需要本人处理（已派出、已回答、已重试）时关闭项：已回答为 `done`，其余为 `superseded`（detail `processing`）。
- 项的时间显示消息的发送时间：列表返回 `messageAt`（收件箱条目的 `createdAt`），不再是项被记录的时间。
- `POST /api/pending-items/{id}/retry`（新）：只接受 `assistant_inbox` 来源，调用 `assistant.RetryInbox`；成功后原项 `done`（`person_answered`），新尝试若再失败有自己的项。重试被拒绝时返回 `code`（`inbox_retry_not_settled` / `inbox_retry_changed` / `inbox_retry_failed`），web 按代码显示本地化文字，不显示服务端英文。
- `handleSetPendingItemState`：收件箱项只允许 `dismissed`（同时 `DismissInbox`），`open`/`done` 返回 409。
- `recordTurnFailure` 对收件箱回合直接返回；`maintainPendingTurnFailures` 收敛旧的收件箱 turn_failed 项。
- 列表与助理概览读取前调用 `reconcileInboxPending`。

### Web

- 侧栏 `NeedsYouSection`：一行「等你处理 · 计数 · 箭头」，链接 `pendingHref()`，新标签打开；计数为 0 时不显示。计数用总数，与等你处理页一致。
- 删除 `UnprocessedSection`、`needsYouFromLine`、`kindMark`、逐条行、`inboxReason`/`inboxSummaryReason`、`home.summary.unprocessed`、`inbox.card/summary*/reason/detail/retry/dismiss/openAttempt`（两种语言），以及 `useAssistantConversation` 里的 `retryInbox`/`dismissInbox`。
- 等你处理页 `InboxItemCard`：第一行「“消息” · 原因」，消息截断省略、原因完整保留；第二行元信息；第三行「重试」（主按钮）、「不再处理」「查看上次尝试」同一基线；「详情」（`<details>`）单独一行。
- `groupPendingItems`：收件箱项按助理分组，标题为助理名；`pendingPrimary` 对收件箱项返回 `none`，动作由卡片给出。
- `waitingReasonKey` 从侧栏组件移到 `assistant-model.ts`（转写区「已保存」回执仍在用），匹配值改为收件箱实际写入的 `worker_update_needed`。原来匹配的 `worker_update_required` 是维护原因，收件箱永远匹配不上。

## 验证

- 定向 Go（远端 CanWendeMac-mini）：`go test ./internal/httpapi -run 'TestInboxEntryNeeds|TestFailedInboxAttempt|TestPendingTurnFailure|TestTurnFailure|TestProviderMismatch'` 通过。新增 `pending_inbox_test.go`：规则表；失败尝试 = 一项且不产生 turn_failed；重复 reconcile 无变化；回答后项为 done。gofmt 通过。
- 评审修复（远端）：`TestInboxRetryBeforeTheNativeEndReceiptIsRefusedWithItsCode`（拒绝映射为代码）、`TestUnprocessedMessageShowsWhenItWasSent`（时间为条目时间）通过；sqlitestore `-run Inbox` 通过；web `pending-items` 22 项（含时间与拒绝文字用例）、`assistant-side-card` 4 项、`i18n` 3 项通过；`audit:ui`、prettier 通过。浏览器未对这两处修复重测（代码与测试覆盖）。
- Web（远端）：`pnpm typecheck` 通过；`assistant-side-card.test.mjs`、`pending-items.test.mjs`（20 项）、`i18n.test.mjs` 通过；`pnpm audit:ui` 通过；prettier 通过。
- 构建：远端 `remote-build` 产出 Server（linux/amd64）与 Web，scratch 栈直接使用这些产物（本机未构建）。
- 真实浏览器（scratch 栈，DB 副本 + e2e-alice 合成数据；未动本人账号）：
  - 助理页侧栏：维护行与「等你处理 7」单行（亮色）。截图：`/tmp/dev254-shots/assistant-home-light.png`。
  - 等你处理页：失败消息显示原因，三个操作同一行，详情独立一行（亮色、暗色、390px 窄屏）。截图：`needs-you-light-v2.png`、`needs-you-dark-v3.png`、`needs-you-narrow-v3.png`。
  - 「不再处理」：项为 `dismissed`（`person_dismissed_not_needed`），条目 `cancelled` 且 `dismissed_by` 为 e2e-alice，计数减少。
  - 「重试」：旧条目 `cancelled`（retried），旧项 `done`（`person_answered`），新尝试出现。合成的 `pa_run_controls` 回执满足服务端前置条件。

## 限制与未覆盖

- 第一次重试被服务端拒绝（合成 session 没有 native end 回执）。拒绝以代码 `inbox_retry_not_settled` 返回，等你处理页用本地化文字说明，不显示服务端原文。
- 390px 窄屏下「查看上次尝试」换到第二行，不再与其余两个按钮同一行。
- 键盘路径只依赖原生按钮与 `<details>`，未单独测试。
- Go 只跑了定向测试，未跑整个 `httpapi` 或 `sqlitestore` 包。
- 瞬时等待（`assistant_busy` 等）不进等你处理页，只在助理页转写区显示「已保存」。这是对「未处理消息都进页面」的收窄：这些原因会自行清除，不需要本人动作。待 orchestrator 确认。
- 收件箱项在读取待处理列表或概览时同步（reconcile-on-read），不在失败事件时推送。侧栏角标是提醒信号，不推送（orchestrator 已确认）。
- 过程事故：scratch-stack 因 TMPDIR 路径不匹配触发过一次本机 `go build`（约 1 分钟），已结束，产物未使用。一次页面快照输出中打印过 e2e-alice 测试账号的密码（scratch 副本）；之后未再打印。

## 验收步骤（待人工验收）

1. 打开助理页：侧栏「等你处理」只有一行，数字与等你处理页顶部「未处理」数一致；点击在新标签打开，助理对话保留。
   期望：一行、一个计数、无逐条列表。
2. 等你处理页：失败的消息显示「“…” · 原因」一行；「重试」「不再处理」「查看上次尝试」在同一行；「详情」在下一行。
   期望：布局对齐，错误详情只在「详情」里。
3. 点「不再处理」：该项消失，计数减 1；助理页没有「没处理的消息」卡片。
   期望：消息不再重试。
4. 点「重试」：旧项消失；电脑在线时开始新尝试；离线时出现「已保存，等待电脑上线」的新项。
   期望：只重试这条消息，不重复产生 turn_failed 项。

## 验收记录（Agent 代验收，2026-11-17，dev 真实浏览器，e2e-alice）

- 编排会话在 dev 上实测：首页侧栏显示「等你处理」一行计数与「事项」；等你处理页显示未处理消息（时间取消息时间）与项目维护项，「打开项目」打开项目面板。train 19 的深链、维护分组、「待办」三个修复已在 dev 验证。
