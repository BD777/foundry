# DEV-101 · Foundry MCP 瘦身第 1 轮：不再阻塞等待会话，工作状态不再每次工具调用都注入

状态：第 1–4 轮已部署 dev，并已提交合入 main（PR #163，`e880c37a`，2026-10-30 23:55 UTC+8；本人授权“把当前本地的所有改动都先提交并合入”）。Agent 自验通过。人工验收待确认。后续“回归 Agent 原生用法”见 [DEV-105](DEV-105-native-agent-conformance.md)。

## 问题

- 截图：14:36 本人问进度，编排会话把进度写成一条中途旁白，然后 `wait_session(timeoutMs=600000)`；14:46 超时（服务器返回 409，界面显示 “Tool failed”），它又调一次。这一轮一直挂着，本人再发的消息要等工具调用结束才被读到。
- 10 月以来（本机 dev 库）：`wait_session` 成功 16 次、失败 38 次（几乎都是超时），8 个会话；`create_session` 带 `wait=true` 15 次，`send_message` 带 `wait=true` 9 次。
- Claude 会话里，“Foundry persistent work state …” 每轮出现两次（回合提示前缀 + UserPromptSubmit hook），每次工具调用前后各一次；没有任何持久工作时也照发（约 600 字）。

## 原因

1. 三处 `timeoutMs` 的描述都写着 “If the session is still running when it elapses, call wait_session again.”，第二次调用就是照这句做的；超时又以错误返回。
2. `wait_session` 的描述只说“下一步需要结果时有用”，没说不该为了转告人而等；`create_session`/`send_message` 的 `wait=true` 让“同步等结果”成为常规用法。
3. **更正此前的分析**：回合报告（DEV-090）只发给**创建者**。截图里的 DEV-093 会话 `…6687` 是原会话 `…1529` 创建的，所以它的报告进了 `…1529`（05:48、07:01 两次），没有进正在等的交接会话 `…8129`；`…8129` 是在 07:02 收到 `…6687` 按任务说明主动发来的消息才知道结果。也就是说，对交接接手者来说，Foundry 没有保证的唤醒信号，`wait_session` 是它唯一“确定”的办法。
4. 工作状态 hook（`claude-runtime-start.ts`）在 UserPromptSubmit、PreToolUse、PostToolUse 都无条件注入。

## 修复

MCP（`apps/server/internal/httpapi`）：

- `wait_session` 只在 **Issue 执行会话**的 tools/list 中出现（`mcpToolListed`）：它的回合结束就是运行结束，确实需要在回合内等协作会话。其他会话（聊天、子会话、验证者、助手）看不到它；模型只能调用看到的工具。直接 `tools/call`（`foundry session wait` CLI、人）仍然可用，DEV-100 的排空分支保留。Foundry Skill 页按同一规则显示角色。
- 删除 `create_session` 和 `send_message` 的 `wait`、`timeoutMs`（以及服务端的等待分支、`waitMCPTerminal`）；对应的限制说明 “Waiting lasts at most 10 minutes per call.” 删除。
- 描述改为：回报会开始你的下一轮，所以结束本轮而不是等；不是你创建的会话（交接留给你的、同级的）只向它的创建者回报，要在消息里请它把结果发给你。
- `get_session_work` 删除（与 `list_session_work` 是同一处理函数）；`list_session_work` 增加 `id`（含执行历史）；`read_context` 去掉 `scope=work`。CLI `foundry work show` 改走 `list_session_work`。

Worker：

- `sessionWorkContext(items, barrier, quiet)`：`quiet` 时没有未完成项、没有停止屏障、没有未分类进程就返回空串；`workContext()` 用 quiet。
- Claude hook：UserPromptSubmit 不再注入（回合提示已带），只记下已展示内容；PreToolUse/PostToolUse 只在内容**变化**时注入，从有到无时注入一句 “nothing outstanding now”；PostCompact 只在有内容时重放。Codex 路径（只在压缩时注入）本来就判空，不变。
- CLI：`session create`/`session send` 去掉 `--wait`、`--timeout-ms`；`session wait` 不变。

