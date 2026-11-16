# DEV-250 回答下方显示本轮派发：派出的会话、发消息的会话、派到的工作区

2026-11-16。本人反馈（截图：通道会话里一轮被折进「Finished thinking and called tools」）：

> 这里是否可以展示一下他是否有 send-message 到对应的 workspace？有的话应当展示出来，方便我追溯？

状态：已部署 dev（train14-20261116）；Agent 代验收（2026-11-16，范围见验收记录）；已合入 main（PR #271）。本项仅以定向测试、typecheck、UI audits 与合成截图验证，未做真实检查。

## 问题

Agent 把工作交给别的会话或工作区时（`create_session`、`send_message`、`dispatch_item`），调用只存在于折叠的过程组里。回答本身不说明工作去了哪里，本人要展开工具调用、读原始输入才能追溯。通道会话、普通对话、助理首页都一样。

## 改动

### 一、从工具调用记录派生（Web，无服务端改动）

- 新增 `components/conversation/turn-handoffs.ts`：
  - 按 `callId` 把一次工具调用的开始/完成（Claude）或调用与结果（Codex）合成一条记录。
  - 只认 Foundry MCP 工具名：`mcp__foundry__create_session|send_message|dispatch_item` 或 `foundry.create_session|…`。
  - 读 worker 自己序列化的工具调用结构，不读回答正文：
    - Claude：工具名 + 裸 JSON 输入；同 `callId` 的后续 tool 消息如果是 JSON，作为结果。
    - Codex：`Arguments` / `Result` / `Error` 分段（`Input`/`Output` 也认）。
    - 输入被 worker 截断时（`… truncated …`），用顶层字段扫描器读取截断前的 `title`、`workspaceId`、`sessionId`、`itemId`、`delivery`；不靠正则猜自然语言。
  - 失败调用（`status: failed`、`Tool failed`、`Error` 段或结果里的 `error`）保留一条 muted 行，带简短原因。
- 类型：`TurnHandoff`（原始 id 与字段）、`TurnHandoffView`（已解析的展示值）、`TurnHandoffLookups`（会话、子会话、工作区名、清单项标题的解析接口）。

### 二、挂在回合的最后一条回答下

- `projectTranscript(entries, { sessionId })` 在过程组 flush 时收集 handoff；遇到新的用户输入、divider 或 failure 时结束本轮，把本轮积累的 handoff 挂到本轮最后一条 assistant 回答上。因此行在折叠过程组之外，始终可见；没有派发就没有行。
- `chat-model.ts` 把 `handoffs` 从投影带到 `ChatViewMessage`；`chatMessageItems` 用宿主提供的 `handoffOf` 把原始记录解析成展示值（无宿主时也给出最小可用行）。
- 共享渲染组件 `components/conversation/turn-handoff-rows.tsx`：
  - 「→ 派出会话 <title> · <workspace> · 运行中/已完成/失败」
  - 「→ 发消息给 <title> · <workspace> · 打断当前回合/回合结束后」（默认 `boundary` 不显示）
  - 「→ 派到 <workspace>：<item title>」
  - 失败：「→ 派出会话失败：<原因>」等，整行 muted，不链接。
  - 会话标题是真实链接（`chatHref`，`target="_blank"`），可复制、可在新标签打开；普通点击按浏览器行为新开标签，保留当前追溯上下文。
  - 紧凑的 `lucide` 下折箭头 + 小字，无卡片、无背景块；多行自然换行。
- `chat-message-list.tsx` 只加三处：导入、`handoffsEqual` 并入 memo 比较、回答内容后渲染 `TurnHandoffRows`。
- `chat-virtualization.ts` 的高度估算加上每行 20px。
- i18n：`conversation.handoff.*` 中英文同步。

### 三、宿主解析（名字从哪里来）

- 聊天页 `use-chat-feature.tsx`：
  - 把 handoff 命名的会话 id 一并交给已有的 `useSessionLinks`（与「来自会话」共用缓存，跨工作区也能取标题/工作区）。
  - `handoffOf` 从当前工作区会话列表解析标题/状态；`create_session` 在结果缺失时，用「本回合会话的子会话 + 相同标题」找刚创建的会话（结构化匹配，不读正文）；工作区名来自 `workspaces`。
