# DEV-200 助理不再注入每轮引导

## 状态

已合入 main（PR #265，squash bb3f7fdd）。

已实现、测试并部署 dev Server（2026-11-13 02:09 UTC+8，与 DEV-197 B2 / DEV-201 合并构建一同上线）。Web、Worker 未改动行为（Worker 只改了一处注释，未发布）。等待人工验收。

## 背景与原则

本人的原则：**“避免注入系统提示词和每轮引导”**。长期指导放在工作目录的 `AGENTS.md` 与 skills，由 Claude Code / Codex 原生加载、按需渐进披露；动态事实由工具按需读取，或以简短的事实通知到达。

只读审计（`/tmp/foundry-agent-injection-audit.9PdZOx/foundry-agent-injection-audit.md`）列出的助理相关注入点：S1（助理 `AGENTS.md`）、S2（三个助理 skill）、T1（每轮 TurnContext）、T2（回执与记忆发布提示）、T9（监督通知）、T10（卡片回答通知）、T17（拒绝、待确认、no_place_fits、helper 不可用），以及 `mcp_tools.json` 中助理工具的策略性描述。逐条对照代码核实后处理；审计未列出、但同属助理通知的到点提醒与每日小结（`list.go`）、电脑上线通知（`device_back`）也按同一原则处理。

## 改动

### 每轮上下文（T1、T2）

`prompt.TurnContext` 从“记忆 + 规则 + 在线电脑 + 项目索引 + 清单 + 跟进的事 + 等你处理 + 单聊去处 + 多句行为要求”缩成一行事实：

```
[Context from Foundry for this turn: not the person's words]
Now: Thursday, 2026-10-15 09:30 (Asia/Shanghai).
[End of context from Foundry]
```

经收件箱捕获的消息再加一行回执事实（receipt id、原始来源、receivedAt、时区；重试时加上一次尝试的会话）。原来的“Resolve relative dates…/Do not silently shift…/Reuse existing identities…”改写进 `AGENTS.md` 与 skills。保留时间行的理由：运行时不知道本人时区，相对日期和提醒都依赖它。

### 搬到 `AGENTS.md`（S1）

`prompt.AgentsFile` 在提示词之后追加：

- `# The person's rules`：设置里的额外要求（≤ 2,000 字符）与“什么时候先问本人”的规则，按决定分组成几行，比逐项列出省约 600 B；
- `# What the person confirmed (newest first)`：两层记忆（≤ 2,000 字符，其余 `read_memory`），以及可读的记忆发布 id；
- `# Their Feishu direct chat`：单聊接管前的去处（有时）；
- 本人能打开的页面、示例与项目索引的位置。

项目与电脑索引写到 `.foundry/project-index.md`（`prompt.ProjectIndexFile`，带写入时刻；Worker 现有路径规则已允许 `.foundry/*.md`，无需改 Worker），`AGENTS.md` 只放指引；实时状态以 `find_workspace` / `get_workspace` 为准。

`system.md` 精简：去掉“每个输入结尾有 Foundry 上下文…”一段，改为 `# Where your facts come from`（本文件 + 工具 + 时间/回执块的含义），把监督、卡片、拒绝、停止的处理合并进 `# Confirmations and refusals`。`prompt.Version` 升为 `2026-11-13.1`。

### 实时状态改由工具读

- 在线电脑：`list_computers` 每行新增 `online` / `offline`（原来只在每轮上下文里有）。
- 清单：`read_list`；跟进的事：`list_tasks`（含等待哪台电脑）；等本人处理的事：`needs_you` op list；记忆全集：`read_memory`。都已存在，无需新增工具。
- `PromptInput` 不再每轮读取 tasks、list、needs-you。

### 通知只写事实（T9、T10、T17 等）

- 监督（`supervision.go`、`helper_failure.go`）：完成/失败/提问/等待/静默/卡住/连不上服务只写发生了什么、错误摘要、`[reason=… profileId=… runtime=…]`、链接；删去 “Check its evidence… / Retry once… / ask the person in plain words… / stop it if it is stuck…”。其他可用账号仍列出，并保留“只是可用性，不是切换许可；只能用角色配置允许的 fallback”这一事实性边界。
- 电脑上线：保留“排队的事会自己开始；不要重发”（幂等语义），删去后续处理指令。
- 卡片回答（`assistant.go`）：declined / applied / failed 只写结果；connector 批准保留“这次批准只覆盖再发一次完全相同的请求”这一授权范围事实。
- 提醒与每日小结（`list.go`）：只写到点的条目与记录的事实。
- 拒绝（`write.go`、`limits.go`、`operations.go`、`workspaces.go`、`assistant.go` 停止/不允许）：保留“不允许/超限/停止 + 本人在哪里改（设置链接）”，删去 “Tell them…”。`no_place_fits` 的 `next` 只剩“没建任何东西；缺什么；create_workspace 接受 deviceId；notAllowed 的电脑可在设置里允许”。
- `dispatch_item` 的 `helper.note`、`remember` 未写入的说明：只写事实。

