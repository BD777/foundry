# DEV-124 执行宿主卡住被回收：留下卡顿证据

## 问题

2026-11-05 13:32（北京时间），CanWendeMac-mini 上的会话 [`sess_1793854535411185628`](https://dev.foundryapp.app/chats/sess_1793854535411185628)（blinklet，Limen · default）在重构途中失败：`Claude Code process terminated by signal SIGTERM`。

## 调查

- daemon 的 `daemon.err.log` 里有 `Execution host did not answer 2 handshakes; reclaiming it.`，之前还有 6 次握手确认超时、4 次确认丢失。新的执行宿主进程 05:32:58Z 启动，会话 05:32:59Z 失败：daemon 回收执行宿主时，宿主里的 Claude 进程收到了 SIGTERM。
- 回收条件（`execution-host/client.ts` 的 `hostWedged`）：宿主心跳（`heartbeat.json`，每 5 秒写一次）超过 60 秒未更新，并且有 2 次握手没响应。所以宿主的事件循环至少卡了约 60 秒。
- 宿主自己的看门狗（`liveness.ts`）要卡满 5 分钟才记录并退出，`service.err.log` 是空的，因此没有任何关于卡在哪里的记录。
- 事件时间线：05:32:18Z Claude 开始写 `LedgerSummaryTests.swift`，这次写入到回收后才显示完成，之前 20 分钟一直正常。写入前 Foundry 会同步拷贝原文件（`captureBefore`），写入后会同步读写文件记录（`recordWrite`）。这两步都直接作用于工作区所在的文件系统，而这个会话的工作区和 `.foundry/sessions/` 在 NAS 的 SMB 共享上（`//…@192.168.1.166/sata11-…`，`smbfs`）。
- 服务端日志里 Mac mini 的 daemon 卡顿记录：05:03:50Z 卡了 25.7 秒（没有标记活动）；其余多次 5–11 秒的卡顿发生在 native chat sync 或 registration 期间。05:26:17Z 到 05:43Z 之间没有 daemon 卡顿记录，说明 13:32 是执行宿主自己卡住了。
- 未能证实：宿主没有日志，拿不到卡住时的调用栈。事后实测 SMB 卷上的 stat、read、readdir 都很快。系统日志里 smbfs 的 `error 96` 全天每 10 分钟有数千条，是背景噪声，不能当证据。

## 本次改动（只补证据，不改行为）

- `execution-host/stall-watcher.ts`（新）：执行宿主的看门狗线程改成独立模块。主线程卡住超过 15 秒（`FOUNDRY_EXECUTION_STALL_REPORT_MS`）时，在卡住期间往 `~/.foundry/execution-host/stalls.log` 记一条：卡了多久、主线程标记的活动、当时卡在哪里。macOS 用 `/usr/bin/sample` 抓 1 秒原生调用栈，存到 `stalls/`，最多保留 5 份；Linux 记 `/proc` 里的线程状态、`wchan` 和 `syscall`。主线程恢复后再记一条大约卡了多久。卡满 5 分钟仍和原来一样，记录后 SIGKILL。日志超过 1 MB 时轮转。
- `platform/stall-monitor.ts`：`beginActivity` 标记的活动同时镜像到共享内存（`shareActivities` / `readSharedActivities`），看门狗线程在主线程卡住时也能读到。只有监视器在运行时才累积 `recent`，执行宿主里不会无限增长。
- `session/files/session-files.ts`：写入前的拷贝和写入后的记录分别标记为 `file copy before write <path>` 和 `file record <path>`。
- daemon 侧：回收执行宿主的日志加上时间戳和心跳的年龄，`Execution host connection:` 这类日志也加上时间戳。

## 部署

- 按集成流程，在 `/tmp/fdy-deploy.lock` 锁内把补丁打进 `~/workspace/foundry-int` 并暂存。在那里构建，并跑 `stall-monitor`、`execution-host-stall`、`execution-host`、`external-connection`、`claude-sdk-runtime` 测试，共 32 个通过。打包后和线上包 `…1793854123` 逐文件对比，只差本次的 6 个 dist 文件、新增的 `stall-watcher.js` 和 `package.json`。
- Worker `0.5.7-dev.269.g97415a6e.local.1793860016` 发布到 `~/.foundry/server/worker-packages`。回滚副本在 `~/.foundry/server/worker-packages-rollback/before-dev124-host-stalls/`，另存 `release.before-dev124.json`。
- Worker 更新（14:25 左右，通过 compute lease 后台运行 `foundry-worker update`）：7 台设备的 daemon 都报告 `…1793860016`。CanWendeMac-mini、macbook、byte-dev-sg、cottoncpp、limen-canada 的执行宿主已切到新版本。byte-dev（旧宿主 `…1793815663`）和 sg-chaos（旧宿主 `…226`、`…1793854123`，其中一个承载本调查会话）还有回合在旧宿主上运行，等它们结束后再切换，未强停。

## 验证

- 主工作区：`scripts/check-changed.sh`（prettier、worker build、54 个 worker 测试文件、audit:modules）通过。
- 新测试 `execution-host-stall.test.mjs`：子进程启动宿主的看门狗，在标记的活动里让主线程空转 4.5 秒（上报阈值设为 2 秒）。断言卡住期间恰好记一条，带上活动名和卡住位置（Linux 上是 `state R`，macOS 上是 sample 文件），恢复后再记一条。`stall-monitor.test.mjs` 新增共享活动的镜像与截断测试。

- macOS 实机验证：在 CanWendeMac-mini 上，用安装好的 `…1793860016` dist、临时目录和 2 秒阈值运行同样的脚本。`stalls.log` 记下了 `event loop blocked for 2017 ms during file copy before write Tests/Demo.swift; sample …sample.txt`，sample 文件 74 KB，包含主线程（`com.apple.main-thread`、`node::Start`）的调用栈；随后记下「ran again」。因为卡住那行要等 `sample` 跑完才写，所以排在「ran again」之后，真正的卡住时刻以 sample 文件名为准。

## 根因（2026-11-05 14:53 第二次失败后确认）

- 用户发「继续」后，会话 14:53 再次失败（`The execution host stopped…`）。这次 `stalls.log` 留下了记录：06:51:54Z 主线程卡了约 16 秒，恢复后立刻再卡，06:52:09Z、06:52:25Z 两次 sample，一直卡到 06:53:15Z 被回收（daemon 日志：`… did not answer 2 handshakes and its heartbeat is 65 s old`）。两次记录的活动都是「no marked activity」，排除了写入前拷贝和写入后记录这两处。
- 两份 sample 的主线程栈完全一致：流读取回调 → microtask → async 函数 → `node::fs::WriteFileUtf8`。`open()` 占 80–98% 的采样，其余在 `close()`。也就是主线程在同步追加文件，每次打开、关闭都要等 SMB。
- 对应代码：`session/runner/claude-messages.ts` 对 Claude 的每条消息执行 `appendFileSync(<工作区>/.foundry/sessions/<会话>/inputs/<输入>/claude-sdk.messages.jsonl, …)`。这个文件在 NAS 的 SMB 共享上。这一轮写了 1266 行，其中 1226 行是 `stream_event/content_block_delta/input_json_delta`：Claude 写大文件时，工具参数是一小段一小段流式发来的，每段一行。所以两次失败都发生在写大文件时。
- 实测（Mac mini，NAS 空闲时）：在该目录同步追加一行，中位数 66.5 ms，p90 133 ms，最慢 716 ms；本地磁盘约 0 ms。追加 300 行，同步写法共 23.3 秒、事件循环单次最长卡 1011 ms；异步流 0.12 秒、最长卡 2 ms。按 1226 行估算，同步写法要卡 90 秒以上，和观测吻合。

## 修复

- `platform/line-log.ts`（新）：`appendLine(path, line)` 为每个文件维护一条 `fs.WriteStream`（追加模式），写入在 libuv 线程池里进行并合并，主线程不再等待文件系统；同一文件保持顺序；空闲 10 秒后关闭；写入出错只报一次，不再让会话失败（原来同步写抛错会中断消息处理）。`flushLines(path)` 等待已追加的内容写完。
- `claude-messages.ts` 的 `claude-sdk.messages.jsonl`、`codex-stream.ts` 的 `codex-sdk.events.jsonl`（Codex 也是逐事件同步追加）都改用 `appendLine`。日志内容和格式不变。读取方 `subagent-transcript.ts` 是按需读取的，最多晚几毫秒。
- 测试：`line-log.test.mjs`（500 行保持顺序且接在原有内容之后；写不了的路径只报一次错、不抛异常）。`claude-background-task-lifecycle.test.mjs` 原本在回合结束后立即同步读日志，改为先 `flushLines`。
- 验证：主工作区 `scripts/check-changed.sh` 通过（83 个 worker 测试文件）；在 foundry-int 里跑 14 个相关测试文件共 88 个测试，全部通过。打包后和线上 `…1793860016` 对比，只差 `claude-messages.js`、`codex-stream.js`（只有 import 和 `appendFileSync`→`appendLine` 这几行）、新增的 `line-log.js` 和 `package.json`。
- 部署：Worker `0.5.7-dev.269.g97415a6e.local.1793862353`；回滚副本 `~/.foundry/server/worker-packages-rollback/before-dev124-line-log/`，另存 `release.before-dev124b.json`。

- Worker 更新（15:05 左右）：7 台设备的 daemon 都报告 `…1793862353`；CanWendeMac-mini、macbook、byte-dev-sg、cottoncpp、limen-canada 的执行宿主已切换。byte-dev、sg-chaos 的旧宿主还有回合在跑，等结束后切换，未强停。
- 端到端（真实 SMB 工作区）：在 blinklet 工作区用 Limen · default（haiku）开测试会话 `sess_1793862433868514810`，让 Claude 用 Write 一次写出 400 行的 `/tmp/fdy-dev124-big.txt`。会话 07:07:14Z 开始、07:08:20Z 完成，回复 DONE，文件 400 行。SMB 上的 `claude-sdk.messages.jsonl` 共 5239 行（其中 5194 行是 `input_json_delta`，是失败那轮的 4 倍多），全部是完整 JSON，顺序正确。`stalls.log` 没有新增记录，daemon 没有回收执行宿主。按原来的同步写法，这一轮会把主线程卡 5 分钟以上。测试文件已删除，测试会话已归档。

## 后续：消息日志不再逐条记录流式片段（2026-11-05，本人选方案 C）

- 背景：`claude-sdk.messages.jsonl` 从首个公开版本起就存在，是 SDK 消息的原始记录。它独有的内容是 SDK 层才有的消息（初始化、子代理和后台任务的开始与结束通知、命令生命周期等），子代理记录页面就读这些，必须保留。流式片段（`stream_event/content_block_delta`）占 85–99% 的行，内容在最终的 assistant 消息里完整出现，每行也没有时间戳；唯一独有的价值是回合中途死掉时，能看出它当时正在生成什么。
- 本人在 A（全部记录）、B（不记片段）、C（片段折叠成摘要）中选了 C。
- 实现：`session/runner/claude-stream-log.ts`（新）的 `ClaudeStreamLog` 决定每条 SDK 消息记哪些行。片段（`content_block_delta`）不再逐条记，按内容块（`parent_tool_use_id` + 序号）累计片段数和字节数。
  - 内容块结束时，在原样保留的 `content_block_stop` 前记一行 `foundry_stream_summary`（`end: "stop"`）。
  - 块还在输出时，每 5 秒记一行 `end: "progress"`。这样即使执行宿主被直接杀掉、来不及写结尾，也能看出当时在哪个块、已经写了多少。
  - 同一序号的块重新开始，或 Claude 进程结束时还有没写完的块，记 `end: "interrupted"`。
  - 其他消息，包括块的开始与结束、message 级事件，都原样记录。摘要行带块类型、工具名、片段数、字节数和耗时。
- `claude-messages.ts`：每个运行时一份 `ClaudeStreamLog`（`WeakMap`，不改 `session-state.ts`）。进程的消息泵结束时补记未写完的块。Codex 的 `codex-sdk.events.jsonl` 没有逐字片段，不变。
- 测试：`claude-stream-log.test.mjs` 用假时钟覆盖进度与结束摘要、子代理的块分开计、未结束的块标为中断、同序号的块重新开始时先关闭旧块。消息相关的 10 个测试文件（共 62 个测试）和主工作区的改动检查（41 个 worker 测试文件）都通过；foundry-int 里 11 个测试文件、共 63 个测试通过。
- 部署：按集成流程在 foundry-int 构建，和线上 `…1793862353` 逐文件对比，只差 `claude-messages.js`、新增的 `claude-stream-log.js` 和 `package.json`。Worker `0.5.7-dev.269.g97415a6e.local.1793867080`；回滚副本 `~/.foundry/server/worker-packages-rollback/before-dev124-stream-summary/`，另存 `release.before-dev124c.json`。

- 设备更新（16:25 左右）：7 台设备的 daemon 都报告 `…1793867080`。byte-dev-sg、limen-canada、macbook 的执行宿主已切换。CanWendeMac-mini 的执行宿主还在 `…1793862353`，等本人的 blinklet 会话跑完后切换；在此之前，这台设备上的新会话也跑在旧宿主上。cottoncpp、byte-dev、sg-chaos 的旧宿主也在等回合结束。
- 端到端：
  - macbook（新宿主），Limen · haiku，测试会话 `sess_1793867338049489129` 一次写 300 行文件。消息日志 43 行：Write 块记了 1 行进度、1 行结束摘要（3894 个片段、27248 字节、27.6 秒），其余 SDK 消息原样保留。
  - 对照：同样的任务在 Mac mini 旧宿主上（`sess_1793867227342354762`）是 3940 行，其中 3903 行是片段。
  - 进度摘要还显示，这个块前 26.5 秒只到了 8 个片段，其余约 3886 个在最后约 1 秒内成批到达。
  - 两个测试会话都已归档，测试文件已删除。
- 自 `…1793862353`（异步写入）部署后，CanWendeMac-mini 的 `stalls.log` 没有新的卡顿记录；本人的 blinklet 会话 15:58 起一直在跑。

## 后续：执行宿主不再在主线程上读写工作区（2026-11-05，本人同意方案 D）

- 决定：保留 DEV-067 的卡死回收（它防的是真实发生过的退出死锁），改为消除「健康的执行宿主主线程被慢 I/O 长时间占住」这一类问题。会话运行目录暂不搬出工作区：写入前留副本、写入后记录读的就是工作区文件本身，搬家解决不了网络盘风险。
- 更正：此前说完成标记的路径「写死在工作区、和 `FOUNDRY_EXECUTION_SESSION_ROOT` 不一致」，核实后不成立。写入和读取都通过 `completionMarkerPath(stateRoot, …)`，使用调用方传入的同一个状态根，是一致的，无需修改。
- 实现：
  - `session/files/session-files.ts`：原 `SessionTurnFiles` 的实现改名为 `TurnFilesCore`，逻辑不变。`SessionTurnFiles` 变成接口相同的外壳：有已注册的运行器（`runTurnFilesOn`）时交给它，否则在本线程运行，所以测试、daemon 和命令行工具行为不变。
  - `session/files/session-files-thread.ts`（新）：`startTurnFilesThread()` 启动一个 worker thread，在里面运行 `TurnFilesCore`。主线程只转发调用。线程把 `emit` 通过消息交回主线程，按原顺序上报。外壳被回收时，通过 `FinalizationRegistry` 释放线程里的实例；`emit` 只经弱引用找回，避免全局表持有回合导致泄漏。线程意外退出时，进行中的调用以「Turn file record thread stopped」失败，旧记录作废，下一次打开时自动换一个新线程。
  - 为什么不用 `fs/promises`：异步 fs 跑在 libuv 默认 4 个线程的共享线程池里，网络盘失去响应时会挂住这几个线程，进程里所有文件和 DNS 操作都会被拖住；独立线程卡住只影响它自己。项目里已有同样的做法（`skills/skill-scan-thread.ts`）。
  - `execution-host/server.ts` 启动时调用 `startTurnFilesThread()`。
  - `platform/line-log.ts` 新增 `startLines(path, line?)`：以截断模式开始一个日志，并丢弃同一文件上旧流里还没写出的内容。每轮开头清空消息日志和 stderr 文件（Claude、Codex），以及失败时写 stderr，都改用它，和随后的异步追加走同一条流，保证先后顺序。Claude 进程每个 stderr 数据块的同步追加改为 `appendLine`。
- 测试：`session-files-thread.test.mjs` 先启用线程，再导入整个 `session-files.test.mjs`，让全部用例在线程模式下再跑一遍（事件、文件记录、diff 一致）；并新增「线程停止后旧记录失败、新记录在新线程上正常」的用例。主工作区 `scripts/check-changed.sh` 通过（90 个 worker 测试文件）；foundry-int 里 12 个测试文件、共 124 个测试通过。打包后和线上 `…1793867080` 对比，只差本次改动的 6 个 dist 文件、新增的 `session-files-thread.js` 和 `package.json`。
- 部署：Worker `0.5.7-dev.269.g97415a6e.local.1793871218`；回滚副本 `~/.foundry/server/worker-packages-rollback/before-dev124-files-thread/`，另存 `release.before-dev124d.json`。7 台设备的 daemon 都已更新。CanWendeMac-mini、macbook、byte-dev-sg、cottoncpp、limen-canada 的执行宿主已切换；byte-dev、sg-chaos 的旧宿主等回合结束后切换。
- 实测（CanWendeMac-mini，工作区放在 NAS 的 SMB 共享上，15 次「写入前留副本 + 写入后记录」，用已安装的 dist）：
  - 原来在主线程上做：共 17.3 秒，主线程全程被卡 17.2 秒，期间定时器 0 次执行。
  - 独立线程：共 16.5 秒，主线程最长被卡 3 ms，期间定时器执行 1518 次。
  - 对照，本地磁盘、原来的写法：共 0.18 秒。
  - 结论：在这块 NAS 上，每记录一次写入约 1.1 秒；原设计里 Claude 每写一个文件，整台设备的所有会话都会被冻结 1 秒以上。（第一次测量的脚本有漏洞：同步阻塞期间定时器从未触发，把「全程卡死」误算成 0 ms，已修正后重测。）
- 端到端（CanWendeMac-mini 新宿主，blinklet 工作区在 NAS 上）：测试会话 `sess_1793871584590849628` 用 Write 依次写 6 个文件。6 次写入都有「Recorded file」，回合结束时又各补一次带 diff 信息的记录；会话目录在 NAS 上，其中 `files.json` 的 6 个条目都是 created，`baselines/`、`changes.json` 正常生成；`stalls.log` 没有新条目。测试会话已归档，测试文件已删除。
- 实际会话：本人的 blinklet 会话从 15:58 发「继续」起，一直跑到重构和重新设计全部完成（事件从 434 条增至 1068 条），没有再失败；`stalls.log` 自 06:52Z 以后没有新的卡顿记录。
- 遗留：主线程上还有每轮或每个事件一次的单次同步写入，包括 `result.md`、完成标记、截图帧（`tool-frames.ts`）、后台任务记录。正常情况下各几十毫秒，只有在网络盘完全失去响应时才可能卡住；其中几处在另一个会话正在修改的文件里，等那项工作合入后再处理。daemon 侧读取会话文件（Changes 面板、子代理记录）仍是同步的；daemon 卡住只会导致与服务端短暂断连，不会让会话失败，另行跟进。

## 限制

- 工作区放在网络共享上时，其他同步文件操作（写入前拷贝、写入后记录、结果文件等）每次仍要几十毫秒；它们一轮只执行有限次数，`stalls.log` 会继续记录超过 15 秒的卡顿。
- daemon 的 60 秒回收阈值和宿主自己的 5 分钟容忍度仍不一致，等证据确认后再一起处理。
- daemon 自己在 native chat sync 期间多次卡顿 5–11 秒，另外跟进。

## 验收步骤

1. 在 `sess_1793854535411185628` 里发「继续」。预期：会话继续重构（包括写大文件）并重跑 `swift test`，不再出现「The execution host stopped」或 SIGTERM。
2. 如果仍然失败：Mac mini 的 `~/.foundry/execution-host/stalls.log` 里应有一条「event loop blocked for … during file copy before write …/file record …」，并指向 `stalls/` 下的 sample 文件；daemon.err.log 的回收日志带有时间和心跳年龄。
3. 如果没有再失败：`stalls.log` 里仍可能出现 15–60 秒的卡顿记录，同样可以用来确认原因。

## 流水

| 时间（UTC+8）    | 变化与证据                                                                                                                                                                                                               | 剩余动作                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| 2026-11-05 14:10 | 调查 `sess_1793854535411185628` 的 SIGTERM：确认是 daemon 回收了卡住的执行宿主；卡住原因未证实，疑似 SMB 上的同步文件操作。本人同意先补证据。                                                                            | 实现、验证、部署                                          |
| 2026-11-05 14:30 | 卡顿记录实现完成，测试通过；Worker `…1793860016` 已发布，7 台设备的 daemon 已更新，Mac mini 实机验证 sample 抓栈成功。                                                                                                   | byte-dev、sg-chaos 的执行宿主等回合结束后切换；等卡顿再现 |
| 2026-11-05 15:10 | 第二次失败的 sample 确认根因：每条 Claude 消息都同步追加到 SMB 上的 `claude-sdk.messages.jsonl`。改为异步追加（Claude 和 Codex 两处），Worker `…1793862353` 已部署到 7 台设备；在 SMB 工作区里写大文件的端到端测试通过。 | 人工验收：在原会话发「继续」                              |
| 2026-11-05 16:30 | 本人选方案 C：消息日志把流式片段折叠为摘要行。Worker `…1793867080` 已部署，macbook 新宿主上的端到端测试日志从 3940 行降到 43 行。                                                                                        | Mac mini 等 blinklet 会话结束后切到新宿主；人工验收       |
| 2026-11-05 17:45 | 本人同意方案 D：执行宿主的会话文件记录移到独立线程，每轮的日志清空和 stderr 改为异步。Worker `…1793871218` 已部署；NAS 实测主线程最长被卡从 17.2 秒降到 3 ms，端到端通过。本人的 blinklet 会话已跑完，未再失败。         | 人工验收；遗留的单次同步写入等另一会话的改动合入后处理    |
