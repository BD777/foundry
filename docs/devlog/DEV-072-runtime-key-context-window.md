# DEV-072 后台任务运行时消息失败：“Session configuration changed while its native runtime still has active work”

| 环节           | 状态   | 说明                                                                                                                                           |
| -------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 问题理解/调研  | 已完成 | 根因见下；证据来自会话事件、设备上运行器的 `/proc` 命令行和 dev.53 源码                                                                        |
| 代码           | 已完成 | Worker（运行时 key、catalog 回退、忙碌时接续）+ Web 一条 toast 文案                                                                            |
| dev Server/Web | 部分   | Server 不涉及；Web 只改 `chat:notices.agentFailed` 两种语言文案，随 DEV-071 的 Web 发布上线（共享树中有 DEV-071 未完成的改动，本项不单独发布） |
| Worker 更新    | 进行中 | 发布 `0.5.7-dev.126.g4cf538f.local.1793206791`；dev 服务器设备 与 用户 Linux 开发机 的连接服务已更新，运行器待切换（见时间线）                 |
| Agent 自验     | 已完成 | Worker 全量测试 989 项 0 失败；新增 3 个用例复现事故路径；check-changed 通过                                                                   |
| 人工验收       | 待确认 | 见“验收步骤”                                                                                                                                   |

## 问题

用户在 用户 Linux 开发机 上的会话（Claude、`anthropic_compatible` 账号、claude-opus-5-5）让一个后台命令持续监视业务 Workflow。之后连发的两条消息都在约 1 s 内失败，报错为 “Session configuration changed while its native runtime still has active work. Wait for it to finish or use a fresh test session.”，同时弹出 toast “<账号名> failed.”。

## 根因

运行时 key（`activeRuntimeKey`）决定一条消息能否复用正在运行的 Claude 进程。它对整个 profile 对象取 hash，其中包括 `profile.contextWindow.source`，也就是窗口大小是从哪里得知的（`endpoint` / `official` / `default` / `setting`）。

对兼容端点，Worker 在每个回合前读一次端点的 `/models` 目录来确定窗口：超时 5 s，失败不缓存，失败后回落到官方窗口表。

会话事件（每条 “Model request usage” 都带 `configuredWindow`）显示：

| 时间（UTC） | 目录读取 | 窗口                  | 结果                                                                              |
| ----------- | -------- | --------------------- | --------------------------------------------------------------------------------- |
| 12:13–15:40 | 成功     | 1M，source `endpoint` | 同一进程被复用 9 次                                                               |
| 15:47       | 失败     | 1M，source `official` | key 变了；旧进程空闲，被静默关闭，另起新进程（“Started Claude Agent SDK”）        |
| 16:22       | —        | —                     | 回合启动后台命令 “Watch business workflow until it leaves running”                |
| 16:29       | 成功     | 1M，source `endpoint` | key 又变了；15:47 的进程有后台任务，`closeOtherClaudeWriters` 拒绝 → 两条消息失败 |

窗口大小没变（都是 1M），模型、推理强度、权限、账号、Skill 目录（各回合 draft id 和 digest 完全一致）、AGENTS.md/CLAUDE.md 都没变。运行中进程的命令行为 `--effort=high --model=claude-opus-5-5`，与会话记录一致。所以不是 DEV-068 的输入框预选，也不是 Server 配置变化。main HEAD 上同样存在这个问题。

## Toast “<账号名> failed.”

`use-chat-send.ts` 在正在回复的会话变为 failed 时弹出 `chat:notices.agentFailed`。原文只有账号名，读起来像是账号坏了，而且不说原因；真正的原因在对话里的 “Run failed” 卡片中。文案改为 “{{agent}}'s run failed. The reason is shown in the conversation.” / “{{agent}} 的运行失败了，原因见对话中的说明。”（已与 DEV-071 协调；toast 组件和调用方式不变）。

## 修复（Worker）