### 工具描述（助理的 16 个工具）

只保留做什么、参数、返回状态、副作用、幂等性与服务端强制的规则（如 remember 的 quote 必须找到）。搬走的策略：remember 的“person 层只用于…”、dispatch_item 的 “Normally use default / Only when … avoid bullet”、update_list 的 “execute only for an explicit request”、needs_you 的 “so you can mention them / a retry on another account…”、remove_device 的 “Ask the person”、find_workspace 的 “call get_workspace before acting”。只改了这些工具的条目，其他工具（DEV-201 负责）未动。

### Skills（S2）

- `assistant-handoff`：新增对完成/失败/提问/静默/连不上服务/无其他账号/电脑上线通知的处理、`helper.unavailable` 与 `note` 怎么告诉本人、回执中重试的处理、needs_you 的 resolve 时机。
- `assistant-memory-and-list`：person 层的取舍、execute plan 的条件、相对时间从 receivedAt 算、到点提醒怎么说、每日小结怎么写。
- `assistant-projects`：共享账号电脑要告诉本人、no_place_fits 时不说 key:value 词。

## 取舍

- **`AGENTS.md` 现在含本人的事实**。DEV-109/196 的设计是“AGENTS.md 不含任何关于这个人的事实”（理由：文件在可能与他人共用的电脑上）。本次按编排决定改为放规则和已确认的记忆。同一台电脑上运行时的会话记录（Claude/Codex transcript）原本就逐轮保存了同样的上下文，所以这个文件不增加新的暴露面；`system.md` 仍要求助理自己的笔记不写个人事实。旧测试 `TestAgentsFileHoldsNothingAboutThePerson` 改为 `TestAgentsFileHoldsTheRulesAndConfirmedFacts`。
- **会话内的新事实**：`AGENTS.md` 在会话开始时加载。对 Codex，同一会话里续跑不会重读；会话中刚记住的事实已在对话历史里，本人在设置里改的内容要到下一次会话，或经 `read_memory` 读到。
- **项目索引放文件而不是 `AGENTS.md`**：索引上限 3,000 tokens，放进去会超过字节预算；索引是快照，路由时仍以 `find_workspace` 为准。
- **时间行留在每轮**：见上。没有其他每轮状态保留。

## 验证证据

### 体量（前 → 后）

| 项                                                            | 前                      | 后                                                       |
| ------------------------------------------------------------- | ----------------------- | -------------------------------------------------------- |
| 每轮上下文（`turn_context_full` fixture）                     | 3,531 B                 | 139 B                                                    |
| `AGENTS.md`（`agents_full`，现含规则与记忆）                  | 7,840 B                 | 7,823 B                                                  |
| `AGENTS.md`（`agents_new_person`）                            | 7,476 B                 | 6,920 B                                                  |
| `AGENTS.md` 最坏情况（2,000 字额外要求 + 40 条记忆 + 长名字） | 8,188 B（不含记忆）     | 21,570 B（上限 28,672 B）                                |
| 助理 16 个工具的 description 合计                             | 6,790 chars             | 6,533 chars                                              |
| skills（handoff / memory-and-list / projects）                | 4,544 / 3,061 / 3,187 B | 5,832 / 3,715 / 3,314 B（含 DEV-197 B1 的 handoff 改动） |

### 测试

- 新增：`TestTurnContextCarriesNoGuidance`（每轮上下文只有时间行，禁用短语清单）、`TestAgentsFileHoldsTheRulesAndConfirmedFacts`、`TestAgentsFileStaysWithinItsBudget`（≤ 7,840 B）、`TestProjectIndexIsAFileAGENTSPointsTo`、`TestAssistantToolDescriptionsStateOnlyTheirContract`（16 个助理工具的 description 不含策略短语）。
- dev 检出合并后：`go build ./...`、`go vet ./internal/personalagent/... ./internal/httpapi` 通过；`internal/personalagent/prompt` 15/15；`internal/personalagent/assistant`、`internal/personalagent` 通过；`internal/httpapi` 定向 82 个（助理、记忆、清单、监督、账号失败通知、needs-you）81 过 1 败。失败的是 DEV-202 的 `TestNeedsYouVisibilityFollowsAssistantScope` 第 124 行（`PendingFor` 不再返回 "allowed account" 条目），在本改动之前的断言、与本改动无关，已转给编排者与 B3。
- `needs_you_test.go` 原断言 `prompt.Input.NeedsYou`，改为断言 needs-you 不进每轮上下文与 `AGENTS.md`。
- `prompt.Version` `2026-11-13.1`，digest `42fb0be72eaf05d1604d26d19a91ce47312b897e8c1b5adfed8e5e469bb38754`。

