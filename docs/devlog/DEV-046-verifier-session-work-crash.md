# DEV-046 验证会话沙箱内 session-work 崩溃

2026-10-26 15:57，编排会话 `sess_1792999134370683044` 发起的独立只读复核 `sess_1793000979087414252`（linux-dev-4 / Opus 5.5，verification）运行 8 分钟后失败：“Sandboxed session exited with code 1”。

## 调查结论

- 日志 `~/.foundry/workspaces/ws_8d046eba-…/verifications/sess_1793000979087414252/session.stderr.log`：`ENOENT: no such file or directory, mkdir '~/.foundry/session-work'`，调用链 `WorkSupervisor` 构造 ← `sessionWork()` ← `emitForClaudeRuntime`（`runner/claude-messages.ts`）← `ClaudeBackgroundTaskTracker.changed/close` ← `closeActiveClaudeRuntime`。
- 触发：复核会话执行的 Bash 命令超过 2 分钟，被 Claude Code 转为后台任务，产生 `backgroundTaskSnapshot`。`emitForClaudeRuntime` 和 `timersObserved`（`runner/claude-runtime-start.ts`）直接调用 `sessionWork()`，后者首次调用时惰性创建设备级 supervisor 并 `mkdirSync(stateRoot/session-work)`。验证沙箱中 Foundry 状态目录被屏蔽且只读，抛错后运行时以该错误关闭；关闭时 tracker 再次上报，异常未被捕获，进程退出。
- 根因：非 supervisor 所有者的进程（沙箱 SDK host，`session/host-child.ts`，不调用 `startSessionWork`，也不 `attach` 会话）通过观测路径副作用创建了设备级状态。`supervisor.ts` 已注明“Sandboxed SDK hosts report events but do not own the device reconciler”，`recordWork*` 也用 `instance?.`，这几处调用没遵守。即使创建成功，未 attach 的会话也不会被记录，因此在该进程创建 supervisor 本无意义。
- 与磁盘无关：当时 `/` 剩余 12 GiB（89%）。

## 修复

由 `sess_1793001518812197918`（linux-dev-4 / Opus 5.5 high）实现：

- `session-work/supervisor.ts`：新增 `observedSessionWork()`，只返回已存在的实例，从不创建。
- `runner/claude-messages.ts`（`observeTimerRun/observeTimers/observeBackground/observeAgent`）与 `runner/claude-runtime-start.ts`（`timersObserved`）改用 `observedSessionWork()?.…`。
- 执行宿主与 daemon 在启动时经 `startSessionWork` 创建 supervisor，进程内运行先 `attach`，行为不变。其余 `sessionWork()` 调用（`daemon/session-run.ts`、`session-work/runtime.ts`、`execution-host/server.ts`）只在所有者进程中运行，保持不变；Codex 路径的 `recordNativeWork` 已是空实例即跳过。

## 验证与部署证据

- 新增 `packages/worker/test/sandbox-work-observation.test.mjs`：状态根不可写的沙箱 host 发出四类观测事件，并关闭带运行中 Bash 任务的 tracker，不抛错、不创建目录、仍发出 `agent_exit` 快照；所有者进程仍把后台任务写入 `session-work/inventory.json`。在 dist 中回退修复后，该测试以同样的 `mkdir …/session-work` 错误失败。
- 相关测试通过：claude-background-task-lifecycle 8、claude-timer-turns 6、session-work 31、native-agent-work 8、agent-background-tasks 13；`check-changed` 通过。编排会话审阅了 diff。
- 发布：随 DEV-044 修复一起打包，Worker `0.5.7-dev.81.gac22cc1.local.1793003292`（dev `release.json`）；包内 `session-work/supervisor.js`、`runner/claude-messages.js` 已复核含 `observedSessionWork`。linux-dev-3 daemon 与执行宿主已加载该版本（`sess_1792995418158071510` 报告）。dev-server（验证会话所在设备）仍待常规 Worker 更新。
- 未提交：git 操作时段为北京时间 22:00 至次日 9:00。

## 待完成

- ~~dev-server 更新 Worker 后，发起一次会运行超过 2 分钟 Bash 命令的验证会话，确认不再崩溃。~~ 2026-10-27 已完成，见下文。
- 人工验收待确认。

## 2026-10-27 09:19–09:30 dev-server 复验通过（编排会话 `sess_1793063405185071529`）

- 环境：dev-server 执行宿主 `0.5.7-dev.81…1793005823`（已含修复）。只读验证会话 `sess_1793063959078988040`（Limen · default / Opus，验证沙箱）。
- 前台 `sleep 150; echo DEV046_LONG_OK`：该版本 Claude Code 在 2 分钟超时后终止命令（exit 143），没有转为后台；会话继续运行。
- 后台 `run_in_background: true` 的 `sleep 150; echo DEV046_BG_OK`：输出 `DEV046_BG_OK`、exit 0，后台任务的开始与结束事件都经过原先崩溃的观测路径，会话存活并完成后续审查。沙箱内 `sandbox-work-observation.test.mjs` 3 项通过。
- 同一会话也证明外部连接（Limen）可以在验证沙箱中正常推理。
- 首次尝试 `sess_1793063862346283862`（linux-dev-4）因 `401 invalid or missing API key` 在首个请求失败；同时间 linux-dev-4 普通会话同样 401、my-cpa 验证会话正常，判定为 linux-dev-4 网关账号问题，与本修复无关。

## 2026-10-27 委托 Agent 准出（编排会话 sess_1793063405185071529）

用户于 2026-10-27 在编排会话中明确：“验证的话你自己接口级别+端到端级别自行验证吧”。以下为 Agent 自验证据，不代表用户本人测试；只关闭已验证范围。

- 结论：通过（委托 Agent 准出）。证据：验证会话 `sess_1793063959078988040` 在 dev-server 验证沙箱内经历 2 分钟超时与真实后台任务（`run_in_background`），会话持续运行并完成审查。

## 提交

- 2026-10-27 夜间窗口经 PR #150 合并到 main（merge `60496ca`），本事项一个提交；多事项共用文件随最后改动它的事项提交。CI 首轮暴露的 Node 22 / 无 Claude CLI / 测试竞态问题在同一 PR 内修复。