1. **key 只认影响进程的东西**（`runner/active-runtimes.ts`）：参与 hash 的 `contextWindow` 只保留 `model` 和 `tokens`，去掉 `source`。窗口大小变化仍会换进程。
2. **目录读取失败时沿用上次结果**（`context-window.ts`）：按端点与凭据记住最近一次成功读到的目录；读取失败或超时时用它，不再回落。只有从没读成功过的端点才回落到官方表或默认值。缓存仍是 10 分钟，失败不缓存，下一回合重试。
3. **进程忙于自己的工作时不丢消息**（`runner/claude-runtime-start.ts`）：key 不同，但写这个 native session 的进程没有 Foundry 回合在跑、只有后台任务、定时器或 Claude 自己续跑的回合时，这条消息交给该进程，后台工作保留。会话里出现一条提示：
   - 只有 Foundry 侧配置变化（Skill、指令、连接细节）：info，“The session's updated setup applies from the first message after that work ends.”
   - 用户自己改了模型、推理强度或权限模式：warning，列出 “Not applied yet: model A → B; …”，并说明后台工作结束后的第一条消息生效，想立刻生效就停止后台任务再发（聊天里已有 “Stop task”）。
   - 换账号：这个进程不能替另一个账号运行，拒绝并说明怎么做（停止后台任务或等它结束后重发），后台工作不受影响。
   - 另一个进程有 Foundry 回合在跑时仍然拒绝（单写者不变），错误文案改为说明原因和下一步。
   - 进程记录启动时的账号、模型、推理强度和权限模式（`ActiveClaudeRuntime.launch`），用来写出上面的差异。

## 自验

- 新增用例：
  - `native-session.test.mjs`《a changed key while background work runs continues on that process and says what waits (DEV-072)》：后台任务运行中，Skill 目录变化 → 复用并给出 info；改模型 → 复用并列出 “model default → claude-other”；换账号 → 拒绝，进程和后台工作不受影响；后台工作结束后 → 新进程以新模型启动，旧进程关闭，始终只有一个进程写该 native session。
  - `context-window.test.mjs`：本地 HTTP 端点先返回目录、超过 10 分钟后返回 503，窗口仍是 `endpoint` 的 400K；运行时 key 不随 `source` 变化，随窗口大小变化。
- 原有 3 个用例（`native-session`、`session-steer`、`claude-launch-secrets`）只把错误文案匹配从 `/active work/` 改为 `/still working/`。语义不变：有回合在跑时仍然拒绝。
- `packages/worker` 全量 `node scripts/run-worker-tests.mjs`：989 项，0 失败。
- `scripts/check-changed.sh`：prettier、tsc web、worker build、audit:ui、audit:modules 通过；它挑出的 25 个 worker 测试文件在文案修正后通过。
- 没有用真实模型复现：fake SDK 用例走的是真实的 `acquireClaudeRuntime` / `closeOtherClaudeWriters` 路径（后台任务以 tracker 的 `hasRunning` 模拟），不产生推理费用。

## 部署

- Worker 发布：`pnpm pack:worker-release --out ~/.foundry/server/worker-packages`，版本 `0.5.7-dev.126.g4cf538f.local.1793206791`（基线 commit 与 `git status` 存于 `~/.foundry/server/releases/dev072-worker/`，上一版 `.1793191889` 的包和 `release.json` 也备份在该目录的 `previous-worker-packages/`）。`/api/worker/release` 已返回新版本。打包内容为 main `4cf538f` 的 worker/protocol 加本项改动，因此也带上已合并、未发布的 DEV-070 注释与提示词改名。
- Server：不涉及。Web：只有文案，随 DEV-071 发布。

## 时间线