### 部署

- Server：dev 检出构建，sha256 `80481a584431f3ab69105c95c0b9ef3a7ddf39a699a779376dc62d3813a255d9`，PM2 online，于二进制写入 8 秒后重启。回滚：`~/.foundry/server/releases/dev023-candidate/foundry-server.pre-dev197-b2`。本项自己的 swap 因磁盘与他项 schema 迁移协调而取消，未产生 `.pre-dev200`。
- e2e-alice 的合成 Worker（`dev152-synthetic-worker.service` 与其 execution host，从 dev 检出的 `packages/worker/dist` 运行，进程自 11-09 未重启）不认识 DEV-196 的 skill 路径，第一次真实轮次失败（"Foundry does not write .foundry/assistant-skills/… into the assistant's folder"）；确认无运行中轮次后重启这两个 user unit，加载当前 dist。

### 真实轮次（dev，e2e-alice）

会话：https://dev.foundryapp.app/chats/sess_1794507762128841444?workspace=ws_4e5616b1-f6cf-44ad-93f4-e0f3fbb08817

1. "Please remember that I prefer tea over coffee." → 原生加载 `assistant-memory-and-list` skill，`read_memory`，`remember`（scope person，引用原话）。回复："I’ve remembered that you prefer tea over coffee."
2. "Put this on my list: call the dentist tomorrow afternoon to reschedule." → `read_list` 查重后 `update_list`。回复："Added to your list: call the dentist tomorrow afternoon (November 14) to reschedule."（本人时区已是 11-13，日期正确。）
3. "What's on my list?" → `read_list`，列出 4 条未完成事项。

三轮的输入尾部都只有一行 `Now: Friday, 2026-11-13 02:2x (Asia/Shanghai).`（Codex rollout 核对）。助理目录的 `AGENTS.md` 7,420 B，含 `# The person's rules`、`# What the person confirmed`，`.foundry/project-index.md` 已生成。

限制：tea 这条写入的是本人层 vault，该 vault 在已断开的合成设备 `DEV023 synthetic Linux` 上，写入处于等待设备状态，所以尚未出现在下一次的 `AGENTS.md` 里；这是测试账号既有的 vault 位置问题，不是本项改动。

### 验收

1. 在自己的助理里开新对话说一件关于自己的事，再看助理目录 `AGENTS.md` 的 `# What the person confirmed` 在下一次对话出现它。
2. 让 helper 完成、失败、提问各一次，看通知只写事实，助理仍会核对证据、重试一次或转交提问。
3. 问“我的清单上有什么”“哪台电脑在线”，助理应调用 `read_list` / `list_computers` 回答。

## 时间线

| 时间（UTC+8）    | 变化与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 剩余动作                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 2026-11-13 02:40 | 实现、worktree 测试、合并进 dev 检出（三处冲突：DEV-202 的 `PendingFor` 块按设计删除，版本号与 digest 合并）；随合并构建上线；e2e-alice 三轮真实对话通过                                                                                                                                                                                                                                                                                                                            | 本人验收；DEV-202 的 needs-you 可见范围测试待其负责人处理 |
| 2026-11-13 04:10 | 跟进 DEV-199 B3：`needs_you` 描述改为事实（op list 返回带 deadline 的本助理事项并确认已读，10 分钟内未确认或处理则以 `assistant_timeout` 转给本人，删去 "while you run"）；`assistant-handoff` 加一行在 deadline 前 op list；`prompt.Version` `2026-11-13.2`（digest `d7f4798c…`）。prompt 15/15、MCP 17/17；Server sha256 `301323eb…` 上线，回滚 `foundry-server.pre-dev200-needsyou`。为满足 5 GiB 磁盘门槛，删除 11-12 09:19 及以前的 12 份旧 `.pre-*`，两组相同的备份改为硬链接 | 本人验收                                                  |
