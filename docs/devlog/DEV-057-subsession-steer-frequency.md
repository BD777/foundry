# DEV-057 子会话 steer 频率分析

状态：已部署 dev（Server），Worker 已发布、待各设备执行宿主切换；人工验收待确认。用户已于 2026-10-28 批准全部建议（“同意”）。

- 2026-10-28 用户问题：`sess_1793108134561127918` 的子会话 steer 父会话是否过于频繁、打断思考；不合理时 Foundry 应如何从 Prompt 与工程上约束（性能优化，非缺陷）。负责会话 `sess_1793117960617996783`，编排 `sess_1793063405185071529`。
- 2026-10-28 00:23 只读取证完成（Server DB `mode=ro` + 代码），详见 [研究记录](../research/DEV-057-subsession-steer-frequency.md)：证据表、逐条判断、投递机制、六项方案与取舍。
- 结论：频率偏高、打断过多。子→父 11 条全为 steer，其中 4 条真阻塞；父→子 35 条，约 26% 可省或合并（含超时重发的重复、评审中途改目标、向无工具会话催报）；父会话两个编排回合 89+ 分钟未回复用户；23:22 四个会话同时触发用户级 TPM 限流。
- 首轮待决策（已被下一条取代）：①是否采用 agent 间默认汇总投递 + interrupt 额度（建议 T=10 分钟、每 30 分钟 2 次）；②Prompt/brief 约定与幂等发送能否先行；③“会话内没有 Foundry 工具”是否另开事项排查。
- 2026-10-28 补充调查（编排会话追问官方运行时是否支持“工具边界注入”）。只读查阅官方文档、发行说明、本机 Claude Code 2.1.308 / SDK 0.3.311 的类型与 CLI 代码、Codex 0.164.0 的 app-server schema 与 rust-v0.164.0 源码，结论写入研究记录的“运行时官方机制与时机”和“推荐投递模型”两节：
  - Claude：官方默认就是工具边界队列，SDK `priority` 有 `now`/`next`/`later` 三档，Foundry 现在用的 `next` 就是边界语义。
  - Codex 0.164：`turn/steer` 在默认开启的 `instant_interrupt` 下会立即抢占正在生成的响应。父会话收到的 11 条子会话 steer 中，有 7 条打断了正在进行的推理，因此更正首轮“没有中断”的说法。Codex 原生的 agent mailbox 按完成项边界投递，但 app-server 没有开放。
  - 推荐三档 `interrupt` / `boundary` / `turn_end`：agent 默认 `boundary`，Codex 的边界由 Worker 模拟。
  - 修复 “not accepting active steer input”：根因是 Server 把 `queued` 当成可 steer；改为持久收件箱，加回执和 `inputId` 幂等。
  - 成本约 10 人日，其中第一阶段约 3 人日。
- 待决策：①是否采用三档；②Codex 的 `boundary` 用 Worker 模拟，还是关闭 `instant_interrupt`；③第一阶段能否先行；④`interrupt` 额度、`boundary` 最长等待、`turn_end` 冲刷的具体参数；⑤“会话没有 Foundry 工具”是否另开事项。

## 实现（2026-10-28，用户批准后）

用户批准：三档投递；Codex 的 `boundary` 由 Worker 模拟，人类消息的 `instant_interrupt` 不变；第一阶段先行；参数为 interrupt 每发送方每 30 分钟 2 次（超出降级为 boundary 并写进回执）、boundary 最长等 15 分钟、turn_end 最长等 10 分钟、同文本 10 分钟内去重。

### 第一阶段：不丢消息、回执、幂等

- Server 新表 `session_inbox`（`sqlitestore/session_inbox.go`，迁移接在 `setupSessionInputSenders` 之后，删除工作区时一并清理）。凡是会话发出的 `send_message`（不切换运行时），都先写入接收方收件箱，再投递。人类消息的路径不变。
- 状态依次是 `held` → `accepted` → `delivered` → `consumed`，另有 `unknown` 和 `failed`：
  - 接收方 `queued`、回合正在结束，或 Worker 回复 `notSteerable`：消息保持 `held`（原因分别为 `queued` / `not_steerable`）。
  - 设备离线：`held`（原因 `device_offline`）。
  - 设备 8 秒内没有回复：`unknown`。不重发，等设备上报事件后结算。
- 收件箱泵（`RunSessionInbox`，每 3 秒一次；会话状态变化时立即运行）：
  - 会话运行中：把 `held` 的消息 steer 进去，失败退避重试。
  - 会话在两个回合之间：所有未投递的消息（含 `accepted`/`unknown` 但回合已结束、未见事件的）合并成一个新回合的输入，每条标明发送方。