- 10-29 00:2x（北京时间）用户截图提问；编排会话 `sess_1793063405185071529` 指派本项。
- 10-29 00:39 根因确认，已把根因和临时办法（等后台监视任务结束或停止它之后再发）发给编排会话。
- 10-29 00:4x 用户授权：修复需要运行器代码时更新 用户 Linux 开发机，并允许 “立即切换” 结束后台监视任务；用户期间不使用该会话。
- 10-29 00:58 Worker 发布 `.1793206791`。
- 10-29 01:01 dev 服务器设备：`~/.foundry/bin/foundry-worker update`（运行器在单独的 execution unit 中，不受 daemon 重启影响）。连接服务 `.1793191889` → `.1793206791`，4 s 后 `runner: ready`。运行器 pid 2447427 仍为 `…/runtime/0.5.7-dev.104.g4d184b2.local.1793172116/…/execution-host/main.js`，pending（有回合在跑，包括本会话），没有停止任何回合。
- 10-29 01:02 用户 Linux 开发机：通过独立的 `systemd-run --user` 单元执行 `foundry-worker update`。连接服务 `.1793191889` → `.1793206791`，约 10 s 后上线。运行器 pid 1193234 仍为 `~/.foundry/runtime/0.5.7-dev.53.g8c85186.local.1792641207/node_modules/@bd777/foundry-worker/dist/execution-host/main.js`（10-22 12:51 起运行），pending 的唯一原因是后台任务 banfbcoo4 仍在运行。“立即切换” 只有设备所有者能调用（`POST /api/devices/{id}/worker/runner/switch`），会话 token 不能调用，该原生任务的 stop 控件为 unavailable；本项不在设备上直接杀进程绕过，已请编排会话转告用户在设备页点 “立即切换”，或等后台任务结束后自动切换。
- 10-29 01:33 用户在设备页点了 “立即切换”，页面显示 “runner switch failed”。实际上切换已经完成：journal 01:33:15 停止 `foundry-execution-…` 单元中的 dev.53 运行器（其 Claude 进程以 143 退出，后台监视任务随之结束），同一单元随即以 `.1793206791` 启动新运行器 pid 430466。新运行器到 01:35:02 才打开控制 socket；此前 daemon 连接一直报 `ENOENT control.sock`，`awaitService` 约 10 s 后放弃，Server 请求 11.2 s 返回错误。01:35:02 起 `daemon-health.json` 为 `runner: ready`，`switch.json` 已删除。`/proc/430466/cmdline` 为 `~/.foundry/runtime/0.5.7-dev.126.g4cf538f.local.1793206791/node_modules/@bd777/foundry-worker/dist/execution-host/main.js`。会话 `sess_1793189579694075630` 无回合运行，native transcript 完好，可继续。本项没有在设备上停止或重启任何服务。
- 10-29 01:4x 修复 “立即切换” 误报失败（见下节），Worker 发布 `.1793209725`；dev 服务器设备 连接服务已更新（运行器 pid 2447427 仍待切换）。用户 Linux 开发机 按用户要求今晚不再改动（用户在该设备上开始紧急工作），之后由用户决定何时更新。
- 10-29 02:53 Worker `.1793213531` 发布（短扣留、扣留起点不重置）；dev 服务器设备 连接服务更新后 `switch.json` 的 `since` 仍为 17:49:45Z，没有重新扣留。用户 Linux 开发机 未更新（用户要求今晚不动）。
- 10-29 03:05 dev Server 通过 SIGHUP 交接上线：`releases/dev072-server/foundry-server`，sha256 `43f1144881b9899c…`（main `4cf538f` 加本项的 Server 改动；也带上了已合并但尚未部署的 DEV-070 提示词改名），复制到 `dev023-candidate`，回滚文件 `foundry-server.pre-dev072`（`51c002635f415499…`）。新 pid 2752928 接管，旧进程 946 ms 后退出，healthz 200；所有设备 2–7 s 内重连（包括 用户 Linux 开发机 的连接服务，属于被动重连，它的运行器和回合不受影响），没有排队中的会话。httpapi 全量（1064 s）与 sqlitestore 全量通过。

## “立即切换” 报失败但实际已切换（10-29 01:33）

