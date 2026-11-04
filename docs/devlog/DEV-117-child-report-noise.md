# DEV-117 子会话汇报降噪

## 当前状态

| 环节            | 状态   | 说明                                                                                                                                    |
| --------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 问题理解 / 调研 | 已完成 | 编排会话 `sess_1793764358364457763` 的只读取证，见“问题”                                                                                |
| 代码            | 已完成 | 仅 Server：`httpapi/child_reports.go`、`mcp_inspect.go` 及其测试，`mcp_tools.json` 中 `create_session` / `create_scheduled_work` 的说明 |
| dev Server/Web  | 已部署 | A：Server `44cf7e078fd1a514`（16:03 UTC+8）；B、C：Server `e6a1afff19d6138c`（16:30 UTC+8），均为 SIGHUP 交接；Web 不涉及               |
| Worker 更新     | 不涉及 | 无 Worker 改动；foundry Skill 不改                                                                                                      |
| Agent 自验      | 已完成 | Go 测试；dev 上真实 Claude 父子会话，见“自验”                                                                                           |
| 人工验收        | 待确认 | 见文末                                                                                                                                  |

## 问题

2026-11-04 本人指出编排会话 `sess_1793764358364457763`（工作区 ccm-omh-integration）一直被子会话的回报打断。05:08–07:05 共 69 条子会话消息、15 条本人消息；每条子会话消息都开启一个编排回合，编排会话几乎每次都向本人转述一次。

其中 Foundry 自动回合汇报 10 条，9 条没有用处：

- 5 条是子会话定时检查的心跳（“仍有 3 running”）。定时 prompt 写明“不向协调重复发心跳”，子会话也没有发消息，汇报来自 Foundry 自身。
- 2 条已过期（#138、#166）：子会话回合结束时，编排会话的新指令已在它的收件箱里排队，汇报的仍是旧状态，编排会话要再用一个回合解释“这是收到批准前写的”。
- 2 条没有新内容。

当场给本人的分析与方案（P1–P5）记录在该次对话中。本人先指示“先做确定没有副作用的”（A，过期汇报，即 P2），随后指示“1 和 2 都做”（B，定时回合不汇报，即 P1；C，`read_context` 合并流式片段）。待本人决定：P3 空闲父会话的 turn_end 摘要窗口；P4 定时任务的确定性检查命令；P5 Web 折叠由其他会话触发的回合。

## 做了什么

### A. 过期的汇报并入下一份

`reportChildTurn` 在现有的跳过判断之后，再检查一项：父会话发给该子会话的消息，本回合有没有读到。

- 判定为过期：父会话的消息仍待投递（held / accepted / unknown），或者在本回合开始后作为另一个回合的输入投递。由人或其他会话发来的消息不算。本回合已 steer 读到的消息、以及本回合本身的输入都不算。
- 过期的汇报不单独投递：写入父会话收件箱，直接记为 `consumed`，`reason=superseded`。Server 日志写 `session child report superseded: …`。
- 不丢内容：该子会话下一份投递的汇报，末尾附上此前连续过期的汇报，按时间先后排列，最多附 3 份，每份最多 600 字，去掉标题和链接。超过 3 份时写明省略了几份，并提示用 `read_context` 读取。
- `create_session` 工具说明补一句事实：回合结束时，如果你更新的消息还在等，这个回合的汇报会放在那条消息开启的回合的汇报里。

为什么不会少信息：父会话的消息在排队，子会话一空闲，收件箱就会用这条消息开启下一回合；那个回合结束时汇报，附带过期的那份。父会话因此少开一个回合，没有任何内容被丢掉，只是晚到一个回合。

### B. 子会话自己的定时回合不汇报

- `childReport` 新增跳过条件：本回合的输入是定时触发的（`Input.TimerFire` 不为空），包括 Foundry 定时任务以 `continue_thread` 续接，以及设备因原生定时器到点恢复会话。日志原因为 `a timer started the turn`。
- 例外：如果父会话的消息到达了这个回合，照常汇报。到达的方式有两种：作为本回合的输入（`DeliveredInputID` 等于本回合输入），或在本回合开始后被 steer 进来、状态为 delivered/consumed。steer 不记录回合 id，所以按送达时间判断。
- 子会话的其他回合照常汇报。`target: new_session` 创建的会话原本就不汇报（`source=chat`）。
- 契约：`create_scheduled_work` 说明这样的回合不会汇报给创建者，有消息时用 `send_message`；`create_session` 从父会话的角度说明同一事实。foundry Skill 的原话（“its turn_end report starts your next one”）对结果仍然成立，所以没有改动，也没有升修订号。
- 取舍：子会话等到条件满足、做完事以后，如果没有发 `send_message`，父会话不会收到通知。这个回合的结果仍可在 `list_session_work` 的运行记录和子会话对话里看到。本人已知悉，并决定做。

