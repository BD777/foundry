# DEV-090 子会话回合结束自动汇报给父会话

## 当前状态

| 环节            | 状态   | 说明                                                                                                                                                              |
| --------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 问题理解 / 调研 | 已完成 | 编排会话给出的证据，加上线上库只读测量（见“测量”）                                                                                                                |
| 代码            | 已完成 | 仅 Server：自动汇报、`reportBack` 开关、回执 `recentToRecipient`、工具说明；foundry Skill 改一句（修订 13 → 14，编排会话已认可措辞）                              |
| dev Server/Web  | 已部署 | 2026-10-30 01:40（UTC+8）与 DEV-085/091/092 合并一次 SIGHUP 交接：Server `6120e1c99759258c…`，回滚副本 `foundry-server.pre-dev085-092`（`2181e7f3…`）；Web 不涉及 |
| Worker 更新     | 不涉及 | 无 Worker 代码改动；Skill 由 Server 按修订号下发                                                                                                                  |
| Agent 自验      | 已完成 | Go 单测；本地临时栈上两轮真实 Codex 父子会话（见“自验”）                                                                                                          |
| 人工验收        | 待确认 | 见文末                                                                                                                                                            |

## 问题

编排会话 `sess_1793063405185071529` 2026-10-29 指派，负责会话 `sess_1793286475110448503`。证据来自当天的父会话 `sess_1793189579694075630` 及其子会话：约 30 分钟内子会话发出 7 条消息，平均 766 字，全部为 boundary。其中 2 条是把本人的授权转述给另一会话，2 条是两段式进度（“正在部署”/“已部署”）。另有约 10 次 `get_session` / `read_context` 轮询，原因是子会话的最终回答不会自动到达父会话。

本人的原则（DEV-079）：不约束 Agent，只告诉它 Foundry 能做什么、什么时候有用；不写限制、不写“必须”。

## 做了什么

**1. 子会话回合结束自动汇报**（`httpapi/child_reports.go`）

- 由 Agent 创建的会话（`source` 为 `agent` 或 `verification`）每结束一个回合（completed 或 failed），Foundry 就在其父会话的收件箱放一条 `turn_end` 消息。发送方记为子会话。内容为：标题、状态、出错时的错误、最终回答的前 1500 字（超出时注明总长，并写明 `get_session` / `read_context` 可读全文）、对话链接。
- 沿用 DEV-057 的收件箱与回执：父会话运行中时，消息在回合结束后进入（运行超过 10 分钟则在下一个边界进入）；父会话空闲时，消息开启新回合；多条一起到达时合并为一个回合。
- 幂等：消息 id 由子会话 id 和子会话当前输入 id 确定性生成（UUID v5），同一回合重复上报只有一条。
- 不汇报：`create_session` 传 `reportBack: false` 的子会话（HTTP `POST /api/agent-sessions` 的同名字段同样有效；记录在 `session_report_optouts` 表，随工作区删除）；父会话已删除、已归档或已被停止（canceled），或父会话由 Issue 控制；定时任务的运行（`source=chat`）；Issue 会话；助理（Personal Agent）派出的任务，助理有自己的跟进。子会话被取消也不汇报。
- 父会话已经读过：父会话对该子会话调用 `wait_session`、`get_session`，或用 `create_session` / `send_message` 的 `wait=true` 拿到已结束的结果时，这条汇报记为 `consumed`（`reason=read_by_parent`），不再投递。先读后报和先报后读两种顺序都覆盖；判断在收件箱的放置锁内完成。
- 子会话自己已交接（去重）：本回合内，子会话发给父会话的消息与最终回答文本相同（忽略空白），或者它的最后一条消息在回合结束前 45 秒内发出，就不再汇报。
- 兄弟会话汇合：父会话空闲时，汇报先等 10 秒，让同时结束的子会话合并成一个父回合。
- 每次跳过都写一行 Server 日志：`session child report skipped: … reason=…`。

**2. `send_message` 回执新增 `recentToRecipient`**：`{lastHour, boundaryOrInterrupt}`，统计本发送方最近一小时发给该接收方的消息（含本条，不计 Foundry 的自动汇报）。只提供信息，不做任何限制。

**3. 工具说明**（`mcp_tools.json`，只补充事实和适用场景，未加任何限制）：

- `create_session`：说明自动汇报的内容和时机、不必轮询、已读不重复、45 秒内的子会话消息视为该回合的交接；新增 `reportBack` 参数说明。
- `wait_session`：子会话会自动汇报，等待适用于本回合下一步需要结果的情形；在这里读过的汇报不再投递。
- `send_message`：原句 “Ordinary async Foundry children have no automatic final forwarding: send one final handoff …” 在本项上线后不再成立，改为说明自动汇报。补充两点：boundary 消息在接收方的下一步、任务进行中送达，turn_end 让对方先结束本回合；会话可以用 `read_context` 直接读另一会话中本人的原话，转述时可以给出链接。回执中新增 `recentToRecipient`。
- `read_context`：`events` 加 `labels=User message` 可逐字列出本人对该会话说的话。