Foundry Skill（两份字节相同，修订 15）：“要用子会话的结果，结束本轮，让回报唤醒你；不要为等一个会话把回合挂着，尤其在聊天里”；“不是你创建的会话只向它的创建者回报，要在消息里请它把结果发给你”。

文档：`session-orchestration-design.md`、`session-work-management-design.md`、`personal-agent.md` 同步；`scripts/live-session-regression.mjs` 六个用例改为“结束本轮、等回报/消息开始的下一轮”（新 `settleWhen`）。

## 第 2 轮（本人决定：删 `wait_session`，Issue 里也不用；交接不特化，只留最基础的能力）

- 删除 `wait_session`（MCP、处理函数、`waitMCPStatuses`、CLI `session wait`）与 `handoff_session`（MCP、`handoffPrompt`、CLI `session handoff`）。接续一个会话就用 `create_session` 带上所需事实；描述、Skill（修订 16）、系统提示里的委派说明、助手提示（`prompt.Version` `2026-10-30.1`，删去已失效的 handoff 两句）同步。
- ~~Issue 执行会话不再有 `create_session`~~（21:45 撤回，见下）。
- DEV-100 的排空：`wait_session` 删除后，排空测试只保留事件流用例；`restartingNotice` 删除。剩下两个长轮询 `feishu_events`（`wait`）与 `acquire_resource`（`waitMs`）本来就不听排空信号，留给下一轮（两者都在候选清单里）。
- 第 1 轮的“待决定”随之取消：不做交接特化，也不改挂子会话；非创建者的会话靠消息里请对方回发结果。
- 自验：`check-changed`（42 个文件）通过，`audit:modules` 除外：它报的 `runner/codex-compatibility` 是另一会话（Codex 0.166 修复）的新文件。服务端全量测试中 `TestChatQueueCoversSessionsAnotherSessionStarted`（DEV-095）满载时失败一次，单独连跑 3 次通过；其余全部通过。线上 `GET /api/builtin-skills/foundry`：40 个工具，无 `wait_session`/`handoff_session`，`create_session` 角色为 session 与 personal_agent，Skill 修订 16。
- 部署：
  - Server：17:58:08 先部署了 `da4c81c8…`，误把另一会话（`sess_1793353072012341166`，正在放开 Agent 归档原生对话的限制）未完成的 `chat_archive.go`、`mcp_archive.go`、`policy.go` 一起带上线；17:59:08 改用这 3 个文件为 HEAD 的副本构建 `d3cac98a8c…` 重新部署（交接 452 ms）。这一分钟内 `chat_archive_events` 无记录；已告知该会话。回滚副本：`foundry-server.pre-dev101`（第 1 轮之前的 `95e6f102…`）、`foundry-server.pre-dev101b`（第 1 轮 `797e3fb5…`）。
  - Worker：`.1793353383`，在 `foundry-dev085b` worktree 打包。另一会话已在该 worktree 加入 Codex 修复并发布 `.1793349927`（含本项第 1 轮），本次在其上加入第 2 轮文件；`release.before-dev101b.json` 为上一版。
- 18:09:56 会话 `sess_1793353072012341166` 从共享树部署 `da4c81c8…`：含本项第 2 轮，以及它已完成的原生对话归档改动（回滚副本 `foundry-server.pre-native-archive` = `d3cac98a…`）。之后的部署都要从共享树构建，包含这些文件。
- 21:45 按本人原则复查（不覆盖 Agent 原有能力、不啰嗦、不多占上下文；Foundry 该有的基本能力保留）：撤回“Issue 执行会话不给 `create_session`”这条自加的限制（本人只说 Issue 里不用 `wait_session`）。Server `e5716ad0…`（基于线上 `da4c81c8…` 仅改 `mcp.go`，回滚副本 `foundry-server.pre-dev101c`）。Issue 执行会话派出的会话仍不会把结果交回这次运行（DEV-090 不向 Issue 角色回报）。
- 教训：部署前列出的“自上次部署以来改动的文件”出现了别人的文件，我没有停下核对就部署了。今后有非本项文件时先查归属，不一起上线。

