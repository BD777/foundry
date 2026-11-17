# DEV-268 通道回合：把会话叫对、把上下文交全、不发占位回复

2026-11-17，本人截图（私聊里的话题）。本文记录调查、改动与验证；已部署 dev（2026-11-17）；待本人验收；已合入 main（PR #274）。

## 问题

本人与区浩辉的私聊里，区浩辉发了缺陷卡片和截图，本人在其下的话题里发 `/ai 查一下这个tag是什么逻辑打的，是否合理`。通道把这些交给助理时：

1. 会话被记成来源的通用名「私聊」，内容其实是与区浩辉的私聊；话题只给了一个 id，没有发起人、时间、正文或卡片标题；话题根消息和更早的回复都没有交给助理。
2. 助理先回「我确认一下……稍后回复你」这种没有信息量的占位消息；处理中表情（OnIt）在这一轮结束时就被移除，而它启动的只读 helper 还在跑。
3. 区浩辉随后在话题里补充「不对吧，这个都不是 autofix 处理的」，没有触发词；续聊规则是 `same-sender`，这条被当作不匹配丢弃，助理收不到。

## 调查（来自 `~/.foundry/server/foundry.db` 的通道交割记录）

- 触发批次 `dlv_456a47449659e63e54017330`（会话 `sess_1794902398667612761`）的输入事实：
  ```
  conversation: direct 7650352051712478420 "私聊"
  thread: 7709046791894813931 (reply)
  context: olk im context 7709047061911457032 --limit 50
  message 1: 本人的 /ai 消息（仅此一条）
  ```
  `where.name` 是来源给私聊的通用名「私聊」，不是对方姓名；卡片和图片消息的 `text` 为空。
- 话题根消息 `7709046791894813931`（区浩辉，15:58，卡片+图片）与 16:08 的补充 `7709049320581909799` 都记为 `dropped / no_rule_matched`，且按隐私设计清空了正文，因此没有任何内容进入会话。
- OnIt：收件箱条目在 16:01:06 解决（占位回合结束）即触发移除；helper `sess_1794902453508133316`（父会话即通道会话）跑到 16:05:55。旧实现只看收件箱条目，不看会话谱系。
- 命名来源：OpenLark 描述符已有 conversation 读（`GET /agent/v1/conversations/:feedId` → `/name`，私聊返回对方姓名）和 members 读（`GET /agent/v1/conversations/:feedId/members`），都是 route 目录里的 read；feed 的 `where.name` 只是原始通用名。Foundry 侧按描述符读取，不写 OpenLark 代码。

## 改动

### 补丁 A（先交付）

- **续聊（`channels/followup.go`）**：新增 `thread-participants`，默认值改为它。语义：已经有过回合的话题里，任何参与者的消息都续聊；话题外的引用回复仍只接最初发消息的人。`same-sender`/`person`/`anyone` 保持原义；`/end` 仍能结束（话题参与者都可以发）。Web 通道编辑器（`channel-model.ts`、`settings-channel-session.tsx` 的选项）与两种语言的文案同步。
- **谁写的（`channels/notice.go`、`followup.go`）**：每条消息的 `sender` 写成 `"区浩辉" (ou_other), not the person`；续聊事实写成 `follow-up: thread <id> (since …) by "区浩辉" (id), not the person`，助理不用再自己推断。
- **OnIt 生命周期（`channels/dispatch.go`、`context.go`、`sqlitestore`）**：交割记录新增 `ack_held` 列；加表情成功后标记，每次巡检检查该回合的会话与它的所有后代会话（`CountActiveAgentDescendants`，递归 CTE）是否还在工作；都在工作才保留，全部结束才移除。会话读取失败时按「仍在工作」处理，宁可多留不撒谎。

### 补丁 B

- **描述符的读取（`contracts/models/connectors.yaml`、`extensions/open-lark/foundry-extension.json`）**：`serverHeld.events.reads` 声明命名读取：`conversation`（名称、类型）、`members`（成员）、`message`（单条消息的发送人、时间、正文、卡片标题、部分类型、媒体 key）、`thread`（话题回复列表）。每条读取的路径参数由 `conversation.id`/`message.id`/`thread.id` 填充，字段用已有的 JSON pointer/模板/时间单位映射；扩展版本 1.6.5。所有读取都走实例网关的 read route，没有产品代码进入 Foundry。
- **命名与话题上下文（`channels/facts.go`、`notice.go`、`dispatch.go`）**：交割前按需读取。私聊/自聊取会话读的名称（失败再按成员兜底），把解析后的名字写回信封（因此会话标题、通道视图也跟着对）。话题回合读取根消息和触发之前的回复（最多 20 条，超出的注明），事实块新增：
  ```
  conversation: direct … "区浩辉" (direct chat with 区浩辉)
  thread: … (reply); thread under "区浩辉" (ou_other), not the person at …
  thread root: 发送人、时间、正文/卡片标题（无文字时给部分类型）、媒体 key
  thread earlier replies: N（逐条给时间、发送人、正文）
  ```
