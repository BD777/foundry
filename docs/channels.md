# 渠道

[项目 Roadmap](../README.md#roadmap) · [文档索引](README.md)

渠道是人在 Web 之外找到 Foundry 的入口。目前只有飞书 Bot：人在飞书群或单聊里 @ 机器人提出需求，Foundry 在配对的 Workspace 里开一个 Chat 会话（或一个 Issue），进展以卡片回到同一个话题。渠道只做协议转换和路由：会话、Issue 的语义在 Server 的工作流里，权限判断沿用[身份与共享](accounts-permissions-design.md)。它不负责 Agent 在会话里使用飞书（读写文档、以本人或 Bot 身份发消息），那是[连接器](connectors.md)；它也不保管飞书应用的密钥，Bot 运行在连接器里的一个飞书应用上。在分层图中属于“入口”层：依赖工作流（Chats、Issues）、连接器（应用与密钥、每个应用一条长连接）和身份与共享（绑定账号与 Workspace 角色）；没有模块依赖它。Web 里的位置是 Workspace 的 Channels 页（`/workspace/channels`），网页对话始终可用，其余每种渠道一节。

## 设计

### Bot = 连接器里的一个飞书应用 + 路由

- **应用与连接。** Workspace 的 Maintainer 从自己在连接器里的飞书应用或实例级应用中选一个运行 Bot。Server 保管密钥，每个飞书应用只有一条长连接（WebSocket 长连接模式，不需要公网 IP），无论多少 Workspace 用它。事件按 `event_id` 去重：内存中保留，经 `feishu_event_receipts` 持久化 24 小时，重启后的重投只确认、不再路由；事件先写入订阅缓冲并确认，Bot 处理在后台进行，慢回复不会让确认超过飞书的 3 秒。
- **路由。** `feishu_bot_routes` 有三种行：`pairing`（每个 Workspace 一行：“这个 Workspace 的 Bot 运行在哪个应用上”，同时存待用的配对码）、`chat`（群）、`p2p`（单聊）。同一个飞书应用下，一个会话只路由到一个 Workspace；一个应用可以服务多个 Workspace，各自不同的会话。
- **消息分派，先匹配先生效**（`ws_manager.go` `handleMessage`）。机器人自己发的消息和去掉 @ 后为空的消息直接忽略。
  1. `/pair <配对码>`：把当前群或单聊绑定到配对码所属的 Workspace；原来路由到别处的会话改路由到这里。在 @ 检查之前判断，应用收得到未 @ 的群消息时不 @ 也生效。
  2. 话题里的回复，且话题是 Foundry 开的、所在会话仍路由到该话题的 Workspace：转给这个话题的会话；话题对应 Issue 时转给 Issue。
  3. 未路由的会话：丢弃并记日志。
  4. 已路由的会话里的新消息：群里需要 @ 机器人（未 @ 的静默忽略），单聊不需要；以 `/issue` 开头时发起 Issue，否则开一个新话题。
- **消息里的文件。** 图片、文件、语音、视频消息，以及富文本里嵌入的图片和视频，由 Server 用应用的 tenant token 下载（`client.go` `MessageResource`），按 Web 上传的同一路径经设备写入 Workspace 的 `.foundry/attachments/`，作为会话附件送入，每条消息合计上限 100 MiB（`message_content.go`、`message_files.go`、`httpapi/session_service.go` `SaveAttachments`）。提示文本在原位置留 `[image]`、`[file: <名称>]` 这类标记；表情包等带不了文件的类型只留 `[sticker]` 这类标记。下载或写入失败不丢消息，会话收到文本和一行失败原因。新话题与话题内跟帖（steer 或续聊）都带附件；Issue 话题与 `/issue` 只收到标记，不带文件。群里单独的图片或文件消息不带 @，只在 Foundry 开的话题里作为跟帖到达。
- **配对码与群的身份。** 配对码形如 `FND-` 加 4 位字符，由 Maintainer 生成，Web 只在生成时显示一次。群以生成配对码的账号身份执行：路由记录 `bound_user_id`，每条消息都重新检查这个账号（`pairing.go` `boundUser`），会话的 `createdByUserId` 就是它，Channels 页在配对处写明这一点。有效期、存储方式和逐条检查的条件见[安全边界 · Accounts](security.md#accounts)。
- **话题 = 一个 Chat 会话。** 新话题开一个会话（`Source: chat`），回复卡片在会话运行期间不断更新：回答随生成写入，工具调用和思考状态显示为提示，每 800 ms 最多更新一次（`stream_buffer.go`），结束时定格为结果或失败原因。卡片是 Card JSON 2.0。话题内跟帖：会话还在运行就 steer，已空闲就作为下一次输入续聊。跟帖无需 @，但前提是应用开通了 `im:message.group_msg`，否则飞书不会把未 @ 的群消息推给应用（Channels 页的配置说明列出了应用需要的能力、事件与权限）。
- **会话名称。** 配对时从飞书读取群名（单聊读对方名字）。之后在三种时机刷新：Channels 页读取时发现副本超过 1 小时、收到 `im.chat.updated_v1`（应用订阅了才有）、有人点“刷新名称”。读取失败时保留旧名称并记录原因（`chat_names.go`）。
- **更换与移除。** 换成另一个飞书应用 = 换了一个机器人，原来配对的会话全部解除；移除 Bot 时应用仍留在连接器里，继续服务其他 Workspace。还有 Workspace 的 Bot 运行在某个应用上时，这个应用不能从连接器删除。

### 飞书中的 Issue

`@机器人 /issue <目标>` 在话题里发起 Issue，澄清 Agent 立即开始。之后话题内的回复无需再 @：Server 根据 Issue 所处阶段，把回复转给澄清 Agent、作为执行者问题的回答，或作为反馈让 Issue 在同一个候选里继续。`/confirm` 确认当前草案，规则与 Web 相同。澄清回复、执行者的问题与许可请求、完成标准草案的新版本、开始执行、等待验收、接受、放弃和系统错误都会回到话题；验收附 Web 链接，接受只在 Web 上进行。话题中的发言在 Issue 里标注来自飞书，决定记为“<绑定账号> (via Feishu)”。飞书侧只做转换（`feishu/issues.go`），Issue 逻辑在 Server（`httpapi/feishu_issues.go`）；重投的事件按幂等键处理，不会重复建 Issue 或重复转发。

### 单聊交给助理

有[助理](personal-agent.md)的人，单聊默认交给助理（设置“单聊交给助理”，可限定一个应用）：存储的 `p2p` 路由不改写，消息改送到助理的 Workspace，原路由指向的 Workspace 作为路由先验写进助理每一轮的上下文；关掉设置即恢复原路由。这样的单聊在原 Workspace 和助理 Workspace 的 Channels 页都列出，带 `assistantWorkspaceId`。迁移来的单聊第一次收到消息时回一条一次性说明，按“人 × 应用”记在 `pa_direct_chats`。群不变，助理不在群里回答。

- **模型之前的固定词**（`feishu/personal_agent.go`）：只认单聊配对的那个飞书用户。整条消息是“停 / stop”等时按停止开关处理，是“继续 / resume”时恢复，是“好的 / 不用了”等时回答该话题（或该单聊里卡片所在）的待定提议；助理停下或家电脑离线时由 Server 用固定文案回复。
- **卡片按钮回调已接入 Bot 路由**（`personal_agent_cards.go`）：提议卡片的“好的 / 不用了”和停止卡片的“继续”经 `card.action.trigger` 回到应用的长连接，只认单聊配对的那个人按下；提议被接受、拒绝、执行、失败或过期时，卡片原地更新。**应用需要在“事件与回调”里以长连接方式订阅回调 `card.action.trigger`**，否则按钮无效，只能回复固定词或在 Web 上确认。
- Server 一侧是 `httpapi/personal_agent_feishu.go`（`feishu.PersonalAgentDesk` 的实现，调用与 Web 相同的停止、恢复与提议服务，提议只按该单聊绑定的账号查找）。

### 关键决定

- **2026-09-24（首次公开发布）起，群沿用生成配对码的账号的权限**，按发送者本人授权留到以后（[账号与权限设计 §8](accounts-permissions-design.md)）。
- **2026-10-03 Issue 逻辑留在 Server**，飞书只做协议转换。这样以后接通用 Adapter 时，任务逻辑不依赖飞书的消息格式。
- **2026-10-12 Bot 改为“连接器应用 + 路由”**（#124）。以前每个 Workspace 自己存一份应用密钥、自己开一条连接。飞书把一个事件只投给同一应用的某一条连接，所以两个 Workspace 共用一个应用时会悄悄丢消息。迁移（`sqlitestore.migrateWorkspaceFeishuBots`）把旧配置并入连接器应用，并标记“密钥曾在设备上，需要轮换”。
- **2026-10-13 Workspace 的“飞书 Bot”页改名 Channels**（#125），旧 URL 重定向。

## 实现边界

截至 2026-10-14（`3092162` 加未提交的工作区改动：消息里的文件）。

**已实现**

- 路由与 Bot：`apps/server/internal/feishu`（`ws_manager.go` 分派与卡片跟随，`pairing.go` 配对码与绑定账号检查，`chat_names.go`，`card.go`，`stream_buffer.go`，`issues.go`，`process_labels.go`）。
- 消息里的文件作为会话附件（未提交，2026-10-14）：`feishu/message_content.go`（解析每种消息类型）、`message_files.go`（下载并交给 Server 存储）。
- 每个应用一条连接、去重、重连退避：`apps/server/internal/feishuevents`（`hub.go`、`connection.go`、`dedupe.go`）。这个包与连接器共用：同一条连接也供 Agent 订阅事件。
- HTTP：`httpapi/feishu.go`（选应用、生成配对码、解除会话、刷新名称、移除 Bot、`GET /api/feishu/app-uses`），`httpapi/feishu_events.go`（接线），`httpapi/feishu_issues.go`。访问规则见 `routes.go`：Workspace 的 Bot 路由都要求 Maintainer。
- 存储：`sqlitestore/feishu.go`（`feishu_bot_routes`、`feishu_chat_threads`、`feishu_event_receipts`、迁移）。
- Web：`apps/web/src/features/channels`（Channels 页、飞书 Bot 一节、会话列表与配对流程）。
- `FOUNDRY_INTEGRATIONS=off` 时不开任何连接，Bot 显示原因（`internal/integrations`，scratch stack 依赖这一点）。

**未实现 / 已知缺口**

- 按发送者本人授权：飞书用户与 Foundry 账号没有绑定，群里任何能 @ 机器人的人都以绑定账号的身份操作。
- 通用 Bot Adapter：只有飞书专用实现，入站事件与出站动作没有抽象成契约。
- 飞书侧不能为新话题指定设备、Agent 或模型，由 Server 按默认规则选择（`session_service.go` `pickSessionDevice`）。卡片按钮回调只用于助理的提议与停止卡片。Issue 话题里的文件不交给 Issue，只留标记。
- 飞书里不能 Accept；CI 等其他反馈来源没有。
- 卡片跟随状态只在内存里（`WSManager.sessions`，助理的话题与提议卡片同样）：Server 在会话运行中重启，这张卡片不再更新，会话本身不受影响；之后的提议发到单聊里而不是原话题。

**验证情况**

- 消息里的文件：已实现，在测试中验证，尚未实机验证。`feishu/message_content_test.go`（每种消息类型的解析、单聊图片、下载失败、表情包、话题内文件 steer）、`httpapi/feishu_attachments_test.go`（超限拒绝、经设备分块写入、命名与 MIME 推断）；Issue 路径、群里 @ 行为和设备离线没有测试。
- 助理的单聊（固定词、卡片回调、一次性说明、提议只属于绑定账号）：只在测试中验证（`feishu/personal_agent_test.go`、`httpapi/personal_agent_wiring_test.go`），未在真实飞书里验证 `card.action.trigger` 的投递。
- 单元与集成测试用模拟事件和假飞书：`feishu/*_test.go`（配对、共享应用、会话名称、Issue 报告），`httpapi/feishu_test.go`、`feishu_issues_test.go`、`feishu_events_test.go`，`feishuevents/hub_test.go`，安全用例 `cases/security/feishu-group-identity.case.json`（群以绑定账号身份执行、权限变化后拒绝）。
- 飞书中的 Issue（2026-10-03，#74）只用模拟事件测试过，尚未在真实飞书群验收。
- 重建后的 Bot：dev 库里有一个 2026-10-12 迁移后在真实飞书完成配对的会话，库中没有话题记录。在这次文档整理中没有找到真实群里话题会话或流式卡片的运行记录；[实机回归](live-regression.md)也把“飞书续聊”列为未实测。

## 后续

- **飞书中的 Issue 真实群验收**：在真实群里走一遍发起、澄清、`/confirm`、执行者提问与回答、等待验收、Web 接受，确认每个阶段都回到话题。
- **按发送者本人授权**：建立飞书用户与 Foundry 账号的绑定、校验和解绑流程，按发送者本人的权限处理操作和消息可见范围；未绑定的人不能触发执行，群成员身份本身不授予 Workspace 或 Accept 权限，解绑后旧映射失效（[账号与权限设计 §8、§9 P3](accounts-permissions-design.md)）。IM 内是否直接 Accept 仍待决定，复杂审阅回到 Web。
- **探索：通用 Bot Adapter，接入飞书以外的 IM。** 先定义入站事件与出站动作的契约：用户身份、会话、消息与回复关联、附件、交互回应、事件标识。任务逻辑只用这层契约，Adapter 负责转换各平台协议，保留平台和租户范围内的身份与消息标识、请求真实性校验和幂等处理。优先评估业界通用 Bot 协议能复用多少，具体协议和库尚未选定；不假设所有 IM 都有相同的话题或交互语义。完成标准：飞书经 Adapter 与 Web 操作同一个任务，核心逻辑不依赖飞书消息格式；未绑定身份、无权限操作和重复事件都有明确处理。

## 代码位置

- 路由、卡片、Issue 转换：`apps/server/internal/feishu/`
- 长连接、去重、事件分发：`apps/server/internal/feishuevents/`（与[连接器](connectors.md)共用）
- HTTP 与接线：`apps/server/internal/httpapi/feishu.go`、`feishu_events.go`、`feishu_issues.go`；路由与访问规则 `routes.go`
- 存储：`apps/server/internal/store/feishu.go`、`apps/server/internal/sqlitestore/feishu.go`
- 协议类型：`packages/protocol/src/feishu.ts`
- Web：`apps/web/src/features/channels/`、`apps/web/src/api/feishu.ts`；文案 `apps/web/src/i18n/locales/{en,zh-CN}/{channels,feishu}.ts`
- 安全边界：[security.md · Accounts](security.md#accounts)
