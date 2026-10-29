# DEV-089 引导进运行中回合的消息：在等什么、何时被读取

状态：Web 已部署 dev（`51a0c49cac0b97f3`，现随 DEV-092 的 `a47d655fe9f8385a` 继续在线），Agent 自验通过（dev 真实 API、合成 Claude 会话）；待人工验收；未提交。负责会话 `sess_1793281526008662517`，编排 `sess_1793063405185071529`。

## 问题

本人在 Linux 开发设备的 Claude 会话 `sess_1793189579694075630` 中（北京时间 2026-10-29 21:40）：

- 21:40:43 Claude 开始一个前台 Bash：`timeout 1200 python3 -m unittest discover …`（描述 “Identify the failing test”），最长 20 分钟。
- 21:40:55 本人发了一条“下一步插入”的消息；Server 0.3 s 后把它引导进回合（事件 “Steered into active turn”）。
- 之后对话里只有 “Working… 2m43s”：正在运行的工具显示在本人消息上方的分组里，消息下方没有任何说明。看不出消息已送达但尚未被读取，也看不出它在等什么。
- 21:45:33 Bash 返回，同一秒 Claude 发起下一次模型请求，消息在这次请求中被读取。

第二例（22:09，本人 Mac 上的 Claude 会话 `sess_1793277998160628174`）：前台 Bash “Measure backup write rate”（4 × `sleep 60`），22:09:52 引导消息后同样只显示 “Working… 2m21s”。

## 原因

投递符合语义。Claude 的 “next” 优先级意味着：消息在当前工具调用返回后的下一次模型请求中被读取。如果当前工具要跑 20 分钟，消息就要等 20 分钟。问题出在显示上：

1. 引导消息下方的 “Working…” 行（`awaiting-step`）没有自己的步骤。正在运行的工具开始于消息之前，所以这一行不显示它。
2. 引导消息本身没有状态：看不出“已送达、等某工具结束后读取”，也看不出“何时已读”。
3. Worker 收到 SDK 的 `tool_progress`，但只用于存活检测，不上报。工具的开始事件里已有描述、命令和 `timeout`，但 Web 没有显示。

## 方案与实现（仅 Web）

无 Server / Worker / 协议改动。所需信息都在已有事件中：工具调用的 running/completed 事件（`callId`）、“Starting subtask”（`metadata.taskId` + `toolUseId`）、“Steered into active turn”和 “Requesting model”。

- `features/chat/turn-activity.ts`：从会话事件得出当前回合仍在运行的工具调用（开始时间、详情、Claude 任务 id），以及每条引导消息的状态：
  - Claude：消息到达时正在运行的调用全部返回后，第一个 “Requesting model” 即为读取时间。
  - Codex：它等的那个工具返回时读取；没有工具在运行时立即读取（Codex 会抢占正在生成的回复）。
  - 回合结束而没有读取迹象：不显示状态，不做猜测。
- 实时活动行（`ProcessDisclosure` 的 `liveActivity`）：对话最下方的运行中一行，只要有工具在跑，就显示它的标签、“工具 · 描述”（无描述时显示命令首行），以及从工具开始起计的时间；输入设置了 `timeout` 时显示上限，例如 “Using a tool · Bash · Measure backup write rate · 2m 21s / up to 4m 0s”。如果这一行自己的运行步骤就是这个调用，保留原标题和计时，只补充详情。行高不变，实测计时前后都是 660×34 / 354×34。
- 引导消息气泡底部的状态行（`components/conversation/steer-status.tsx`）：
  - 等待中：“已送达 · Claude 会在 Bash 结束后读取（已运行 1m 6s / 最长 4m 0s）”；Codex 用自己的措辞（“Codex 会在 … 返回时读取”）。
  - 已读：“Claude 已于 22:34:50 读取”。
  - Claude 的消息只等一个调用、且该调用有任务 id 时，等待 60 秒后出现 “停止 Bash 并立即读取”。点击后先确认（“正在运行的命令会被停止，未完成的部分会丢失”），焦点落在“继续等待”；点“停止 Bash”后经已有的 `POST /api/agent-sessions/{id}/background-tasks/{taskId}/stop` 停止该任务（Worker 的 `stopClaudeBackgroundTask` → SDK `query.stopTask`，自 #116 起已覆盖前台任务）。工具随即失败返回，Claude 在下一次请求中读到消息。不会自动停止。只对工作区成员且设备在线时提供；失败时弹错误提示，可以重试。
- 中英文案同时提交（`conversation.steer.*`、`conversation.process.elapsedLimit`）。

立即打断（interrupt）与本轮结束后（turn_end）：

- interrupt：Claude 的消息走同一条引导路径（同一事件），状态行和停止操作一样适用。
- turn_end：消息在输入框上方的队列行里等待（DEV-082 原有），回合结束后作为下一回合的输入，不存在“已送达未读”的阶段；回合运行时，最下方的实时活动行照样显示正在运行的工具。

## 测试

- `test/steer-waiting-visibility.test.mjs`（8 项）：本人案例的事件序列（等待 → 21:45:33.4 已读）；工具运行中出现的模型请求不算已读；回合结束、新输入清除运行状态；Codex 的两种读取时机；`chatMessagesForThread` 给出实时行（描述、上限 240000 ms）和停止任务；Codex 或无权限时不提供停止。
- `test/steer-status-render.test.mjs`（4 项，happy-dom）：等待文案与上限；60 秒前不提供停止；确认流程、焦点在“继续等待”、停止中、已读；停止失败后可再次停止；Codex 不提供停止。
- `scripts/check-changed.sh --files <16 个文件>`：tsc、68 个相关 Web 测试文件、12 项 UI 审计全部通过；prettier 已格式化。