### C. `read_context` 的对话视图合并流式片段

- 进行中的回合，Codex 的解说和回答以累积快照保存，每一版是一个事件，同一消息 id 各版的文本逐步变长；回合结束后，压缩会把它们合成一条。Web 本来就按消息 id 合成一行显示（`mergedKey`、`processDisplayRows`），但 `scope=thread` 把每一版都列成一条消息。编排会话读运行中的子会话时，会读到大量重复片段，例如 `sess_1793772246673945684` 在回合中显示 218 条，结束后为 58 条。
- `sessionConversation` 按 `kind:id` 合并 commentary/assistant 快照：位置取第一版，文本和时间取最后一版。`events` 视图不变，仍逐条列出。

## 限制

- 父会话的消息如果最终投递失败（子会话在这期间被归档，或设备离线超时），下一回合不会发生，过期汇报只留在库里，仍可用 `read_context` 读到。
- 下一份汇报如果因为“父会话已读”（`get_session`）或“子会话自己已交接”被跳过，附带的过期内容也不再投递。这两种情况下，父会话或子会话都已直接处理了最新状态。
- A 的判定读的是子会话收件箱中自本回合开始前 1 小时起的 200 条消息；附带内容读的是父会话收件箱最近 24 小时内的 500 条消息。
- B：Claude 子会话在同一进程内由原生定时器继续的回合，如果不产生新的 Foundry 输入，就不经过这条判断，行为不变。

## 检查

- `child_reports_test.go` 新增 `TestChildReportOutdatedByTheParentsWaitingMessage`，覆盖三种情形：父会话的消息在等，汇报记为 superseded，下一份汇报附带其内容且只有一个标题；其他会话的消息在等，照常汇报；本回合 steer 读到的消息，照常汇报。
- `TestChildReportSkipsATurnItsTimerStarted`：定时检查回合不汇报；之后由父会话开启的回合照常汇报；定时回合中父会话的消息被 steer 进来时照常汇报。A 的“本回合 steer 读到”用例改为与实际一致：steer 不记录回合 id。
- `TestConversationMergesStreamedSnapshots`：三版快照合成一条，取最后一版的文本和时间；另一条解说的位置不变。
- `scripts/check-changed.sh --files …`：A 时 prettier、gofmt、httpapi 8 个测试、audit:contract 全部 PASS；B、C 时 prettier、gofmt、httpapi 16 个测试、audit:contract 全部 PASS。另跑 `-run 'TestChildReport|TestSendReceipt|TestConversation|MCP|Inspect|Thread'` PASS。

## 部署

- 2026-11-04 16:00–16:03 UTC+8：持 `/tmp/fdy-deploy.lock`，把本项补丁 3-way 应用到 `foundry-int`（当前线上的共享暂存树，586 项其他会话的改动），无冲突。在该树上构建并跑定向测试（`TestChildReport|TestSendReceipt|MCP`），通过。
- Server `44cf7e078fd1a514`，SIGHUP 热交接：新 pid 3948299 接管，旧 pid 3547882 在 900 ms 后退出，`/healthz` 200，各设备 2–6 s 内重连。回滚：硬链接 `releases/dev023-candidate/foundry-server.pre-dev117`，换回后 SIGHUP。数据库无改动。
- B、C：2026-11-04 16:28–16:30 UTC+8，排在 DEV-116 之后获得部署锁。用“HEAD + A 补丁”到当前代码的差量补丁 3-way 应用到 `foundry-int`；另一会话在该树暂存的 `mcp_inspect.go` 4 行改动与本项不冲突。在该树上构建并跑定向测试，通过。Server `e6a1afff19d6138c`：新 pid 3977456 接管，旧 pid 3970092 在 545 ms 后退出，`/healthz` 200。这次构建也带上了 DEV-116 已部署的暂存内容；DEV-116 在 16:22 的部署也已包含 A。回滚：`foundry-server.pre-dev117b`（即 DEV-116 的二进制），换回后 SIGHUP。
- 部署前磁盘剩 8.6 GiB（已用 92%）。`/tmp` 下的大目录属于其他会话，无法确认可删，没有清理；本次构建很小。