**4. foundry Skill**（两份副本字节一致，修订 13 → 14，校验和 `730718e1…`）：只把上面那句已不成立的话替换为事实陈述，措辞经编排会话认可：

> Foundry reports each turn a child session ends to the session that created it: a turn_end message with its status, the first 1500 characters of its final answer and a link (create_session `reportBack: false` turns this off). The creator can carry on without polling; a child's own message is useful for what its answer leaves out.

## 测量：自动汇报与子会话自发交接的重复

只读查询线上库（`mode=ro`）。2026-10-28 15:22 至 2026-10-29 22:40，共 75 条子→父消息（另有 1 条找不到其后的回合结束）：

| 情形                                                   | 条数 | 消息到回合结束                 | 期间工具调用 |
| ------------------------------------------------------ | ---- | ------------------------------ | ------------ |
| 交接后立即结束回合（最终回答几乎是同一内容的另写一遍） | 47   | 5.5–24 s                       | 0–1          |
| 中途消息，之后还有工作                                 | 28   | 82 s 至 3.3 h（多数 > 15 min） | 2–566        |

- 文本完全相同：0 条。75 条中相似度最高 0.45，子会话的最终回答通常是给人看的改写版本，所以只按文本去重一条也去不掉。
- 因此去重同时按时间：最后一条子→父消息在回合结束前 45 秒内发出即视为交接，可以覆盖 47 条中的 47 条；28 条中途消息全部 ≥ 82 s，不受影响。

## 检查

- Go：`child_reports_test.go` 共 7 个测试：
  - 每个输入汇报一次，重复上报不新增，下一回合再报一次；
  - 长回答截断；
  - opt-out、父会话被停止、父会话已归档、定时运行，四种情形均不汇报；
  - 去重：同文本、45 s 内的交接都去掉，回合早段的进度消息保留汇报；
  - 父会话已读：他人读取不影响；先报后读、先读后报都记为 consumed；
  - 兄弟汇合：两个子会话的汇报在等待期内保持 held，等待结束后合并为父会话的同一个新回合（“Message 2 of 2”）；父会话的这个回合不向子会话发送任何消息，父会话结束后两个子会话的收件箱仍为空；
  - `recentToRecipient` 计数：最近一小时 3 条，其中 boundary/interrupt 2 条；两小时前的 1 条和自动汇报都不计入。
- `go test ./internal/httpapi ./internal/sqlitestore ./internal/store`（相关子集）、`builtinskills` 通过；Worker `foundry-skill.test.mjs` 通过（两份 SKILL.md 字节一致）。
- 干净 worktree（`d4537b1` + DEV-085 + 本项补丁）全量 `go test` httpapi/store/builtinskills/sqlitestore：只有 `TestSessionObserversReactInOrderAfterViewers` 失败，原因是新增观察者后该测试的期望列表没有同步。已补上 `childReportReactions`（`events_sessions_test.go`），单独重跑通过。
- 共享树 `scripts/check-changed.sh`：prettier、gofmt、sqlitestore、store、audit:contract 通过；httpapi 在高负载下达到 20 分钟超时（超时时正在建测试库，不是断言失败）；audit:modules 只报 DEV-091 进行中的 `cloudflare_callback_page.go`，不属本项。

## 自验（真实模型，本地临时栈）

- 环境：`scripts/scratch-stack.sh`，`SCRATCH_SOURCE_DB` 指向一个空库（不复制线上库：当时磁盘只剩约 9 GiB）；本机 Worker（本地 dist），Codex 本地登录，reasoning low；临时工作区 `/tmp/dev090/ws`。验后整栈删除。
- **第一轮**（父 `sess_1793288092431864974`）：父会话按提示调用一次 `create_session` 后，以 PARENT-STARTED 结束回合，期间只读了一次 Skill 文件，没有调用 `get_session`、`wait_session` 或 `read_context`。子会话 15:35:23（UTC）回答 `CHILD-OK 42`。15:35:24.09 汇报进入父会话收件箱，15:35:24.12 开启父会话新回合，父会话回答 `REPORT-SEEN CHILD-OK 42`。收件箱记录 delivered_as=turn，随后 consumed。
- **第二轮：兄弟汇合与来回检查**（父 `sess_1793288331901128311`）：父会话一次创建 3 个子会话。临时设备逐个执行，三个子会话相隔约 10 s 先后结束：
  - sib 1 的汇报等满 10 s 后单独开启一个父回合（sib 2 的汇报晚到 14 ms）；
  - sib 2 和 sib 3 的汇报在该回合结束时合并为一个回合（“Foundry held 2 messages …”）；
  - 父会话在第一个汇报回合中向 sib 1 发送 turn_end 消息；sib 1 回答 AGAIN-OK，汇报回到父会话，父会话回答 DONE 后结束，没有再发任何消息。
  - 共计 3 个子会话的初次结束产生 2 个父回合，加上 1 次往返的 1 个父回合，没有来回循环。