- 编排会话的猜测是旧运行器只因后台任务忙，“立即切换” 停不掉它。实际不是这样：只有后台任务、没有回合时，旧运行器（不支持 `drain_switch_v1`）按 `legacy` 路径由服务管理器直接停止（`systemctl --user stop`，SIGTERM），这条路径已有测试《an older runner busy without turns is switched by switch now directly》。确认对话框也会列出后台任务（“Background tasks only” 徽标），并说明它们会停止。
- 真正的原因是新运行器启动慢，加上等待逻辑有缺陷：
  - 新运行器在打开控制 socket 之前，先等待第一次 session-work 扫描（`startSessionWork` → `supervisor.start` → `tick`）。这次扫描要读所有会话的原生记录，还要请求 Server，在这台设备上耗时约 106 s（claims 落盘 01:33:16 → socket 01:35:02，中间只有这一步是 await）。
  - daemon 的 `awaitService` 名义上等 60 s，但循环上限是 100 次，每次 100 ms，连接失败时立即返回，所以实际约 10 s 就放弃，报 `connect ENOENT …/control.sock`。“立即切换” 的请求要等新运行器能应答才返回，于是把这个错误当作切换失败报给页面，并把运行器标为 failed 5 分钟。
- 修复（Worker）：
  - `execution-host/server.ts`：第一次 session-work 扫描不再阻塞 socket 监听；`supervisor.start` 先装定时器再做首扫，首扫失败后续扫描也照常进行。
  - `execution-host/client.ts`：`awaitService` 按截止时间等待，去掉次数上限。新运行器心跳新鲜（进程存在、`heartbeat.json` 一分钟内更新）时，最多等 10 分钟；没有心跳的只等基础时长。超时报 “The session runner did not start answering within N s (…)”，页面的失败原因会显示这句。
  - `switchNow`：旧运行器停止、新运行器启动后就返回 `switched: true`，不再等新运行器恢复完。这段时间运行器状态为 “Switching…”，能应答后变为 current。
- 测试：`runner-drain.test.mjs` 新增《switch now answers once the new runner started, and waits while it recovers (DEV-072)》。新运行器有心跳，socket 在基础等待（200 ms）之后 1.2 s 才打开：`switchNow` 在 1 s 内返回 switched，状态为 switching，之后变为 current，版本为 new。原有《switch now stops exactly the reviewed turns…》改为等待状态变为 current。Worker 全量 990 项，0 失败；check-changed 通过。
- Web 和 Server 没有改：对话框已经列出后台任务；失败时页面显示 Worker 给出的原因，现在这个原因是可读的。

## dev 服务器设备 上消息等待约 30 分钟，以及丢失的 17:50 消息（10-29 01:50–02:20）

**等待的原因（排空扣留 + 新版本重置扣留起点）**

- 被扣留的是编排会话 `sess_1793063405185071529`（用户的聊天）。用户 17:50:09Z 的消息显示 “Waiting for device”，直到 18:19:48Z 才开始，共 29 分 39 秒。DEV-073 在 18:20:21 发出，立即开始（已过上限）；没有别的会话被扣留。
- `switch.json` 的 `since` = 17:49:45.715Z，是本项第二次发布（`.1793209725`）更新连接服务的时刻；17:49:45 + 30 分钟 = 18:19:45，扣留在那之后 3 s 解除。第一次发布（`.1793206791`，since 17:01:28）的扣留已在 17:31 到期，所以 17:45 的回合没有等待。
- 缺陷：pending 期间换了新的目标版本，`beginDrain` 把它当成一次新的待切换，30 分钟扣留重新计时。另外，这台共享设备上旧运行器（`.1793172116`，pid 2447427）几乎没有空闲的时候，被扣留的回合只能等上限到期。
- Server 只知道会话还在排队，所以显示的是通用的 “Waiting for device”。

**修复**

- Worker（`execution-host/drain.ts`、`client.ts`）：
  - 新回合最多扣留 30 s（原为 30 分钟）。之后在旧运行器上运行，旧运行器在第一次没有回合运行时切换。
  - pending 期间安装的更新沿用原来的 `since`，已经用掉的扣留不会重新开始。
  - 测试：《a busy device's new turn runs within the short hold, and a newer release never re-arms it (DEV-072)》。设备忙，`switch.json` 是旧 stamp 且已过上限：新回合立即交给运行器，没有扣留。drain 策略测试改用上限的一半。