- **打开窗口里的其他人（`channels/runner.go`、`context.go`）**：触发之后、回合及其 helper 仍在工作时，同会话里别人的消息（非触发词、非续聊、非 bot/自己写入）记为 `context`，由 `Context` 端口以边界投递 steer 进正在跑的会话；不创建收件箱回合。窗口由会话谱系判定；回合/helper 结束后未投递的 context 记为 `window_closed` 并清正文。容量 20 条 / 8 KB 每窗口，超出的记 `context_capped`，下一条 context 通知写明「cap reached，后面的不再投递」。
- **会话标题与行标记**：标题为 `<通道名> · <会话名> · 话题`（有话题时）；Web 通道行标记（`channelOriginMark`）同样加「话题」。种子 `AGENTS.md` 的续聊与上下文事实改为新语义（新通道生效）。

## 验证

- `go test ./internal/channels`（整包，本地）：通过。新增定向：
  - `TestThreadParticipantRepliesFollowUpBySetting`：话题里另一参与者的回复在 `thread-participants` 下作为 follow-up 交付、带谁写的；`same-sender` 下丢弃且不留正文；`/end` 结束后不再续聊。
  - `TestAckStaysWhileAHelperRuns`：回合结束后 helper 仍在跑时表情保留，helper 结束才移除，且不会重复移除。
  - `TestHandOverNamesAThreadAndReadsItsRoot`：私聊命名为「区浩辉」，话题事实带根消息（卡片标题）与更早回复，触发之后的回复不交付，解析后的名字写回存储。
  - `TestOtherParticipantsMessageWhileOpenIsContext`：窗口内另一参与者的消息作为 context 进入运行中的会话（不新建回合），超容量时 20 条上限生效并注明。
- `go test ./internal/connectors -run 'TestExtensionDescriptorsPassServerChecks'`：通过（新的 `events.reads` 描述符与 OpenLark 1.6.5 扩展通过服务端检查）。
- `apps/web`：`message-channel-model` 15/15 通过（默认续聊改为 thread-participants）。
- 远端检查（`scripts/remote-check.sh`，CanWendeMac-mini）受 live 树已有的 TypeScript 错误阻塞：`packages/protocol/src/annotations.ts` 从 `./daemon-messages.js` 导入未导出的 `SessionInputAnnotation`，依赖安装阶段即失败，与本文改动无关；httpapi 定向测试因此未在远端跑完。
- 补丁 A 单独导出为 `/tmp/dev268-patchA.patch`（23 个文件，已 `git apply --check` 验证；补丁 B 的代码不在其中）。
- 无部署、无提交，未发送任何以本人身份的消息。

## 局限与待办

- 话题根消息/回复的图片只给出媒体 key（描述符的读取机制读 JSON；媒体是字节路由），未作为附件传给会话；助理可用来源自己的 `im media` 读取。
- context 投递在「检查会话状态」和「Send」之间有极小竞态：若回合恰在此时结束，Send 会把上下文作为新回合输入。要彻底消除需要会话级「仅运行中」原子投递。
- 本人通道 `channels/openlark/AGENTS.md` 的续聊事实需要按新语义更新，并加入本人那一行规则「话题里别人的续聊，判断是否和这件事相关：相关就回，不相关就不回。」——需由编排会话通过工作区文件编辑器（带版本历史）应用；本会话没有 personOnly 权限。

## 补丁 A 部署前修正（2026-11-17）

- 远端 `channels` 整包测试发现两处问题，已修正后整包通过：
  - OnIt 在回合已结束（交割记录均为 done）时不再被释放：`dispatchChannel` 在没有未结交割时直接返回，`settleAcks` 不会运行，表情要等下一条消息才消失。现在无未结交割时也执行释放（`dispatch.go`）。
  - `TestFollowUpsContinueAThreadWithoutATrigger` 仍断言旧默认 same-sender；该测试显式固定 same-sender，新默认由 `TestThreadParticipantRepliesFollowUpBySetting` 覆盖（`channels_test.go`）。
- 远端检查：`channels` 整包、`httpapi -run 'Channel|MessageChannel|Lineage|Ack|Followup'`、`sqlitestore -run 'MessageChannel|Lineage|Delivery|Channel'`、`connectors -run TestExtensionDescriptorsPassServerChecks`、`generate-contracts --check`、Web typecheck、`message-channel-model` 测试均通过。
- 迁移：`message_channel_deliveries` 新增 `ack_held`（默认 0），部署前备份数据库。
