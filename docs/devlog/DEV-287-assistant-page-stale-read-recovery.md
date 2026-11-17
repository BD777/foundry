# DEV-287 助理页面实时更新：断网后不再卡住，陈旧读取不回退完成状态

状态：已部署 dev（2026-11-18）；Agent 代验收（2026-11-18，范围见验收记录）；已合入 main（PR #277）。

## 问题

- 2026-11-17 人在助理页面打开时，助理派出的 helper 完成，报告启动了新的首页回合；页面仍显示「Running」且没有回答，而事项面板已更新（回答已正确落库）。
- 复现（dev，e2e-alice 合成数据，助理 `asst_3fc8b4a2107893e6b1e36425a39aacdb`）：断网 20 s 后页面永久停在「没能加载你的助理 / Failed to fetch」，直到手动点「重试」。断网期间与之后，流事件仍然正常送达（见下方日志）。

## 调查与证据

### 1. 实时流复现（live，未断网）

- 页面 `/assistants/<id>` 无头 Chromium，EventSource 注入记录器。发送任务后 helper 启动、完成，首页回合 `sess_1794761923996513314` 与 helper 的 `agent_session_created/started/completed` 全部到达页面。
- 每条流事件的 `workspaceId` 均为助理当前工作区 `ws_4e5616b1-…`（`formerWorkspaceIds` 为 `ws_7ccbde37-…`，本次事件中未出现）。因此「流按 workspaceId 过滤丢事件」的假设在本次日志中不成立。
- 本次未能取得可靠的「回答何时出现在页面」计时：第一轮采样没有可区分的回答标记，之后的隐藏页运行因旧回答文本残留而误报（已作废）。页面实时可见性因此未经验证，列为限制。

### 2. 断网复现（offline，20 s）

事件日志摘录（相对发送时刻 t0 的秒数；断网 +10 s 至 +30 s）：

```
+4.3   agent_session_started   sess_…3314 (首页回合)
+28.4  agent_session_completed sess_…3314
+31    页面文本长度 2346 → 140，显示「没能加载你的助理 / Failed to fetch / 重试」
+33.4  agent_session_completed sess_…3314 (首页回合回答后)
+38.8  agent_session_event     helper 的回答流
+48.1  agent_session_completed helper
```

- 断网结束（+31 s）后流事件持续送达，但会话读取（`read()`）已在断网期间失败，页面状态为 `failed`。`historyNotice` 据此隐藏整段对话（`assistant-home.tsx`），即使流已经把新回合放进 `sessions`。
- 失败后没有任何自动再读：流以 `Last-Event-ID` 续传，没有 `resync`，`onResync` 不触发；只有手动「重试」能恢复。
- 复现脚本与事件日志保存在提交者的临时目录，不入库。

### 3. 陈旧读取覆盖（代码证明）

- `read()` 与 `readInFull` 的 `getAgentSession` 在请求发出时取得会话快照；若流在请求途中送来完成事件，快照返回后 `mergeLoadedAgentSession`（`apps/web/src/lib/agent-session-events.ts:223-226`）以 `incoming` 的 `status` 覆盖 `existing`，页面会回到 Running。
- 该路径未在 dev 上实际触发（需要读取与完成事件的精确交错），因此它是代码可证明的缺陷，不是已复现的根因。

## 根因

1. **断网后不再读取（已复现）**：会话读取失败后，页面停在 `failed`，没有任何自动重试；流续传不会触发重新读取，失败状态会一直遮住对话。
2. **陈旧读取覆盖流事件（代码证明，未复现）**：读取请求途中到达的流状态（尤其完成状态）会被快照的旧状态覆盖，且该会话不会再被读取。

## 修复

文件（`apps/web/src/features/personal-agent/use-assistant-conversation.ts`）：

- `failedReads` 计数 + 效果：页面为 `failed` 时 5 s（`failedReadRetryMs`）后自动再读，直到成功。
- `streamedAt`：`upsert` 记录流最后一次改变某会话的时刻。
- `readAsOf`：读取开始之后流改变过的会话，其会话级状态（`status`、`completedAt`、`response`、`error`、`lastActivityAt`）取流上的值；事件与首条输入仍取读取结果（否则 Feishu 首条消息会丢失，这一点已由既有测试 `assistant-conversation-order` 覆盖）。应用于 `read()` 与 `readInFull` 两处。

测试（新增 `apps/web/test/assistant-conversation-recovery.test.mjs`，修复前两条均失败，修复后通过）：

- 读取开始后、快照返回前收到完成事件：快照返回后状态仍为 completed，`working` 为 false。
- 首次读取失败（网络）后，无需任何操作在 15 s 内自动恢复为 ready。

## 检查

- 远端（CanWendeMac-mini，lease_aee511799707ac21d08c）：`web typecheck` PASS；`pnpm --filter @foundry/web build` PASS；`test/assistant-conversation-recovery.test.mjs` PASS（2/2）；`test/assistant-conversation-order.test.mjs` PASS（3/3）。
- 本地 prettier 检查对改动文件通过。

## 验收（部署后，dev）

1. 打开助理页面，断网约 20 s 后恢复：页面应在数秒内重新显示对话，不出现「没能加载你的助理」。
2. 保持页面打开，让助理派出 helper，helper 完成后回合结束：页面应实时显示最终回答与「已完成」状态，不停留在 Running。
3. 隐藏页面标签页后重复 2：回到前台时状态应与服务器一致。

## 限制

- 未部署到 dev；上面的验收需部署后执行。修复的实时效果未在 dev 上验证。
- 陈旧读取覆盖只有代码证明与单元测试，dev 上未复现。
- 没有取得可靠的「回答出现在页面」的实时计时；隐藏页运行数据作废。
- 未改动 `mergeLoadedAgentSession` 本身，只在 hook 层保护流上的会话级状态。

## 时间线

| 日期       | 事项                                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-18 | Agent 代验收（编排者，Web 3f88b417e868553f）：首次读取期间断网后，页面在 1.33 s 与 0.84 s 内恢复，无需点「重试」。陈旧读取覆盖仅由测试覆盖；隐藏页面的情形未跑（见限制）。 |
