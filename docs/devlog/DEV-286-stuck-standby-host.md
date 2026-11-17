# DEV-286 旧执行宿主长期不退出，阻塞设备定时器

状态：已部署 dev（2026-11-18）；Agent 代验收（2026-11-18，范围见验收记录）；已合入 main（PR #277）。

## 案例（2026-11-18，byte-dev）

- 会话 `sess_1794913474912095168` 的两个定时器（`work_35063ad1…`、`work_066cdc6c…`）显示「Scheduler disconnected」，`confirmedRevision` 自 12:44Z 起为 0，并有「2 control(s) awaiting device confirmation」。
- byte-dev 同时运行两个执行宿主：当前宿主（`foundry-execution-eb05747fba8c6c8d`，root `execution-hosts/2943183e5ade`，01:10 启动）处于待命（standby），因为 `seniorHostPresent` 发现更早启动的 `foundry-execution-ac1240441bb2e2ba`（root `execution-hosts/8f1fd6ea21c3`，2026-11-13 启动）仍然存活。
- 旧宿主没有 claim、没有子会话，心跳新鲜，owner.json 指向当前 daemon。它从不退出，于是新宿主推迟了所有会话工作（`deferred-session-work.json`），也没有任何工作监督者向调度器发心跳。
- 编排者 17:36Z 手动停止旧服务单元，约 10 秒内新宿主接管，两个定时器在 17:37:29Z 确认（rev 1）。

## 根因（代码证据）

两条路径各自让这种状态永久化：

1. **待命宿主只看「是否存活」，不看对方是否已退役。**
   `packages/worker/src/execution-host/roots.ts` 的 `seniorHostPresent` 对任何存活的、更早启动的宿主都返回 true。daemon 已经让旧宿主 `retire`（`server.ts` 的 `retire` 处理器）并停止了它的定时器恢复，但待命宿主完全不知道这件事，于是永远等下去。旧宿主退役时既不停心跳，也没有任何文件标记。

2. **退役宿主卡在「忙」状态时，daemon 永远不停它。**
   `packages/worker/src/execution-host/fleet.ts` 的 `drainRetiring` 只在 `drainDecision` 返回 `switch` 且 `prepare_upgrade` 返回 ready 时才停止宿主。`drainDecision` 在「没有 turn、没有后台任务，但 `busy` 为真」时返回 `switch boundary`；而 `atTurnBoundary()` 还要求 `sessionWorkBusy()`、`operations`、`scheduled()` 等都为零。只要其中任一个卡住，`prepare_upgrade` 永远不 ready，宿主永远不被停止，也没有任何升级路径。`switchNow` 只在人工「立即切换」时使用 `now`，自动路径没有。

未在本次会话中直接读取 byte-dev 上旧宿主的快照（`busy` 的具体来源与 outbox 计数未取证），因此「是哪一个计数卡住」仍是待确认项，见下文「限制」。

## 修复

- `roots.ts`：新增 `retiring` 标记文件（`markHostRetiring` / `hostIsRetiring`）。`seniorHostPresent` 忽略被 daemon 退役的更早宿主，它已经停止心跳并暂停定时器恢复，不再持有设备共享工作。
- `server.ts`：`retire` 处理器写入/清除该标记，并调用 `observedSessionWork()?.setDraining(next || draining)`，让退役宿主停止心跳（与升级排空一致）。启动时清除陈旧标记。`cancelUpgrade` 改为按 `retiring` 恢复 `setDraining`，避免取消升级时误把退役宿主的心跳打开。
- `fleet.ts`：`drainRetiring` 新增一条路径：宿主没有 turn、没有后台任务、没有忙碌的常驻 agent，且这种「安静」状态持续 `retiredIdleStopMs`（120 秒，可由 `timing.idleStopMs` 覆盖）后，以 `now` 模式停止。outbox 非零仍然先不停（信封先经活跃链路投递），与原有保证一致；有 turn 或后台任务时仍只等待，「忙的 senior 先完成 turn」保持不变。
- 未改变：同一时间只有一个设备工作所有者（待命宿主仍只在前一个宿主不再存活或已被 daemon 停止时接管）；运行中的 turn 不会被停止。

## 检查

- byte-dev（lease `lease_9046395db357ac73955f`，已释放），`scripts/remote-check.sh --worker test`：
  - `host-rollover.test.mjs`：24/24 通过，包含两个新用例：
    - 「a retired host that is idle but refuses the gentle switch is stopped after its quiet period」：默认时长内不停；`idleStopMs: 0` 时以 `now` 停止，新宿主保持运行。
    - 「a senior host the daemon retires does not hold the device's work」：标记写入后不再被待命，清除后恢复。
  - `runner-drain.test.mjs` 6/6，`execution-host.test.mjs` 3/3，`execution-host-stall.test.mjs` 1/1。
  - `npx tsc --noEmit`（packages/worker）通过。
- 未部署，未提交（按 brief）。

## 时间线

