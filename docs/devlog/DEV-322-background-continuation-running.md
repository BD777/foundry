# DEV-322 后台任务结束后 Claude 自己接着跑的那一轮，从开始就显示为运行中

状态：**已部署 dev（train 106，Server + Web + Worker），真实浏览器端到端检查通过；待本人验收**。

## 问题

2026-11-20 本人反馈 sess_1795189068394754005：正文说"等调研 agent 返回结果"，右边面板却没有任何活跃任务（截图时间 15:42:30）。

## 调查（真实数据）

- 事件时间线（dev 库只读）：15:38:38 启动子 agent `a1876aba07cc4ff05`；15:39:57 本轮结束；15:41:13 子 agent 完成（`Subtask completed`，面板变成 "Ended agents (1)"）；15:42:29 才出现 `Background task continued`，带最终回答。
- 会话的原始 SDK 日志（`inputs/98d208de…/claude-sdk.messages.jsonl`）：`task_notification` → `background_tasks_changed` → `init` → `status` → `stream_event message_start` … → `result success`。也就是说，子 agent 一结束 Claude 就自己开了新一轮，模型输出了 76 秒。
- **根因：** Worker 对这种后台续跑只在整轮结束时（`finishClaudeContinuation`）发一个事件，开始时什么都不发。Claude 自己发起的定时任务回合已经有做法：开始时先发一条未完成的 `timerFire` 事件，服务端据此把面板标为运行中，结束时再发一条带回答的事件。后台续跑缺的就是开始这一条，所以这 76 秒里服务端和 Web 都没有"正在工作"的信号。
- Codex 有同样的缺口：它自己发起的回合只用于资源租约，不发会话事件。

## 修复

- Worker
  - `runner/claude-messages.ts`：模型第一次真正输出时（stream event，或不是 CLI 合成的 assistant 消息），发出开始事件 `timerFire{origin:"background", startedAt, completedAt:""}`。只有通知记账、没有模型回合的 result 不发。结束事件沿用同一个 `startedAt`。没有回答就结束的，或者结果发现这一轮其实属于某个定时任务或插话的，也补发结束事件。
  - `tasks/agent-timers.ts`：`backgroundTurnEvent`、`promptedTurn()`。`runner/active-runtimes.ts`：进程关闭时补发结束事件。
  - `runner/codex-app-server.ts`：在 `turn/started` 时发开始事件，结束时一定发结束事件。
- Server
  - `store/session_panel.go`：后台续跑的开始和结束按开始时间配对；新增面板字段 `backgroundRun`；`busy` 包含它；定时任务行只认领 scheduled 的运行记录。
  - `store/session_state.go`：开始事件带 state key。
  - `sessionprogress/progress.go`、`httpapi/mcp_progress.go`：get_session 的 progress 在运行期间带 `ownTurn {origin, startedAt, prompt}`。
- Web
  - 正文不显示未结束的开始事件，结束时显示一次分隔线和回答。
  - 运行期间聊天底部显示"后台任务结束后 Claude 继续工作中 · HH:MM 起"，带转圈；标签页标题显示后台工作中。
  - `thread/chat-model.ts`：运行中的过程组不再从上一条回答开始计时。
- Protocol：`session-panel.ts` 增加 `backgroundRun`。

## 检查

- Worker：112 个测试中 111 个通过、0 个失败（通过 `scripts/run-worker-tests.mjs`，在临时副本中构建）。新增用例回放了上面那份真实消息序列，确认开始事件在第一个 `message_start` 时发出，不会在通知或记账 result 时发出，结束事件沿用开始时间，失败和进程关闭的情况也覆盖到了。更新的用例：`claude-timer-turns`、`codex-keep-alive`、`claude-narration`、`claude-background-task-lifecycle`。
- Go：用 `-run` 定向跑了 `./internal/store`、`./internal/sessionprogress`、`./internal/sqlitestore`、`./internal/httpapi`，都通过。新增 `TestPanelBackgroundRunRunsFromItsStartToItsEnd`、`TestOwnTurnIsTheOpenRunTheAgentStartedOnItsOwn`。
- Web：`pnpm typecheck`、`chat-context-background.test.mjs`（新增用例）和 22 个相关的 transcript、chat-model、schedule 测试文件都通过；`pnpm audit:ui` 通过。