- Server（`httpapi/session_start_notice.go`）：运行器报告 pending/switching 且有被扣留的回合时，15 s 后（原为 3 分钟）在会话里写一条 “Worker update in progress”。内容说明设备正在切换到更新后的会话运行器，消息会在一分钟内开始，所有者可以在设备页立即切换；如果新运行器正在启动，则说明它一应答就开始。测试：`TestMessageHeldForAnUpdatedRunnerSaysWhy`。
- 没有采用蓝绿双运行器（编排会话的方案 a）：要让两个运行器共用控制 socket 和服务单元，还要按会话归属路由，改动面太大，今晚风险过高。短扣留 + 不重置扣留起点（方案 b）可以保证消息不会等几分钟。

**丢失的 17:50 消息**

- 那条消息没有在合并被扣留的消息时丢掉。它是自己的输入，但一直没有开始。约 18:05:18，这个聊天被停止（`POST …/cancel`，2.3 s；聊天页的 “Waiting for device” 提示带有 Cancel 按钮），取消了这个从未开始的输入。随后，被扣留的 turn_end 消息开始了下一回合。
- 新回合开始时，Server 会把 native session 没看到的内容告诉它（`resumeNativeSession` → `sessionConversation`），但只渲染有回答的回合。原测试也写明 “an unanswered turn tells nothing”。所以这条从未到达任何 native session 的消息，在下一回合的上下文中被丢掉了：页面上能看到，agent 看不到。
- 修复（`sqlitestore/native_sessions.go`）：没有回答的回合也写进上下文，后面加 “(No answer: this turn was stopped or failed before it answered.)”。新测试 `TestNextInputCarriesAMessageCanceledBeforeItStarted` 修复前失败、修复后通过；`TestConversationContextRendersAnsweredTurns` 按新规则更新。
- 已知遗漏：Worker 上报 native session id 之后才失败的回合（如 用户 Linux 开发机 16:29 的两条），会把 “最后看到的输入” 推过它，因此它也不会作为上下文补发。根治的做法是只在回合真正到达 agent 后才推进这个标记。今晚未改。

**验证与部署**

- Worker 全量 991 项，0 失败；sqlitestore 全量通过；httpapi 全量结果见时间线。
- Worker `.1793213531` 已发布；dev 服务器设备 连接服务已更新。更新后 `switch.json` 的 `since` 仍是 17:49:45（stamp 换成新版本），说明没有重新扣留。用户 Linux 开发机 今晚不动。

## 已知限制

- 修复在运行器里。用户 Linux 开发机 的运行器切换前，这台设备仍是 dev.53 的行为：目录读取一抖动、正好又有后台任务时，消息仍会这样失败。临时办法：等后台任务结束或停止它之后再发。
- Server/Web 无法替运行器补救：失败发生在运行器取进程这一步。
- 接续在旧进程上的回合用的是旧进程的配置（提示里写明）。新加的 Skill 要等后台工作结束后的第一条消息才能用。
- 运行时 key 的其他组成部分仍在 hash 里：会话自己改了 AGENTS.md/CLAUDE.md 或 Skill 目录，仍会换进程。空闲时照常换；忙时按上面的方式接续，不再失败。

## 验收步骤

1. 设备页 Devices → 用户 Linux 开发机 → Settings → Worker：连接服务为 `0.5.7-dev.126.g4cf538f.local.1793206791`；会话运行器切换后也是这个版本。
2. 在 https://dev.foundryapp.app 打开该会话，发一条消息：正常回复，不再出现 “Session configuration changed…”。
3. 让会话启动一个长时间的后台命令（例如每分钟检查一次的监视），在它运行时再发一条消息：应正常回复。如果期间配置有变化，对话里会出现一条 “Claude is still running this session's background work…” 的说明。
4. 后台命令运行时在输入框改模型或推理强度再发：回复照常，说明里列出 “Not applied yet: model … → …”；停止后台任务后再发，新模型生效。
5. 让一次运行失败（例如发给离线账号）：toast 显示 “<账号名>'s run failed. The reason is shown in the conversation.”（中文界面为 “… 的运行失败了，原因见对话中的说明。”）。