## 第 3 轮：只减啰嗦和上下文占用，不删能力（本人原则：不覆盖 Agent 原有能力、不过度啰嗦、不多占上下文；基本能力保留）

**依据。** 10 月以来 1444 份原生记录里 Foundry 工具返回的大小：`send_message` 中位 5.9KB × 1369 次 ≈ 8.0MB（每次回传整条会话记录，原始提示出现两遍）；`create_session` 中位 5.5KB；`get_session` 中位 7.0KB、p90 23KB，`read_context` summary 中位 24KB（夹着全部已结束的后台工作）；`list_resources` 中位 10KB、p90 46KB；`read_context` thread 把整段会话 JSON 在 12KB 处截断，既无法往后读，也不是合法 JSON。业界做法：Anthropic《Writing effective tools for agents》（大结果组合分页、范围、过滤、截断并给合理默认；`response_format` concise/detailed；截断时告诉 Agent 怎么取更多；返回高信号信息），MCP 规范的不透明游标分页（`nextCursor`），Claude Code 对 MCP 输出 10k token 告警、默认上限 25k。

**改动（服务端）：**

- 写操作只回简报：`create_session`、`send_message`、`cancel_session` 返回 `{id, title, status, source, error, provider, profile, model, workspaceId, parentSessionId, inputId}`，加上送达附件、设备离线说明和消息回执；不再回传会话记录。
- 摘要里的持久工作只列未结束项（每项一行，最多 10 条）和已结束数量，记录本身由 `list_session_work` 读。
- `read_context scope=thread`（原生对话为 `transcript`）改为对话本身：用户消息、回答与 commentary，不含工具调用；默认最新一页 20 条，`offset`/`limit` 翻页，每条按 `maxChars`（默认 2000）截断并给出原长，整页在 `maxBytes` 内，返回 `earlier`/`later` 告诉下一页怎么读。
- `scope=file` 与带 `path` 的 `changes`（diff）按行读：`offset`（从 1）、`limit`（默认 400 行，至多 2000），在行间截断，头部写明行号范围与下一页 `offset`。
- `list_resources` 默认简洁：每个实例只给类型、状态、未就绪原因和持有者；`detailed: true` 再给 backends、details、operations、lastSeen。旧式 `resources` 列表照旧（老 Worker 只有它）。
- 工具回答的 JSON 不再把 `< > &` 转义成 `\u003c` 之类。
- 撤回第 2 轮“Issue 执行会话不给 `create_session`”（见第 2 轮）。

**描述与 Skill：**

- 普通聊天可见工具的定义 46KB → 31KB：描述只写做什么、参数和限制，协作礼仪与选择建议只留在 Skill 里一份（`send_message` 6.1K → 2.2K，`create_session` 7.0K → 3.8K）。`operate_resource` 的 cua-driver 操作参考与 Cloudflare 权限级别是接口文档，只轻删。
- foundry Skill 12KB → 5.1KB（修订 17）：去掉与工具描述重复的“事实”“持久工作”段和助手工具清单；frontmatter 描述（每个会话的技能列表都带）约 1000 → 580 字符，保留触发词（各类 id、`/chats/`、“what they changed”）。

**自验：**

- `check-changed` 通过（`audit:modules` 除外：报的是另一会话的 `runner/codex-compatibility`）；`httpapi` 全量一次失败 `TestListResourcesFollowsReach`（简洁模式隐藏了旧式 `resources`，已改为始终保留），修复后相关测试通过；新增 `TestConversationPagesWhatWasSaid`、`TestLineWindowPagesAFile`。
- 真实端到端（e2e-alice 的 DEV-048 合成设备 Worker 临时运行，构建与发布包相同；Claude low）：会话 `sess_1793370124237563217` 读一条 30 条消息的合成会话：`limit=4` 得到 26–29，按 `earlier` 读到 22–25；两次返回 1079 / 913 字节；`create_session` 返回 333 字节；随后被子会话回报唤醒，回答 `CHILD=OK`。两条合成会话已归档，合成 Worker 与执行宿主已停止。

