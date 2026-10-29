# DEV-082 聊天输入框的三种投递方式

状态：已部署 dev（Server `7194206839c1ba50…`，Web `5cfedf8c1085c147`），Agent 自验通过（Codex、Claude 真实会话）；待人工验收；未提交。负责会话 `sess_1793267095681128496`，编排 `sess_1793063405185071529`。

用户 2026-10-29 批准方案（“同意”）。

## 问题与方案

Agent 运行中，人发出的消息原先只有两种去向：排队到本轮结束，或在队列里点“引导”立即插入（Codex 的 `turn/steer` 会抢占正在生成的回复）。DEV-057 已给 agent 之间的消息做了 interrupt / boundary / turn_end 三档，人发的消息没有。

现在 Agent 运行时：

| 操作           | 方式               | 何时进入                                                                                                     |
| -------------- | ------------------ | ------------------------------------------------------------------------------------------------------------ |
| Enter / 点发送 | 下一步插入（默认） | Agent 下一个工具步骤：Codex 在工具已运行约 1 秒时；Claude 在工具调用开始时交给它（它在该工具结果返回后读取） |
| Ctrl/⌘+Enter   | 立即打断           | 立即送达；Claude 的“立即”仍在当前工具调用完成后读取（与 DEV-057 一致，菜单文案写明）                         |
| Alt/⌥+Enter    | 本轮结束后         | 原来的排队：本轮结束后作为下一条消息                                                                         |

发送按钮旁新增箭头菜单（`ChoiceMenu`，Radix 下拉 + 现有菜单样式），三项各写明效果和快捷键；Agent 空闲时菜单标题说明“消息直接发送”，选项不可用。尚未送达的消息在输入框上方显示为队列行：说明在等什么（Codex 带 15 分钟兜底倒计时），右侧下拉可随时改投递方式，铅笔可编辑，垃圾桶“撤回”。

## 实现

关键决定：下一步插入的消息由 **Server 持有**，而不是交给 Worker 持有。

- 理由：Worker 一旦接下（Codex 的 boundary hold、Claude 的 SDK 队列），就无法撤回或改方式；而且旧逻辑里，Worker 持有的消息若回合先结束会被丢弃（队列项已标记为已发送）。Server 持有时，撤回、改方式、编辑都是普通的队列操作；回合先结束时，消息作为下一回合输入，不会丢。另一个好处是对所有已部署的 Worker 版本都有效（用户 Linux 开发机未升级也能用）。
- 代价：边界由 Server 根据设备上报的工具事件判断，比 Worker 内判断多一次网络往返（几十毫秒）。
- 不选的方案：给 Worker 增加“撤回/改投递”的控制命令。要改 daemon、执行宿主和两个运行器，并且只在新 Worker 上生效。

具体：

- Server：`chat_queue_items` 增加 `delivery`、`delivery_at` 两列（`ensureColumn` 迁移）；入队与编辑接受 `delivery`（boundary / interrupt / turn_end，其他值 400）；队列项返回 `delivery`、`deliverySince`、`fallbackAt`。`httpapi/chat_queue_steer.go` 跟踪各会话正在运行的工具（`message.kind=tool` 的 running / completed 事件）：Codex 工具开始约 1 秒后（或在此之前完成时）投递，Claude 在工具事件出现时投递；interrupt 立即投递；每 3 秒巡检一次，处理暂时不能 steer 的 interrupt 和超过 15 分钟的 boundary。设备不支持 steer 时自动改为“本轮结束后”。回合结束时，带投递方式的消息排在普通排队消息之前，作为下一回合输入。原有的提问回答（`steer: true`，DEV-063）路径不变。
- Web：`ComposerInput` 把 Enter 的修饰键交给宿主；`AgentComposer` 新增可选 `actionMenu`（分体按钮）；`conversation-queue.tsx` 行内状态与投递方式下拉；`delivery-choices.ts` 集中快捷键与文案；中英文案同时提交。Issue 页面的对话（浏览器侧队列）不变。
- Worker：无改动。

## 测试

- Go：`TestChatQueueDeliveryModes`（claude / codex：boundary 在推理中保持、撤回、工具开始后投递且 Codex 不早于 1 秒、turn_end 改 interrupt 立即投递、回合先结束时 boundary 消息优先成为下一回合）、`TestChatQueueDeliveryWithoutSteering`；原有 `TestChatQueue*`、sqlitestore 队列与迁移测试通过（连跑 3 次）。
- Web：新增 `test/chat-delivery-modes.test.mjs`（修饰键映射、菜单文案与 Claude 说明、运行中入队带 delivery 并可改为 turn_end、空闲时直接发送）；队列/输入框相关 10 个测试文件 52 项通过；`tsc` 与全部 UI 审计、`audit:contract`、`audit:modules` 通过。

