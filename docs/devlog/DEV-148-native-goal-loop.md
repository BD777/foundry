# DEV-148 原生目标、定时唤醒与提问路由：按 Claude Code / Codex 原生方式运行

## 问题

Claude Code 2.1.x 与 Codex 0.167 在原生形态下已经能自己推进长任务：Codex 有线程目标（goal）并在目标未完成时自己继续下一轮，有后台终端和自己的输入队列；Claude Code 有 `ScheduleWakeup`（动态 /loop）、`CronCreate` 定时任务、`AskUserQuestion` 提问和计划模式的 `ExitPlanMode` 审批。Foundry 运行它们时把这些能力丢掉了：

- Codex 每个 Foundry 回合结束就关掉 app-server，目标的自动续跑、后台终端、排队输入随进程一起消失；Codex 自己发起的回合在 Foundry 里看不到。
- 提问和审批只在本人的对话里有效。一个会话派出的子会话一提问就没人回答，Codex 的审批、`requestUserInput`、MCP elicitation 也没有统一去向；不在本人对话里的会话（定时运行、Issue、角色会话）里提问会一直挂着。
- Worker 重启后，Claude Code 恢复会话时会自己带回 `CronCreate`，但不会带回 `ScheduleWakeup`，到点的唤醒丢失；Foundry 若再补发一次 cron 又会重复触发。
- 界面看不到 Codex 的目标，也不能暂停或清除。
- Codex 0.167 不再接受 `on-failure` 审批策略，已保存这个值的配置和会话启动失败。

## 调查

- Codex 0.167（`codex app-server` 的 JSON-RPC schema）：`thread/goal/get|set|clear`、`thread/goal/updated|cleared` 通知，目标状态为 active / paused / blocked / usageLimited / budgetLimited / complete；自动续跑、后台终端（command execution 项）和 `thread/queue/*` 只存在于 app-server 进程内，进程关掉即结束。服务端请求里有命令/补丁审批、`requestUserInput` 与 MCP elicitation。审批策略枚举里已没有 `on-failure`。
- Claude Code 2.1.x 与 Agent SDK：`canUseTool` 收到 `AskUserQuestion` 与 `ExitPlanMode`；计划获批时 Claude Code 原生会切到本人选择的模式。SDK 0.3.318 定义了 `active_goal` 消息（`SDKActiveGoalMessage`），但 CLI 2.1.311 运行 /goal 时没有发出它，Foundry 收不到 Claude 目标的信号，相应处理保留但不会触发。定时任务：Claude Code 恢复会话时带回 `CronCreate` 任务（只在其 hook 运行时才报告），不带回 `ScheduleWakeup`；Foundry 需要的定时恢复行为从 CLI 2.1.291 起才稳定（`claudeTimerResumeVersion`）。
- Foundry 原先的做法与上面冲突：每回合结束即关闭 Codex；提问只认“本人对话”；Worker 重启后不再知道会话的定时；最低 Claude CLI 版本跟随 SDK 的 `claudeCodeVersion`，而 SDK 经常比配套 CLI 早一个版本。

## 修复

- **提问与审批路由**（Server `session_questions.go`，Worker `claude-questions.ts`、`codex-app-server.ts`）：Server 为每个会话解析 `AgentSession.questionsTo`：本人对话为 `person`；由其他会话创建的为 `parent`（沿父链最多 8 层，到不了本人则为空）；定时、Issue、角色、工具会话为空，提问立即拒绝。`parent` 时提问结束子会话本回合，以 “Foundry question:” 投递到父会话收件箱，父会话用普通文字 `send_message` 回答，答案作为子会话下一条消息。Claude 的 `AskUserQuestion`、`ExitPlanMode` 与 Codex 的审批、`requestUserInput`、elicitation 共用同一套回答格式。本人对话中显示审批卡片（批准 / 拒绝 / 拒绝并说明）；计划获批后切到会话的常规模式；已回答、超时或被取代的提问在“待处理”中关闭。
- **Codex 常驻**（`codex-app-server.ts`、`codex-thread.ts`、`native-work/codex.ts`）：回合结束后只要 Codex 还有自己的工作（目标、后台终端、队列、自己发起的回合）就保留 app-server；Codex 自己发起的回合以续写（continuation）发布到会话。
- **目标**（`session_goals.go`、`goals.ts`、Web 对话侧栏）：Codex 目标显示在对话上下文面板（窄屏在标题栏），可暂停、继续、清除（经 `thread/goal/set|clear`，必要时先打开线程）。Claude /goal 的处理已就绪，但 CLI 2.1.311 不发信号，暂不生效。
- **定时恢复**（`agent-timers.ts`、`session-timers.ts`、`session_timer_fire.go`）：设备按会话保存最后一个持有进程报告的定时；Worker 重启后，`ScheduleWakeup` 与动态 loop 的唤醒由 Foundry 投递，已过期的唤醒只补发一次并标为补发；Claude 的 cron 交给 Claude Code 原生恢复，不重复触发。
- **审批策略**：去掉 Codex `on-failure`，已保存的值按 `on-request` 处理。
- **版本**：`@anthropic-ai/claude-agent-sdk` devDependency `>=0.3.318`、peer `>=0.3.201`；最低 Claude CLI 为定时恢复版本 2.1.291，不再跟随 SDK 的 `claudeCodeVersion`。新增 `test/codex-protocol-contract.test.mjs`，对照 Codex 生成的 schema 检查 Foundry 用到的方法与字段。
- **Issues 隐藏**：`apps/web/src/lib/feature-flags.ts` 的 `issuesEnabled=false`，侧栏、链接、操作都不再通向 Issues，`/issues` 打开工作区的对话；功能代码、Server 与数据不变。
- Foundry skill 修订 26（说明子会话提问如何回答）。

