# DEV-234 在助理里看通道会话：来源、分段与只接收通道消息

2026-11-16。本人希望从助理这边能看到 Channel 过来的消息、被如何处理成 Session，以及消息来自哪个会话、谁发的、内容是什么；并确认方向是**以通道工作区的会话列表为视图**：按 IM 会话分组，助理页和设置页各有一个入口，不另做通道页面、不在侧边栏加 tab。

状态：已部署 dev（train2-20261116）；Agent 代验收（2026-11-16，范围见验收记录）；已合入 main（PR #269）。

2026-11-16 E2E（`sess_1794771302095655670`，第 1 轮）：通道回合的结构化来源（通道、会话、话题、发送者、时间、正文）在真实自聊里出现。

## 改了什么

### Server

- `GET /api/personal-agent/channels/{channel}/conversations`：通道的来源会话语义分页（游标），每个会话带最后发送者/时间、消息数、命中数、会话数，以及按时间倒序的会话（segment、新会话/续聊及原因、状态、标题）。
- `GET /api/personal-agent/channels/{channel}/deliveries` 支持 `conversation`、`sessionId` 和 `cursor`，返回 `nextCursor`；保留 `dropped=1`。文本保留仍为 30 天。
- `GET /api/personal-agent/sessions/{session}/channel`：一个会话的全部通道回合（按 hand-over 分组），每回合带通道、来源会话、话题、segment、新会话/续聊原因和每条消息（发送者、时间、文本、投递状态、规则）。
- 每次通道 hand-over 成为会话输入时，把结构化来源存进输入事件元数据（`SessionInput.channelOrigin` → `AgentSessionEventMetadata.channelOrigin`）：通道、来源 kind、会话、话题、每条消息。Agent 收到的 facts block 不变。投递记录在交接前已写入；如果收件箱先被处理、记录还没来得及打上 inbox id，按通道和 inbox channel 取未标记的记录，仍能生成来源。
- 会话列表（`presentSessions`）给只读的通道会话带 `channelOrigin` 摘要（来源、会话、segment、新/续聊、最后发送者/时间），供 Web 分组和行内说明；只对 `workspaceAccess=read` 的会话查一次。
- `WorkspaceProjection.channelId` 标出消息通道的工作区；`MessageChannelView.conversationCount` 给入口显示对话数。
- **通道会话只接收通道消息**：`POST /api/chats/{id}/queue`、`/queue/{itemId}/steer`、`/queue/{itemId}/retry`、`PATCH /queue/{itemId}` 和 `POST /api/agent-sessions/{id}/messages` 对人员来源返回 409 和明确原因（`this conversation takes input only from the <source> channel`）。带有 `SentBySessionID` 的会话消息（helper 回报）和 Foundry 自己的内部通知不走这些路径，保持原样。

### Web

- 聊天视图：通道回合显示紧凑来源头 `openlark · 群名 · 张三 · 14:03`（带「话题」「续聊」标记），下面逐条显示发送者/时间/正文；Agent 收到的 facts block 收进「详情」，不再作为本人的消息出现。
- 通道工作区的会话列表按来源会话（群/私聊/自己的会话名）分组，组头显示来源、最后发送者和时间；每个会话行显示该段日期、新会话/续聊原因和状态；每个会话组有「下条新会话」。
- 通道工作区不提供「新对话」，也不显示人员分组/拖拽（分组由来源会话决定）。
- 通道会话不显示输入框，位置显示只读提示「这个对话只接收 openlark 通道的消息」和「通道设置」入口。
- 助理会话页标题区有一行安静的通道入口（`openlark 通道 · 3 个对话`），打开对应通道工作区的会话列表。
- 通道设置卡片用「N 个对话」链接替换「最近消息」列表。

## 验证

- Go 定向测试（CanWendeMac-mini，远程 runner）：
  - `go test ./internal/httpapi -run TestMessageChannelReadEndpoints`：会话列表分页/过滤、会话回合、人员写入被拒，PASS。
  - `go test ./internal/sqlitestore -run TestMessageChannelReadPagesAndOrigins`：游标分页、按会话/会话 id 过滤、来源摘要、hand-over 分组，PASS。
  - `go test ./internal/personalagent/assistant -run TestChannelOriginOfOneHandOver`：hand-over 的结构化来源（通道、会话、话题、消息），PASS。
- Web：`node --test test/channel-chats.test.mjs test/message-channel-model.test.mjs test/i18n.test.mjs` 20/20 PASS；`tsc --noEmit` PASS（同一 runner）。
- 截图（scratch stack，合成数据，正常比例、浅色与窄屏）：见 `.foundry/attachments/dev234/`。

## 验收步骤

1. 打开助理页：标题区出现 `openlark 通道 · N 个对话`，点进对应通道工作区。
2. 通道工作区的会话列表按 IM 会话分组；组头有来源、最后发送者和时间；每个会话行有段日期和新/续聊原因。
3. 点开一个通道会话：每轮显示来源头（群名、发送者、时间、话题/续聊），正文是消息原文；展开「详情」看到 Agent 收到的 facts block。
4. 同一页面没有输入框，只有「这个对话只接收 openlark 通道的消息」和「通道设置」；通道工作区没有「新对话」按钮。
5. 设置 → 消息通道：卡片上的入口打开同一会话列表。

## 限制

- 本次改动之前产生的通道回合没有结构化来源，聊天视图仍显示原始 facts block；之后的回合都带来源。
- 通道视图就是通道工作区的会话列表，没有单独的通道页面；这是与本人确认后的方向。
- 尚未提交、未部署；补丁路径见交接报告。