## 部署

- Server：随 DEV-084 的协调部署上线（11:28:52 UTC，SIGHUP 交接，sha256 `7194206839c1ba50d20c0cf29a11eb9b2247b9045686e28dff9774687e509d27`，回滚 `releases/dev023-candidate/foundry-server.pre-dev084`）。
- Web：12:01:56 UTC `scripts/deploy-web-dev.sh` 发布 `5cfedf8c1085c147`（上一版 `b8fa4ca040397688`，回滚副本 `releases/dev082-web/previous-20261029T120156Z`），发布前已向 DEV-079 / 084 / 086 / 088 确认工作树可构建，全量 `tsc` 通过。
- Worker：不涉及。

## Agent 自验（真实会话）

1. 本地合成栈（私有源码副本 + 空数据库，已发布 Worker，Codex 本机登录）。Codex 会话 `sess_1793270743210951543`：
   - 推理中按 Enter 发 B2：行显示“等待… 15:00 后直接插入”并倒计时；第一个 `sleep 20` 11:37:00.180 开始，B2 11:37:01.210 插入（约 1.03 秒）。
   - Alt+Enter 发 T1 → 行显示“本轮结束后”；在行内下拉改为“下一步插入” → 在当时运行的工具中插入。
   - W1 撤回后从未进入对话。Ctrl+Enter 发 I1 → 立即插入。
   - 回答逐字列出 B2 / T1 / I1 及读取时机，W1 未出现。
2. dev（e2e-alice，DEV-048 合成工作区，外部连接 · Claude，low）`sess_1793275417660833114`：
   - 工具运行中 Enter 发 C1、Ctrl+Enter 发 C3：都在第一个 `sleep 20` 期间进入；Claude 回答两条都在 sleep 1 结束后读到，与菜单说明一致。
   - Alt+Enter 发 C2：等四个 sleep 结束后作为下一回合（12:05:35）。
   - C2 的回合没有调用工具，期间按 Enter 发的 C4 一直保持，回合结束后成为再下一回合（12:05:55）。
3. 键盘：Tab 到箭头按钮，Enter 打开菜单并聚焦第一项，方向键移动，Enter 选择，Esc 关闭并回到按钮。
4. light / dark × 1280 / 390：菜单在视口内，无横向滚动。截图在 `.foundry/attachments/20261029/dev082/`（不入库）。

自验中发现并修复：Server 持有的消息投递后没有推送队列变化，浏览器里一直显示“发送中”。已在投递后推送。

## 限制

- Claude 的“下一步插入”在工具调用开始（模型开始写工具参数）时交给 Claude，Claude 在该工具结果返回后读取。这是它自己的工具边界，不会打断推理，但交出之后就不能再撤回。
- 边界依赖设备实时上报工具事件。Server 重启后，正在运行的工具要等下一个工具事件才会被识别（最长等到 15 分钟兜底）。
- 用户 Linux 开发机未做验证（按要求不碰）。新逻辑在 Server 上，与 Worker 版本无关。

## 人工验收步骤

1. 在 dev 打开任一聊天，让 Agent 执行几个较长的命令，例如“依次分别运行 `sleep 30` 三次”。
2. Agent 思考时输入一句话按 Enter。预期：输入框上方出现一行“等待 Agent 的下一个工具步骤…”；Codex 还会显示“N:NN 后直接插入”。下一个命令开始后约 1 秒，这一行消失，消息出现在对话里，回复没有被打断。
3. 再输入一句，按 Alt+Enter（Mac 为 ⌥+Enter）。预期：行右侧显示“本轮结束后”；本轮结束后它作为下一条消息发出。
4. 运行中点行右侧“本轮结束后 ⌄”，改为“立即打断”。预期：消息马上进入对话。
5. 输入一句按 Enter 后，在它插入前点垃圾桶。预期：该消息不会进入对话。
6. 点发送按钮右侧的箭头。预期：三种方式各有说明和快捷键；Agent 空闲时菜单标题为“Agent 空闲时，消息直接发送”，选项不可用，按 Enter 直接发送。

## 清理（2026-10-29 21:00 北京时间）

- DEV-048 合成设备的临时 Worker 单元已停止，执行宿主也已停止（`dev082-dev048-worker`，DEV-083 期间曾换为 `dev083-dev048-worker`）。合成 Claude 对话 `sess_1793275417660833114` 已归档（批次 `arch_01a187aa-…`）。
- e2e-alice 已登出，cookie 已删除。本地合成栈 `dev082`、私有源码副本、临时浏览器 profile 均已删除。
