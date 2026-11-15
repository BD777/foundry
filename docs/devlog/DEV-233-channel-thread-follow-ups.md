# DEV-233 通道续聊与回复位置

状态：已部署 dev（train2-20261116）；Agent 代验收（2026-11-16，范围见验收记录）；已合入 main（PR #269）。

2026-11-16 E2E（`sess_1794771302095655670` 第 1 轮、`sess_1794778276586307621` 第 3 轮）：真实自聊里免前缀续聊与自写丢弃通过。

## 问题

本人的原话（2026-11-16）：

- 「我们总是以话题回复的方式去回复那个发消息的人。可以不用@人。……prefix触发之后，续聊……在同一个话题里面可以不用带prefix自动也来到Channel的对应Session里面去，这个要从工程上去处理。」

今天通道的过滤只有 `Rules`：每条消息都要自己命中触发词（或规则），话题里没有触发词的后续消息会被丢掉，即使同一话题的会话已经在跑。回复位置也只存在于助理自己的判断里，事实块没有给出回复命令。

## 调查

- 调研一（`sess_1794760727259595718`）确认了三种参考行为：Persona 群聊按话题绑定、私聊按引用绑定；OpenLark 目前每条消息都要前缀；Devin/Linear 订阅话题后免提及续聊。建议把续聊做成过滤器的一个阶段，而不是改会话键。
- 调研二（`sess_1794760734573412903`）给出了 Web 现状，与 DEV-233 相关的是会话/投递分组和事实块原文。
- 现有代码：`apps/server/internal/channels/filter.go` 的 `Stage` 已存在；`runner.go` 只把 `op=new` 的新消息交给规则；`notice.go` 已输出 `rule`、`thread`、`context`；会话键在 `runner.go` 的 `SessionKey`，空闲滚动在 `dispatch.go` 的 `DecideRollover`。

## 改动

### 过滤器与会话绑定（Server，`internal/channels`）

- `filter.go` 新增 `follow_up` 规则 id（`RuleFollowUp`）；`followup.go` 维护活跃绑定的快照：
  - 以（通道、会话、话题）为键，绑定来自当前段里已投递的消息；首个发送者、开始时间取该话题/会话当前段最早的消息。
  - 会话失败（最新投递 `failed`）或显式结束（`follow_up_end`，写入 `MessageChannelKeyResetPending = "ended"`）后绑定结束；空闲滚动不算结束：续聊仍会匹配，并由既有 `DecideRollover` 开新段。
  - 回复/引用：`attributes.replyTo` 指向通道投递过的消息，或 `attributes.replyToMe=true`（回复助理自己的消息）。
  - 无话题的聊天只认回复/引用；自聊的普通记事不会被当成续聊。
  - 机器人消息、`sender.isOwnWrite`、以及网关记录为助理自写的消息永不匹配；自写消息记录为 `dropped/own_write`。
- `runner.go`：先按 `Rules` 判断；只有规则未命中时才落到续聊（触发了的新消息仍按原规则归类）；结束命令在 `Rules` 之前处理，记录为 `dropped/follow_up_end`，不交给助理，也不在 IM 里回复。
- 通道配置 `followUps { enabled, from: same-sender|person|anyone, endCommands }`：新通道与既有通道默认开启、`same-sender`、`/end`；`httpapi` 校验并持久化。

### 助理自写消息（Server，确定性）

自聊里助理用本人的账号写消息，`isSelf`/`replyToMe` 对它的回复同样成立。不能靠"引用了哪条消息"猜：助理可能回复批次里较早的一条。现在由网关记录：

- 描述符新增 `serverHeld.writes`：列出写路由（`method` + 路由目录里的 `path`）和响应里的 JSON pointer（`createdMessageId`）。OpenLark 声明 `POST /messages/:messageId/replies`、`POST /conversations/:feedId/messages`、`POST /agent-sessions/:sessionKey/messages`，都取 `/messageId`。
- 网关在写请求成功（2xx）后、把响应交回设备之前，按声明从响应里取出新建消息 id，追加一条 `extension_write_created_message` 审核事件（账号、会话、设备、id）。
- `channels.Ports.OwnWrites` 只查该来源账号最近 48 小时内 `extension_write_created_message` 这一类事件（新索引 `(account_id, kind, created_at)`），不扫账号的全部审计；`decide` 在处理规则/续聊之前把集合内的消息（以及 `sender.isOwnWrite`）记为 `dropped/own_write`，正文不保留。
- 查询失败时**不投递**这一批：不保存记录、不前进游标，通道进入 backing_off 并记录错误，下一次轮询用同一游标重读。
- 原先"引用最新一条已投递消息就当作自写"的猜测已删除。