## Agent 自验（真实浏览器）

环境：dev API（e2e-alice），页面静态资源由 Playwright 换成本项构建 `51a0c49cac0b97f3`。DEV-048 合成设备 Worker 以 `systemd-run --user`（`dev089-dev048-worker`，已发布 runtime）临时运行，在合成工作区 `ws_d4da0f57-…` 新建合成 Claude 会话（外部连接，low），只执行 `sleep`。

1. 机制预检（API）`sess_1793282347355440703`：`sleep 120` 运行中引导一条消息，再调用停止接口。工具 0.2 s 后失败返回，0.25 s 后发起模型请求，Claude 回复了消息中要求的词。
2. 停止路径，light 1280（`sess_1793284403423580681`）与 light 390（`sess_1793284698237592469`）：
   - 引导后状态行为 “Delivered · Claude reads it after Bash finishes (running 10s / up to 4m 0s)”，实时行为 “Using a tool · Bash · Synthetic wait for DEV-089 · 10s / up to 4m 0s”。
   - 1m 6s 时出现 “Stop Bash and read now”。键盘操作：focus 后按 Enter 打开确认，焦点在 “Keep waiting”；Shift+Tab 到 “Stop Bash”，再按 Enter。
   - 工具约 1 s 后失败返回，状态变为 “Claude read it at …”（时间与 “Requesting model” 事件一致），Claude 在回答中原样引用了消息。
3. 自然读取，dark 390（`sess_1793284544163466492`）与 dark 1280（`sess_1793284876772037573`）：`sleep 45` 期间引导。少于 60 秒，不出现停止操作。工具返回后状态显示 “Claude read it at …”，与 “Used tool” / “Requesting model” 同一秒。
4. 截图在 `.foundry/attachments/20261029/dev089/`（不入库）：`stop-light-1280-*`、`stop-light-390-*`、`read-dark-390-*`、`read-dark-1280-*`。

另有一条未引导的会话 `sess_1793284706903244147`：并行运行时，它在合成设备上排队到前一条结束，脚本超时，没有引导就结束了。

清理：6 条合成会话已归档（批次 `arch_01a18849-…`）；合成 Worker 单元 `dev089-dev048-worker` 及其执行宿主已停止；e2e-alice 已登出，cookie 与私有源码副本已删除。

## 部署

- Web：2026-10-29 23:30（北京时间）`scripts/deploy-web-dev.sh` 发布 `51a0c49cac0b97f3`。上一版是 release 会话刚部署的 `c1b07613f3962ebf`（PR #160 合并后的 main `d4537b1`），回滚副本在 `releases/dev089-web/previous-20261029T153020Z`。构建来自共享工作树，即 main `d4537b1` 加本项文件；`apps/web` 下没有其他未提交改动，`packages/protocol` 里另一会话的未提交改动只有接口字段，不产生 JS。这个构建 id 与浏览器自验时用的构建相同（内容哈希一致）。发布后用公网页面复查：`version.json` 为 `51a0c49cac0b97f3`，历史合成会话显示 “Claude read it at …”。
- 2026-10-30 01:42:46（北京时间）DEV-092 发布 Web `a47d655fe9f8385a`，替换 `51a0c49cac0b97f3`。按 DEV-092 的说明，这一版包含本项文件（`d4537b1` + DEV-089），另加 DEV-091/092 的 Cloudflare 连接器改动。回滚副本在 `releases/dev092-web/previous-20261029T174242Z`。本项没有另行复验。
- Server / Worker：不涉及。

## 限制

- 读取时间是推断的：Claude 取消息之后的第一次模型请求，Codex 取工具返回的时间。Worker 没有为 Claude 上报“已读”事件；Codex 的 “Steered message read” 由 Server 拦截，不进转录。
- 只有 Claude 以任务运行的调用（前台 Bash 在约 3 s 后注册为任务）可以停止。其他工具（MCP、子 Agent 之外的调用）不提供停止操作。
- 停止按钮在等待满 60 秒时出现，状态行会多一行，这是一次状态变化，不是悬停引起的位移。
- 390 宽时实时行的标题会和详情一起截断（“Using a t…”）。
- Issue 页面的对话（浏览器侧队列）未接入。
- 验证中我的一条 `systemctl --user cat foundry-worker.service` 把服务环境里代理 URL 中的凭据输出到了本会话的工具输出中。建议轮换该代理凭据。该值未写入任何文件或文档。

## 人工验收步骤

1. 在 dev 让 Claude 运行一个较长的前台命令，例如 “在前台运行 `sleep 150`（不要放到后台）”。
2. 命令开始后发一句话（Enter）。预期：
   - 你的消息气泡底部显示 “已送达 · Claude 会在 Bash 结束后读取（已运行 …）”，计时每秒更新；
   - 对话最下方一行显示 “正在使用工具 · Bash · <描述或命令> · 时间”，设置了超时时还显示 “/ 最长 …”。
3. 等 1 分钟。预期：气泡内出现 “停止 Bash 并立即读取”。点击后先出现确认说明（命令会被停止），可以选 “继续等待”。选 “停止 Bash” 后，几秒内状态变为 “Claude 已于 HH:MM:SS 读取”，Claude 随即回应你的消息。
4. 再试一次不停止：用短命令（如 `sleep 40`）引导，等命令结束。预期：状态变为 “已于 … 读取”，与 Claude 开始回应同一时间，不出现停止按钮。
5. 切换深色主题和窄屏（手机宽度），重复第 2 步。预期：文字可读，按钮不溢出。