## 部署 / 版本

2026-11-08 在 `/tmp/fdy-deploy.lock` 下（15:31:57–16:01:42 UTC）把本分支对 `origin/main` `81973b46` 的 diff 以 `git apply --3way` 应用到 dev 主仓库（应用后 diff 与分支逐字节一致），`pnpm install --prefer-offline`（SDK 0.3.201 → 0.3.318）后 `pm2 restart foundry-web-dev`。

- Server：从主仓库 `go build`，binary sha256 `fe993630a665…`；旧 binary 留作 `~/.foundry/server/releases/dev023-candidate/foundry-server.pre-dev148`（`fb52bf46e3dc…`）。重启前在线备份 `~/.foundry/server/backups/foundry-20261108-1534-pre-dev148.db`（`integrity_check` ok，保留最新 3 份）。15:35:10 UTC `pm2 restart foundry-server`（未用 `--update-env`），healthz ok；在线的 6 台设备 7 s 内重连，运行中/阻塞的会话保持原状态。
- Web：`e1ea9c39ac09cc7c`（上一版 `23b800df393d55b2`，入口保存在 `~/.foundry/server/releases/dev148/previous-20261108T153914Z/`），经 `scripts/deploy-web-dev.sh` 发布，入口资源逐字节一致、同源 API 返回 JSON。
- Worker：`0.5.7-dev.318.g81973b46.local.1794152365`（上一版 `.313.gec721cf9…1794014301` 的包与 `release.json` 在 `worker-packages-rollback/before-dev148/`，另有 `release.before-dev148.json`）。经 compute 租约在 CanWendeMac-mini、byte-dev、byte-dev-sg、cottoncpp、limen-canada 后台运行 `foundry-worker update`，sg-chaos 用独立 systemd 单元；6 台设备记录均为新版本，5 台远端设备只剩新执行宿主；sg-chaos 的旧执行宿主还有运行中的回合，按排空规则等其结束后切换，未强制。macbook 离线，未更新。

- 16:21 UTC 补部署 Server `309a6f792f73`：PR 的 CI 发现 Feishu 卡片缺 “Goal updated” 的中文标签（`TestEveryProtocolProcessLabelHasAChineseCardLabel`），补为“目标更新”。同样在部署锁下构建；旧 binary 留作 `foundry-server.pre-dev148b`，重启前备份 `backups/foundry-20261108-1620-pre-dev148b.db`（integrity ok，删去最旧的 `…0916-pre-dev146.db`，保留 3 份）；healthz ok，6 台在线设备 5 s 内重连。这次构建时主仓库里已有 DEV-149（#226）的 Server 修复（15:49:58 UTC 以未暂存改动应用），因此该修复随此 binary 上线；15:35 的 binary 与之前运行的 binary 都不含它，没有回退。部署后主仓库每个改动文件与本分支 rebase 到 `ca999e10` 后的内容逐字节一致。

## 检查

- 分支（rebase 前的同一 diff）：`scripts/check-changed.sh` 14 项中 13 项通过（prettier、gofmt、protocol 构建与测试、Web tsc、84 个 Web 测试文件、Worker 构建、sqlitestore 与 builtinskills/httpapi/store 的 Go 测试、UI / 契约 / OpenAPI / 模块审计）；Worker 测试 123 个文件中只有 `external runWorkspaceSession preserves its prepared config inside the real OS sandbox` 失败。
- 该失败的原因：分支工作树的 `node_modules` 是指向另一工作树的符号链接，测试里的沙箱只放行测试根目录与系统路径，读不到链接目标。dev 主仓库真实安装后同一测试通过（22/22）；同一源码在符号链接工作树中仍然失败，确认与代码无关。
- dev 主仓库真实安装上的完整 Worker 测试（`scripts/run-worker-tests.mjs`，2500M 内存上限）：1240 项，1231 通过、0 失败、9 项按平台或需真实账号跳过（macOS 沙箱、原生 Codex / Claude 实网用例等）；上面的沙箱用例与 “the daemon handles every message type” 均通过。
- 部署前：Protocol、Worker、Web `tsc`、`go build` 与 `go vet`（httpapi、store）通过。

## E2E（dev，真实模型）