**部署：** Server `d40f255f…`（22:20）与 `6d4cb3c1…`（22:29，JSON 不转义）；回滚副本 `foundry-server.pre-dev101d`（`e5716ad0…`）。Worker `.1793370045`：`foundry-dev085b` worktree 加入 Skill 修订 17（worktree 自上次打包以来无他人改动），`release.before-dev101c.json` 为上一版。

**还可以做（未做）：** 所有工具回答改为不缩进的紧凑 JSON（约省两到三成字节，要改约 1300 处测试断言）；`list_sessions` 默认页大小；助手专属 12 个工具的描述；系统提示里的委派说明与 Skill 去重。

## 第 4 轮：助手工具描述，以及 Foundry 往系统提示里加了什么

- **助手专属 12 个工具：** 定义 20.5KB → 14.4KB。描述只写接口；确认被删的行为规则（确认卡片怎么跟人说、`no_place_fits` 时只问一个白话问题、不因“上次用过”选项目、引用须是本人原话、密码等不存、先改再加、会话结束不等于完成）都已在助手自己的系统提示 `personalagent/prompt/system.md` 里，未改该提示。
- **紧凑 JSON：** 实测 10 月以来工具返回 19.7MB 缩进 → 18.0MB 紧凑，只省约 9%（`send_message`、`create_session` 各 3%：体积在内容，不在空白），且网页里人看工具详情时缩进更好读；不做。更正第 3 轮“要改约 1300 处测试断言”的说法：那是对所有测试文件里 `": "` 的粗略计数；真正按缩进 JSON 文本做 `strings.Contains` 的断言约 22 处，其余测试都先解析 JSON 再比字段。
- **Foundry 追加到系统提示的内容**（Claude 的 appended system prompt、Codex 的 developer_instructions，每个工作区会话都有）：
  1. 设备说明（约 2KB）：本机浏览器、附件位置、注册服务、飞书 profile 等环境事实，以及引用文件路径的格式要求。保留。
  2. 委派说明（1.4KB，DEV-027 于 2026-10-20 加入）：何时自己做、何时用原生子代理、何时开 Foundry 会话。纯行为引导，与 Skill 重复。**已删除**（`delegation-instructions.ts`，模块审计登记同步删除），DEV-027 记录已追加说明。
  3. Skill 策略与目录（约 12KB）：每个 skill 一条 JSON（名称、描述、路径），约 2.5KB 规则文字；工作区有草稿 skill 或排除项时还写明“原生子代理已禁用”，并下发 Claude `disallowedTools: [Agent, Task]`、Codex `multi_agent=false`。**待本人决定**，见下。
- 自验：`check-changed`（worker 18 个测试文件、prettier、contract）通过，`audit:modules` 只剩另一会话的 `runner/codex-compatibility`；httpapi 工具与助手相关测试通过；新包 dist 中无 “Foundry delegation”。
- 部署：Server `d4a74eb5…`（22:40，只改 `mcp_tools.json`）；Worker `.1793371252`（`foundry-dev085b` worktree 自上次打包无他人改动；`release.before-dev101d.json` 为上一版）。

### 待决定：Skill 目录与原生子代理禁用

- Claude 的原生 skill 列表已经列出这些 skill（名称与描述），Foundry 的 JSON 目录对 Claude 是重复的；Codex 关掉了原生 skill 说明（`include_instructions: false`），目录是它唯一的列表。建议：Claude 只留两三句必要规则（草稿怎么建、怎么刷新），去掉 JSON 目录；Codex 保留目录但只放名称、描述、路径。
- 只要工作区里有草稿 skill，该工作区所有会话都失去原生子代理（本会话就是如此：没有 Agent/Task 工具）。原意是保证 Skill 试用（with/without skill 对照）不被原生子代理绕过。建议：只在 Skill 试用会话（带 `skillSelection` 创建的）里禁用，普通会话保留原生子代理。这会改变 Skill 隔离的保证范围，需要本人决定。

## 第 1 轮的待决定（已由第 2 轮取代）

交接（`handoff_session`）后，原会话的子会话仍然向原会话回报。两种做法：

- A（推荐）：交接时把原会话的子会话改挂到接手者名下，回报自然到接手者，仍是一棵树、不会互相唤醒。会改变聊天列表里的父子关系。
- B（本轮已落地的部分）：不改血缘，靠描述和 Skill 让接手者在消息里请对方回发结果。

