# DEV-229 通道实测修复（Server）：只读派发、事实块、最近消息、标题、种子模板

状态：已部署 dev（train17-20261113，Server only，sha256 `380677b3…`，2026-11-13T18:18:46Z 起运行）；待本人验收。已合入 main（PR #268）。工作树 `~/workspace/foundry-dev229`（以 main 当时的工作区为基线，补丁 = `git diff`）。

来源：DEV-203 通道实测报告（`sess_1794585597739851554` 最后一条回答），通道 `mch_0e47207b6ad14d91bade`，通道会话 `sess_1794585876751990513`。Worker 侧（通道会话里的连接器工具）是 DEV-228，另一会话负责。

## 1.（高）只读 helper 被无关会话卡住，且没人知道

**根因。** `checkPAOperationInput`（`sqlitestore/personal_agent_operation.go`）在派发的输入落库时，只要目标工作区里有任何活动会话（`queued`/`running`/`blocked`，verifier 与 utility 除外）就拒绝，`DeliverOperation` 记成 `waiting / workspace_writer_busy`，每 10 秒重试。派发没有"只读"的概念：`paop_0c0a…` 的"只读"只写在 prompt 文本里，Foundry 读不到。ccm-omh-integration 里 `sess_1794583466320780196`（12单补跑）从 23:37 起一直是真正的 `running`（在轮询一个长任务），所以这条派发一直等。排队期间不会告诉任何人。

**"活动"的定义是对的。** 活动 = 有一轮正在进行（queued/running/blocked）。两轮之间空闲（completed）的会话不算忙。一轮里 sleep / 等后台命令的会话仍是 `running`：Foundry 看不出它下一步会不会写，所以写类步骤继续等它。报告里"发送会话 sleep 时也算活动"就是这种情况，不改。

**修复。**

- `dispatch_item` 新增 `readOnly`（布尔，默认 false）：助理声明这一步不改工作区。只读步骤跳过写者检查（含"上一条输入还没确认结束"那一项），不再自动续到该事项正在执行的写者会话（只去它被派去的地方）。helper 的 brief 末尾多一行事实："The assistant dispatched this step as read-only; it started without waiting for other sessions that may be changing this workspace."
- 正在跑只读步骤的会话（其当前输入属于一条 `readOnly` 派发）不算写者，不挡后来的写类步骤。
- 写类步骤照旧等写者，但不再静默：首次撞到忙时记 `waitingSince`、`busySessionId`、`busySince`；等满 `OperationQueuedNoticeAfter`（5 分钟）时给派发它的会话发一条 Foundry 通知（只写事实），真正开始时再发一条：
  - `排队中：派发步骤 <stepKey> 从 <时间> 起在等项目 "<名称>" (<ws>)：会话 <sess> 从 <时间> 起一直在运行，这一步等它结束后才开始。`
  - `开始了：派发步骤 <stepKey>（从 <时间> 起排队）现在在会话 <sess> 里运行。`
    时间按本人时区。通知走与任务通知相同的合并通道（`notices`），助理停止时不发。
- `workspace_writer_busy` 改为带字段的 `store.WorkspaceWriterBusyError`，错误文本仍以 `workspace_writer_busy:` 开头。

**取舍。** 只读是助理的声明，不是沙箱：helper 仍以普通会话运行，这样它能用该工作区的本机登录（如 bytedcli；DEV-228 的决定是本机登录按设计不进通道会话，需要时派 helper）。写者槽本来就是派发之间的协调，不是安全边界；Foundry 只负责不让它静默等待（agent owns its actions）。

**卡住的 `paop_0c0a462e415c1fb07a385a409e31469a`。** 它是部署前派出的，没有 `readOnly` 标记，部署后它仍是写类步骤，会继续等 `sess_1794583466320780196` 结束后自己开始；部署后 5 分钟通道会话收到了"排队中"通知。结果见下文"部署后检查"。

## 2.（低）事实块首行自相矛盾

**根因。** `channels.Notice` 的首行是写死的 `[Message channel: messages from other people, not the person's words]`。

**修复。** 按这一批消息的发送者生成：全是本人 → `[Message channel: messages from the person]`；全是别人 → 原句；混合 → `[Message channel: messages from the person and from other people; only those with sender is the person: yes are the person's words]`。

## 3.（低）长消息带两遍

**根因。** 命中触发词时同时输出 `text`（原文）和 `text without trigger`，各最多 8 KB。

**修复。** 正文只带一次：命中触发词时输出 `trigger`、（有的话）`mentions before trigger`（触发词前被跳过的 @ 提及）和 `text without trigger`；没命中时只有 `text`。8 KB 上限和 `text cut: yes, at 8 KB` 标记不变。种子 AGENTS.md 里"事实块怎么读"一条同步改写。

## 4.（低）「最近消息」的"助理做了什么"会丢

**根因。** `messageChannelActions`（`httpapi/message_channels.go`）读这个账号**全局最近 500 条**网关审计再按会话过滤；本人账号一小时就有 603 条（大多是别的会话的读请求），较早投递的写操作被挤掉。

