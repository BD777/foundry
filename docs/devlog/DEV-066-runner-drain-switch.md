# DEV-066 会话运行器排空切换（含 DEV-067 卡死运行器回收）

状态：已部署 dev（Server `51c00263…`、Web `6796efb44e5fdab8`、Worker `0.5.7-dev.104.g4d184b2.local.1793191889`）。dev 服务器设备 和 用户 Linux 开发机 的连接服务已更新；两台的运行器都处于 pending，等运行中的工作结束后切换（见时间线）。待人工验收。 2026-10-29：Agent 委托验收未关闭（dev 服务器设备 运行器仍为 `.1793172116`；用户 Linux 开发机 运行器按用户决定等待后台任务结束后自动切换），见文末。

合并：2026-10-28 夜间窗口经 PR #154 合并到 main（分支 `release/dev054-068`，本事项单独提交，共用文件在 shared wiring 提交）。

## 问题

- **DEV-066**：执行宿主（会话运行器）只在 `prepare_upgrade` 被问到的那一刻空闲时才切换版本（`execution-host/server.ts` 中 `ready = !busy()`）。设备一直有回合在跑，就一直切不过去。用户 Linux 开发机 的运行器停在 dev.53 约 6 天，而它的 daemon 已是 `.1793172116`。DEV-048/052/057/061/063 的运行器侧修复都没有生效。
- **DEV-067**（用户的 Mac 事故，2026-10-28 15:09–15:42，离线 34 分钟，报告：`.foundry/attachments/20261028/incident-mac/`）：
  1. 旧运行器（build 81）在 uncaught exception 后卡在退出路径（`Environment::Exit → uv__threadpool_cleanup → uv_thread_join`）。control.sock 能接受连接，但从不回复握手，SIGTERM 无效。
  2. 新 daemon 在连 WebSocket 前 `await startExecutionHost()`：握手 35 s 超时，`launchExecutionService()` 看到 job 存在就返回，`awaitService()` 再重试 100 次。
  3. 启动期间只写一次心跳，watchdog 每 5 分钟杀一次 daemon，launchd 拉起后它又卡住。
  4. 人工 bootout 加 SIGKILL 后才恢复。

## 方案与实现

### 排空切换（用户 10-28 批准方案 A）

都在 daemon 侧实现，旧运行器（dev.53）也适用（`execution-host/client.ts`，策略见 `execution-host/drain.ts`）：

- 装了新运行器（entry 或 stamp 变化）后，运行器进入 **pending**。开始时间记在 `execution-host/switch.json`，daemon 重启不会重置 30 分钟上限。
- **新回合不交给旧运行器**，留在 daemon 内存里。Server 侧会话保持 `queued`：Server 只在收到 `session_started` 后才改成 running；daemon 重启后，Server 在 hello 时会重新派发 queued 会话，所以不需要持久化 payload（payload 含凭据）。
  - 发给被扣留会话的 steer 抛 `SessionNotSteerableError`，按 DEV-057 的规则由 Server 持有并在之后补投。
  - 取消被扣留的回合：从队列里删掉，并上报 “Session canceled before it started.”。
  - `owns()`/`hasSession()` 都包含被扣留的回合，恢复逻辑不会把它们当成孤儿。
- **何时切换**（`drainDecision`）：
  - 完全空闲：旧协议的 `prepare_upgrade`（idle）。
  - 新运行器（`drain_switch_v1`）在没有回合和后台任务时，走 `prepare_upgrade{mode:"boundary"}`。这时运行器检查没有回合、没有后台任务、没有受管服务；定时器随 runtime 关闭交接给新运行器。
  - 回合还在跑：扣留新回合，最多 30 分钟。超过上限后放行新回合（`waitingFor: "turns"`），在第一次没有回合运行时切换。回合永远不会被自动停止。
  - 没有回合，但旧运行器仍有后台任务、定时器或服务：等 60 s 后放行（`waitingFor: "background"`），等这些工作结束，或由所有者点立即切换。
