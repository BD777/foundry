# DEV-267 助理对话不再出现授权外写操作的原始卡片；被停止的一轮说出来

状态：已部署 dev（2026-11-17）；待本人验收；已合入 main（PR #**PR**）。

2026-11-17。本人截图（ByteWork 首页）反馈：「1. 样式难看 2. 我发的那条消息没有给我回复？」

## 1. 授权外写操作的卡片

### 调查

- 首页对话里的卡片不是 Server 生成的会话条目：Web 读 `GET /api/personal-agent/proposals`，由 `apps/web/src/features/personal-agent/assistant-model.ts` 的 `placeProposals` 把每条提议插进对话，`proposal-card.tsx` 画卡片。
- Server 唯一的卡片生产者是飞书：`apps/server/internal/feishu/personal_agent_cards.go` 的 `PersonalAgentProposalCreated`（会话话题或助理单聊里发 `BuildProposalCard`）。`pa_proposals` 里的 `connector_write` 由 `internal/connectors/confirmations.go` 建立，摘要里带原始请求路径（截图里的 `POST /api/connectors/extensions/openlark/gateway/agent/v1/documents/drive/items`）。
- Needs you 走 `pending_items`（`pending_connector_write.go`），与提议列表无关，所以从对话源里排除不影响它。
- 其他提议种类（`create_workspace`、`archive_workspace`、`rename_workspace`、技能/连接器变更等）的摘要来自 `personalagent/texts.go` 的 `actionPhrases`，按本人语言生成、只带项目或文件夹名，没有原始路径或 id；本次不改。
- 飞书里按词回答（「好」「不用了」）的 `answerProposalByWord` 会匹配该会话的待决提议；排除 `connector_write` 后，本人在没看到卡片时也不会用一句话盲答。

### 修复

- Web：`conversationProposals()` 在读取提议列表时排除 `kind === "connector_write"`（`use-assistant.ts`），首页对话与「好/不用了」都不再包含它；今天已渲染的两张卡片随之消失。
- Server：`PersonalAgentProposalCreated` 与 `answerProposalByWord` 跳过 `connector_write`；Needs you 仍是它唯一的决定入口。

## 2. 被停止的一轮

### 谁停的（证据）

不是本人。`pa_run_controls` 行 `parctl_91065d32…`（会话 `sess_1794542612133670581`，输入 `b504486c…`）：

```
state=stopped  stopReason=observed_token_budget
observedTokens=785380  tokenBudget=500000
lastUsageAt=2026-11-17T03:34:38.817Z  confirmedAt=2026-11-17T03:34:39.191Z
```

助理运行控制（`internal/personalagent/assistant/run_control.go`）在 30 秒一次的巡检里看到该轮已观察用量超过 50 万，向设备发 `cancel_session`，再用 `CancelPersonalAgentInput("Stopped: observed_token_budget")` 结束会话。设备端不知道原因，发出通用的 `Session canceled / Canceled by user.`，且 Worker 的完成报告先到，会话因此留下 `Session was canceled.`——本人看到的「Canceled by user」是错的。

同一机制历史上的停止（全部 `pa_run_controls`）：

| 会话                     | 时间              | stopReason            | observedTokens / tokenBudget |
| ------------------------ | ----------------- | --------------------- | ---------------------------- |
| sess_1792543738826399636 | 2026-10-21 00:53Z | observed_token_budget | 192518 / 100000              |
| sess_1794542612133670581 | 2026-11-17 03:34Z | observed_token_budget | 785380 / 500000              |

另有 `person_requested`（本人的停止）与 `assistant_stopped`（停止开关）各一次。

### 根因：预算把缓存读取按全价计

`observeAssistantInputTokens` 用该轮最新一次原生用量 `InputTokens + OutputTokens`，而 Worker 的 `turn-usage.ts` 把 `cache_read_input_tokens` 加进了 `InputTokens`。长对话每轮重读约 8.5–8.8 万 token 的缓存上下文，9 次模型请求就超过 50 万，正常的一轮被杀。预算本意是拦住失控的轮次，不是按账单计费。

### 修复

- 预算改数「未缓存输入 + 缓存写入 + 输出」：`observedTurnTokens` = `InputTokens - CacheReadTokens + OutputTokens`（负数按 0）。Server 端只用 Worker 已上报的字段，Worker 协议不变。
- 原因写进会话终态：`CancelPersonalAgentInput` 在 Worker 报告先到、会话已是 `canceled` 时，用 Server 的原因替换通用消息；已完成/失败的会话不改。Worker 的取消事件改为中性的「The turn was stopped.」，不再假称是本人。
- 首页：一轮没有写出回答就结束（`canceled` / `failed`）时，在本人那条消息下一行说「已停止：这一轮用量超过上限」（`observed_token_budget`）、「已停止：这一轮超时」（`timeout_budget`）、「已停止」（本人停止）或「没有完成：<原因>」（失败），旁边是「重试」，走与 Needs you 相同的 `POST /api/personal-agent/inbox/{id}/action` retry。
- 文档：`docs/personal-agent.md` §9 写明该上限的计数口径与终态原因。

## 验证

- Go：`go test ./internal/httpapi ./internal/feishu ./internal/sqlitestore`（结果见下方时间线）。
  - 新增 `TestAssistantTurnBudgetExcludesCacheReads`：9 次 × 8.7 万缓存 + 少量未缓存/输出约 1.3 万，低于 50 万；纯新输入的失控轮次仍超过 50 万。
  - 新增 `TestAssistantRunControlReasonWinsOverWorkerCancel`：Worker 先写 `Session was canceled.`，Server 原因覆盖；已完成的会话不被改写。
  - 新增 `TestConnectorWriteProposalPostsNoCard`：`connector_write` 不发飞书卡片，普通提议仍有卡片。
- Web：`pnpm typecheck`；`node --import ./test/register-bundler-resolve.mjs --test test/personal-agent.test.mjs`（新增两条：无回答结束的 `ended` 行与原因；`conversationProposals` 排除 `connector_write`）。
- Worker：`pnpm typecheck`。

## 限制

- 本次之前已经结束的会话保留旧的 `Session was canceled.`，界面显示「已停止」；新的停止才带 Server 原因。
- 失败的 `<原因>` 取会话错误首行原文（Worker 的英文失败分类尚未在首页本地化），后续可复用聊天页的失败文案。
- 已部署 dev（2026-11-17）；待本人验收；已合入 main（PR #**PR**）。
