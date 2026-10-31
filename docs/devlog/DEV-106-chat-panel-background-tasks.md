# DEV-106 · 聊天右侧面板不显示 Claude 的后台命令

状态：已修复并部署 dev Web `c12e7f5aa210a44d`，Agent 自验通过（真实浏览器）；待人工验收；未提交。

## 问题

2026-10-31 23:01–23:15（UTC+8），`sess_1793342952134984811`（Claude）后台运行 `bv08r5s5p`（完整 verify）约 10 分钟。本人看右侧面板没有后台任务；同一时刻 `read_context scope=background` 返回它，状态 running。

## 调查

- 数据没问题。库里该会话 15:01:10Z 有 `backgroundTaskSnapshot`（`bv08r5s5p` running），15:27:48Z 才是 completed；Server 的窗口读取（`stateEvents`）按 `background` 键保留最新一条。
- 在 dev 用合成 Claude 会话复现（e2e-alice，DEV-048 合成工作区，后台 `sleep 420`）：页面刚加载（没有任何实时流）时，Server 的会话事件和 `GET /work` 都有该任务，但面板只有 Context / Files / Sources，没有 Background。所以不是流、焦点会话或快照时机的问题（另一会话列的三个假设都不成立）。
- 根因：PR #138（`c1338f7b`，2026-10-22）把 `<BackgroundSection>` 从 `chat-context-card.tsx` 删掉了。取代它的 `SessionWorkSection` 只显示 `schedule` 和 `agent` 行（`isSidebarWork`，DEV-022 为避免 Codex 的几百条命令进侧栏而过滤了 `process`）。Claude 的后台命令、监视器、工作流在工作库存里正是 `process`（`sessionwork/projection.go`），于是两处都不显示。`chatContextCardForSessions` 仍算出 `card.background`，`runningBackgroundWork`（回合结束后的“仍有后台工作”提示）也仍在数它，但没有地方渲染。`chat-context-folds` 测试还把“Background 不出现”写成了预期。

## 修复（只改 Web）

- `apps/web/src/features/chat/chat-context-card.tsx`：`data.background` 非空时渲染 `BackgroundSection`，不再依赖工作库存是否加载。进行中的在前，已结束的折叠，行可点开详情和输出。后台子 Agent 仍在 Subagents/Agents 区，不重复。
- DEV-022 的“不要把普通命令塞进侧栏”不受影响：`card.background` 来自 Claude 自己的后台任务快照（最多保留 20 条已结束），不是工作库存里的 Codex 命令执行。工作库存仍隐藏 `process`。
- 测试 `test/chat-context-folds.test.mjs`：原来断言 Background 不出现的用例改为断言“进行中 1 行、已结束折叠 `2 finished · 1 failed`”；新增“工作库存已加载时仍显示”用例。恢复修复前的 `chat-context-card.tsx`，两条用例失败；修复后通过。

## 自验

- `scripts/check-changed.sh --files`（2 个文件）：prettier、tsc web、64 个 Web 测试文件、12 项 UI 审计全部通过。
- 真实浏览器（e2e-alice，headless Chromium，DEV-048 合成设备 Worker 临时以 `systemd-run --user` 运行）。会话 `sess_1793463366800156975`（修复前）、`sess_1793464054073569150`（修复后，后台 `sleep 300` + 前台 `sleep 40`）：
  1. 修复前：回合进行中，面板没有 Background（`before-no-background.png`），而 Server 已有 running 快照。
  2. 修复后，回合进行中：Background 1，“Run sleep in background · Command · running 43s · Running”。
  3. 回合结束（答复 STARTED）后，任务仍在运行：面板持续显示 running，计时每 15 秒推进（`after-running.png`）。
  4. 任务结束（16:32:44Z）后：实时变为折叠行“1 finished”，不需刷新；Claude 随后在聊天里说明 exit code 0。
  5. 刷新页面：仍显示“Background › 1 finished”（`after-finished-reload.png`）。
- 截图在 `.foundry/attachments/20261031/dev106/`（不入库）。两条合成会话已归档（批次 `arch_01a192cf-…`），合成 Worker 单元 `dev106-dev048-worker` 已停止，e2e-alice 已登出，临时 cookie/环境文件已删除。

## 部署

- Web：2026-10-31 12:27 EDT（16:27Z）`scripts/deploy-web-dev.sh`，`c12e7f5aa210a44d`，上一版 `5c527bfe3ab74d38`，回滚入口在 `~/.foundry/server/releases/dev106-web/previous-20261031T162728Z`。从共享工作树构建（含他人未提交的 DEV-104 Web 文件，它们此前已在线上）。
- Server / Worker：不涉及。

## 人工验收

1. 打开一个 Claude 会话，让它后台运行一个较长的命令（如 `sleep 300`）。
2. 右侧面板出现 “Background 1”，命令行显示 Running 与已运行时间；回合结束后仍在。
3. 命令结束后该行折叠进 “1 finished”；刷新页面后仍在。

## 限制

- 前台 Bash 超过约 3 秒会被 Claude 登记为任务，它们也会出现在 Background（行为同 #138 之前）；已结束的最多保留 20 条。
- 没有为“工作库存隐藏 process”与“Background 区显示 Claude 后台任务”写成同一处说明；两处的分工只记在此文件。

## 流水

- 2026-10-31 20:15–20:45（北京时间）：复现、定位、修复、部署 Web `c12e7f5aa210a44d`、Agent 自验通过；待人工验收；未提交。