- 切换成功后，被扣留的回合交给新运行器。切换失败则记录 `failed`，5 分钟内不扣留新回合，之后重试。
- **立即切换**（仅所有者可用）：`POST /api/devices/{id}/worker/runner/switch`，请求体带所有者确认过的回合。
  - Server 先重新读一遍运行器（`read_execution_runner`）。如果有确认列表之外的回合，返回 409，不停止任何东西。
  - 否则按普通 Stop 的路径 `cancelSession` 每个回合，会话状态为 canceled，下一条消息继续。
  - Worker 再核对一次，取消回合，最多等 30 s，然后 `prepare_upgrade{mode:"now"}`。旧运行器不认识 now，直接 stop/start。
- **上报**：daemon 在 Server 声明 `runner_reports` 时发送 `execution_runner`（protocol `DeviceRunner`：version、targetVersion、state current/pending/switching/failed/unavailable、pendingSince、deadline、runningTurns、heldTurns、backgroundSessions、waitingFor、reclaiming、error）。Server 按连接保存，在 `liveDevices` 中加到设备上。回合明细（含会话标题）只能由所有者通过 `GET …/worker/runner` 读取。

### 卡死运行器（DEV-067）

- **回收**：握手超时改为 10 s。超时后不再只因 job 存在就当成正常。
  - 新运行器每 5 s 写一次 `heartbeat.json`。心跳停止 ≥ 60 s，并且连续 2 次握手无应答，判定为卡死。没有心跳的旧运行器需要连续 3 次无应答。
  - 判定卡死后执行 `reclaimExecutionService`：按平台停止 job（launchd bootout，或 `systemctl stop`），再按 identity.json 精确结束进程（先 TERM，宽限期后 KILL），然后重新启动。
  - 已连上的运行器如果 snapshot 超时，就断开连接重新握手，避免 用户的 Mac 事故前那种 2360 次 ack 超时却一直不处理的情况。
  - `awaitService` 总时长不超过 60 s。
- **daemon 降级而不阻塞**：进程一启动就开始 30 s 心跳；`startExecutionHost` 最多等 15 s，然后照常连 Server。运行器在后台由每 5 s 一次的 refresh 重试或回收，期间状态报为 `unavailable`/`reclaiming`。
- **运行器自检**（`execution-host/liveness.ts`）：
  - uncaught exception 和 unhandled rejection 先写入 `fatal.log`，再 `SIGKILL` 自身，绕过会挂起的 threadpool join，由 systemd/launchd 拉起。
  - 一个 worker thread 监视事件循环，阻塞超过 5 分钟（`FOUNDRY_EXECUTION_STALL_LIMIT_MS`）就记录并 SIGKILL 自身。
- **watchdog 覆盖运行器**（macOS `scripts/watchdog.sh`）：运行器心跳过期 5 分钟，且 pid 与启动时间吻合时，bootout 它的 label，再 TERM，5 s 后 KILL。Linux 没有 watchdog，靠 daemon 回收和运行器自检。
- **更新成功的判定**：`worker-install.ts` 在重启后等新 daemon 的 `daemon-health.json`，最长 120 s。版本必须正确、进程存活、已注册 Server，并且运行器为 ready 或 reclaiming，才写 succeeded；否则写 failed 并附原因（`daemonCameOnline`）。
- **根因调查**：sample 中 4 个 libuv worker 都在 `uv_cond_wait` 里空闲，主线程却在 join，与 Homebrew Node 链接系统 libuv 时退出死锁的现象一致。uncaught exception 本身的文本不在这次收集的日志里（运行器的 stderr 没有收进证据包），现在会写进 `fatal.log`。

### Web（设备页）

- Worker 一节分成两行（`InfoRow keyValue`），分别显示版本和状态：
  - “连接服务 / Connection service”：已是最新 / 有可用更新 / 正在更新。
  - “会话运行器 / Session runner”：已是最新 / 等待切换 / 正在切换 / 切换失败 / 无响应。
- 主按钮改为 “更新 Worker”。等待中显示：几个回合在运行、新回合最晚等到几点、几个新回合在排队。
- 次按钮 “立即切换” 打开 `Dialog`，列出会被停止的回合（会话标题，只有后台任务的会话标注出来）。确认按钮用新增的 `Button variant="danger"`，打开时焦点在取消上，Esc 关闭。
- 设备列表加徽标 “运行器待切换 / 运行器切换中 / 运行器切换失败 / 运行器无响应”。“Update all” 的汇总列出待切换的设备。
- 顶部横幅在只有运行器未切换时，标题为 “这台设备的会话运行器尚未切换”，不放按钮，按钮只在 设置 → Worker 里出现一次。

