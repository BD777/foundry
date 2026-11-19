# DEV-315 相邻注释消息显示为原始包装

2026-11-19。本人截图反馈：「连着发 annotation 似乎展示上会有问题」。第三条注释消息（运行中的 steer）整段显示为 Agent 收到的原始提示，没有「1 条注释」。

状态：**已部署 dev（Web，train 98，2026-11-19 约 08:35Z）；Agent 代验收仅覆盖 Codex，Claude 未验证；待本人验收**。

## 根因

Web 的 composer 队列 `onSent`（`apps/web/src/features/chat/use-chat-feature.tsx`）：队列条目变为已发送时，为它加一条 outbox 记录（`accepted`）。这条记录有两个缺陷：

1. 只带了 `text`（模型收到的包装），没有带 `annotations`。渲染时 `typedText` 不剥离包装，也没有注释芯片，于是显示原始提示。
2. 匹配规则（`chat-outbox.ts` `matches`）用 `agent-session:<sid>:<队列条目 id>` 与转录消息 id 比较。steer 的转录消息 id 是 `<回合输入 id>/steer_…`（Claude）或 `<回合输入 id>/<steerId>`（Codex），与队列条目 id 不同。于是记录永远不被标记为已送达，一直以 `waiting` 形式显示在转录末尾，直到刷新页面（outbox 只在内存中）。

同一会话的正常消息（composer 直接发送的）不受影响，因为它们的 outbox 记录与事件 id 一致。

## 排除的层（有证据）

- **服务端存储与推送**：运行中的两条 steer 在实时 SSE 帧与存储事件中都带有 `message` 与 1 条 annotation，数量与顺序一致，没有任何一帧的 steer 版本缺少 `message`。
- **Worker**：两条 Claude 测试与一条 Codex（立即 + 边界暂存）测试通过；执行宿主的 `claude-turn-controls.js` 已包含 DEV-266d 改动，宿主启动于 Worker 更新之后。
- **Web 事件层与适配器**：把实时帧按顺序重放（`appendAgentEvents` → `normalizeAgentEvents` → `sessionTranscriptEntries` → `projectTranscript`），两条 steer 渲染正确。
- 此前怀疑的「旧宿主」「合并 steer」「边界暂存合并」均不成立。

## 实时复现（dev，synthetic 账号 e2e-alice）

- 环境：e2e-alice 名下的合成设备（`dev_881ccb3c-2f85-4c77-8e61-85d0065a5b79`，设备标签 VM-4-8-debian，隔离的 HOME 与 state，独立 `FOUNDRY_STACK=dev315alice`）与合成工作区 `ws_1866c86f-d416-402c-a4a1-68ae8961dd1e`（路径为临时目录）。
- Claude 无法在此机器运行（`claude_local` 为 `missing_auth`；`limen_default` 绑定在另一台离线设备），因此复现使用 Codex（`codex_local`），它走同一条 steer 事件路径（`Steered into active turn`）与边界暂存。这是与截图（Claude）的差异，需在验收时补一次 Claude 会话。
- 步骤与 Web 相同的 API：`POST /api/agent-sessions/{id}/messages`（长 Bash `sleep 60`），运行中两次 `POST /api/chats/{chat}/queue`（`steer: true`，`delivery: boundary`，`annotations` 与包装文本由协议包的 `serializeAnnotatedPrompt` 生成，与 Web 相同），同一个回答的两条纯注释。
- 浏览器（agent-browser，e2e-alice 登录）观察：
  - 运行中、steer 前：没有原始包装。
  - steer 后（实时页）：原始包装可见（`raw-wrapper-visible=True`）。
  - 回合结束后（实时页）：仍可见。
  - 刷新后：不可见，注释正确显示。
- 实时页 DOM（React fiber）显示原始包装所在的消息对象：`clientId` 存在、`steered=false`、`annotations=0`、文本 750 字，即 outbox 记录，而不是 steer 事件的条目。

截图（未入库）：

