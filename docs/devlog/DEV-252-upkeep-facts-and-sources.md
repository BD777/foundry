# DEV-252 维护事实进助理工作区；助理页面显示输入来源

状态：已部署 dev（train14-20261116）；真实检查通过（部署后 `.foundry/upkeep.md` 生成、维护通知不再产生回合，scratch 栈「维护：N 条修改建议待你确认」入口与 `[Foundry]` 来源行截图核对）；Agent 代验收（2026-11-16，范围见验收记录）；已合入 main（PR #271）。局限保持不变。

## 问题

2026-11-16 的排查（[session](https://dev.foundryapp.app/chats/sess_1794809664688467914)）确认：DEV-238 的 `AnnounceUpkeep` 把每一次维护状态变化都变成 ByteWork 人对人会话里的一条 `foundry_notice` 回合。一夜 15 条，内容多是计数抖动（waiting 14↔13、摘要 25→26→11→4），每次都逼出一条「没有新情况」的回复。同时助理页把 `[Foundry]` 输入直接丢掉（`assistant-model.ts`），页面上看不到这些回合是谁触发的，回复像凭空出现。

另外三处同批修正：

- 维护状态变化时应只把事实放进助理自己的工作区，由助理在需要时读取；不向对话推送回合（推送即引导注意力）。
- 助理页侧栏没有「维护等待本人确认」的安静入口；`upkeepNoticeText` 的维护设置链接用的是 `owner.ID`，发给其他助理时会指错。
- 通道「N 个对话」用 `COUNT(DISTINCT session_key)` 统计所有见过的记录，包含被丢弃的消息和过期记录；与通道工作区里实际存在的对话不一致。

## 设计（编排会话 2026-11-16 已定）

- **不再有维护通知回合**：删除 `tell` 路径，`AnnounceUpkeep` 改为 `RefreshUpkeep`。
- **事实文件**：Foundry 写 `.foundry/upkeep.md`，与 `.foundry/project-index.md` 同一套写入器与只读规则（Web 里 `.foundry/` 本就是只读；Worker 的 `foundryFactFile` 把它排除在运行态 revision 之外，刷新不会重启原生会话）。内容：
  - 等本人确认的 review 建议（项目、条数、何时起）；
  - 失败任务（项目、原因、何时）；
  - 停摆任务（原因、等待起点）；
  - 到期摘要：只算 `SummaryDueAt <= now`、按 workspace 去重、只在 home 设备离线（被阻塞）时列出，并给出等待的设备名。
- **归属**：任务按 `AssistantID` 只进入它所属助理的 home（治理/共享记忆属于默认助理，助理层记忆属于该助理）；到期摘要只给默认助理。设置链接用接收方自己的 `agent.ID`，修正 `owner.ID` 指错。
- **页面**：助理页侧栏在有待确认建议时显示一行安静入口「维护：N 条修改建议待你确认 →」，链接到该助理设置里维护所在的页面；为 0 时不显示。
- **输入来源**：助理页不再丢弃 `[Foundry]` 输入，保留 `inputSource`，复用 DEV-246 的 turn-source 行；旧事件仍靠文本前缀兜底。这样仍可能出现的通知回合（例如 helper 汇报）会显示触发来源。
- **通道对话数**：只统计保留期内（30 天，与清理文本的窗口一致）至少有一条 delivered/done 消息的会话，排除仅被丢弃的会话与 `reset_command`。

## 实现

- 新增 `apps/server/internal/personalagent/assistant/upkeep.go`：`RefreshUpkeep`、按助理的 `upkeepStateOf`、`dueDigestFacts`（纯函数）、`upkeepFileContent`（纯函数）、`writeUpkeepFile`、`upkeepFileFor`（每次 home run 随文件下发）。
- `maintenance.go`：`drainMaintenance` 改调 `RefreshUpkeep`；删除通知文案与 `tell` 分支。
- `instructions.go`：home run 的 `prompt.Input.Upkeep` 由 `upkeepFileFor` 填充；通道工作区仍只有项目事实。
- `prompt/prompt.go`：新增 `UpkeepPath`、`Input.Upkeep`、`RunFiles` 里的文件、managed block 的一行事实（只说位置，无建议）。
- `packages/worker/src/session/personal-agent-files.ts`：`.foundry/upkeep.md` 属于 `foundryFactFile`，不进入运行态 revision。
- `store/personal_agent.go` + `assistant/assistant.go`：overview 增加 `maintenance`（待确认建议条数与项目数），供侧栏使用。
- `sqlitestore/message_channels.go` + `store/message_channels.go` + `httpapi/message_channels.go`：计数加保留期与投递状态；保留期常量与文本清理共用。
- Web：`assistant-model.ts` 保留 `inputSource`、不再丢弃 `[Foundry]`；`assistant-home.tsx` 传递来源并挂侧栏入口；`assistant-side-card.tsx` 新增 `MaintenanceWaitingSection`；中英文案。

## 检查

byte-dev（compute shared lease，`scripts/remote-check.sh`）：

```text
--go ./internal/personalagent/prompt ./internal/personalagent/assistant ./internal/sqlitestore \
  -run 'TestRunFilesCarryTheUpkeepFacts|TestAgentsFileGolden|TestRunFilesIncludeTheAssistantSkills|TestDueDigestFacts|TestUpkeepFileContent|TestMessageChannelConversationCount|TestMessageChannelReadPagesAndOrigins'
--go ./internal/httpapi -run 'TestUpkeepFactsAreWrittenNotSent|TestUpkeepFactsGoOnlyToTheOwningAssistant'
--web typecheck
--web test test/personal-agent.test.mjs test/assistant-side-card.test.mjs
--worker test personal-agent.test.mjs
```

覆盖：

- 状态抖动只更新 `.foundry/upkeep.md`，不产生任何 run（`TestUpkeepFactsAreWrittenNotSent`）。
- 文件内容只含到期摘要、按 workspace 去重；两个助理各拿自己的任务与设置链接（`TestDueDigestFacts...`、`TestUpkeepFileContent...`、`TestUpkeepFactsGoOnlyToTheOwningAssistant`）。
- 通道计数排除丢弃、过期与 reset_command（`TestMessageChannelConversationCountKeepsDeliveredWithinRetention`）。
- 助理侧栏入口为 0 时不渲染，点击打开设置（Web 测试）。
- 助理页把通知保留为来源行、结构化 `child_report` 随行（Web 测试）；Worker 里 `upkeep.md` 刷新不改变 runtime key。

真实浏览器：`scripts/scratch-stack.sh up dev252` 用本 worktree 构建 server + web，复制线上库后，以 e2e-alice 登录，在其助理下插入一条合成 review（8 条 patch，仅 scratch 库）。助理首页侧栏显示「维护：8 条修改建议待你确认 →」；同一页面里既有的 `[Foundry]` 通知显示为「Foundry 通知」来源行（含正文与时间），不是本人气泡。截图：`.foundry/attachments/dev252/assistant-side-card.png`（1440×900，浅色）。合成任务与 scratch 栈验后删除。

## 限制

- 到期摘要的「阻塞」以默认助理 home 设备离线为准；设备离线时文件写入会推迟到下一次在线（与 project-index 的离线行为一致），或下一次 home run。
- 文件内容为英文事实（与 `.foundry/project-index.md` 一致），由助理按人的语言转述；侧栏文案走界面语言。
- 真实浏览器只覆盖助理首页侧栏（scratch 栈 + e2e-alice 合成维护任务截图）；其余为定向 Go/Web/Worker 测试。未验证真实 Feishu 通道计数在长期数据上的变化，只验证了查询语义。

## 验收步骤

1. 用 e2e-alice + 合成数据打开助理首页：侧栏应出现「维护：N 条修改建议待你确认」，点击进入该助理设置里含维护的分节；把 N 归零后该行消失。
2. 在助理 home 的 `.foundry/upkeep.md` 查看：只有到期（`SummaryDueAt <= now`）且 home 离线时的摘要；失败的 review 有原因；等待超过 30 分钟的 review 有等待起点。
3. 人为改动一个治理任务状态，确认会话里不再出现新的 `[Foundry]` 维护通知；页面上已有的通知若仍存在，应显示为来源行而非本人气泡。
4. 通道设置/首页的「N 个对话」应与该通道工作区实际对话数一致。