## 验收步骤

1. 在 Claude 会话里让它启动一个后台子 agent（例如"后台派一个 agent 调研 X，你先回复我，等它回来再总结"），本轮先结束。
2. 子 agent 运行期间，面板 Agents 里显示它在运行（原来就有）。
3. 子 agent 结束后、Claude 写总结期间：聊天底部显示"后台任务结束后 Claude 继续工作中 · HH:MM 起"，带转圈，标签页标题显示后台工作中；正文不多出一条分隔线。
4. 总结完成后，转圈消失，正文只出现一条分隔线和总结。事件带任务时，分隔线显示任务行（例如"后台任务完成 · 子智能体 · <任务名> · HH:MM"）；不带任务时显示"Claude 在后台任务结束后继续"。
5. 在这期间用 get_session 查这个会话，`progress.ownTurn.origin` 是 `background`。

## 部署与端到端检查

- 2026-11-20 16:11Z，train 106（`scripts/deploy-dev.sh --label dev322-bgturn-train106 --server --web --worker`，基于 `7df58eb4` 加本项及同批改动构建）：Server `fd59f10973b5`；Web `a576901d96be4366`（替换 `caff13207bbf0551`）；Worker `0.5.7-dev.375.g7df58eb4.local.1795190952`。sg-chaos 于 16:12:18Z 更新到该版本。
- 用 Agent 通过 MCP 建的会话验证不了本项：这类会话在后台任务运行期间不结束本轮（`waitsForBackgroundWork`），只有本人从 Web 发起的聊天才会走到续跑路径。
- dev 上的测试账号 e2e-alice 没有可用的 Claude 账号（Limen 周额度用完，合成设备没有登录），所以改用临时栈：在 dev 数据库副本上，用当前 checkout 的 Server、Web、Worker，以本人身份和 hell-tw 模型服务，从 Web 输入框发起聊天，在真实 headless 浏览器中跑了三次（英文；英文且同时轮询 API；中文且中途刷新页面）。
  - 续跑期间：底部显示"Claude is continuing after background work since 00:44"或"后台任务结束后 Claude 继续工作中 · 00:46 起"，带转圈，刷新页面后仍在；API 返回 `backgroundRun{origin:"background", completedAt:""}`，`busy: true`；正文没有新的分隔线；标签页标题显示 ⚙️。
  - 事件：4 次续跑各有一对开始和结束事件，`startedAt` 相同，开始事件的 `completedAt` 为空。
  - 结束后：约 1 秒内提示消失，`backgroundRun` 为空，`busy` 为 false；每次续跑只有一条分隔线和回答。浏览器控制台、Worker 和 Server 日志都没有错误。
  - 截图和时间线在仓库外的 `/tmp/dev322-e2e/`。

## 其他发现（未处理）

- `scripts/scratch-stack.sh` 的 `worker stop` 和 `down` 不会停止执行宿主：脚本按 `state/execution-host` 计算单元名，Worker 现在把执行宿主放在 `state/execution-hosts/<id>`。宿主会一直运行，并重新建出实例目录。
- 临时栈的 Web 构建在 Node 默认堆大小下会内存不足，需要设置 `NODE_OPTIONS=--max-old-space-size=2200`。
- 中文界面下，面板里的"Host schedule origin is unconfirmed; adopt it to control"仍是英文。

## 限制

- get_session 的 `lastAnswer`、`completedAt`、`status` 仍然只反映本人发起的那一轮，不反映后台续跑的回答；只新增了 `progress.ownTurn`。
- 已有的 `failedTimerRun` 在会话有定时任务时可能取到失败的后台续跑，本次没改。
- 旧数据里没有 timer id、未结束的 scheduled 开始事件没有新的 state key，只有新事件才有。

## 时间线

- 2026-11-20：调查、实现、定向测试；部署 train 106。
- 2026-11-21：临时栈真实浏览器端到端检查通过；提交到 main。