## 验证

- 单元测试：
  - Worker：`runner-drain.test.mjs`（策略、扣留后交给新运行器、取消被扣留回合、立即切换拒绝未确认回合、旧运行器忙时直接 stop/start）；`runner-reclaim.test.mjs`（模拟卡死：接受连接不回复且忽略 SIGTERM 的子进程，被按 identity KILL 后回收；心跳正常时不回收；`daemonCameOnline`；fatal 后 SIGKILL；事件循环阻塞时自行退出）；`worker-install.test.mjs` 的更新重试测试改为等新 worker 上线；`large-envelope-pieces` 增加 `runnerReports`。相关 8 个文件共 37 项通过。
  - Server：`device_runner_test.go`（投影只属于上报它的连接；立即切换在列表变化时返回 409，且不发出切换；只转发已确认的回合）。路由覆盖测试通过。
  - `audit-contract`、`audit:modules`、`audit:ui`、protocol 测试 76/76、web `pnpm typecheck` 通过。
- 真机测试：dev 服务器设备 上的 scratch stack `dev066`，合成 Worker，Codex 本地账号。证据见 `.foundry/attachments/20261028/dev066/evidence-drain.txt` 和截图。
  - **排空**：A（`sleep 150`）在运行器 2457991 上运行时 “更新”，pending 状态为 runningTurns 1、heldTurns 1，B 留在 queued。A 正常完成（DONE-A，没有被停止）。新运行器 2462921 在 A 结束 1.3 s 后启动，B 在新运行器上完成。
  - **立即切换**（浏览器操作，light 1280 和 dark 390；Enter 打开对话框，焦点落在取消上，Esc 关闭）：D 被 Server 取消（canceled），运行器 2465752 换成 2470095。给 D 发下一条消息后，D 完成并回复 “CONTINUED”。
  - **卡死**：对运行器 2470095 发 SIGSTOP，再重启 daemon。17 s 时 daemon 已上线（运行器报 unavailable），69 s 时开始回收，74 s 时新运行器 2471993 就绪，被冻结的进程已结束。
- 修复过程中发现的问题：第一次立即切换只由 Worker 取消回合，Server 侧会话仍显示 running。改为 Server 先走 `cancelSession`。

## 局限

- 旧运行器（≤ `.1793172116`）不认识 `boundary`/`now`。有定时器或服务时，它只能等这些工作结束，或由所有者点立即切换；这时不会交接定时器（旧版行为）。
- 被扣留的回合只保存在 daemon 内存里；daemon 重启后靠 Server 的 queued 重派。
- Web 的 `worker-commands.test.mjs`（“share one read”）失败。失败与 DEV-062 的 GET 重试有关，不是本项引起的。check-changed 中的 go test 编译失败来自 DEV-068 未完成的 `session_accounts.go`。
- 用户的 Mac 只能远程只读诊断，不在那台机器上复现；macOS 路径（launchd bootout 和 watchdog）只有代码和单元测试覆盖。

## 验收步骤

1. Devices → 某台设备 → 设置 → Worker：看到 “连接服务” 和 “会话运行器” 两行，各有版本和状态。
2. 在运行器有回合运行时点 “更新 Worker”：连接服务立即更新，运行器显示 “等待切换” 和最晚时间。这时发给其他会话的消息显示排队，运行中的回合结束后，这些消息在新运行器上运行。
3. 再次等待切换时点 “立即切换”：对话框列出将被停止的回合；取消保持等待；确认后这些回合显示已取消，运行器切到新版本，给该会话发下一条消息可以继续。
4. 设备列表：等待中的设备有 “运行器待切换” 徽标，“Update all” 的汇总里列出它。
5. 用户 Linux 开发机 和 dev 服务器设备 的运行器离开旧版本（见下方时间线中的 `/proc` 记录）。

## 时间线