- 助理首页 `assistant-home.tsx` + `use-assistant-conversation.ts`：
  - `useAssistantConversation` 额外返回助理项目里的全部会话摘要（不只首页展示的 3 个），供 handoff 解析 helpers；不额外拉取任何 transcript。
  - `dispatch_item` 的清单项标题从 `assistant.listItems` 按 `itemId` 取。

### 未做：IM 写入行

设计中的可选项「→ 已回复到 openlark」本轮跳过。网关有 `extension_write_created_message` 审计，但 Web 没有按 session 读取它的接口或投影；现有 `/api/feishu-gateway/requests` 只返回请求字段，且没有到某个 transcript 回合的关联。要做得可靠，需要新增服务端 per-session 审计投影，不属于「便宜且结构化」的范围。未解析任何 shell 命令。

## 验证

- Web 定向测试（CanWendeMac-mini，`scripts/remote-check.sh`，lease `lease_99e65694…`）：`test/turn-handoffs.test.mjs`、`test/personal-agent.test.mjs`、`test/session-turns.test.mjs`、`test/transcript-pipeline.test.mjs`、`test/chat-transcript-classification.test.mjs`，68 pass / 0 fail。
- `tsc -p tsconfig.json --noEmit`（同一设备）：PASS。
- `pnpm audit:ui`（同一设备）：全部通过（含 component-system、state-layout、hints 16 项既有基线）。
- 截图（scratch stack，从本 worktree 构建；e2e-alice 登录；浏览器内替换所选会话的 `agent-session-threads` 与 related lookups 为合成事件，未写栈内数据；浅色）：
  - `.foundry/attachments/dev250/dev250-turn-handoffs-light.png`（1440×1500：create_session、send_message、dispatch_item、失败调用各一行）
  - `.foundry/attachments/dev250/dev250-turn-handoffs-narrow.png`（800×1500）
  - scratch stack 已 `down`。

## 验收步骤

1. 打开一个本轮调用过 `create_session` 的对话：折叠过程组下方、该轮回答之下出现「派出会话 <标题> · <工作区>」，标题可点击在新标签打开该会话；能解析到子会话时附「运行中/已完成/失败」。
2. 调用过 `send_message`：出现「发消息给 <标题> · <工作区>」；非默认 delivery 附「打断当前回合」或「回合结束后」。
3. 助理首页有 `dispatch_item`：出现「派到 <工作区>：<清单项标题>」。
4. 调用被拒绝/失败：出现 muted 的「…失败：<简短原因>」，不链接。
5. 没有派发的回合不出现任何行；多行按调用顺序排列。
6. 浅色/窄屏下不遮挡回答、不与过程组折叠行混在一起。

## 限制

- Claude 的工具事件不带 MCP 结果（worker 只发调用详情），所以 `create_session` 的新会话 id/状态要靠「父子会话 + 标题」在当前工作区会话列表中出现；找不到时只显示输入里的标题与工作区，不链接。Codex 的 `Result` 段能直接给出 id/状态。
- `send_message` 的目标在别的、当前未加载的工作区时，标题由 `/link` 解析；状态只在目标会话已加载时显示。
- `dispatch_item` 的清单项标题只在有助理清单数据的宿主（助理首页）显示；普通聊天页显示「派到 <工作区>」，因为 Chat 功能不持有助理清单。
- 截图里的 dispatch 行因此只显示工作区名；助理首页会带清单项标题。
- 旧 transcript 里的工具调用若已被截断到认不出工具名，或调用记录不在已加载的事件窗口内，不会补行。

## assistant-model.ts 的最小改动（供并行合并）

`apps/web/src/features/personal-agent/assistant-model.ts` 只加了三处，互相同一目的：

1. 导入区：`import { toolHandoffs, type TurnHandoff, type TurnHandoffToolStep } from "../../components/conversation/turn-handoffs";`
2. `AssistantLine` 接口：新增可选的 `handoffs?: TurnHandoff[]`。
3. `assistantLines` 内：
   - 每轮开始处新增 `let steps: TurnHandoffToolStep[] = [];`；
   - `flush` 内在 push 回答前把 `toolHandoffs(steps, session.id)` 挂到 `answer.handoffs`，然后 `steps = []`；
   - 循环顶部新增一段：`event.message?.kind === "tool" && event.message.text` 时把 `{id, callId, status, text, title}` 收进 `steps`。

没有改动用户消息分支、`isServerNotice` 判断、回答 id 合并逻辑或 `startsConversation`；DEV-252 改这些地方时不需要动本功能的三处。
