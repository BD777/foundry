# DEV-264 归档只有一个可见会话的文件夹却说「25 个对话」

状态：已部署 dev（2026-11-17）；Agent 代验收（2026-11-17，范围见各自验收记录）；已合入 main（PR #**PR**）。

本人截图（2026-11-17，ccm-omh-integration，byte-dev）：侧边栏「运行时初始化」文件夹里只画了 1 个会话，右键「归档文件夹」的对话框却说 25 chats、列原始 `sess_…` id，并要暂停 3 个定时工作。「我 archive 这个只有一条 session 的 group 时他说有 25 chats」。

## 调查

只读副本（ws_56c549f3…，group 4fbf4053…）25 个 position：15 个已有归档标记，10 个未归档。会话列表投影是 `ListAgentSessionSummaries` → `ListArchivedSessions(exclude)` → SQL `... AND NOT archivedSessionSQL ORDER BY activity_at DESC LIMIT 80`，再排除删除/无会话 position；Web 的 `isChatSession` 只决定哪些 source 算 chat。文件夹 position 归档后仍然保留（对话框自己也这么写），所以文件夹可以持有超出最新 80 条窗口的会话。该工作区第 80 行的 activity 是 `2026-11-11T15:18Z`，10 个未归档里只有 `sess_1793796382703541001`（11-13）在窗口内，其余 9 个是 11-04~06 的真实会话，只在窗口外。结论：它们确实属于文件夹，不是 move/删除留下的陈旧 position；对话框应计 10、列出标题，并说明 9 个较早会话不在侧栏显示。3 个定时工作也是真的：2 个属于隐藏子会话 `sess_1793851113386910853`，1 个属于可见会话，都在 10 个之内。

## 修复

- Server（`sqlitestore/chat_archives.go`）：`ArchiveChatIDs` 增加 `restore`；归档时按 position 解析结果过滤掉「已有归档标记（id 或 native alias）」和「会话/聊天已不存在」的成员，恢复保持原样。REST 与 MCP `archive_session(groupId)` 共用这条规则，计数、blocker、暂停工作都只来自真正会归档的会话。
- Server：归档预检结果新增 `archivedTitles`（`chat_titles` 重命名优先，否则 payload 标题），对话框可命名侧栏没画出来的会话。
- Server：新增 `GET /api/chat-layout/member-counts` 与 `GET /api/chat-layout/members?groupId=&cursor=&limit=`（按 group 分页、活动时间倒序，游标同 `ListSessionPage`），只计列表能画出的未归档会话/原生聊天。前端据此在文件夹末尾显示一行「更早的 N 个对话」；点开按页加载，文件夹内的行数 = 对话框里的数量，不提高 80 条窗口。
- Web：`useChatGroupMembers` 拉计数、翻页并把加载到的会话并入 chat 列表（沿用现有行渲染、状态和标题）；`ChatGroupSection` 末尾渲染紧凑的 ghost 行（前置 ChevronRight、hover 填充、可键盘聚焦、`aria-expanded` 随是否已加载过一页）；文件夹右键菜单不再显示会误导的可见行数；归档对话框按标题列出（重名用弱化的短 id），行用共享 `AppLink`（真实链接、正文 ink 色，hover/聚焦才出现下划线与 ↗ 图标，不再整列蓝色），可点开对应会话；对侧栏未画出的会话显示「文件夹里还有 N 个较早的对话不在侧边栏显示，已列在上面，也会一起归档」；两语言。

## 验证

- Go：`go build ./...`；`internal/sqlitestore` 全量（唯一失败 `TestPersonalAgentItemPageFiltersAndPages` 在 origin/main 同样失败，日期敏感、与本项无关）；新增 `TestArchiveFolderActsOnUnarchivedMembersOnly`（归档成员不重复计数/不重新打标记、陈旧 position 被忽略、按批次恢复只恢复本批次）与 `TestChatGroupMembersCountAndPageUnarchivedChats`；`internal/httpapi` 定向 Archive/ChatLayout 测试通过。
- Web：`tsc --noEmit`、全部 `scripts/audit-*.mjs` 通过；`chat-archive-review`、`chat-archive-stable`、`chat-archived-route`、`chat-group-context-menu`、新增 `chat-group-older-members` 共 13 个测试通过。
- 真实浏览器（scratch 栈，e2e-alice，合成工作区 ws_7ccbde37… 内新增合成文件夹：90 条较新的无关会话 + 1 条窗口内成员 + 9 条窗口外成员 + 15 条已归档成员 + 1 个合成定时工作）：左侧 1 行 + 「更早的 9 个对话」；展开后 10 行、该行消失；对话框「10 个对话」、10 行标题（弱化短 id）、注记 9 个较早会话、只列合成定时工作、按钮「归档 10 个对话」；展开后再开对话框仍为 10 且无注记；点列表行能打开隐藏会话（标题/记录正常）。浅色 1440×900、深色、窄 640×900 截图：`/tmp/dev264-sidebar-light.png`（更早行 hover/focus）、`/tmp/dev264-sidebar-expanded.png`、`/tmp/dev264-dialog-light.png`（首行 hover）、`/tmp/dev264-dialog-dark.png`（首行 hover）、`/tmp/dev264-dialog-narrow.png`、`/tmp/dev264-hidden-chat-open.png`；无页面错误。计算样式确认对话框行静止色等于 `ink`、静止无下划线、hover/聚焦才有下划线；更早行 `aria-expanded=false/true` 与键盘聚焦均验证。
- 已部署 dev（2026-11-17）；Agent 代验收（2026-11-17，范围见各自验收记录）；已合入 main（PR #**PR**）。scratch 栈已 `down` 并删除。

## 限制

- 「更早的 N 个」按文件夹里列表可画出的成员计数；Issue 所属会话（列表里本来就不当 chat 画）不计入，归档对话框仍会把它作为 blocker 计数。当前工作区没有这种成员。
- 若在别的标签页改动了文件夹，确认时 `expectedChatIds` 仍会拒绝过期确认。
