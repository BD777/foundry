# DEV-147 一轮的“无文字回复”被并到上一轮，看起来像回合被截断

## 问题

2026-11-07 本人报告：会话“地狱焚决群近两天消息总结”（`sess_1793699947780564649`，byte-dev，Codex 0.167.0，`byte-llm-gateway · flux/gpt-6-astra`）里，有些回合跑完命令就停了，没有任何收尾，像是被 Foundry 截断。

## 调查

- Foundry 只在 Codex 自己发出 `turn/completed`（status=completed）时结束一轮（`codex-app-server.ts`），没有超时或其他提前结束的路径。
- 经本人允许，通过 compute lease 只读查看 byte-dev 上该线程的 Codex rollout（`~/.codex/sessions/2026/11/03/rollout-…-01a1a0d9-….jsonl`）：每次空结束都是模型 API 返回了一条 `role=assistant, phase=final_answer` 的消息，`output_text.text == ""`；该请求的输出只有 4 个 token（推理也计入时为 31–418 个）。Codex 正确识别并记录了它，然后正常完成这一轮。网关报告的用量说明正文确实没有生成，不是网关丢了内容。
- 时间线：11-06 09:13 UTC 第一次出现（输入以“无需回复”结尾），之后定时任务“没有新增保持静默”的每次触发都是空答，11-07 起连本人发的“继续”也是空答，截至 11-08 11:37 共 19 次。同一模型在 Codex 0.166.0 上跑了 123 轮、在其他会话中跑了多轮，都没有空答。Codex 0.167.0 的发布说明没有相关改动。结论：这是模型在“保持静默”的指令下给出空的最终回答，并在线程历史里自我模仿，与 Codex 版本无关，**不需要锁定 Codex 版本**。
- Foundry 的问题在显示环节：Worker 在没有文字时报告 `Codex completed without a text response.`，Server 把它记成该输入的答复事件 `evt_<inputId>_answer`（没有 `message`）。Web 把所有“不带 message、id 中没有流式序号”的 `Response stream` 当作会话唯一的旧式流（`agent-event-log.ts` 的 `agentEventKey` / `responsePosition` / `appendAgentEvents` / `normalizeAgentEvents`，以及 `isMatchingResponseStreamEvent`），所以第二条起的每一轮答复都覆盖了会话里第一条同类答复，并显示在那一轮的位置。用该会话的真实事件跑 `chatMessagesForThread`：00:34 那一轮的答复显示在 23:35 那一轮末尾，“继续”这一轮什么都没有，与截图一致。

## 修复

- protocol：`sessionInputAnswerEventId(inputId)` / `isSessionInputAnswerEventId(id)` 命名这种答复；Server 用同名的 `store.SessionInputAnswerEventID`（id 不变，纯重构）。
- Web：输入的答复只属于它自己的输入，不再当作旧式流的快照（`isStreamAnswer` / `isLegacyStreamSnapshot`），也不与别的答复匹配。真正的旧式流（无序号的历史数据）照旧合并。已存的历史会话无需迁移，刷新即正确显示。

## 验证

- 新测试 `agent-session-events.test.mjs` “an answer the server recorded for an input stays in that input's turn”：修复前失败（第二轮答复出现在第一轮，第一轮答复丢失），修复后整批规范化与逐条实时合并两条路径都通过。
- 用该会话 23:34–00:35 的 55 条真实事件（只读导出，放在仓库外）跑 `chatMessagesForThread`：修复前 00:34 的答复出现在 23:35 那一轮、“继续”一轮为空；修复后两轮各自以自己的答复结尾（23:38:05、00:34:39）。
- `scripts/check-changed.sh`（prettier、gofmt、protocol 构建与测试、Web/Worker 类型检查、11 个 Web 测试文件、sqlitestore 与 store 的 Go 测试、UI 与契约审计）全部通过。

## 部署

- 2026-11-08 13:41 UTC：dev Web `23b800df393d55b2`（上一版 `0bb3898aea268fcb`，入口保存在 `~/.foundry/server/releases/dev147-input-answer/previous-20261108T134140Z/`），在 `/tmp/fdy-deploy.lock` 下从主仓库构建，经 `scripts/deploy-web-dev.sh` 发布，脚本确认入口资源逐字节一致、同源 API 返回 JSON。Server 改动只是给已有 id 命名，行为不变，未重新部署；Worker 未改动。
- 部署后在真实 Chromium（headless，独立上下文）中以 e2e-alice 登录 dev，打开其合成会话 `sess_1794014494961809154`，只在浏览器内把 `GET /api/agent-session-threads/…` 的事件替换为两轮合成空答（`dev147-synth-1/2`），没有写库，也没有运行模型。页面顺序为“turn one → 无文字回复 → turn two → 无文字回复”，build `23b800df393d55b2`；截图在本人工作区 `.foundry/attachments/20261108/dev147-two-empty-turns.png`。

## 验收步骤

1. 打开会话“地狱焚决群近两天消息总结”，刷新页面。
2. 预期：11-06 起的每个定时检查回合、以及 11-07 的“继续”回合，末尾都显示 `Codex completed without a text response.`，不再出现“跑完命令就结束、没有任何收尾”的回合；该文案只出现在对应回合，不会堆到更早的回合。
3. 之后新的空答回合在页面开着时也直接显示在当前回合末尾，无需刷新。

## 限制

- 空答本身是模型行为。答复文本仍是 Worker 的英文兜底文案 `Codex completed without a text response.`，没有本地化。
- 定时任务 prompt 里的“没有新增保持静默”是导致空答的直接原因：可以改成“不给其他会话或群发消息，但在本会话用一句话写本轮结论”。该任务属于本人，未改动。