| 时间（UTC / 本地）    | 事件                                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 17:46Z / 01:46        | 孤儿宿主 pid 60476（root `execution-hosts/deb3ea129b81`，runtime `…1794937039`）启动。                                                                                                                                                                 |
| 18:06Z                | 前任宿主 `a1a8fdd534f1`（pid 99092）启动。                                                                                                                                                                                                             |
| 18:28:27Z             | 当前宿主 pid 43631（root `execution-hosts/5c010783f3e0`，runtime `…1794940019`）启动；前任 `a1a8fdd534f1` 被正确停止（`stopped` 标记）。                                                                                                               |
| 18:33Z（编排者检查）  | 孤儿宿主仍存活、心跳新鲜，所有 claim 已完成，无 outbox、无 `retiring` 标记。                                                                                                                                                                           |
| 2026-11-17，286b 跟进 | 只读核查：当前宿主根目录没有 `deferred-session-work.json`，但这不能证明它未待命（见「286b」）；孤儿宿主是 launchd 作业 `app.foundry.execution.126939481ca9ea27`（`KeepAlive`），用 kill 会被拉起，只能 `bootout`。定时器阻塞未能确认，未停止孤儿宿主。 |
| 2026-11-18            | Agent 代验收（编排者）：train 54 之后，守护进程把遗留宿主标记为退役；当前宿主负责定时器；byte-dev 18:06Z 的宿主在 claim 结束后停止；Mac mini 的遗留宿主只因一个后台任务仍在运行而存活（符合排空规则）。                                                |

## 286b 修复（跟进）

**根因**：孤儿宿主已被 daemon 退役（`retiring: true`，runtime `…1794937039` 带 `rollover` 能力，其 `retire` 处理器会暂停定时器恢复），但标记只由宿主自己的 `retire` 处理器写入（`server.ts` 的 `retire`）。`fleet.ts` 的 `refreshRetiring` 在快照已是 `retiring` 时不再发 `retire`，于是没有任何路径写标记，`roots.ts` 的 `seniorHostPresent` 继续把它当作待命的前任。

**修复**（`fleet.ts`，`refreshRetiring`）：

- 宿主具备 `rollover` 能力且最新宿主健康时，daemon 在 `retire(true)`（若尚未退役）之后写入 `retiring` 标记；已有标记则不重写。
- 最新宿主不健康、进入 `retire(false)` 宽限分支时，daemon 清除标记。
- 不具备 `rollover` 能力的旧宿主不写标记：它们不会暂停定时器恢复，标记会造成双重所有者。它们仍会阻塞待命，需要人工停止（见「限制」）。
- 排空规则不变：`drainRetiring` 的忙碌等待、outbox 等待、安静期后停止，以及「运行中的 turn 不被停止」都未改动。

**测试**（`host-rollover.test.mjs`，新增 3 个）：

- 「an older host retired by an earlier daemon is marked, stopped once idle, and the current host takes the work」：标记后 `seniorHostPresent` 为 false，`idleStopMs: 0` 时停止，新宿主保持运行。
- 「an older host with an active claim is marked but not stopped until the turn ends」：有 claim 时标记但不停；claim 结束后停止。
- 「an older host without the rollover capability is not marked」：无能力的旧宿主不写标记，也不停止。

**检查（286b）**：

- byte-dev `scripts/remote-check.sh --worker test host-rollover.test.mjs runner-drain.test.mjs execution-host.test.mjs execution-host-stall.test.mjs`（`--tree` 为 `fix/dev286b` 工作树，`--base HEAD`）：37/37 通过（host-rollover 27，runner-drain 6，execution-host 3，execution-host-stall 1）。首次运行中两个用例（claim 结束后停止；无能力宿主不停止）失败，原因是测试断言本身：前者需要显式刷新一轮 fleet，后者错误地断言了旧宿主不会被空闲停止。已修正测试，代码未变。
- `npx tsc --noEmit`（packages/worker）通过（exit 0）。
- 未部署，未提交，未更新 Worker。

## 限制（286b）

- 当前宿主是否真的处于待命，仍未在 Mac mini 上直接证明（没有读取其 `standby` 内存状态）。`deferSessionWork` 只设置内存标记，文件只在会话挂接时才写入。
- 无 `rollover` 能力的前任宿主不会被标记，因此仍会阻塞待命。Mac mini 上的孤儿宿主具备该能力，不在此限制内。
- 若部署时 `retire(true)` 从未对孤儿宿主成功发送（其快照状态未读取），标记路径会在下一次刷新时补写，但停止仍依赖 `prepare_upgrade`，需在部署后观察。

## 限制

- 未复现 byte-dev 上的具体卡住状态：没有读取旧宿主快照（busy 来源、outbox、sessionWorkBusy）。新路径保证「安静且无 turn 的退役宿主最终会被停止」，但若卡住原因是 outbox 非零，仍不会停，需要在 byte-dev 上只读确认后再决定是否调整。
- 「待命宿主向用户报告卡住原因」（调度器就绪原因指出持有工作的宿主）未实现，保留为后续项。
- 其他设备（CanWendeMac-mini、macbook、sg-chaos、byte-dev-sg、cottoncpp、limen-canada）上是否存在多个 `foundry-execution-*` 宿主或待命宿主，本次未逐台只读核查，未停止任何宿主。