**修复。** 新增 `MessageChannelGatewayActions`：按通道会话 id、从最早一次投递起的时间窗、`kind=extension_connector_request`，且只取写操作或被拒的请求（`detail.write=1` 或 `outcome=refused`，非 JSON 的 detail 跳过），上限 2000。`external_account_events` 新增索引 `(session_ref, id)`（线上约 7k 行，迁移开销可忽略）。

## 5. 通道会话标题被摘要覆盖

**根因。** 通道会话创建时标题是对的（线上 `sess_1794585876751990513` 的 `title` 是「openlark · 私聊 · 11-13 11:04」），但它的 source 是 `chat`；`chatTitleService.SessionCompleted` 在任何 `chat` 会话第一轮答完后自动起名，写进 `chat_titles`，列表优先显示 `chat_titles`，于是变成「询问当前目录与AGENTS.md首条信任边界」。顺带：日期用的是服务器本地时区（EST），不是本人时区。

**修复。** `RecordMessageChannelSession` 在第一次记录通道会话时，同一事务里 `INSERT OR IGNORE` 一条 `chat_titles`（与"接管原生对话时保留已有标题"同一机制），自动起名因此不再触发；本人手动改名仍然生效，之后再记录也不会覆盖。后续分段标题里的日期改用本人时区（`PersonLocation`）。已存在的会话（包括本人那条）标题不回改。

## 6. 新通道工作区的 AGENTS.md 种子

`channels.SeedInstructions` 新增「通道的事实」一节：

- 这个工作区对通道会话只读，没有哪个设置能放开写入；这个文件由本人在 Foundry Web 的助理设置「工作区文件」里编辑。（原句"可以在 Foundry 的通道设置里修改"被助理推成了"可以在通道设置里放开写权限"。）
- 只有当**每条启用的规则都要求触发词**时，才写：不带触发词（「/ai」…）的消息不会转给你；请本人确认时，请对方回复时带上触发词，或者用 `needs_you` 交给本人。有不需要触发词的规则时不写这句（否则是假话）。

Foundry 不改已有工作区的 AGENTS.md。本人现有通道工作区（`ws_0349bea7-71fb-4ff8-8691-e6ef1acea43b`，触发词 `/ai`）建议加在「信任边界」前：

```markdown
## 通道的事实

- 这个工作区对通道会话只读，没有哪个设置能放开写入；这个文件由本人在 Foundry Web 的助理设置「工作区文件」里编辑。
- 不带触发词（「/ai」）的消息不会转给你。请本人确认时，请对方回复时带上触发词（例如「/ai 发」），或者用 `needs_you` 交给本人。
- 需要本机登录的工具在通道会话里不可用；需要它们时用 `dispatch_item` 派 helper 到对应工作区，只读的查询带 `readOnly: true`。
```

（第三行是否保留取决于 DEV-228 对 bytedcli 的结论：若它经 Foundry 连接器提供、在通道会话里可用，就删掉这一行。）

并把「事实块怎么读」里关于 `rule`/`trigger`/`text without trigger` 的一条换成：

```markdown
- 每条消息的 `rule` 说明它为什么被转来。命中触发词时给出 `trigger` 和去掉触发词后的正文 `text without trigger`（触发词前的 @ 提及在 `mentions before trigger`）；否则正文在 `text`。正文超过 8 KB 时会截断，并标注 `text cut`。
```

## 改动

- `store/personal_agent_operation.go`：`ReadOnly`、`WaitingSince`、`BusySessionID`、`BusySince`、`QueuedNoticeAt`；`WorkspaceWriterBusyError`。协议镜像 `packages/protocol/src/personal-agent-operation.ts`。
- `sqlitestore/personal_agent_operation.go`：只读跳过写者检查；只读步骤的会话/输入不算写者；新字段随保存更新。
- `personalagent/assistant/operations.go`、`supervision.go`：`readOnly` 参数、排队/开始通知、文案。
- `httpapi/mcp_tools.json`：`dispatch_item.readOnly`。
- `channels/notice.go`、`channels/skill.go`：首行、正文只带一次、种子模板。
- `store/message_channels.go`、`sqlitestore/message_channels.go`、`sqlitestore/external_accounts.go`、`httpapi/message_channels.go`：按会话与时间窗读审计；索引。
- `httpapi/message_channel_runtime.go`：标题记录、本人时区。

## 检查

CanWendeMac-mini（compute lease，`scripts/remote-check.sh`）：

