# DEV-266 正文内联注释：选中 Agent 回答 → 评论 → 随消息一起发送

2026-11-17。本人反馈：很多时候需要在正文里逐条回复 Agent 的回答，希望参考 Codex App 的做法（选中文本、加注释、编号标记、输入框里的「N 条注释」芯片）。

状态：scratch 栈真实浏览器验证部分通过（见「验证」）；已部署 dev（2026-11-17）；Agent 代验收（2026-11-17，范围见各自验收记录）；已合入 main（PR #**PR**）。

## 事实与根因

- Codex App 发给模型的注释格式（已由编排端在 Codex rollout 中核对）：前置 `# Response annotations:` 说明段，随后 `<response-annotations>` 内是紧凑 JSON 数组（每项 `id` / `text` / `annotation`（无评论时省略）/ `source{messageId,startOffset,endOffset}`），再接 `## My request:` 与本人消息。模型用 `:codex-annotation{index="N" id="ID"}` 指向被回应的注释。
- 注释位置用 Foundry 消息 ID 与字符偏移表达，不用轮次号；同样的措辞出现在多轮时不会歧义。
- 本地 Codex rollout 中未找到该包装；字段名与顺序以 Codex App 的 app.asar 内嵌包装为准，并由编排端从本人在 Codex App 的一次测试 rollout 核对（rollout 内容未记入本文）。

## 改动

### Web（apps/web）

- `components/conversation/annotations.ts`：数据模型、格式化（与 Codex 包装逐字一致，有黄金字符串测试）、剥离包装、锚点哈希与校验。
- `answer-annotations.tsx`：Agent 回答上的选中 → 「注释」浮层 → 可选评论编辑器（✓ 或 Cmd/Ctrl+Enter 提交，Esc 取消）；编号标记（hover/focus 显示评论，点击再编辑）；已发送注释的高亮。
- `annotation-chip.tsx`：输入框芯片「N 条注释」，点开列表，可编辑、删除、全部清除；已发送消息里的「N 条注释」折叠列表。
- `annotation-reference.tsx` + `remark-codex-annotations.ts`：Agent 回答中的 `:codex-annotation{...}` 渲染为「注释 N」引用链接，悬停显示所选文本与评论，点击跳到源回答并高亮。未知 id 只显示编号，不显示原始指令。
- `use-conversation-annotations.ts`：草稿注释按会话保存，与草稿文本同一本地条目，刷新后保留；上限 20 条。
- `conversation-actions.ts`：发送时把注释格式化进消息；排队时随队列条目保存；发送被接受后清空草稿注释。
- `conversation.tsx`、`chat-message-list.tsx`、`chat-transcript-stage.tsx`：接入。只读或禁用的输入框不提供注释。
- 助理首页：补上 `storageKeyPrefix`（与 Chat 草稿持久化对齐），注释通过个人 Agent 收件箱发送。
- `components/ui/popover.tsx`：新增可选的受控 `open` / `onOpenChange`（向后兼容）。
- `scripts/audit-inline-styles.mjs`：为 `answer-annotations.tsx` 增加一条白名单，理由是测量出的选区位置通过作用域 CSS 自定义属性传入（与 chart、confidence-meter 的既有例外相同）。

### Server / Protocol

- 契约：`SessionInputAnnotation`（id、selectedText、sourceEventId、comment?、startOffset?、endOffset?、turnNumber?、messageAt?）；`SessionInput`、`TranscriptMessage`、`SendAgentSessionInput`、`CreateAgentSessionInput`、队列项、steer 载荷、个人 Agent 收件箱均可带 `annotations`。
- 服务端规范化：去掉空 id/空文本、去重、评论与选中文本各限 2000 字符、最多 20 条、偏移成对且合法。不改写提示词。
- 队列新增 `annotations_json` 列（含迁移）。

## 验证

真实浏览器（scratch 栈，合成长回答，未部署，无 Agent runtime）：截图 21 张存于 `/tmp/dev266-e2e/shots/`（未入库）。

- 通过（截图确认）：选中 Agent 回答 → 「注释」浮层；提交后正文末尾出现编号标记 1；输入框芯片「1 comment」带 ×；发送后的消息气泡显示正文与「1 条注释」折叠（气泡不显示包装原文）。浅色与深色主题的前几步已截图。
- 未完成（scratch 验证被提前终止）：键盘路径（截图 07 已生成，未确认结论）、窄屏（390px）、编辑与删除后的完整状态（截图 06 已生成，未逐项确认）、directive 引用链接与点击定位高亮、流式回答与只读会话的禁用。发送后停在「等待本地 daemon 取件」，因 scratch 栈没有 runtime，未验证模型收到的内容。

- `apps/web` typecheck：通过（exit 0，对照 worktree 的 protocol 源码，临时 tsconfig 已删除）。
- 定向 web 测试：63/63 通过（注释格式黄金串、包装剥离、已发送注释的偏移还原、directive 插件、conversation-input、personal-agent）。
- UI 审计（`audit:buttons`、`audit:native-controls`、`audit:inline-styles` 等）：全部通过（在修正原始 `<button>`/`<textarea>` 与内联样式后）。
- Go：`go build ./...`、`go vet`、gofmt 通过；定向测试（注释规范化、会话事件、队列往返与迁移、收件箱捕获/重放/重试、`sessions` 包）通过。
- 全量 `sqlitestore` 有一个失败 `TestPersonalAgentItemPageFiltersAndPages`，在干净 HEAD 上同样失败，与本改动无关。

## 限制

- Steer 注释需要 worker 把 `annotations` 写入它的 transcript 事件；载荷已带上，worker 尚未改动。
- 通道来源的收件箱条目目前不带注释（仅文本）。
- 工作树基于 HEAD c8c8a35e；与 live tree 的未提交改动在以下文件重叠，需合并时人工对齐：`personalagent/assistant/inbox.go`、`sqlitestore/migrations.go`、`store/contract-schema.json`、`packages/protocol/src/chat.ts`、`contract.gen.ts`、`contract-schema.json`。