- 事件结算：设备上报的 `evt_<inputId>`（“Steered into active turn”）记为 `delivered`。Codex 原生回显后，Worker 上报 “Steered message read”，记为 `consumed`；这条事件不写入会话记录。新回合启动记为 `consumed`。
- 被拒绝的消息（工作区不再提供服务、助理额度、Skill 校验）当场把错误返回给发送方，与直接发送一致，不进入等待。
- 幂等：`inputId` 必须是小写 UUID，可由发送方提供；同一 `inputId`，或 10 分钟内同一发送方发给同一会话的相同文本，都返回原消息的回执（`duplicate: true`），不会再发一次。
- 回执：`send_message` 的结果新增 `message` 字段，含 `inputId`、`delivery`、`state`、`deliverAt`、`reason`、`downgraded`、`note`。`get_session` 新增 `messages`：待投递消息列表和最近 24 小时按投递方式、状态的计数。另外每次状态变化 Server 都写一行 `session message …` 日志（含等待时长），作为指标。

### 第二阶段：三档投递

- `send_message` 新增 `delivery`（`interrupt` / `boundary` / `turn_end`，会话发出的消息默认 `boundary`）和 `inputId`；CLI `foundry sessions send` 对应新增 `--delivery`、`--input-id`。修正了工具说明里 “Codex queues it for the next one” 的错误。
- interrupt：立即 steer。超出额度降级为 boundary，回执写明 `requestedDelivery` 和 `downgraded`。
- boundary：
  - Codex：Worker（`runner/codex-boundary.ts`）先持有消息，等工具开始运行并持续 1 秒、即模型正在等工具结果时，再 `turn/steer`；工具不到 1 秒就结束时，在结束时投递。最长持有 15 分钟，超时按 interrupt 投递。回合结束时还没投出的，由 Server 合并到下一回合。
  - Claude：沿用 `priority: "next"`，在工具轮次之间投递。
- turn_end：留在收件箱，回合结束后作为下一回合输入；已等满 10 分钟的，按 boundary 冲刷进当前回合。
- 与批准方案的差异：Claude 的 interrupt 仍是 `next`，没有用 SDK 的 `now`。`now` 会中止当前回合，Foundry 的 Claude 回合会以中断时的半截结果结束，消息的回答则变成没有归属的续写。`next` 是不丢工作的最早时机。Claude 的 `consumed` 暂不检测（停在 `delivered`）。
- 兼容性：新 Worker 配旧 Server，没有 `delivery`，行为不变；旧 Worker 配新 Server，boundary 退化为立即 steer，而且旧 Worker 的 “not accepting” 拒绝文本同样会被 Server 认出并保持 `held`。沙箱会话桥（`session/workspace.ts`、`host-child.ts`）原先丢失了发送方，现在会把发送方和投递选项一起传过去。
- Skill：foundry Skill（两份副本内容相同，修订号升到 11）补充了选择 delivery 的规则、一次性提出合同、不发确认、看回执而不重发、评审前先冻结。

### 测试

- Go：`TestInboxHoldsAMessageTheTurnCannotTakeYet`（不可 steer 时保持 → 重试 → accepted → 事件 delivered → consumed，consumed 报告不进入会话记录；设备超时为 unknown、不重发、由事件结算）、`TestInboxTurnEndWaitsThenFlushes`、`TestInboxStartsTheNextTurnAndAdmitsOnce`（排队中保持、重复与同 id 去重、第 3 次 interrupt 降级、回合结束后合并成一个回合、启动后 consumed）。同时更新了观察者顺序测试和 builtinskills 修订号测试，`TestMCPToolsRefuseUnservedWorkspace` 的拒绝语义保持不变。
- Worker：新增 `codex-boundary.test.mjs`（5 项）；`foundry-skill`、`session-steer`、`codex-app-server`（26 通过，原生项受环境门控跳过）、`execution-host`、`foundry-cli`、`issue-steering` 均通过。
- 已知的他人失败，不属本项：`daemon-dispatch`（DEV-055 未完成的 `read_device_file`）；`sqlitestore` 三项（DEV-062 进行中，已由其修复）。

### 后续：人工排队消息也可按 boundary 投递（应 DEV-063 请求）

- `POST /api/chats/{id}/queue/{itemId}/steer` 可选带 body `{"delivery":"boundary"}` 或 `"interrupt"`，值经 `SendAgentSessionInput.Delivery` 传进 steer。不带 body 时行为不变；其他值返回 400。DEV-063 用它在回合中送达对 Codex 提问的回答。测试：`TestChatQueueSteerTakesABoundaryDelivery`。

### 部署安排（2026-10-28 12:20）

- 磁盘曾降到 9.84 GiB，部署因此暂停并告知编排会话；12:20 已回升到 10.55 GiB。
- Server：重新构建的二进制混入了 DEV-062 尚未完成的 `cmd/foundry-server/lifecycle.go` 改写，不能部署。已约定由 DEV-062 随它的部署一起发布本项 Server 改动，不再单独重启。
- Worker：交 DEV-061 发布一次，包含双方改动。
- 发布后在真实 Codex 会话上核实 boundary 持有和 consumed 回执，再补写验收步骤。

### 部署与线上自验（2026-10-28 15:22–15:26 北京时间）