- 新测试 `TestAssistantOperationWaitsForTheWriterAndSaysSo`（写步骤等写者并记下是谁；5 分钟后通知一次且只一次；只读步骤在写者运行时直接开始，brief 带只读事实；只读 helper 仍在跑时写者结束，写步骤开始并通知"开始了"）、`TestMessageChannelActionsSurviveABusyAccount`（600 条别的会话的读审计之后仍找到本轮的写；投递前的写不算；非 JSON detail 不出错）、`TestChannelSessionTitleIsKeptFromAutomaticNaming`；扩展 `TestNoticeStatesTheFactsOfAContinuedAndANewSession`（三种首行、长文只出现一次、@ 提及、截断标记）、`TestDispatchHandsOneTurnPerConversationAndFollowsIt`、`TestSeedInstructionsCarryTheGuideAndHowToReadTheFacts`（两条新事实；无规则或有免触发词规则时不写触发词那句）。
- `go test ./internal/httpapi -run 'Channel|Seed|PersonalAgent|Assistant|Title|Mcp|MCP'`、`-run 'Operation|MessageChannel|…|Budget|Drift|Wiring'`：PASS。
- `go test ./internal/personalagent/... ./internal/store ./internal/channels`：PASS。
- `go test ./internal/sqlitestore`：除 3 个与本项无关的失败外通过——`TestRemovedDeviceLeavesNothingBehind`、`TestEveryDeviceOrPathColumnIsClassifiedForMigration`、`TestEveryTableNamingAnOwnerIsOwned` 都指向 DEV-223 未提交的 `workspace_file_revisions` 表（main 工作区里的进行中改动，不在本补丁里）。
- `node scripts/audit-contract.mjs`：PASS。

## 部署后检查

- Conductor 部署 train17-20261113：Server sha256 `380677b368a53da83d78a3657a883b9608006e7d747d44f25cd99a29017e31fe`，替换 train16 `30789765…`，回滚副本 `foundry-server.pre-train17-20261113`；迁移前备份 `~/.foundry/server/backups/foundry-20261113-pre-dev229.db.gz`；线上库已有 `idx_external_account_events_session`。conductor 在 byte-dev 对 train 树复跑 httpapi 两组、personalagent/store/channels、audit-contract：通过；sqlitestore 同样 3 个 DEV-223 失败，已转 DEV-223。
- `paop_0c0a462e415c1fb07a385a409e31469a`（只读查询线上库）：部署后仍是 `waiting / workspace_writer_busy`（如预期：部署前派出、无只读标记），新字段已记录 `waitingSince 18:19:47Z`、`busySessionId sess_1794583466320780196`、`busySince 15:37:07Z`；`queuedNoticeAt 18:24:59Z`。
- 通道会话 `sess_1794585876751990513` 在 18:24:59Z 收到 Foundry 通知：「排队中：派发步骤 mr618-readonly-check-1 从 2026-11-14 02:19 CST 起在等项目 "ccm-omh-integration" (ws_56c5…)：会话 sess_1794583466320780196 从 2026-11-13 23:37 CST 起一直在运行，这一步等它结束后才开始。」时间按本人时区。`waitingSince` 从部署后第一次撞到忙算起（旧记录没有这个字段），所以通知在部署后 5 分钟发出。
- 12单补跑会话结束后这条派发会自己开始，届时通道会话会收到「开始了」通知；写本节时它尚未结束。

## 限制

- 只读是助理的声明，Foundry 不强制；声明只读却写了，与另一个写者冲突的风险在助理。
- 部署前派出的步骤没有只读标记，仍按写类等待。
- 已存在的通道会话标题不回改；已存在工作区的 AGENTS.md 不改（建议行见上）。
- 通知在内存里合并发送；Server 恰好在通知发出前重启时，这一条可能丢（`queuedNoticeAt` 已记，不会重发）。

## 验收步骤（本人）

1. 在通道里发 `/ai 派 helper 去 <某工作区> 只读查 X`，同时该工作区里有另一个会话在跑。预期：helper 立刻开始（`pa_operations` 状态 `delivered`），不再 `workspace_writer_busy`；回复里有结果。
2. 让助理派一个会改文件的步骤到正在跑会话的工作区。预期：5 分钟后通道会话收到「排队中：派发步骤 … 会话 sess_… 从 … 起一直在运行」，那个会话结束后收到「开始了：…」。
3. 在自聊里发 `/ai 你好`。预期：通道会话输入的第一行是 `[Message channel: messages from the person]`；消息只有 `trigger` 和 `text without trigger`，没有重复的 `text`。
4. 发一条超过 8 KB 的 `/ai …` 长消息。预期：正文只出现一次，带 `text cut: yes, at 8 KB`。
5. 等 4 小时空闲后（或新会话）再发 `/ai …`。预期：新通道会话在列表里的标题是「openlark · <对话名> · <本人时区的日期>」，第一轮答完后不变成摘要；手动改名后保持手动名。
6. 「最近消息」里，本轮助理通过 openlark 发出的回复都列在"助理做了什么"里，即使账号同时段有大量别的请求。
7. 新建一个只用 `/ai` 规则的通道。预期：工作区 AGENTS.md 有「通道的事实」两条。本人现有通道的 AGENTS.md 按上面的建议行手动加入后，助理要求确认时会提示带 `/ai`，也不再说存在"放开写入"的设置。
