# DEV-278 助理告诉本人的话能到本人手里（未读标记 + `needs_you tell`）

状态：已部署 dev（2026-11-18）；Agent 代验收（2026-11-18，范围见验收记录）；已合入 main（PR #277）。日期：2026-11-18。

## 问题

来源：`.foundry/reports/assistant-review-20261117-web.md` D5、`.foundry/reports/assistant-review-20261117-channel.md` D4。

- 帮手回报（`child_report`）触发的助理答复只存在于会话事件流里，只有当时打开助理页面才看得到；`pa_inbox` 只有带 `origin` 的来源（飞书）才 `NotificationPending`，web 消息本来就不推送。
- 消息通道会话想把“图片没进话题”“10/20 那批 75 单要不要只读复核”告诉本人时，只有会话结尾答复一个出口；`needs_you` 的 `hand_over` 是“要本人决定的事”，不是“告诉本人一件事”。

## 调查

- 推送路径只有飞书：`personalagent/assistant/inbox.go:398` 与 `feishu/personal_agent_inbox.go:157` 只处理带 `Origin` 的 `pa_inbox`；`feishu/ws_manager.go` 的 `SessionEnded` 只处理飞书自己开的话题。
- `pending_items` 的全部来源（`store/pending_items.go`）都是决定、审批、失败或交接，没有“只是告诉本人”的种类。
- Web 侧助理首页用 `use-assistant-conversation.ts` 读会话并跟流；侧栏只有 Needs you 的数量，没有“助手有新答复”的状态。
- `PersonalAgentSettings` 已有 `feishuDirectChat` / `feishuAppId`，飞书单聊卡片路径可复用（`assistantDirectChat`）。

## 实现

### (a) home 对话的未读标记（状态，不做判断）

- Server：`assistants` 新增 `home_answer_at`（最近一次 home 答复时间）与 `home_seen_at`（本人最近一次查看）。`homeAnswerReactions` 在任意 home 会话终态且 `Response` 非空时记录；带 parent 的帮手会话、消息通道会话、工具会话不记。`RecordHomeAnswer` 用 `AssistantForHomeConversation`（当前 home 或 former home，绝不匹配通道工作区）。
- 路由：`GET /api/personal-agent/home-unread` 与 `POST /api/personal-agent/home-seen`（自动别名为 `/api/assistants/{assistant}/…`，`personOnly`）。`home-seen` 在一条 UPDATE 里把 seen 推到当前 answer，之后到达的答复仍未读。
- Web：`useAssistantHomeUnread` 在标签页可见时每 10 秒读一次，并跟 `agent_session_completed`；助理页可见时调用 `home-seen`。侧栏「助理」显示圆点（`navBadge`），标签页标题/图标用同一未读标记。明确不向飞书推送 home 答复。

### (b) `needs_you op=tell`

- 新来源 `notice`：`handler=person`、无选项、无截止；`note` 1–600 字。`sessionId` 默认当前会话，home 和消息通道会话都能用；只用该助理自己的会话（`Conversation`），别的会话拒绝。同一会话 + 同一句话只保留一条未结项；重复只刷新，不重复发飞书。
- 「等你处理」里是一条紧凑行：助理的话、来源、时间、打开会话、知道了（`dismissed` / `person_dismissed_not_needed`）。没有回复框，不回到帮手。
- 本人设置飞书单聊时，同一条话发一次飞书卡片（`feishu.TellPerson`，`assistantDirectChat` + `SendCard`）；这是本次唯一新增的飞书推送。工具说明只写它做什么，不写什么时候用。

### 文档

- `docs/personal-agent.md` §5 工具表与 §7 进展汇报。
- `docs/assistant-orchestration.md` §h 数据、转换与界面。
- `mcp_tools.json` 的 `needs_you` 说明、`op` 枚举与 `limits`。

## 验证

- Go：`go build` 通过（store、sqlitestore、personalagent/assistant、feishu、httpapi）。定向测试：
  - `internal/feishu`：`TestTellPersonPostsOneNoteToThePairedDirectChat` 通过。
  - `internal/httpapi`：`TestHomeAnswerUnreadFollowsThePersonLastView`、`TestHomeUnreadRoutesMarkSeen`、`TestNeedsYouTellPutsOneDismissableNote`、`TestNeedsYouTellRefusesOtherSessionsAndAnEmptyNote` 通过。
- Web：`tsc --noEmit`（worktree，protocol 源码映射）通过；`pending-items`、`document-title` 与新增 `assistant-unread` 定向测试通过（37 passed，1 个原有 skip）。覆盖未读圆点、标题标记，以及 notice 行的打开/知道了。
- 真实浏览器（浅色/深色、窄屏）按 worker 规则由编排会话在 dev 部署后执行；本会话未部署、未提交。

## 验收步骤（dev 部署后）

1. 用语料：e2e-alice 建一个助理与一个消息通道会话，造一次 `child_report`（帮手回报）与一次 `needs_you op=tell`（合成数据）。
2. 不在助理页时等帮手回报触发答复：侧栏「助理」出现圆点，标签页标题带 ✅；打开助理页后圆点与 ✅ 消失。
3. 通道会话调用 `tell`：Needs you 出现一条紧凑行（原话、会话链接、知道了）；本人设置飞书单聊时飞书收到一张卡片；按“知道了”后该行关闭，帮手不收到任何消息。
4. 浅色/深色、窄屏各看一次；确认侧栏、标题与 notice 行都不溢出。

## 限制

- 没有 web push；不看 Foundry 页面时，未读标记只在标签页可见时更新（10 秒轮询 + 完成事件）。
- 未读标记在折叠成图标栏时不显示（标签页标题仍有标记）。
- 部署与提交不在本会话范围内。

## 时间线

| 日期       | 事项                                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-11-18 | Agent 代验收（编排者，e2e-alice 浏览器，Web 72ac74dca55c1b63）：助理首页的答复带「助理」点与 ✅ 标题，打开后清除；`needs_you tell` 行在浅色/深色/390 px 紧凑显示，「知道了」关闭。未跑飞书卡片（e2e-alice 无飞书）。截图 `.foundry/attachments/20261118/verify-278-285/`（未提交）。 |