试过第三种“回报给发起本轮的会话”：同级之间、子会话主动回消息给父会话时会互相唤醒（A 问 B，B 回消息，A 的回合报告又发给 B……），已撤回，未部署。

## 自验

- `scripts/check-changed.sh`（本项 26 个文件）全部通过：prettier、gofmt、protocol 构建与测试、web tsc、worker 构建与 20 个测试文件、httpapi 60 个相关测试、builtinskills、audit:contract。
- 服务端全量 `go test ./...`：除 `httpapi` 外全部通过；`httpapi` 单独以 `-timeout 30m` 重跑通过（659.6 s；默认 10 分钟超时下与其他检查并发时会超时）。
- 新增/改动的测试：`sessionWorkContext` quiet 模式；Issue 执行会话的 tools/list 有 `wait_session`、聊天和验证者没有，直接调用仍可用；Skill 页角色；`list_session_work` 带 `id`；CLI 参数；`codex-app-server` 压缩后刷新改为种入一个暂停的计划（没有工作就不 steer，旧用例的假 Codex 只在收到 steer 时结束回合，会一直挂起，另一个会话 `sess_1793346287514873412` 也碰到并跳过了它）。
- `foundry-cli.test.mjs` 在并发跑 20 个文件时出现过一次空请求体（`Unexpected end of JSON input`），单独连跑 3 次都通过，重跑整套也通过，视为负载下的偶发问题，未深究。
- 线上只读核对（e2e-alice，密码只由脚本读取，验后登出）：`GET /api/builtin-skills/foundry` 共 42 个工具，`wait_session` 角色只有 `issue_execution`，没有 `get_session_work`，`create_session`/`send_message` 不再有等待限制，Skill 修订 15，内容含新段落。
- 真实端到端（e2e-alice 的 DEV-048 合成设备 Worker 临时以 `systemd-run --user`（`dev101-dev048-worker`）运行，构建与发布包相同；合成工作区 `ws_d4da0f57-…`；Claude 外部连接，low）：
  - 编排会话 `sess_1793349190454482438` 看到 27 个 Foundry 工具，没有 `wait_session`、`get_session_work`；调用一次 `create_session` 后立即结束本轮（`CHILD=sess_1793349199877340448`）；20 s 后被子会话的回报唤醒，回答 `CHILD-SAID=CHILD-OK`。
  - 它的原生记录里，两轮、4 次工具调用，工作状态出现 0 次；对照本会话（旧 Worker）的原生记录：695 次提及、386 个 hook 附件。
  - 再让它后台启动 `sleep 25`，接着两次普通 Bash：工作状态只在后台命令出现后注入一次（1 项 running），后两次工具调用没有重复。
  - 清理：两条合成会话已归档（`arch_01a18bf3-…`）；合成 Worker 单元及其执行宿主 `foundry-execution-2f24728fc1335ada` 已停止；临时脚本目录已删除。

## 部署

- Server（2026-10-30 16:30:08 UTC+8，SIGHUP）：从共享树构建（HEAD `a0ba354` + 已上线的 DEV-085 r4、DEV-095、DEV-096、DEV-099、DEV-100 + 本项；部署前核对 `apps/server` 自 DEV-100 部署以来只有本项改动）。sha256 `797e3fb5dfe71034d9eb424c61ed7f69ef7cf573824d542270ce25bbd0b933c7`；回滚副本 `releases/dev023-candidate/foundry-server.pre-dev101`（`95e6f102…`）。新进程 16:30:11 接管，旧进程 627 ms 后退出（`<nil>`）；`/healthz` 200。无数据库迁移。
- Worker（16:31）：`0.5.7-dev.168.ga0ba354a.local.1793349062`，在 `foundry-dev085b` worktree 打包：它与上一版发布包 `.1793343579` 的源码一致，加入本项的 Worker/协议/Skill 文件。**不含**共享树里另一个会话尚未发布的 Codex 0.166 网关修复（`codex-app-server.ts`，`sess_1793346287514873412`）；已核对新包有本项改动、没有 `codexProviderArguments`，Skill 与服务器副本字节相同。上一版 `release.json` 备份为 `worker-packages/release.before-dev101.json`，旧包保留。本机（dev 服务器设备）以 `systemd-run --user` 执行 `foundry-worker update`：daemon 已为新版本；正在跑本会话的执行宿主空闲后切换，没有强停。其他设备空闲时自行更新。
- Web：不涉及（Skill 页从 API 读取）。