## 自验

### A

dev 上的真实会话（Claude，工作区 foundry，设备 sg-chaos），两者都是合成测试会话，已归档：

- 测试父会话 `sess_1793779422212955075`（`reportBack: false`，不打扰发起它的对话）创建子会话 `sess_1793779440752194402`，任务是运行 `sleep 45` 后回答 ALPHA-DONE。随即用 `send_message`（`turn_end`）发去“回答 BETA-DONE”。
- Server 日志：03:04:04（EST）父会话的消息进入子会话收件箱，状态 held；03:04:13 记录 `session child report superseded`，该汇报为 `state=consumed reason="superseded"`；03:04:17 下一份汇报进入父会话收件箱。
- 父会话只开了一个回合，收到一份汇报（一个 `Foundry report:` 标题）：最终回答 `BETA-DONE`，末尾附 “An earlier turn ended 2026-11-04T08:04:13Z while your newer message to it waited; it said: …”。附上的是第一回合的回答：Claude Code 拦下了前台的 `sleep 45`，子会话问要不要改用后台。这正说明了附带内容的必要：过期回合里可能有问题要父会话回答。

### B

- 测试父会话 `sess_1793781040432410515`（`reportBack: false`）创建子会话 `sess_1793781061290492280`。子会话用 `create_scheduled_work` 建了一个一次性定时任务 `work_f51d836f285737050caad5f7b6f9cac1`（90 秒后，`continue_thread`），回答 `SCHEDULED …` 后结束回合。
- Server 日志（EST）：03:31:24 第一回合的汇报进入父会话收件箱，03:31:36 投递；03:32:55 `session child report skipped: … reason="a timer started the turn"`。
- 子会话对话：08:32:46Z 定时回合开始，08:32:55Z 回答 `GAMMA-TICK`。父会话对话只有第一份汇报，之后没有再被叫醒。两个测试会话已归档。

### C

- 在线核对正在运行的 Codex 会话 `sess_1793780648810266048`（ccm-omh-integration，08:26:24Z 开始的回合）：库里这一回合有 31 个解说快照事件，对应 5 段解说，同一段最多 7 版；`read_context scope=thread` 返回 5 条，每条都是最新的完整文本。

## 验收步骤

A. 过期汇报

1. 在任一会话里用 `create_session` 派一个子会话，任务要做一会儿（例如“读 3 个文件并总结，最后回答 A”；Claude Code 会拦下前台的长 `sleep`）。
2. 子会话运行期间，对它 `send_message`（`delivery: turn_end`），内容为“再回答 B”。
3. 预期：父会话只收到一份汇报。它的最终回答是 B，末尾附有“An earlier turn ended … while your newer message to it waited; it said: …”，内容是第一回合的回答。不会再单独收到一份只有第一回合的汇报。

B. 定时回合 4. 让子会话用 `create_scheduled_work` 建一个 1–2 分钟后触发的定时任务（`target: continue_thread`），然后结束回合。5. 预期：父会话收到这第一回合的汇报；定时触发的回合结束后，父会话不再收到汇报，子会话对话里能看到这个定时回合。如果在定时回合运行期间父会话给子会话发了消息，这个回合照常汇报。6. 对照：之后父会话再给子会话发一条消息，那个回合照常汇报。

C. 对话视图 7. 有 Codex 子会话正在输出解说时，在编排会话里对它 `read_context scope=thread`。8. 预期：每段解说只出现一次，是当前最新的完整文本，不再出现“我”“我先只…”这样逐步变长的片段。

## 流水

- 2026-11-04 约 15:10 UTC+8：分析 `sess_1793764358364457763` 的通知量，给本人 P1–P5；本人指示“先做确定没有副作用的”。
- 2026-11-04 16:03 UTC+8：A 的 Server 部署；16:04 dev 真实父子会话自验通过。
- 2026-11-04 约 16:10 UTC+8：本人指示“1 和 2 都做”（B、C）。16:30 Server 部署；16:31–16:33 dev 自验通过（B 用真实定时任务，C 用运行中的 Codex 会话）。剩余：人工验收；P3/P4/P5 待本人决定。
- 2026-11-04 23:30 UTC+8：本人授权提交。基于 `origin/main` `97415a6e` 开分支 `fix/dev117-child-report-noise`，5 个 Server 文件与线上 `foundry-int` 逐字节一致；`go build ./...`、相关 httpapi 测试、gofmt、go vet、prettier 通过。README 那一行已随 DEV-107 的 #196 合入。