Claude 流程用本人账号下 byte-dev 的 `workspace` 工作区（只写 `dev148-synthetic/`）；Codex 与浏览器检查用 e2e-alice，在本机临时配对的合成设备（设备记录 `VM-4-8-debian`，`dev_a870ddf7-…`，独立状态目录 `~/.foundry/dev148-acceptance/`，运行 dev 主仓库的新构建）和合成工作区 `ws_68dbe9ca-…`（`~/dev148-synthetic-workspace`）。e2e-alice 的密码只由脚本从仓库外文件读入，未输出。

- (a) 子会话提问路由到父会话：编排会话 `sess_1794152801620281757` 创建子会话 `sess_1794152815343665061`；子会话 15:47:02 用 AskUserQuestion 提问，父会话随即收到 “Foundry question: session sess_1794152815343665061 … asks and waits for the answer”，用 `send_message` 回答 “blue”；子会话下一回合收到回答、写入 `child-color.txt`（内容 `blue`），回复 `DONE blue`。
- (b) Codex 目标：`sess_1794152814317659939` 设定目标后自己续跑完成 goal-a/b/c，面板显示“已完成 · 1万 tokens”。`sess_1794153047424822494` 在真实 Chromium 中：目标“进行中”（浅色、深色、1440 与 390，窄屏标题栏有“目标进行中”按钮），点“暂停”→已暂停（16:00:06），“继续”→进行中（16:00:18），“清除目标”并确认→目标消失（16:00:25），已在运行的那一轮 16:01:07 结束后没有再开新一轮（slow-6 未创建）；对话中显示“N 个不是你发起的回合 · 后台任务结束后 Codex 继续”。
- (c) ScheduleWakeup：`sess_1794152803830511050` 15:46:59 设定 120 s 唤醒，15:49:00 触发一次（`timerFire` `54a25901`），15:49:10 完成并写入 `wakeup.txt`。
- (d) Issues 隐藏：e2e-alice 的侧栏没有 Issues 入口，`/issues` 跳到工作区对话。
- (e) 本人对话的审批卡片（Codex，on-request）：`sess_1794153258528041793` 卡片“等待你的回答”，键盘聚焦“发送回答”后 Enter 批准，命令返回 `HTTP/2 200`；`sess_1794153445768341595` 深色 1440 / 390 与浅色 390 的待回答卡片，选“拒绝”发送后显示“已回答 · 拒绝”，Codex 回复未执行。三条审批在“待处理”中均为 `replied` / `superseded`。第一条 `sess_1794152814443742943` 无人回答，3 分钟后超时，卡片显示“已按自己的假设继续”。
- 收尾：上述 8 个合成会话已归档；合成 Worker（`dev148-synthetic-worker` 单元）及其执行宿主已停止，状态目录留在仓库外；byte-dev 上的 `dev148-synthetic/` 已删除；compute 租约已释放。
- 截图在本人工作区 `.foundry/attachments/20261109-dev148/`（目标浅/深/窄屏、暂停、继续、清除确认、审批卡片聚焦/深色/窄屏/拒绝后、Issues）。

## 限制

- Claude 的 `ExitPlanMode` 计划卡片（本人对话）没有在 dev 上用浏览器复核：没有本人账号的浏览器凭据，e2e-alice 的设备上也没有可用的 Claude 账号。该卡片（“Approve this plan?”）在 scratch 栈 nint2（同一份代码，真实 Claude）上验证过浅/深、1440/390、批准与拒绝；nint3 验证的是 Codex 本人审批卡片。
- Claude /goal：CLI 2.1.311 不发 `active_goal`，Claude 的目标不会显示，处理代码暂不生效。
- 在 dev 上没有实测 Worker 重启后的定时补发（单元测试与 scratch 栈 nint4 覆盖过：过期唤醒只补发一次并标为补发，cron 不重复）。
- 页面开着时回答审批卡片后，输入框上方“等你处理 · 1”至少 8 s 没有消失，刷新后消失（服务端已关闭该项）。
- macbook 离线，仍是上一版 Worker；sg-chaos 的执行宿主等运行中的回合结束后才切换。

## 验收步骤

1. 在本人对话里让 Claude 创建一个子会话，并让子会话用 AskUserQuestion 提问。预期：父会话收到以 “Foundry question:” 开头的消息；父会话用普通文字回复子会话后，子会话按回答继续，不需要本人介入。
2. 在 Codex 对话里让它设定一个需要多轮的目标（每轮等 1–2 分钟）。预期：右侧“活动 · 目标”显示目标、状态和用量；Codex 在你没发消息时自己继续，对话中出现“不是你发起的回合”；“暂停”后不再继续，“继续”恢复，“清除目标”确认后目标消失。
3. 让 Claude 用 ScheduleWakeup 约 2 分钟后唤醒自己。预期：到点触发一次，对话出现“定时任务已触发”及其结果。
4. 在 Claude 对话里用计划模式提出计划。预期：出现计划审批卡片，批准后按会话的常规模式继续执行；拒绝时 Claude 不执行。
5. 在 Codex 对话（审批策略 on-request）让它执行需要联网的命令。预期：出现审批卡片，批准后执行，拒绝后不执行；“待处理”中该项随之关闭。
6. 侧栏没有 Issues 入口，打开 `/issues` 会到当前工作区的对话。