## 限制

- 部署这次修复的那一次 SIGHUP 交接中，旧进程仍是旧行为（DEV-100 已说明）。
- 运行中的会话要等其执行宿主加载新 Worker 后，hook 才变安静；tools/list 在会话下一次连接 MCP 时生效。
- 不是 Agent 创建的会话、Issue 角色会话、定时运行仍不回报（DEV-090 原规则）。

## 验收步骤（给用户）

1. 在一个聊天里让 Agent 派一个子会话做事，然后问它“做完了没”。预期：它回答进度后结束本轮（不出现 `mcp foundry wait session`）；子会话结束后，它被回报唤醒并告诉你结果。
2. 在任意 Claude 会话里展开过程列表或工具详情。预期：没有后台工作时，不再出现 “Foundry persistent work state … 0 outstanding work item(s)”；启动一个后台命令后出现一次，状态变化时再出现。

## 流水

| 时间（UTC+8）    | 变化与证据                                                                                                                                    | 剩余动作                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 2026-10-30 14:50 | 分析截图会话与工具调用统计；本人同意先做第 1 轮（阻塞与镜像类、工作状态 hook）                                                                | 实施                            |
| 2026-10-30 15:20 | 与 DEV-100（同时在改 `mcp_sessions.go`、`drain*.go`）约定顺序：先做 Worker、Skill、文档，服务端在它结束后合入                                 | 等 DEV-100                      |
| 2026-10-30 15:45 | 发现回报只发创建者（更正原因 3）；试“回报给发起者”有互相唤醒风险，撤回；改为描述/Skill 说明 + 待决定的方案 A                                  | 本人决定 A/B                    |
| 2026-10-30 15:50 | DEV-100 交还文件；服务端补丁合入共享树，构建与 vet 通过                                                                                       | 全量测试、部署                  |
| 2026-10-30 16:25 | check-changed 与服务端全量测试通过（见“自验”）                                                                                                | 部署                            |
| 2026-10-30 16:31 | Server `797e3fb5…` SIGHUP；Worker `.1793349062` 发布，本机 daemon 更新                                                                        | 端到端                          |
| 2026-10-30 17:20 | 本人决定删除 `wait_session`、`handoff_session`；实施第 2 轮                                                                                   | 自验                            |
| 2026-10-30 17:59 | 第 2 轮部署（含一次误带他人文件的部署与 1 分钟后的纠正，见“第 2 轮”）；线上核对通过                                                           | 人工验收                        |
| 2026-10-30 21:45 | 按本人原则复查，撤回 Issue 执行会话的 `create_session` 限制；Server `e5716ad0…`                                                               | 第 3 轮                         |
| 2026-10-30 22:29 | 第 3 轮：描述与返回瘦身、thread/file/diff 分页、list_resources 简洁默认、Skill 修订 17；Server `6d4cb3c1…`、Worker `.1793370045`；端到端通过  | 人工验收                        |
| 2026-10-30 22:40 | 第 4 轮：助手工具描述 20.5KB → 14.4KB，撤下系统提示里的委派说明；Server `d4a74eb5…`、Worker `.1793371252`                                     | 本人决定 Skill 目录与子代理禁用 |
| 2026-10-30 23:55 | 本人要求提交合入：干净 worktree 内 `pnpm format`、`pnpm verify` 通过；PR #163 两次 CI 通过后合入 `e880c37a`。另一会话进行中的设备页改动未带入 | 人工验收                        |
| 2026-10-30 16:40 | 真实 Claude 端到端通过（不等待、靠回报唤醒；工作状态只在变化时注入）；清理合成环境                                                            | 人工验收；A/B                   |
