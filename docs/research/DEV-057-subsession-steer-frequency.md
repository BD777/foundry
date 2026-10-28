# DEV-057 子会话 steer 频率分析

状态：用户已于 2026-10-28 批准全部建议并进入实现。实现记录（含与方案的差异：Claude 的 interrupt 仍用 `next`）见 [devlog](../devlog/DEV-057-subsession-steer-frequency.md#实现2026-10-28用户批准后)。下文保留分析时的原始结论。

问题（用户，2026-10-28）：`sess_1793108134561127918` 和它的子会话之间来回发消息，用户觉得子会话 steer 父会话太频繁，总在打断它思考。要判断两件事：对这个任务来说，这样高频的交互合不合理；如果不合理，Foundry 应该在 Prompt 和工程上怎样约束。用户的定位是性能优化，不是缺陷。

范围：只读。数据来自 Server DB（`agent_session_events`、`session_input_senders`、`agent_sessions`，用 `mode=ro` 打开）和本仓库代码，没有给这些会话发消息，也没有改动它们。时间都换算成北京时间（UTC+8）。统计截止 2026-10-28 00:23:30，这时父会话和三个子会话还在运行。

## 结论

**频率偏高，打断太多。需要优化，不建议维持现状。**问题主要不在某个子会话话多，而在协作方式本身。

- 这个任务确实需要实时协调，不能全部改成异步：两个仓库之间要定证据合同，产品 baseline 的事实在父会话手里，两个 writer 还共用同一把部署锁。11 条子→父消息里，有 4 条是真阻塞，必须马上处理。
- 低效来自交付方式。46 条 agent 间消息中，35 条（76%）以 steer 形式注入正在运行的回合，没有分级，也没有合并，每条都落进一个约 575k token 的父会话上下文。父会话自己发出的更多：35 条，是收到的 3 倍。其中有重复发送、对正在评审的会话改目标、催一个根本没有回复工具的会话报状态。
- 结果是父会话两个编排回合加起来跑了 89 分钟以上，用户一次都没收到回复。用户只好在 00:06 和 00:16 自己插话，问进展、问它有没有忘了主线。23:22 时，所有运行中的会话同时触发了用户级 TPM 限流。

## 证据

### 会话

| 会话             | 角色                                    | 期间状态                                             |
| ---------------- | --------------------------------------- | ---------------------------------------------------- |
| `…8134561127918` | 父会话（Codex，high effort）            | 22:46 起进入编排回合                                 |
| `…2506867687150` | 子会话：BBC 复现证据合同（跨两个仓库）  | 运行中                                               |
| `…2560202529645` | 子会话：资源初始化与就绪                | 运行中                                               |
| `…9633886834738` | 子会话：部署器只读复核                  | 22:00–22:18，已完成                                  |
| `…4428972910611` | 子会话：onboarding 只读复核             | 运行中，曾排队                                       |
| `…1702804858039` | 子会话：Skill 离线试运行                | 1 分钟，已完成                                       |
| `…2143456622224` | 用户 23:31 交给父会话管理的四表迁移会话 | 一个回合从 21:55 跑到 00:14，会话内没有 Foundry 工具 |

### 子→父：11 条，全部是 steer

| #   | 时间     | 发送方 | 字数 | 类型                                      | 父会话的反应                                                        | 判断                       |
| --- | -------- | ------ | ---- | ----------------------------------------- | ------------------------------------------------------------------- | -------------------------- |
| 1   | 22:52:35 | …7150  | 319  | 早期发现（brief 要求“尽早回报”）          | 3 分钟后回复“收到，继续…”并补充范围                                 | 有用，可以等回合边界       |
| 2   | 22:58:19 | …7150  | 878  | 决策请求：生产者在另一个仓库，问由谁改    | 约 9 分钟后授权扩大范围（23:07:39）                                 | **阻塞**                   |
| 3   | 23:07:48 | …7150  | 815  | 字段合同提案                              | 和父会话的授权只隔 9 秒，消息交错；父会话没有回应，继续写自己的代码 | 可省                       |
| 4   | 23:14:39 | …7150  | 393  | 请父会话提供 baseline 事实                | 63 秒后反问                                                         | **阻塞**                   |
| 5   | 23:16:33 | …7150  | 454  | 回答父会话的提问                          | 采纳，去 clone 知识仓库                                             | **必要**（是被要求的答复） |
| 6   | 23:36:55 | …7150  | 402  | 限流恢复后的状态，加一个“文件 owner 是谁” | 6 分钟后回答 owner                                                  | 部分必要                   |
| 7   | 23:37:32 | …9645  | 657  | 恢复后上报阻塞：supervisor 恢复该谁调度   | 5 分钟后授权                                                        | **阻塞**                   |
| 8   | 23:54:09 | …7150  | 266  | 确认 baseline 编码，附进度                | 不需要回应                                                          | 可省                       |
| 9   | 00:09:17 | …9645  | 441  | 自称“必要检查点”：MR 已合入，新 MR 在做   | 之后部署了 master                                                   | 有用，不紧急               |
| 10  | 00:15:30 | …7150  | 562  | 实现可评审，请求复核                      | 00:22 安排了复核                                                    | 必要（交付），不紧急       |
| 11  | 00:23:04 | …9645  | 528  | 最新动作的状态                            | —                                                                   | 可省                       |

合计：必须马上打断父会话的 4 条（#2 #4 #5 #7），有价值但可以等边界或合并发的 4 条，可以省掉的 3 条。中位间隔 7.2 分钟，最短 0.6 分钟。从 22:48 起（扣除限流停摆的 13 分钟），平均每小时 8.0 条。

### 父→子：35 条，其中 24 条是 steer

| 接收方       | 条数                                   | 问题                                                                                                                                                                                                                                                                                                             |
| ------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| …4738 评审   | 17 分钟内 8 条（4 个回合，4 条 steer） | 首轮评审进行中，22:02 和 22:03 连发两条 steer：“最终以我下一条锁定的 head 为准”，第二条锁定新 head；22:10 和 22:12 又各补一条。评审对象一直在变，前后共评了 4 轮。先冻结 head 再提交评审，可以减少约 3 条                                                                                                        |
| …2224 迁移   | 1 个回合里 10 条 steer                 | 21:56、21:58、22:10 三条内容几乎一样。21:56 那条 `send_message` 返回 “did not answer within 8 s”，实际上 1 秒前已经送达，于是被重发。23:19 要求“立即发我当前迁移实质状态”，可对方会话没有 Foundry 工具，不可能回复；父会话只能靠 `read_context` 和 `get_session` 轮询，共 45 次。22:24 和 22:26 两条可以合成一条 |
| …7150 合同   | 9 条（2 个回合，7 条 steer）           | 多数在回答对方的问题。有 1 条只是确认（“收到，继续”）；23:53 和 23:59 把 baseline 分两次发，可以合并                                                                                                                                                                                                             |
| …9645 资源   | 5 条（2 个回合，3 条 steer）           | 基本合理                                                                                                                                                                                                                                                                                                         |
| …0611、…8039 | 3 个回合                               | 合理（brief 和恢复各一次）                                                                                                                                                                                                                                                                                       |

估计 35 条里约 9 条（26%）可以省掉或合并。…7150 和父会话从 22:52 到 23:59 互发了 14 条 steer，实际是在用中断的方式，借父会话的大上下文，一点一点谈合同字段和 baseline 编码。

### 对父会话的影响

- **会打断正在进行的推理（2026-10-28 补充调查后更正）。**之前写的是“没有中断任何回合或命令”，这对工具成立：steer 不会停掉正在执行的命令。但对模型推理不成立。父会话用的 Codex 0.164 默认开启 `instant_interrupt`，steer 一到，正在生成的模型响应就会被抢占（见下文“运行时官方机制”）。事件里能看到：11 条子会话 steer 中有 7 条到达时，父会话正有一个推理项在生成，这些推理项之后再也没有完成，紧接着就是新的推理项。这个数只是下限，因为请求已经发出、但第一个推理项还没开始的情况，事件里看不到。父会话对其他会话发出的 steer 也一样：…2224 有 5/10、…4738 有 2/4 打断了正在进行的推理。所以用户说的“频频打断思考”是字面意义上的。此外，下一次采样时多了一条要处理的 user 消息，父会话得重新规划，常常还要回一条消息。从 steer 送达到父会话下一个可见动作，中位约 30 秒；最长三次分别是 4.4、4.8、5.7 分钟，基本是 575k 上下文在 high effort 下的单次推理时间。
- **回合不结束，用户看不到进展。**两个编排回合，一个从 22:46 到 23:22（36 分钟，被 TPM 限流打断），一个从 23:30 到 00:23 还在跑（53 分钟以上），期间进来 11 条子会话 steer 和 3 条用户 steer。用户 00:06 问“你现在跟进的事项都有哪些……是不是往边边角角钻牛角尖了”，00:16 再次插话。steer 在不断延长回合，让父会话一直没有机会回答用户。
- **token。**编排窗口内，父会话有 43 次模型请求、2423 万输入 token，单次中位 575k。其中 28 次（65%，1595 万）带 Foundry 协调调用，16 次（905 万）发了消息。父会话每多一次采样约 0.55M 输入 token，大部分是缓存读。
- **限流。**23:18，运行中的四个会话每分钟合计 413 万输入 token，是这段时间的峰值。23:21:51–23:22:21，父会话和三个子会话（…7150、…9645、…0611）同时报 `user tpm rate limit exceeded`，恢复用了 13–21 分钟。大上下文是主要原因，协调消息不是唯一原因；但 23:14–23:19 正好有 5 条消息在来回，每条都会在两端引起额外采样。网关 TPM 是否计入缓存 token 未知，所以这里只能说“推高了负载”。

口径：token 数取 Codex 每次请求上报的 context `inputTokens`，没有区分缓存读。消息必要性是逐条读原文后的人工判断，表里已写明理由。

## 机制（代码）

| 环节         | 现状                                                                                                                                                                                                                                                                                                                | 位置                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 投递         | `send_message` 只有一种投递方式：接收方运行中就 steer，空闲就作为下一轮输入。没有紧急程度、批量或延迟选项；内部虽有 `RequireIdle`，但 MCP 没有暴露                                                                                                                                                                  | `apps/server/internal/httpapi/session_service.go` `sendSessionMessageWith`、`mcp_sessions.go` `sendMessageForMCP` |
| Codex        | app-server `turn/steer`（`expectedTurnId`），把消息注入当前活动回合；不会停工具，但 0.164 默认的 `instant_interrupt` 会抢占正在生成的响应（更正，见下文）                                                                                                                                                           | `packages/worker/src/runner/codex-app-server.ts` `steer()`、`codex-stream.ts`                                     |
| Claude       | 往输入流推一条 `priority: "next"` 的 user 消息，等当前这批工具调用结束后并入同一回合；与 Codex 不同，不会抢占正在生成的内容（更正，见下文）                                                                                                                                                                         | `packages/worker/src/runner/claude-turn-controls.ts` `steerClaudeTurn`                                            |
| 接收方看到的 | 只多一句前缀 “Foundry message source: another agent session (id)…”，看不出消息是阻塞还是 FYI，也看不出发送方是子会话还是同级、还有几条在排队                                                                                                                                                                        | `packages/worker/src/session-prompt.ts` `userMessageText`                                                         |
| 超时         | steer 等待设备确认 8 秒（`sessionControlTimeout`）。超时后告诉发送方 “try again”，但消息可能已经送达，于是被重发（本例 21:56→21:58）                                                                                                                                                                                | `session_service.go:27`、`http_responses.go`                                                                      |
| 等待         | `wait_session` 只能等状态（completed、failed 等），不能等“有子会话需要我处理”，所以父会话只能轮询                                                                                                                                                                                                                   | `mcp_sessions.go` `waitSessionForMCP`                                                                             |
| 文档         | `send_message` 的工具说明写着 “Codex queues it for the next one”，实际上 Codex 也是注入当前回合，事件就是 “Steered into active turn”。说明有误                                                                                                                                                                      | `apps/server/internal/httpapi/mcp_tools.json`                                                                     |
| 指引         | foundry Skill 的“Coordinate with other sessions”一节和 `send_message` 的说明已经写了什么时候可以发中间消息，但条件里的“接口或合同变化”和“约定的检查点”太宽，在谈合同的任务里几乎条条消息都能套上（子会话自己就标了“必要检查点”）。父会话的 brief 一边要求“尽早回报”“尽早给出文件名”，一边要求“完成发一次”，自相矛盾 | `packages/worker/skills/foundry/SKILL.md`、`mcp_tools.json`                                                       |

题外发现：…2224 和 …9645 都说过“本会话没有 Foundry tools / CLI 拒绝凭据”，所以中间的阻塞没能发出去。这会迫使父会话轮询，建议单独立项排查，不在本项范围内。

## 改进方案（按收益和成本排序）

| 排名 | 方案                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 类型   | 成本                                                  | 在本例中能减少多少                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1    | **消息分级加汇总投递。**`send_message` 增加 `delivery: interrupt \| batch`：用户消息和 `interrupt` 照旧立即 steer；agent 发给 agent 默认 `batch`，先放进 Server 端的接收方收件箱，每隔 T 分钟（默认 10，接收方或编排者可以调）合成一条 steer 投递，接收方回合结束时则作为下一轮输入。同一发送方的多条按顺序保留全文，标明发送方和条数。回执告诉发送方“已排入 hh:mm 汇总”。每个发送方每 30 分钟最多 2 次 `interrupt`，超出降级为 batch 并告知。整套在 Server 实现，与 Codex 和 Claude 无关             | 工程   | 中（3–5 天：store、投递、MCP schema、Web 展示、测试） | 打断父会话 11 次 → 约 4 次；…7150 那条“提案、授权、确认”的乒乓链可以在汇总里一次说完                 |
| 2    | **Prompt 和 brief 约定。**Skill 和 `send_message` 说明里给出分级：`blocker`/`decision`（我没有 X 就不能继续）和 `handoff`（交付）才用 interrupt，其余写进自己的记录或最终交付。禁止“收到/继续”式确认。自己能查到的事实先自己查。合同一次提完整提案，不要一点点谈。评审前先冻结 head，评审过程中不推新 head，等它结束再开一轮。发送超时先用 `get_session`/`read_context` 核对有没有送达，不要直接重发。brief 模板固定写“汇报约定：只报阻塞和最终结果”，不再写“尽早回报”。同时修正 Codex 投递说明的错误 | Prompt | 低（约 1 天，加 skill 双份一致性测试）                | 可以省掉约 9 条父→子消息和 3 条子→父消息。效果取决于模型是否遵守，本例里模型已经在借宽泛条件自圆其说 |
| 3    | **不用 steer 的状态通道，加按需等待。**新增 `report_progress`，写入一条结构化状态（阶段、head、阻塞、下一步），在 `get_session`、`list_session_work` 和 Web 上可见，但不 steer 接收方。`wait_session` 支持 `until: ["attention"]`：任一子会话发出 interrupt、完成或失败时返回                                                                                                                                                                                                                         | 工程   | 中                                                    | 替代 #8、#9、#11 这类状态消息和 23:19 那次催报；45 次轮询基本可以变成少量阻塞式等待                  |
| 4    | **幂等发送。**`send_message` 返回 `inputId`，超时返回“送达未知，inputId=…，先核对再重发”。Server 对同一发送方、同一接收方、10 分钟内文本相同的消息去重                                                                                                                                                                                                                                                                                                                                                | 工程   | 低（约 1 天）                                         | 消除 21:56/21:58 这类重复                                                                            |
| 5    | **编排者纪律。**编排回合只做派发、`wait_session(attention)`，最后给用户一段状态说明；深度实现交给子会话。本例中父会话一边编排，一边亲自写 onboard.py、查 SCM baseline，所以 steer 总是落进它深度工作的中间                                                                                                                                                                                                                                                                                            | Prompt | 低                                                    | 回合变短，用户能及时看到进展                                                                         |
| 6    | **指标。**按会话统计：每小时收到的非用户 steer（按发送方分）、每回合 steer 数、interrupt 与 batch 的比例、协调采样的 token 占比、重复和纯确认消息、多久没有给用户回复。发送回执里附软提示，如“近 20 分钟你已给 X 发了 4 条，请合并”                                                                                                                                                                                                                                                                   | 工程   | 低                                                    | 用来调 T、interrupt 额度和 Prompt                                                                    |

建议顺序：先上 2 和 4（低成本、立即见效），再上 1 和 3（结构性解决），6 跟着 1 一起上线，用来确认效果。

2026-10-28 更新：方案 1 的二档 `interrupt|batch` 由后文“推荐投递模型”的三档（`interrupt` / `boundary` / `turn_end`）取代，原来的汇总窗口 T 并入 `turn_end`。

取舍：

- **真阻塞会不会被拖慢？**保留 `interrupt`，用户消息永远立即投递。误标为 batch 的阻塞最多晚 T 分钟；发送方在这段时间继续做独立工作，Prompt 里明确规定“没有 X 就停”的情况必须用 interrupt。
- **interrupt 被滥用。**用每个发送方的额度限住，超出降级并告知；6 里的指标会把滥用暴露出来。
- **会不会丢上下文？**汇总只是拼接，保留每条原文，不做摘要，所以不会丢信息。“后一条取代前一条”只在发送方明确声明时生效。
- **纠偏会不会变慢？**用户 00:16 明确要求父会话及时 steer、纠正子会话，纠偏仍应走 `interrupt`。方案减少的是噪音，不是纠偏。
- **回合边界不可靠。**长回合可能一小时都不结束，所以只靠“下个回合边界再投递”不够，必须配合 T 分钟的汇总窗口。

## 运行时官方机制与时机（2026-10-28 补充调查）

问题：除了“排到回合结束”和“立即 steer”，官方 Claude Code / Agent SDK 和 Codex 是否支持在回合内的自然边界（例如工具调用之后）注入外部输入？这是否是官方推荐的时机？“立即 steer”是否本来就只在边界生效？

版本：Foundry Worker 的 SDK 依赖是 `@anthropic-ai/claude-agent-sdk` 0.3.201，设备托管运行时实际用的是 Claude Code 2.1.308 + SDK 0.3.311 和 Codex CLI 0.164.0。本例中父会话和子会话都是 Codex 0.164.0。

### Claude Code / Agent SDK：官方支持边界投递，而且这就是默认行为

| 机制                                                                                          | 时机                                                                                                                                                                                                                                                                                             | 出处                                                                                                     |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| CLI 里，Claude 工作时按 Enter                                                                 | 不打断回合，消息先排队。“if you queue a message while Claude is running tool calls, Claude Code passes it to Claude as soon as those tool calls finish, within the same turn. When the turn ends with messages still queued, they go out…”。斜杠命令和 `!` 命令要等回合结束                      | [Interactive mode › Queue messages while Claude works](https://code.claude.com/docs/en/interactive-mode) |
| 维护者说明（2026-08-17）                                                                      | “delivered to Claude at the next tool-call boundary within the current turn… so Claude can change course without you pressing Escape and losing in-progress work. The only time it waits until the end is when Claude is producing a text-only reply”                                            | [anthropics/claude-code#64624](https://github.com/anthropics/claude-code/issues/64624)                   |
| Esc / Ctrl+C，`Query.interrupt()`                                                             | 停止当前响应或工具，已完成的工作保留，排队的消息接着发                                                                                                                                                                                                                                           | 同上；`sdk.d.ts` `interrupt()`                                                                           |
| Ctrl+Enter（发送队列，v2.1.275+）                                                             | 能转入后台的工作转入后台，同一回合内读消息；否则打断回合（v2.1.281 起）                                                                                                                                                                                                                          | 同上                                                                                                     |
| SDK `SDKUserMessage.priority: 'now' \| 'next' \| 'later'`                                     | 类型定义里没有说明文字，以下是从 2.1.308 CLI 代码读出的：`now` 一入队就中止当前回合（`abortController.abort("interrupt")`）；`next` 在工具轮次之间并入当前回合（类型文档原文：“queued user message folded into the running turn between tool rounds”）；`later` 不在回合中途并入，等回合结束再发 | `sdk.d.ts` 的 `SDKUserMessage`、`SDKResultMessage.user_message_uuids`；CLI 打包代码                      |
| Hook 的 `additionalContext`（PreToolUse、PostToolUse、PostToolBatch、Stop、UserPromptSubmit） | 工具前后或停止时，往模型上下文追加文字，是“上下文”，不是用户消息                                                                                                                                                                                                                                 | `sdk.d.ts` 的 `*HookSpecificOutput`                                                                      |

结论：Foundry 现在给 Claude 用的就是 `priority: "next"`，即官方的“工具边界队列”，本身已经是边界语义。纯文本回答期间不会插入，会留到回合结束。

### Codex：用户 steer 立即抢占；agent 之间的消息才按边界投递，但 app-server 没有开放

| 机制                                                     | 时机                                                                                                                                                                                                                                                                                                              | 出处                                                                                                                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TUI：工作中按 Enter（steer），按 Tab（排队）             | Enter 把指令注入当前回合，Tab 排到下一回合（斜杠命令和 shell 命令同理）；另有 `codex queue --thread … --message …`                                                                                                                                                                                                | [Codex CLI slash commands](https://developers.openai.com/codex/cli/slash-commands)；[openai/codex#9077](https://github.com/openai/codex/pull/9077)；本机 `codex queue --help` |
| 0.163.0 起默认“立即 steer”                               | 发行说明：“Send a follow-up while Codex is responding to steer it immediately”，“Enable instant interrupts by default”（#51812）                                                                                                                                                                                  | [rust-v0.163.0](https://github.com/openai/codex/releases/tag/rust-v0.163.0)                                                                                                   |
| `instant_interrupt`（0.164：UnderDevelopment，默认开启） | “Preempt responses and yield foreground code-mode observations on new user input”。`watch_user_input` 一看到待处理的用户输入，就取消本次采样（`or_cancel(&preempt)`）。HTTP 流直接丢弃，WebSocket 流先 drain，然后带着这条输入重新采样。工具不会停                                                                | `codex-rs/features/src/lib.rs`、`core/src/session/turn.rs`、`input_queue.rs`（tag rust-v0.164.0）                                                                             |
| 0.164.0：待处理的注入会打断 `wait_agent` 和 `sleep`      | “Make pending injections interrupt agent waits and sleep”（#55644）                                                                                                                                                                                                                                               | [rust-v0.164.0](https://github.com/openai/codex/releases/tag/rust-v0.164.0)；[#55644](https://github.com/openai/codex/pull/55644)                                             |
| 关闭 `instant_interrupt` 时（≤0.162 的行为）             | 输入要等当前采样请求，以及其中的工具调用返回后才被取走。一个长流可以把 steer 压住几分钟                                                                                                                                                                                                                           | [openai/codex#40805](https://github.com/openai/codex/issues/40805)                                                                                                            |
| 内部的 agent 间 mailbox                                  | 只在推理或 commentary 项完成后的边界抢占，不切断工具调用（“Hosts can keep the current response intact and deliver mail before the next model request”）。`defer_mailbox_preemption` 可以推迟到下一个正常输入边界；`trigger_turn=false` 的邮件只随下一回合投递                                                     | `turn.rs`（`preempt_for_mailbox_mail`）、`input_queue.rs`、`features/src/lib.rs`                                                                                              |
| app-server 对外的接口                                    | 只有 `turn/start`、`turn/steer`（`expectedTurnId` 不匹配就失败；review/compact 回合不能 steer，见 `NonSteerableTurnKind`）、`turn/interrupt`。有 `thread/queue/changed` 通知，但没有供客户端入队的方法。`turn/steer` 返回成功只说明已入队，不说明模型已经读到；要看 `clientUserMessageId` 对应的 userMessage 回显 | 本机 `codex app-server generate-json-schema`（0.164.0）；#40805；#32254                                                                                                       |

结论：

- 在 Codex 0.164 上，“立即 steer”不是边界投递。消息一到，正在生成的推理就会被丢弃，然后基于 575k 上下文重新采样。父会话事件里 7/11 的子会话 steer 都打断了正在进行的推理，原因就在这里。
- Codex 官方给人类消息的默认是立即抢占，给 agent 消息的设计是在完成项的边界投递（或者排到下一回合），但这条通道只给 Codex 原生子 agent 用，app-server 客户端拿不到。

### 是不是“官方最佳实践”

两家都没有专门写多 agent 消息时机的规范文档。从默认值和源码看，方向是一致的：

- 人类的纠偏立即生效：Codex 默认立即抢占；Claude 默认工具边界，加一个“立即发送”键。
- 不急的消息在边界投递，不能切断进行中的工作：Claude 的 `next` 就是这样；Codex 的 agent mailbox 在完成项边界抢占，也可以推迟。
- 只是告知的消息排到下一回合：Claude 的 `later`，Codex 的 Tab、`codex queue`、`trigger_turn=false`。

所以“边界队列”是两家都在用的原生语义，但这是从默认值和代码推出来的，不是官方文档明确称为最佳实践。三档正好对应两家已有的三种原语，不需要 Foundry 自己发明新的档位。

## 推荐投递模型

### 三档

| `delivery`  | 语义                                                                                                         | Claude                                                                              | Codex（app-server）                                                                                                                                                    | 默认使用者                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `interrupt` | 立即生效，可以抢占正在生成的内容；已完成的工作和正在跑的工具都保留                                           | `priority: "now"`（中止当前回合，紧接着处理这条消息）；或者 `interrupt()` 加 `next` | 立即 `turn/steer`（0.164 由 `instant_interrupt` 抢占）                                                                                                                 | 人类在 Codex 上的消息（保持现状）；agent 只用于阻塞、安全、纠偏，有额度 |
| `boundary`  | 下一个完成边界生效：工具调用结束，或者推理/commentary 项完成；不切断正在生成的项；纯文本回答期间等到回合结束 | `priority: "next"`（原生，就是现在的做法）                                          | Worker 先拿着消息，等到正在生成的推理或消息项都完成、工具项 `item/completed` 时再 `turn/steer`，模仿 Codex 自己 mailbox 的规则；回合结束还没投出去的，作为下一回合输入 | agent 发给 agent 的默认值；人类在 Claude 上的消息（保持现状）           |
| `turn_end`  | 等这个回合结束，作为下一回合的输入；同一接收方的多条合成一条                                                 | Foundry 收件箱在回合结束后投递（不依赖原生 `later`，Worker 重启也不会丢）           | 同左，回合结束（`turn/completed`）后用 `turn/start` 投递                                                                                                               | 状态、进度、FYI、最终交付发给仍在运行的编排者                           |

几点补充：

- Codex 的 `boundary` 必须由 Foundry 模拟，因为 app-server 没有开放 mailbox。要设两个兜底：边界最长等 15 分钟，超过就按 `interrupt` 投；遇到 review 或 compact 回合就留在收件箱里等。另一种做法是对 Foundry 管理的 Codex 关闭 `-c features.instant_interrupt=false`，让所有 steer 都退回“当前采样结束后”的语义，再用 `turn/interrupt` 实现 `interrupt`。但这样会改掉人类在 Codex 上的默认体验，不推荐作为默认，可以留作开关。
- 前一节提出的 T 分钟汇总窗口，变成 `turn_end` 的一个可选参数：回合太长时，最晚 T 分钟按 `boundary` 冲刷一次，避免“回合不结束就永远收不到”。

### 不丢消息：修复 “This session is not accepting active steer input”

原因（代码）：Server 的 `activeOrBlocked`（`actor.go`）把 `queued` 也当成运行中，于是走 steer 路径。但会话还没开始回合，Worker 里没有登记 steer 目标，`steerActiveSession`（`packages/worker/src/session-control.ts`）就直接抛这条错误，消息被扔掉，只给发送方一个错误。下面这些情况都会这样：

- 回合刚结束：Claude 的 `runtime.pending` 已经换掉；Codex 的 `active.terminal` 已经为真。
- Codex 还没收到 `turn/started`。
- 回合是 review 或 compact。

本例中，编排会话处于 `queued` 时连续 3 次被拒；…2224 在 00:15:22 回合收尾时也被拒过一次。

修复：

1. Worker 返回带类型的 `not_steerable`（附原因：`queued`、`finishing`、`no_turn`、`non_steerable_kind`），不再抛字符串错误。
2. Server 把这条消息写进持久收件箱（键为 `inputId`），按它的 `delivery` 投递：会话排队时，并入将要开始的回合输入（还没发给设备的话），或者等 steer 目标登记后再投；回合正在结束时，作为下一回合输入。
3. 发送方立即收到回执：`state: "held"`，以及 `deliverAt`。

任何情况下都不再丢弃。

### 回执与幂等

- 状态依次是 `accepted`、`held`、`delivered`、`consumed`。
- 判断“已读到”：Codex 看 `clientUserMessageId` 对应的 userMessage 回显（#40805 提醒，RPC 成功不等于消费）；Claude 看 `SDKResultMessage.user_message_uuids` 或 assistant 上的 `user_message_uuid`。
- `inputId` 可以由发送方提供。同一个 id 永不重复投递：Worker 已有 `appliedSteers`，Server 加收件箱唯一约束。8 秒超时时返回 `state: "unknown"`，并提示“先查回执，不要重发”。
- 同一发送方、同一接收方、10 分钟内文本相同的消息直接去重。

### 限流与合并

- `interrupt`：每个发送方每 30 分钟 2 次，超出降级为 `boundary`，并在回执里说明。
- `boundary`：同一边界上待投的多条合成一次 steer，开头注明“来自 X 的 N 条”。
- `turn_end`：每个回合结束时合成一次投递。
- 用户消息不限流，不降级。

### MCP schema

```jsonc
// send_message 新增
"delivery": { "enum": ["interrupt", "boundary", "turn_end"] }, // 省略时：agent→boundary；用户→保持运行时默认
"inputId": { "type": "string" },      // 幂等键
"supersedes": { "type": "string" }    // 替换一条仍在收件箱里的消息
// 返回
{ "inputId": "...", "delivery": "boundary", "state": "steered|held|started_turn|duplicate|unknown",
  "deliverAt": "now|next_boundary|turn_start|turn_end", "reason": "downgraded_quota|queued|finishing|non_steerable_kind" }
```

另外：`get_session` 和 `read_context` 显示待投条数；`wait_session` 支持 `until: ["attention"]`（见前文方案 3）。同时修正工具说明里 “Codex queues it for the next one” 的错误。

### Skill 和 Prompt 指引

- 每条消息先选档：需要对方立即改变动作（阻塞、纠偏、安全）用 `interrupt`；改变了对方下一步的输入，比如合同、文件 owner、等待的依赖就绪，用 `boundary`；状态、FYI、交付回执用 `turn_end`。
- 不发确认，不重发；超时先查回执。
- 编排者纠偏子会话可以用 `interrupt`（用户在 00:16 明确要求过）。

### 指标

- 每种档位的条数。
- Codex 被抢占的进行中推理项数，每小时统计。本例基线：父会话收到的 11 条子会话 steer 里，7 条打断了推理。
- 收件箱等待时长的 p50 和 p95。
- 被拒或丢弃数，目标为 0。
- 重复、降级的条数。
- 被抢占请求浪费的 token。

### 成本

| 部分                                                                                                                                                                                                            | 估计       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 第一阶段：不丢消息（类型化 `not_steerable`、Server 收件箱、回执）、`inputId` 幂等、修正工具说明                                                                                                                 | 约 3 人日  |
| 第二阶段：三档 `delivery`。Claude 映射 `now`/`next` 约 0.5 天；Codex 边界模拟和回显回执约 2 天；`turn_end` 合并投递约 1 天；限流和降级约 0.5 天；Web 显示待投、已投、已读约 1 天；两种运行时的端到端测试约 2 天 | 约 7 人日  |
| Skill 和 Prompt                                                                                                                                                                                                 | 0.5 天     |
| 合计                                                                                                                                                                                                            | 约 10 人日 |

## 需要决策

1. 采用三档投递（`interrupt` / `boundary` / `turn_end`），取代前文的二档 `interrupt|batch`：agent 消息默认 `boundary`，用户消息保持各运行时的默认。
2. Codex 的 `boundary` 用 Worker 模拟（推荐），还是给 Foundry 管理的 Codex 关闭 `instant_interrupt`（会改变人类在 Codex 上的 steer 体验）。
3. 第一阶段（不丢消息、回执、幂等、修正说明）能否先行，约 3 人日。
4. 参数：`interrupt` 额度（建议每 30 分钟 2 次）、`boundary` 最长等待（建议 15 分钟）、`turn_end` 的 T 分钟冲刷（建议 10 分钟）。
5. “会话没有 Foundry 工具”这个现象要不要另开事项排查。
