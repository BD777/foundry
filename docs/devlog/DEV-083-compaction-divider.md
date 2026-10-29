# DEV-083 对话里显示上下文压缩的位置

状态：Web 已部署 dev（`37c8ae8f9b2b08c1`），Agent 自验通过；Server 与 Worker 改动已在共享工作树，随今晚（22:05 北京时间）批量提交后的 Server 交接与 Worker 发布上线；待人工验收；未提交。负责会话 `sess_1793267095681128496`，编排 `sess_1793063405185071529`。

## 问题

用户（2026-10-29）：“compact 这个动作在 chat 内容里没有展示。加一个展示，让用户大概知道在什么位置发生了 compact。如果有 compact 前后的 context summary info 就更好了，没有也行。”

原状：压缩已被记录为会话事件（`metadata.contextUsage.compaction`，线上已有 183 条），但只用于 Context 面板的“压缩次数”；对话里只在过程分组中有一行“Claude is compacting the conversation context.”。导入的 Claude 原生对话还会把压缩摘要（`isCompactSummary`）显示成一条很长的“用户消息”。

## 方案与实现

- **Web**：对话中，压缩发生的位置显示一条分隔线，例如“上下文已压缩 · 自动 · 951.8K → 38.2K tokens · 17:01”。有什么数据就显示什么：
  - 压缩前的 token：Claude 会报告。
  - 压缩后的 token：Claude 在压缩记录里给出；Codex 不给，取压缩后的下一次请求输入。
  - 时间。
  - 有摘要时，分隔线是一个按钮，展开后显示 Agent 继续工作所依据的摘要，可复制，默认收起。没有摘要时只是一条说明。
  - Context 面板的“压缩次数”行显示“N 次 · 最近 时间”。这一行本身就是链接，点击后对话滚到那条分隔线并短暂高亮。
  - 顺带改进：所有 `?message=` 消息链接现在把目标消息滚到视口中间，不再停在顶部、被“对话目录”栏挡住。
  - 涉及文件：`components/conversation/compaction-divider.tsx`（新）、`features/chat/transcript-adapters.ts`、`transcript-projection.ts`、`chat-session-status.tsx`，中英文案。
- **Worker**（不改变 Agent 行为，只读取）：
  - Claude 压缩记录增加 `postTokens`。
  - 压缩后，从该会话自己的 transcript 中读出 `isCompactSummary` 摘要（按 `compact_boundary` 的 uuid 定位；分别在 0.2/1/3/8 秒尝试）。读到后上报一条 `compaction-summary:<uuid>` 边界事件，事件文字只是“已压缩”标签。旧 Web 只会显示一条普通分隔线，不会把整段摘要显示出来。
  - Codex 本地压缩的 `compacted.message` 作为摘要；远程压缩的摘要是加密的，因此没有摘要。
  - 原生对话导入：`compact_boundary` 成为带数字的分隔线，摘要并入它，不再作为用户消息显示。
- **Server**：只增加可选的 JSON 字段，透传数据：`AgentContextCompaction.postTokens`/`summary`，`TranscriptMessage.compaction`。没有迁移，不发通知。
- **协议**：`AgentContextCompaction.postTokens`/`summary`，`TranscriptMessage.compaction`。

## 测试

- Web：新增 `test/chat-compaction.test.mjs`（7 项）：
  - 分隔线位置与数字；
  - 摘要并入、不另成消息；
  - Codex 取下一次请求的输入；
  - 导入对话；
  - 旧 Server 去掉 compaction 字段时不出现第二条分隔线；
  - 分隔线所在页尚未加载时，摘要单独成为分隔线；
  - 键盘展开与收起、`aria-controls`、复制按钮。

  相关 17 个测试文件共 114 项通过。`tsc`、全部 UI 审计通过。
- Worker：新增 `test/context-compaction.test.mjs`（SDK 计数、按 uuid 从 transcript 读摘要、导入合并、Codex 摘要）；`context-usage` 断言更新为带 `postTokens`；相关 6 个文件 32 项通过；`tsc` 与 `audit:modules` 通过（新文件已登记到模块）。
- 用真实数据核对读取逻辑：用本工作区编排会话自己最近一次真实压缩做只读验证，只看长度和哈希、不输出内容。SDK `compact_boundary` 的 uuid 与 transcript 中的边界一致。截取压缩发生时的 transcript 片段，能读出 14,265 字符的摘要，与 transcript 中记录的长度一致。
- Server：`TestContextCompactionKeepsItsSummary`：模拟设备经 WebSocket 上报，浏览器再读取，`postTokens`、`summary` 与 `message.compaction` 都保留。

## 浏览器自验

- 合成栈（私有源码副本 + 空库，Server/Web 含本项）：在 Codex 合成会话中写入一条合成压缩记录和一条摘要事件，均标明为合成数据。
  - 分隔线出现在两条消息之间，显示“Automatic · 951.8K → 38.2K tokens · 07:37 AM”。
  - 键盘 Enter 展开与收起摘要。
  - 在 Context 面板点“1 · last 07:37 AM ↪”后，分隔线滚到视口中部（y=363/860）并高亮。
  - light/dark × 1280/390 均无横向滚动。

  截图在 `.foundry/attachments/20261029/dev083/`（不入库）。
- dev 上真实会话压缩：在 e2e-alice 的合成 Claude 会话中发送 `/compact`。Foundry 把它当普通文本交给了 Claude，Claude 回答它无法执行这个 CLI 命令，所以没有发生压缩。这个限制不属于本项，见下文。为此，DEV-048 合成设备临时运行本项的 Worker 构建，验后已停止（包括执行宿主）。合成会话已归档。

## 部署

- Web：12:55:58 UTC `scripts/deploy-web-dev.sh` 发布 `37c8ae8f9b2b08c1`（上一版 `5cfedf8c1085c147`，回滚副本 `releases/dev083-web/previous-20261029T125558Z`）。发布前 DEV-086 / DEV-088 确认可构建，全量 `tsc` 与全部 UI 审计通过；发布后 e2e-alice 打开合成会话，页面无报错。
- Server、Worker：按编排安排，今晚提交后一次 Server 交接、一次 Worker 发布。上线前，dev 上的压缩分隔线照常显示（数据线上已有）。展开摘要、Claude 的压缩后 token 数（先用压缩后的输入数）和导入对话中的数字，要等 Server/Worker 上线后才有。

## 限制

- 在 Foundry 聊天里输入 `/compact`，不会作为 Claude Code 命令执行。建议另开事项。
- 本项未在真实会话中等到一次压缩，触发成本高（约 1M token）。用真实数据结构回放并读取了真实 transcript 片段作为替代。
- Codex 远程压缩没有可读的摘要，分隔线只有时间，以及压缩后下一次请求的 token 数。

## 人工验收步骤

1. 打开一个发生过压缩的长对话（如编排会话）。预期：压缩处有一条“上下文已压缩 · 自动 · 约 970K → 约 11K tokens · 时间”的分隔线，位置在压缩前后两段对话之间。
2. 打开右侧 Context，展开状态，看“压缩次数”。预期：显示“N 次 · 最近 时间”。点击后对话滚到最近那次压缩，分隔线短暂高亮。
3. 今晚 Server/Worker 上线后，等一次新的 Claude 自动压缩。预期：分隔线可以点击，展开后显示 Claude 继续工作所依据的摘要，有复制按钮，默认收起。
4. 打开一个导入的 Claude 原生长对话。预期：原来那段很长的“This session is being continued…”用户消息不再出现，改为分隔线，摘要在其中展开。
