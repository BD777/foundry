# DEV-199「等你处理」：准确、先给助理、不引导提问

## 状态

已合入 main（PR #265）。

方向已由本人确认（2026-11-12，[编排会话](https://dev.foundryapp.app/chats/sess_1794464313271186377)）。B3 已合入 dev、通过定向验证并部署 Server 与 Web，等待人工验收。现状调研：[sess_1794497802095643663](https://dev.foundryapp.app/chats/sess_1794497802095643663)，只读，基于真实数据和代码，每条结论都附 path:line 和出处。

## 本人的目标

1. 准确率和召回率最重要：真正需要本人的事不能漏，不需要本人的事不能塞进来。
2. 执行者按原生方式工作，Foundry 不引导它提问；只有执行者自己决定要问时才会产生问题。
3. 执行者的问题先交给助理（助理用更强的模型）：助理能答就自己答，答不了才转给本人。
4. 助理觉得执行者的做法可疑、自己又拿不准时，也可以问本人，这也是一个来源。

## 现状与差距（摘要，证据见调研会话）

- Foundry skill（`SKILL.md:122`）和 handoff brief 都要求 helper「blocked 时以一个问题结束」，这是在主动引导提问。
- 结构化提问（Claude 的 AskUserQuestion、Codex 的 approval / requestUserInput / elicitation）识别准确，25/25；正文里的提问只会通知助理，召回很差。
- `handler` 在条目创建的那一刻就定了：如果当时助理停止或离线，条目直接给本人，之后不会改给助理（`needs_you.go:47`）；也没有「助理多久没处理就升级给本人」的时限。最近 7 天 49 条，全部给了本人。
- `turn_failed` 当前处于打开状态的 7 条里，约 3 条已经过期（配额早已重置、503 是瞬时错误）。原因是 Worker 先上报失败，Server 之后才决定是否重试（`worker-failure.ts:23`），并且没有自动过期。
- 去重是按会话做的：同一个配额问题，在两个会话里各算一条。
- 助理每轮上下文里只有「给助理 N 条」这个数字，没有具体条目（`prompt.go:616`）。
- 没有准确率、召回率、处理时长、升级率的度量。

## 设计

1. **不引导提问。** 删掉 Foundry skill、handoff brief、`session_questions.go` 回退文案、Codex「ask in your reply instead」里的提问要求，改成「如实报告是什么挡住了你、需要什么才能继续」。保留一条机制说明：「如果你决定要问，用原生的提问工具」，因为结构化提问的识别最准确。
2. **执行者的问题一律先给助理。** 属于助理 helper 的条目，`handler` 永远是 assistant；助理停止或离线时，条目排队等它。升级时限：助理在 10 分钟内没有确认也没有处理，自动转给本人，并说明原因。本人主动停止助理时，保留现有的 HandOverAll。
3. **助理按需读取自己的待处理条目。** Foundry 不在每轮上下文注入条目或数量；新条目的到达通过现有任务通知路径发一条事实事件（哪个帮手、问题、条目 id、截止时间）。助理需要时调用 MCP `needs_you` 的 `op=list`（复用 `assistant.Service.PendingFor`），也可以自己回答（`send_message`）、转给本人（`hand_over`，附上判断）或关闭（`resolve`）。助理自己发起的问题，也作为来源之一进入本人列表。
4. **失败按「故障事件」处理。**
   - 先由 Server 决定是否重试；只有不再重试的失败，才生成条目。
   - 同一个根因（用户 + provider/账号 + 错误类别）只算一条，后续出现只累加次数。
   - 后续回合成功、配额到了重置时间、或者已经替换了 provider，就自动关闭。
5. **度量。**
   - 每条记录它最终怎么结束：assistant_answered、handed_over、auto_resolved、person_answered、person_dismissed_not_needed。
   - 本人的条目上增加「不需要我」按钮，作为准确率的标注来源。
   - 按来源统计准确率、处理时长和升级率。

## 实施批次

- B1：不引导提问（文案和 skill 修订）。
- B2：失败按故障事件处理、自动关闭、去重。
- B3：在「可见范围」切片完成后，做助理优先 + 升级时限 + 按需读取 + 「不需要我」按钮和结束方式的记录。

## B3 实现（2026-11-13）

- **助理优先。** 属于某个助理的帮手会话，新建条目一律记为 `handler=assistant`，包括助理当时已停止或家电脑离线的情况；这些条目排队等助理，不再在本人打开列表时自动转交。本人主动停止助理时仍调用 `HandOverAll`，把当时已由助理处理的条目转给本人。
- **确认与升级。** 新助理条目的 `deadline_at` 在写入数据库时设为创建后 10 分钟。确认信号是助理通过 MCP `needs_you op=list` 读到自己的条目，或对条目执行 `hand_over` / `resolve`，或通过 `send_message` 回答帮手；确认时间写入 `acknowledged_at`。Server 的 `pending-needs-you` 后台任务启动即扫、之后每 10 秒扫描一次；`deadline_at` 和 `acknowledged_at` 都在条目上，所以重启不会丢截止时间。到期仍未确认的条目转给本人，`handed_reason=assistant_timeout`、`outcome=escalated_timeout`，卡片显示“助理 10 分钟内没有处理”。
- **到达通知。** 每个助理条目只发一条短事实通知，复用任务通知的 `notices.add` / `tell` 路径，并持久化 `notified_at` 防止重启重复发送；内容只有帮手、问题、条目 id 和截止时间。没有新增每轮提示或系统提示注入；助理需要详情时调用 `needs_you op=list`。
- **结束方式。** 条目增加 `outcome`，可能值为 `assistant_answered`、`handed_over`、`escalated_timeout`、`auto_resolved`、`person_answered`、`person_dismissed_not_needed`。本人后续回答或忽略一个已升级条目时，最终结果覆盖升级阶段的 outcome；`handed_reason` 仍保留它为何升级。每次 outcome 变更写一行 `pending item outcome` 日志，含来源、outcome 和处理时长。
- **本人按钮。** 本人处理的未结条目直接显示“不需要我”按钮，无确认对话框；点击调用现有 state 接口并以 `person_dismissed_not_needed` 关闭。英文为 “Not for me”。
- **助理自己的问题。** 已核对：助理会话本身不是帮手，它的结构化问题经 `pendingReactions` 记为本人处理，已有来源路径无需改动。

相关代码：`apps/server/internal/personalagent/assistant/needs_you.go`、`apps/server/internal/httpapi/pending_needs_you.go`、`apps/server/internal/httpapi/mcp_needs_you.go`、`apps/server/internal/sqlitestore/pending_items.go`、`apps/web/src/features/pending/pending-item-card.tsx`。

验证（worktree）：9 个定向 Go 用例通过，覆盖助理离线/停止时仍归助理、10 分钟升级、确认阻止升级、HandOverAll、辅助回答/交回/自动解决/本人回答/本人忽略的 outcome；pending-items 存储迁移测试通过；`go build ./...` 与受影响包 `go vet` 通过。Web `pending-items.test.mjs` 18 通过、1 个既有 Issues 关闭场景跳过，Web typecheck 与 Prettier 通过。

部署（2026-11-13）：全部改动按 worktree 暂存版本为 base 逐文件三方合并；除 devlog 的 B1/B2 并发内容外无冲突，devlog 冲突按保留既有时间线与新增 B3 段落解决。合并后的 dev 树再次通过同一组 Go 检查、`go build ./...`、目标包 Vet、Web 18/19 测试、typecheck 与 Prettier。迁移前用 `fdy-db-backup needs-you-b3` 做 SQLite online backup，`integrity_check=ok`；压缩后为 `~/.foundry/server/backups/foundry-20261113-0244-needs-you-b3.db.gz`（451,256,227 bytes，gzip test ok，SHA-256 `0bfb975d…6440`）。Server 从 `d7c43f52…` 换到 `bdfb9e05…`，旧二进制为 `foundry-server.pre-needs-you-b3`；PM2 online、restart count `80`、实际 `/proc/<pid>/exe` 与构建 SHA-256 一致，`/healthz` startedAt `2026-11-12T19:13:58Z`。只读核对迁移列 `deadline_at`、`acknowledged_at`、`notified_at`、`outcome` 均已建立。Web 发布 `06c2bacc215e580a`（上一版 `b1033914d2c6c21f`），入口资源一致且同源 API 返回 JSON。

真实浏览器（e2e-alice，zh-CN，1280×900）：加入一条明确标记的合成 `assistant_timeout` 条目后，卡片显示“助理 10 分钟内没有处理”和“不需要我”；卡片位于视口内且页面无横向溢出。点击“不需要我”后回读为 `state=dismissed`、`outcome=person_dismissed_not_needed`、`handedReason=assistant_timeout`。截图：[needs-you-b3-escalated.png](../../.foundry/attachments/20261112/needs-you-b3-escalated.png)。合成 pending 行已删除，浏览器已登出、清 cookie 并关闭，临时认证目录已删除。

文案修正（2026-11-13）：验收截图里的升级原因曾被通用“已由助理处理”渲染器加上多余的“助理：”前缀。`assistant_timeout` 现在使用独立的 muted reason line，中文只显示“助理 10 分钟内没有处理”，英文只显示“The assistant didn't handle it within 10 minutes”。Web `pending-items.test.mjs` 18 通过、1 个既有 Issues 关闭场景跳过，typecheck 与 Prettier 通过；Web 在同一 `/tmp/fdy-deploy.lock` 内构建并发布 `4dffa14f6e9489cf`（上一版 `06c2bacc215e580a`）。e2e-alice 1280×900 复查确认无“助理：”前缀、无多余空格、无横向溢出，合成行已再删除。截图：[needs-you-b3-escalated-copy-fix.png](../../.foundry/attachments/20261112/needs-you-b3-escalated-copy-fix.png)。

## 时间线

| 时间（UTC+8） | 变化与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 剩余动作                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 2026-11-12    | 调研完成，方向确认                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | B1、B2 开工；B3 等「可见范围」切片完成 |
| 2026-11-13    | 可见范围切片完成（DEV-202），B3 可开工                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | B3 开工                                |
| 2026-11-13    | B2 完成：失败只在 Server 决定不再自动重试后生成；按 user + provider/account + category 合并，`other` 保留会话粒度；成功、重置时间、替代固定窗口和 provider 变化会以 `auto_resolved` 关闭，10 分钟清扫同时幂等迁移旧条目。Server `d7c43f52…` 已部署，health ok；B2 定向测试、整 Server build 与目标包 Vet 通过。部署前二进制备份为 `foundry-server.pre-dev197-b2`（`44d9abbe…`）。windeng 名下 open `turn_failed` 从 7 降到 2：两条旧 503、已过重置时间的 quota 和已消除的 provider mismatch 自动关闭，两个同账号 quota 会话合成一条（13 次、2 个会话）；保留一条 host_stopped 与一条重置时间仍在未来的 quota。                     | 人工验收；B3 继续                      |
| 2026-11-13    | B1 完成：Foundry skill、handoff brief、子会话问题回传文案和 Codex 无处理人提示均改为如实说明阻碍/需要，不再要求 blocked 时以问题结束；原生问题工具的机制说明保留。两份 foundry skill 逐字节一致，revision 36 联合 checksum 为 `134f23c7…`；assistant prompt 最终版本 `2026-11-13.1`（digest `42fb0be7…`，包含 B1 handoff 文案）。Worker `0.5.7-dev.354.geb87723d.local.1794508212` 已部署到 7 台在线设备并全部回报成功；Server `d7c43f52…` 已部署，PM2 online，本地与公网 health 均 200。部署前二进制备份为 `foundry-server.pre-dev197-b1`（`80481a58…`）。Worker 定向 17 项、Go `builtinskills`/`prompt`/`httpapi` 定向批次通过。 | 人工验收                               |
| 2026-11-13    | B3 已逐文件合入 dev；迁移前 DB 备份、Server/Web 部署和真实浏览器自验完成。Server `bdfb9e05…`、Web `06c2bacc215e580a`；截图与清理回执见上。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 人工验收                               |
| 2026-11-13    | 修正 B3 升级原因的重复“助理：”前缀和英文大小写/措辞；Web `4dffa14f6e9489cf` 已部署，pending Web 18/19、typecheck、Prettier 与新截图通过。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 人工验收                               |