- Server：由 DEV-062 合并部署（本项与 DEV-062 共用一次重启）。PM2 `foundry-server` PID 2281975，`/proc/2281975/exe` 的 SHA256 为 `aa09f6b2ee80fb36…`，与 `releases/dev057-inbox/foundry-server` 一致；`/healthz` 返回 ok，`startedAt=2026-10-28T07:22:14Z`。线上库已建 `session_inbox` 表。回滚二进制为 `foundry-server.pre-dev062`（`61e2c75f…`）。
- Worker：DEV-061 从共享树发布 `0.5.7-dev.104.g4d184b2.local.1793172116`，包内含 `runner/codex-boundary.js` 与 `foundry.input_consumed`。用户 Linux 开发机 的 daemon 已加载新版，但执行宿主仍是 dev.53（忙碌中，空闲后切换）；dev 服务器设备 的执行宿主仍为 `.1793154141`。因此真实 Codex 会话上的 boundary 持有和 consumed 回执尚未在线验证，要等宿主切换。
- 线上合成会话 `sess_1793172170670669593`（Claude，仅执行两次 `sleep 40`）：
  - 07:22:56 发出 boundary 消息：会话尚在排队，回执 `held` / `turn_start`；同文本重发得到 `duplicate: true`，没有第二条。
  - 07:24:19 首次投递时 Worker 回复不可 steer，消息保持 `held`（`not_steerable`）——这正是此前编排会话遇到的拒绝，现在不再丢失。07:24:21 回合可接收后投递，转为 `accepted`，随后 `delivered`。
  - turn_end 消息在回合中保持 `held`，07:26:10 回合结束后作为下一回合输入，随即标为 `consumed`；会话回复确认收到原文。
  - Server 日志逐条记录了每次状态变化和等待时长。
- 自验中发现：turn_end 消息在会话排队时，回执写的是 `deliverAt: when_steerable`，应为 `turn_end`。已修复（`receiptFor`）并于 15:43 部署。
- 本地补充：`codex-boundary.test.mjs` 新增端到端用例。在 Codex 流中，boundary steer 在推理期间被持有，工具开始约 1 秒后才进入回合；interrupt 立即进入；回显后上报 “Steered message read”，未知 id 不上报。共 6 项全部通过。按 DEV-061 的提示，`runner/codex-boundary` 已登记到 `scripts/audit-module-boundaries.mjs`，三个 Worker 文件已用 prettier 格式化。

### 人工验收步骤

1. 在任一编排会话中，对一个正在运行的子会话调用 `send_message`，`delivery` 设为 `boundary`。预期：结果里有 `message.state`，取值 `accepted` 或 `held`，并带 `deliverAt`；`get_session` 的 `messages` 能看到这条消息。
2. 对一个刚创建、仍在排队的会话发同一条消息两次。预期：第一次 `held` / `turn_start`，第二次 `duplicate: true`；会话开始后只收到一次。
3. 发一条 `turn_end` 消息给运行中的会话。预期：回合中不打断，回合结束后作为下一回合输入；对方回复中能看到原文。
4. 30 分钟内对同一会话发 3 次 `interrupt`。预期：第 3 次回执带 `requestedDelivery: interrupt`、`delivery: boundary` 和 `downgraded` 说明。
5. 设备执行宿主切换到 `.1793172116` 后，对正在运行、会调用工具的 Codex 会话发 `boundary` 消息。预期：推理过程中不出现 “Steered into active turn”；下一个工具开始运行约 1 秒后才出现；状态依次变为 `delivered`、`consumed`。

### 编排会话的后续要求（2026-10-28 15:40–15:44）

- `TestRenamedToolArgumentsKeepTheirOldNames`：按新语义更新。对等待设备的会话，再发相同文本，返回第一条消息的回执（`duplicate`），不再拒绝；发不同的消息则保持 `held`。两轮循环改用不同文本，避免触发 10 分钟去重。
- “Waiting for … to start this message…” 提示原先用连接上报的主机名（如 `VM-x-y-debian`），现改用 Foundry 中设备的显示名（如 `dev 服务器设备`，`session_start_notice.go` 改用 `deviceLabel`）。
- 以 DEV-062 的 SIGHUP 零停机交接部署：15:43:56 新进程 2304941 接管，旧进程 347 ms 后退出；`/proc/2304941/exe` 的 SHA256 为 `edac08df5a13b9fc…`，`/healthz` 返回 ok。回滚为硬链接 `dev023-candidate/foundry-server.pre-dev057`（即 `aa09f6b2…`），没有额外占用磁盘。
- 部署前通知了运行中的 DEV-066，消息用 `turn_end` 发出，线上回执为 `held` / `deliverAt: turn_end`，没有打断它。
- 截至 15:44，线上收件箱共 16 条：boundary 消费 6、投递 8，turn_end 消费 1、等待回合结束 1，没有失败或丢失。
- `scripts/check-changed.sh`：Go httpapi 中的失败只剩上面那条（已修复）；prettier 只报 `mcp_tools.json`，已格式化；worker 40 个测试文件、protocol、web tsc、audit:contract、audit:modules 均通过。
- 磁盘：部署后为 9.95 GiB，略低于 10 GiB 下限。本项已删除自己的重复二进制和临时文件，不再写入。
