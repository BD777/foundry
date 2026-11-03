# DEV-112 · Issue 执行成为普通会话

状态：已实现；测试与 scratch 栈真实 Codex 端到端自验通过；未提交（提交窗口 22:00–09:00）；未部署；待人工验收。

## 问题

复盘（[会话与 Issue](../refactor/retrospective-sessions-issues.md) B-1、B-2、B-8）：Worker 的 Issue 执行器自己拼一个会话对象、用 500 ms 定时器发 “Response delta/reset”；Web 为它另写一套转录投影；Steer 和取消走 `issue_environment` 的 `steer`/`cancel` action 和 Worker 按 Issue 登记的另一张表，32000 字节上限两端各查一次，只支持 Claude；Issue 页先列会话、再逐个读执行的完整会话，最多 21 个请求。

## 实现

- Worker：所有输入（Chat、澄清、Issue 执行）都走 `executeAgentSession`，角色只提供 `SessionRole`（`session/session-role.ts`：`prepare` 决定在哪运行和发什么，可选 `run`、`settle`、`stopped`、`nativeSessionId`）。Issue 执行（`issue/issue-execution.ts`）只保留 Issue 自己的部分：候选与沙箱、合同提示词、两轮之间准备仓库、快照与结果（`issueResult`）。执行以真实会话 id 运行，steer/cancel 由沙箱登记到同一张会话控制表；同一路径发标准事件（`Response stream` 等）。删除 `issue-executor.ts`、`issue-steering.ts`、`execution-process.ts`、`daemon/issue-run.ts` 和环境 RPC 的 `steer`/`cancel`。澄清改为同样的角色写法。
- Server：`sessions.Send`/`Cancel` 对运行中的 `issue_execution` 会话照常 steer 和取消（规则 `takesControl` 一处）；结束后的执行与澄清仍由 Issue 接管（`ErrSessionControlledByIssue`），会话之间的 inbox 消息仍拒绝。删除 `POST /api/issues/{id}/environment/steer|cancel`。新增 `GET /api/issues/{id}/executions`：最近 20 次执行，各带最新事件窗口（与 `GET /api/agent-session-threads/{id}` 同一窗口实现）。
- Web：Issue 对话一次请求读执行，用 Chat 的会话转录投影渲染（`features/chat` 导出 `sessionTranscriptItems`，由 app 层传给 Issue 详情）；Issue 只补原始目标、反馈和提问，执行答案在 Issue 里的副本（`msg_<会话 id>`）不再重复显示。引导走 `POST /api/agent-sessions/{id}/messages`，停止走 `/cancel`，Claude 与 Codex 都可引导。删除 delta/reset 投影和 Issue 自己的失败卡片文案。
- 另修一个阻断问题：Codex 会话把工作区 skill 链接到工作目录的 `.agents/skills` 并改写源仓库 `.git/info/exclude`；在 Issue 的沙箱里（澄清只读、执行的 `.git` 只读）这一步报 `ENOENT`/`EROFS`，所有选了 skill 的 Codex 澄清与执行都失败（scratch 栈复现：`EROFS … /tmp/fdy-a8df-ws/.git/info/exclude`）。沙箱内（`FOUNDRY_RUNTIME_CONFIG_ISOLATED=1`）改链到私有 HOME 的 `~/.agents/skills`，Codex 原生也读这里（`session/preparation/index.ts`）。

## 自验

- Go：`go test ./...` 全部通过；新增 `TestIssueExecutionIsSteeredAndStoppedAsASession`（claude、codex：会话 steer 带 delivery 到设备、cancel 到设备、会话 canceled、设备回报后 Issue blocked/canceled、结束后的执行拒绝消息与取消），`TestIssueExecutionsAreReadInOneRequest`。
- Worker：新增 `issue-execution.test.mjs`（mock 两次复用候选、经会话上报并可补报、开始前取消回报 canceled；真实沙箱 + 假 Claude CLI / 假 Codex app-server：运行中按会话 id steer 进入回合并出现在答案里，按会话 id 取消得到 `issueResult.canceled` 且候选保留；两轮之间准备仓库）。相关文件全部通过。
- Web：全部 1005 项测试通过；`issue-conversation.test.mjs` 新增 Claude/Codex 各一项：只发 `GET /api/issues/{id}/executions` 一个读请求，队列里的 Steer 发到 `/api/agent-sessions/{id}/messages`，停止发到 `/cancel`。`audit:ui`、`audit-contract`、`audit-module-boundaries` 通过。
- scratch 栈（工作树构建，本人库副本，Worker 共用系统账号，`codex_local`，临时 Git 工作区）：
  - 修 skill 链接前：`ISS-107` 澄清失败（`ENOENT … .agents/skills`），执行失败（`EROFS`）；失败经标准路径显示（Session failed、Issue 阻塞并带原因、环境指针保留）。
  - 修后：Web 发反馈 → 执行完成；再给一个 `sleep 90` 的反馈，执行运行中在浏览器里点队列的“Steer” → `POST /api/agent-sessions/sess_1793690031009914441/messages`，转录显示“Delivered · Codex reads it when the command returns”，Codex 回复会在 sleep 后追加；点停止 → `/cancel`，会话 canceled，Issue blocked（needs_input），候选保留；Web 发“继续” → 新执行续上原生会话，把被打断前 steer 的那一行也写进 NOTES.md，Issue 进入 Verifying。
  - `ISS-108`：真实 Codex 澄清读了 README 并给出草案，浏览器点“确认标准并开始” → 执行完成，候选只多了 CHANGELOG.md，源工作区与候选里都没有 `.agents`。
  - Issue 页每次打开只有 `GET …/executions` 一个执行读取（另有原有的 contracts 读取）；亮/暗、1440/700 宽截图检查，无水平溢出。

## 已知限制

- Issue 的 `Run` 指针仍抄着会话状态（B-10 的 Server 侧）；Web 已改用会话自己的状态渲染。
- Issue 页每次执行只读最新 1000 个事件，更早的不在 Issue 对话里分页（会话卡片可打开 Chats 看全部）。
- Issue 页的输入仍是浏览器内队列，没有 Chat 的投递方式选择（接口支持 `delivery`）。
- 被取消的执行按 Chat 的样式显示为“Run failed · Canceled by user”。
- 仍未走真实浏览器完成采集、判定与 Accept（这部分代码未改）。

## 人工验收

1. 新建一个 Codex Issue，确认标准后让它执行一个较长的命令。预期：执行过程与 Chat 中一样显示；在输入框写一句话、点队列的“引导”，消息进入正在运行的回合。
2. 运行中点停止。预期：Issue 变为需要回复，候选保留；发“继续”后新执行接着做，并记得前面的引导。
3. 打开一个有多次执行的 Issue，在开发者工具里看请求。预期：执行只读一次 `GET /api/issues/{id}/executions`。