- **来回为什么不会循环**：汇报只沿创建关系由子到父；父会话的回合结束时，只有它自己也是某个会话的子会话，才会向上汇报给它的父会话，不会发给子会话。若父会话用 `send_message wait=true` 拿到子会话的结果，那条汇报记为已读，不再投递。

## 部署（2026-10-30 01:40 UTC+8）

- 构建：干净 worktree `d4537b1` 依次应用 DEV-085、DEV-090、DEV-091、DEV-092（v1 + v2 增量）的补丁，不含共享树中其他会话未完成的改动。四项合并后全量 `go test`（httpapi、store、builtinskills、sqlitestore、externalaccounts、connectors）通过；应用 DEV-092 v2 后，重跑 connectors、store、externalaccounts、sqlitestore 和 httpapi 相关子集，均通过；`go vet ./internal/...`、gofmt 通过。
- 交接：线上 `releases/dev023-candidate/foundry-server` 原为 `2181e7f3…`，先硬链接为 `foundry-server.pre-dev085-092`，再原子替换为 `6120e1c99759258c1c1c3081b507582d4f1f01fc29688508df8c41daaf736bd9`。之后向 supervisor 发 SIGHUP：新进程 3.2 s 就绪，旧进程 3.3 s 后退出；`/proc/<pid>/exe` 校验和一致，`/healthz` 200。7 台设备在 10 s 内全部重连。迁移已建 `session_report_optouts`，以及其他三项的新表。
- 自验：本会话就是编排会话的子会话，本回合结束时线上会走一次自动汇报（若最终交接消息在回合结束前 45 s 内发出，则按去重规则跳过）。

## 限制

- 同时结束的判断依赖 10 s 汇合窗口。相隔超过 10 s 先后结束的子会话，最多再多出一个父回合：父回合运行期间到达的汇报，会在该回合结束时合并。
- 45 s 交接窗口是启发式规则：子会话先发“正在部署”，部署在 45 s 内完成并结束回合时，父会话收不到“已部署”的那份最终回答。实测 75 条中没有这种情况。
- 设备异常导致的失败（Server 恢复逻辑标记的 failed）同样汇报；被取消的子会话不汇报。
- 汇报只针对 Agent 创建的会话。本人在子会话里直接对话时，该回合结束同样会汇报给父会话。
- 工具说明和 Skill 只陈述能力，没有加入任何约束 Agent 行为的规则。

## 流水

| 时间（UTC+8）    | 变化与证据                                                                                                | 剩余动作                       |
| ---------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 2026-10-29 23:10 | 接手；只读测量线上库：75 条子→父消息，文本相同 0 条，交接型 47 条（≤24 s）                                | 实现                           |
| 2026-10-29 23:35 | 实现与单测通过；临时栈第一轮真实运行通过；向编排会话提交 Skill 措辞                                       | 编排确认                       |
| 2026-10-29 23:40 | 编排会话认可措辞，要求补两项检查：兄弟汇合、无来回循环。新增 10 s 汇合与对应测试；临时栈第二轮通过        | 与 DEV-085/091 合并重启 Server |
| 2026-10-30 01:40 | 与 DEV-085/091/092 合并部署，Server `6120e1c9…`（SIGHUP，回滚 `foundry-server.pre-dev085-092`），见“部署” | 人工验收                       |

## 人工验收步骤

1. 在任一自己的对话里让 Agent 用 `create_session` 开一个子会话，做件小事（如“回复 OK”），并说明不必等待。预期：子会话结束后几秒到十几秒，父对话出现一条以 “Foundry report: session sess_… finished a turn: completed.” 开头的消息，含最终回答和链接，Agent 随即继续；期间它没有调用 `get_session` 或 `wait_session`。
2. 让 Agent 创建子会话时传 `reportBack: false`。预期：子会话结束后父对话没有汇报。
3. 让 Agent 用 `wait_session` 等子会话结束。预期：等待结果正常返回，之后不再收到同一回合的汇报。
4. 让 Agent 给某会话发两条 `send_message`。预期：第二条的回执里 `message.recentToRecipient` 为 `{"lastHour": 2, "boundaryOrInterrupt": …}`。
