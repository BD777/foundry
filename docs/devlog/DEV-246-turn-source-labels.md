# DEV-246 不再折叠非本人回合，改为逐轮标出来源

2026-11-16。本人反馈（截图：`4 turns you did not start · 4 after background work 10:47–10:49`）：

> 这个折叠感觉不是很妥，因为有些事情是我的 query 之后他异步完成，所以对我的回复也被折叠进去了。要不改成不要折叠了，在 UI 上明显一点区分出"我发的、其他 session 发的、background task 发的、等等"？

状态：已部署 dev（train10-20261116）；Agent 代验收（2026-11-16，范围见验收记录）；已合入 main（PR #271）。本项仅以定向测试、typecheck、UI audits 与合成截图验证，未做真实检查。

## 问题

会话把「不是本人发起」的连续回合折成一行。本人提问后，Agent 在后台任务结束时异步续答，这个答复合法的回合不是本人发起，也会被折进那一行，本人看不到给她的回答。折叠只从「谁发起了这一轮」判断，无法知道这一轮其实是在回答本人的问题。

## 改动

### Server：结构化 `inputSource`（DEV-246）

- 契约新增 `AgentSessionInputSource`：`kind`（`person` / `session` / `child_report` / `background` / `scheduled` / `foundry_notice` / `channel`），以及 `sessionId`、`title`、`status`、`response`。`SessionInput` 与 `AgentSessionEventMetadata` 各带一个 `inputSource`；生成文件同步更新（`contracts/models/sessions.yaml` → Go / TS / schema）。
- 输入在创建处就记录来源，Web 不再读提示词：
  - `SendAgentSessionInput.InputSource` / `CreateAgentSessionInput.InputSource` 可由调用方显式设置；未设置时由 `InputSourceOf` / `FirstInputSource` 按 `timerFire`、`channelOrigin`、`sentBySessionId` / 父会话推导，默认 `person`。
  - 会话收件箱 `session_inbox` 新增 `input_source_json`（幂等迁移），`SendInboxMessage` 的普通消息写 `session`；`startTurnWithInboxItems` / steer 把它带给新输入；多条消息合并且来源不同时记为 `session` + 首个发送者。
  - 子会话的 `turn_end` 报告写 `child_report`，带子会话标题、`completed`/`failed` 状态和最终回答（失败且无回答时带错误摘要）；旧报告释放时也带同一来源。
  - 助理的 Foundry 自身通知写 `foundry_notice`。
  - 个人记忆的 `PersonWords` 先按结构化来源判断，旧输入仍保留提示词兜底。

### Web

- 删除自动折叠：`components/conversation/session-turn-folds.ts`、`session-turns-fold.tsx` 移除；`chat-transcript-stage.tsx` 不再生成折叠行、开合状态和就地滚动，所有回合按顺序内联。
- `components/conversation/turn-source.ts` 的 `isTurnInput` / `turnSource` 先读 `inputSource`：
  - 本人：普通用户气泡，不加额外标签。
  - 其他会话：「来自会话 <标题>」，可打开。
  - Helper 汇报：「<helper 标题> 汇报 · 完成/失败」，只显示 `response`（最终回答或错误），可打开对应会话。
  - 后台任务完成 / 定时任务：「后台任务完成：<任务描述>」/「定时任务：<标题>」。
  - Foundry 通知：「Foundry 通知」。
  - 通道：保留 DEV-234 的 `openlark · 群名 · 张三 · 时间` 来源头（`channelOrigin`），不套新行。
  - 其他：通用「自动触发（<原始 kind>）」。
  - 文本前缀（`Foundry report:`、`[Foundry]`）只作为旧事件的 legacy 兜底，注释里写明。
- 非本人输入由新的 `turn-source-row.tsx` 渲染成紧凑系统行：图标、来源标签、时间，正文超过约 6 行时可展开/收起；样式与本人的右侧气泡不同。其后的 Agent 回答照常显示，不再被任何折叠遮住。
- 后台/定时来源的任务描述仍来自 `timerFire.prompt` 首行写入的 `continuationDetail`（`transcript-adapters.ts`）。
- 保留「只看我的对话」开关（`chat.onlyMine`），它仍是本人显式选择，且始终出现在会话标题栏（不再只在有折叠时才出现）：`visibleSessionTurns` 只隐藏满足原折叠条件的非本人回合（不含正在运行、有待回答提问、或本人在其中说过话的回合），不再生成折叠行。中英文提示去掉「折叠」措辞。
- 内部改名 `foldedTurns` → `hiddenTurns`、`onFoldedTurnsChange` → `onHiddenTurnsChange`；删除 `SessionTurnsFold` 类型和 `sessionTurns` 文案，新增 `turnSource` 文案（中英文同步）。

## 验证

- Go 定向测试（CanWendeMac-mini）：`internal/store`、`internal/sessions`、`internal/personalagent` 全包 PASS；`internal/sqlitestore` 输入/线程相关用例 PASS；`internal/httpapi` 的 `TestChildReport…`、`TestInbox…`、`TestSendReceipt…`、`TestChatQueueSteer…` PASS。新增 `TestSessionInputSourceIsStructured`、`TestNewSessionInputSourceIsStructured`，并在子报告/收件箱测试中断言结构化来源。
- 契约：`pnpm audit:contract` PASS；`node scripts/generate-contracts.mjs --check` 本机 PASS（无遗留差异、无可破坏变更）。远端 `pnpm audit:openapi` 因 runner 无法访问 `goproxy.cn` 未能下载 oapi-codegen，属环境网络问题。
- Web 定向测试（CanWendeMac-mini）：`test/session-turns.test.mjs`（新增结构化来源用例）、`test/i18n.test.mjs`、`test/waiting-children.test.mjs`、`test/chat-linked-session.test.mjs`，22 pass / 1 skip（skip 为既有）。
- `tsc -p tsconfig.json --noEmit`：PASS；`pnpm audit:ui`（全部 UI audits）：PASS（含 inline-style、state-layout、component-system）。
- 截图：scratch stack（从本 worktree 构建）中以 e2e-alice 登录，浏览器内替换所选会话的 `agent-session-threads` 响应为合成事件（未写栈内数据），浅色 1440×1250：
  - `.foundry/attachments/dev246/dev246-turn-sources-light.png`（本人、后台完成、helper 完成/失败汇报、其他会话）

## 验收步骤

1. 打开一个本人提问后由后台任务异步完成的会话：所有回合内联显示，不再出现「N turns you did not start」折叠行，后台续答直接可见。
2. 后台回合上方显示「后台任务完成：<任务描述>」；定时回合显示「定时任务：<标题>」。
3. 其他会话发来的输入显示「来自会话 <标题>」，helper 的 turn_end 显示「<helper 标题> 汇报 · 完成/失败」，只显示最终回答（失败显示错误），链接可打开对应会话。
4. Foundry 自身输入显示「Foundry 通知」；通道回合仍显示 DEV-234 的来源头。
5. 长正文的来源行可「展开完整内容 / 收起内容」。
6. 「只看我的对话」仍可隐藏非本人回合；关闭后全部恢复，提示不再提折叠。

## 限制

- 本次改动之前存下的输入没有 `inputSource`，Web 仍按旧提示词标记兜底；新输入全部走结构化来源。
- 「其他」来源只在数据出现未知 kind 时出现。
- 截图中的 helper/其他会话标题是合成数据。