### 事实块（Server）

- 每条续聊消息：`rule: follow_up`，并输出 `follow-up: thread … (since …)` 或 `follow-up: quote … (since …)`。
- 描述符新增 `reply.kinds`（按会话类型给出回复命令模板），事实块新增 `reply:` 行，与 `context:` 并列；OpenLark 群聊填 `olk im reply {message.id} --thread`，私聊/自聊填 `olk im reply {message.id}`。
- 描述符的 envelope 映射新增通用字段 `sender.isOwnWrite`，以及 `attributes.replyTo` 所需的 `when` 条件、`trimPrefix` 和 JSON pointer `-1`（数组末项）；OpenLark 从 `item.refs` 的 `parent` 引用映射 `replyTo`（去掉 `msg:` 前缀）。OpenLark 扩展升到 1.6.0，带上 `serverHeld.writes`。
- `SeedInstructions` 增加回复位置与续聊规则：群聊在触发消息的话题里回复、不 @ 人；私聊/自聊引用回复、已有话题才用话题；本人可在话题里或引用回复直接续聊，`/end` 结束。触发词事实改为「新会话需要触发词」。

### 编辑器（Web）

- 通道编辑器在会话字段旁新增「续聊」：开关、谁能续聊（最初发消息的人/只有你/任何人）、结束命令；仅在来源声明了 `threads` 能力时显示。
- `MessageChannelCapabilities` 增加 `threads`（来源映射了 `thread.id`）；类型、模型与中英文文案同步。

## 验证

- Go 定向测试：
  - `cd apps/server && go test ./internal/channels/` — 通过（含配对消息分别回复后自写不触发、本人引用助理回复仍续聊、自写查询失败时不投递并重试、失败/结束/空闲滚动等）。
  - `cd apps/server && go test ./internal/connectors/ -run 'TestExtensionDescriptorsPassServerChecks|TestExtensionGatewayRecordsTheMessageAWriteCreates'` — 通过（OpenLark 1.6.0 清单合法；写响应里的 `messageId` 在响应返回前记录）。
  - `cd apps/server && go test ./internal/httpapi/ -run 'MessageChannel|ChannelInbox|ChannelSession|ChannelTurn|FollowUpInTheSameThread|MessageChannelOwnWrites'` — 通过（HTTP e2e：触发 → 同话题免前缀续聊 → 同一会话；自写集合按 kind/时间读取，600 条后续无关事件后仍能命中）。
- Web：`apps/web` 的 `message-channel-model.test.mjs` 15 个用例通过；`pnpm typecheck`、`pnpm audit:ui` 通过。
- 截图（scratch stack 从本工作树构建，登录 e2e-alice，`GET /api/assistants/<id>/channels` 注入合成来源/通道）：
  - `/home/windeng/workspace/dev233-channel-followups-light.png`（1440×900，浅色）
  - `/home/windeng/workspace/dev233-channel-followups-narrow.png`（390×844，浅色）
- 未部署、未提交。

## 验收步骤

1. 在一个有话题能力的来源上保存/打开通道，确认「续聊」默认开启、谁能续聊为「最初发消息的人」、结束命令为 `/end`。
2. 在群话题里发带触发词的消息，等助理在该话题回复；再在同一话题里直接发一条不带触发词的消息，确认助理继续在同一会话里处理，事实块有 `rule: follow_up` 与 `follow-up: thread …`。
3. 换一个人在同一个话题里发不带触发词的消息，确认不会触发。
4. 私聊里引用助理的回复继续聊，确认进入同一会话；在自聊里发普通记事，确认不触发。
5. 发 `/end`，确认聊天里没有多余回复；再发不带触发词的消息不触发，发带触发词的消息开新会话。

## 已知限制

- OpenLark 的 `/changes` 不暴露「这条消息由 agent 写入」，所以 `sender.isOwnWrite` 在 OpenLark 上恒为 false；自写识别依赖 `serverHeld.writes` 声明的写路由。走未声明的路由（或上行写入失败但消息仍出现）不会进这个集合，需要时在描述符里补声明。群聊/私聊里其他人的消息仍受 `from` 默认 `same-sender` 约束。
- 续聊绑定只从最近 500 条已投递记录重建；非常繁忙的通道可能丢失很旧的话题绑定（与现有派发窗口一致）。