- 10-28 用户批准方案 A 和页面设计（编排会话 `sess_1793063405185071529` 的 brief）。同日追加 DEV-067（用户的 Mac 事故）。
- 10-28 20:52 实现与 scratch 真机验证完成；Worker `.1793191889` 已打包；等待 Server 和 Web 部署放行。
- 10-28 21:11 dev Server 通过 SIGHUP 交接上线：`releases/dev066-runner/foundry-server`，sha256 `51c002635f415499083b15eebb71e4b890841af00e709fb634db2b7474e82e01`，复制到 `dev023-candidate`，回滚文件 `foundry-server.pre-dev066`。新 pid 2484312 接管，旧进程 853 ms 后退出，healthz 200。nginx `foundry-dev.access.log` 在 21:10:30–21:13:30 记录 659×200、18×304、9×400、6×101、1×404，**0 个 5xx**。这次上线同时带上了共享树中 DEV-063 的 boundary 改动和 DEV-068 的 agent_defaults（编排会话放行）。
- 10-28 21:13 dev Web 通过 `deploy-web-dev.sh` 发布 build `6796efb44e5fdab8`（上一版 `421f79759d57b573` 保存在 `releases/dev066-runner/web/`）。
- 10-28 21:13 dev 服务器设备 执行 `~/.foundry/bin/foundry-worker update`：从 `.1793172116` 升到 `.1793191889`，新 daemon 3 s 后上线（`daemon-health.json` 显示 runner ready、已连接）。运行器 pid 2447427（`/proc/2447427/cmdline` 为 `…/runtime/0.5.7-dev.104.g4d184b2.local.1793172116/…/execution-host/main.js`）进入 pending，因为 DEV-066 和 DEV-068 等会话的回合还在运行，回合结束后切换。
- 10-28 21:15 用户 Linux 开发机 通过一个独立的 `systemd-run --user` 单元执行 `foundry-worker update`（compute 命令跑在 daemon 的 cgroup 里，daemon 重启会连带结束它）：从 `.1793172116` 升到 `.1793191889`，daemon 13 s 后上线。运行器仍是 **dev.53**：pid 1193234，`/proc/1193234/cmdline` 为 `~/.foundry/runtime/0.5.7-dev.53.g8c85186.local.1792641207/node_modules/@bd777/foundry-worker/dist/execution-host/main.js`，自 10-22 12:51 起运行。当时有一个用户回合在跑（`sess_1793189579694075630`，21:12 开始），被正常放行跑完，没有被停止。21:23 已没有回合，但这个回合的受管后台任务 “Watch resumed runs until reproduction finishes” 还在运行，dev.53 把它算作 busy。**这就是此前 6 天切换不过去的原因。** 按规则没有强制切换：后台任务结束后，旧运行器第一次完全空闲时会自动切换；也可以由所有者在设备页点 “立即切换”（该后台任务会被停止）。

## 2026-10-29 Agent 委托验收（用户 2026-10-28 授权）

- 委托：用户 2026-10-28 约 23:35 在编排会话 `sess_1793063405185071529` 中把发布验收委托给 Agent（“验收这块，你先做到你自己去端到端验收，没问题的话，大概率就OK了……”）。以下是独立验收 Agent `sess_1793201829998538711` 在 2026-10-28 23:37 至 2026-10-29 00:40 取得的证据，不代表用户本人测试；只关闭已验证的范围。
- 环境：真实 dev（Web `b0ba3d5929f1811e`，Server `51c00263…`），e2e-alice 登录（密码只由脚本从仓库外文件读取）。DEV-048 合成设备临时用已发布的 Worker `.1793191889` 运行，验后停止；合成工作区 `ws_d4da0f57-…`。一条合成 Codex 会话 `sess_1793202140770104457`（gpt-6.1-sol，8 个短回合）同时用于 DEV-051/054/055/057/063/064/065，验后已归档。截图在 `.foundry/attachments/20261028/acceptance/<item>/`，不入库。
- dev 服务器设备：连接服务 `runtime/current` 指向 `.1793191889`；运行器进程仍加载 `.1793172116`（已运行约 4 小时），尚未切换。
- 用户 Linux 开发机：用户 2026-10-28 约 23:40 决定让运行器等待，后台任务必须继续运行；任务结束后运行器自动切换。这是用户选择的保留限制，本轮没有按 “立即切换”。
- 设备页两行（步骤 1）：e2e-alice 只能看到合成设备；直接运行的合成 Worker 不报告运行器，只有 “Connection service” 一行，无法在此复核。步骤 2–4 沿用实现方 scratch 证据。
- 结论：未关闭，等运行器切换后复核步骤 5。
