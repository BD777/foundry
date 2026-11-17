# DEV-272 排队的消息不再显示成「定时任务」

状态：已部署 dev（2026-11-17）；待本人验收；已合入 main（PR #**PR**）。

2026-11-17。本人截图反馈（ccm-omh-integration，chat `sess_1794903494975054964`，17:36）：「为什么这个是 scheduled task 啊，他不是直接 queue 在后面发出去的消息吗？」消息是 `/foundry-orchestration 另外你看看这个skill，你说sub-session该用什么？`，转录里被标成定时任务（闹钟图标）。

## 调查

会话事件（UTC，即北京时间减 8 小时）：

| 时间     | 事件                                     | 含义                                                               |
| -------- | ---------------------------------------- | ------------------------------------------------------------------ |
| 09:35:04 | Steered into active turn                 | Worker 把这条消息作为 steer 推进正在运行的 Claude 回合（本人气泡） |
| 09:35:42 | Claude Agent SDK finished                | 该回合结束                                                         |
| 09:35:44 | Scheduled task fired（同一文本）         | Claude Code 在回合结束后才把这条 steer 当作自己的提示提交          |
| 09:36:00 | Scheduled task fired（同一文本，带回答） | 上一条的结束记录                                                   |

根因在 Worker：`ClaudeTimerTracker.handlePromptSubmit`（`packages/worker/src/session/tasks/agent-timers.ts`）的 `UserPromptSubmit` 钩子规则是「没有 Foundry 回合运行时，Claude 提交的任何提示都是定时任务」。它不知道 Worker 自己推送过的 steer。回合结束后 Claude Code 才提交该 steer，`isActiveTurn()` 为假，于是被记成 `timerFire`（origin `scheduled`），Web 按定时任务行显示。

## 修复

- `ClaudeTimerTracker` 记录 Worker 推入 Claude 输入的 steer 内容（`expectSteer`，按 trim 后的文本匹配，最多 16 条）。钩子收到的提示若命中记录，就不是定时任务：没有运行中的回合时只标记 `steerTurn`，不发出 `timerFire`。
- `steerClaudeTurn` 在推入输入前登记该内容（`claude-turn-controls.ts`）。
- 回合结束时，`finishClaudeContinuation` 对该 steer 的回答发出 `Response stream`（与 Server 写最终回答的标签一致），不发 `timerFire` 也不发 `backgroundTurn`。这条 steer 的气泡已由「Steered into active turn」记录，不重复发送。
- 真正的定时任务、后台任务续写的标签和路径不变。

## 验证

- 新增单测（`test/agent-timers.test.mjs`）：steer 回合结束后被提交 → 无 `timerFire`、`takeSteerTurn()` 为真且只取一次；回合内提交的 steer 不算回合；真实定时任务仍以 `scheduled` 触发。
- 新增回放测试（`test/claude-timer-turns.test.mjs`）：steer 在回合结束后由 Claude 提交，随后结果消息 → 无 `timerFire` 事件，回答以 `Response stream` 发出。
- 在 byte-dev（Linux compute，lease `lease_440ad1e5d85f2f20fa3a`）上，对只含本次改动的干净树（HEAD + 本补丁，见下）运行 `scripts/remote-check.sh --worker test agent-timers.test.mjs claude-timer-turns.test.mjs`：27/27 通过。
- CanWendeMac-mini 的 compute 运行接口当时反复返回 `device_error`（包括分配任务槽），因此改用 byte-dev，符合 no-byte-dev 规则的 fallback。
- 实时工作树（`~/workspace/foundry`）中他人未提交的 DEV-266 注释改动使 `packages/protocol` 无法构建（`annotations.ts` 从 `daemon-messages.js` 导入未导出的类型）；本补丁不依赖也不包含该改动，验证在干净树上完成。

## 限制

- 未在真实浏览器里复现排队 steer 的转录行。
- 匹配依赖 SDK 钩子里的 `prompt` 与推入的 `content` 文本一致（trim 后）。真实 SDK 的字节级行为未在本次回放中验证；若不一致，问题会退回原状，需要在 dev 上用一条排队消息复核。
- 回放测试没有先在修复前的代码上跑红，修复前后的对比依据是上述事件时序与代码路径。

## 验收步骤（dev 部署后）

1. 在一个正在运行的 Claude 会话中，回合进行时发送一条消息（它会排队或以 steer 进入）。
2. 等当前回合结束。
3. 预期：这条消息以本人气泡显示，没有「定时任务」或闹钟行；它的回答紧随其后，没有「后台任务」行。
4. 对照：一个真实的定时任务仍显示为「定时任务」行。