- `/tmp/dev315-shots/01-running-before-steer.png`
- `/tmp/dev315-shots/02-after-steers-live.png`（原始包装可见）
- `/tmp/dev315-shots/03-after-turn-live.png`
- `/tmp/dev315-shots/04-after-reload.png`

实时帧与存储事件：`/tmp/dev315-evidence/capture5.json`（实时与存储的事件与帧，含文本，仅保存在本机临时目录）；脚本：`/tmp/dev315-evidence/drive5.py`。

用真实捕获数据回放（修复前后对比，同一批帧与队列条目）：

| 版本                                    | 送达  | 结果                                                      |
| --------------------------------------- | ----- | --------------------------------------------------------- |
| 修复前（onSent 无 annotations，旧匹配） | 0 / 2 | 两条 steer 各有一条 `waiting` 副本，副本显示原始包装      |
| 修复后                                  | 2 / 2 | 两条 steer 都与各自的队列条目匹配，没有副本，没有包装文本 |

## 改动

Web（`apps/web`）：

- `src/features/chat/composer/chat-outbox.ts`：带注释的记录按注释 id 集合与转录消息匹配（先于 id 与文本匹配）。两条相邻的纯注释 steer 各自匹配自己的记录。
- `src/features/chat/use-chat-feature.tsx`：`onSent` 带上队列条目的注释（`receivedAnnotations`），与转录一样显示为芯片，文本为本人原文。
- `test/chat-outbox-annotations.test.mjs`（新增，5 条）：纯注释 steer 送达；相邻两条各自匹配；未送达时以本人原文等待（不显示包装）；他人注释不误匹配；无注释的原有行为不变。修复前两条失败（送达与相邻），修复后全部通过。

Worker（`packages/worker/test/session-steer.test.mjs`，新增 2 条，保留）：

- Claude：两条纯注释 steer 并发进入同一回合，各自 `message` 保留包装与注释。
- Codex：一条立即、一条边界暂存（`boundaryLimitMs: 0`），各自 `message` 保留包装与注释。
- 这两条不是修复：它们守住 Worker 层，此前已确认 Worker 层正确。

文档：本文件与 `docs/devlog/README.md` 一行索引。

## 检查

- 本地：`packages/worker` `session-steer.test.mjs` 25/25（`tsc -p tsconfig.json` 重建 dist 后）；`apps/web` `chat-outbox-annotations.test.mjs` 5/5 与 `chat-steer-annotations.test.mjs`（远端 web-test PASS，65 秒）。
- 远端（byte-dev 计算资源）：`remote-check --web typecheck` PASS（47 秒）；`remote-build --web` OK（SHA256SUMS 校验通过，产物在临时目录）。
- 未做：完整 `pnpm test`；Claude 实机；修复后的 dev 实机（需先部署）。

## 部署

- 只涉及 Web。Server 与 Worker 不需要部署。
- 部署后按下面的验收步骤在 dev 上做一次真实浏览器检查。

## 验收步骤（部署 dev 后）

1. 用一个 Claude 会话（本人账号）：先发一条普通问题，等回答完成。
2. 让它运行 Bash `sleep 60`。
3. 运行中，选中上一条回答的一段文字，点「注释」，不打字，直接发送；紧接着对另一段文字做同样操作（连续两次）。
4. 预期：两条消息都显示为「1 条注释」（注释芯片），没有「Response annotations:」原文；回合结束后仍然一样；刷新后一致。
5. 回到第 3 步再做一次「注释 + 文字」的消息，预期显示注释芯片与文字。

## 限制

- 复现使用 Codex；Claude 的同一路径未在本环境实机验证。
- 修复依赖注释 id 唯一。同一注释被重复发送时（重试），匹配以注释集合为准。
- 收件箱（session inbox）的注释合并仍不支持注释（`mergedInboxInput` 不带注释），不可达，另案。
- 合成设备 `dev_881ccb3c-…` 与工作区 `ws_1866c86f-…` 仍留在 e2e-alice 名下（离线），未删除，等待本人决定是否清理。四个测试会话已归档（`arch_01a1f25c-35c5-794b-b41e-0c7c6cf09cf8`）。
