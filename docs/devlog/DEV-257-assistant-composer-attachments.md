# DEV-257 助理输入框支持图片与文件，与普通 Chat 一致

2026-11-16。本人反馈：

> Assistant 的输入框里面居然不能粘贴 image or files。我预期它的输入能力跟普通 Chat 的输入框一致。其实这是同一个组件吧？只是它在 Assistant 那里要隐藏 Provider、model、Permissions……尽量复用组件，用参数来控制细节变化。

状态：已部署 dev（train15/16/17-20261117）；Agent 代验收（2026-11-17，范围见验收记录）；已合入 main（PR #272）。

## 事实与根因

- 助理首页本来就用共享的 `components/conversation/conversation.tsx`（`composer={{ mode: "plain" }}` 只隐藏 runtime 控件）。
- 它没有传 `attachments` / `onAttachmentsAdd` / `onAttachmentRemove` / `onAttachmentsRestore`，所以 Conversation 不渲染附加按钮、文件输入、粘贴、拖放和预览；`assistant-home.tsx` 的 `send()` 也把 `_attachments` 丢掉。
- 服务端已经支持带附件的收件箱消息（通道消息经 `PrepareAssistantInbox` / `SaveInboxAttachments` 把文件挂到 turn 的 `input.Attachments`），但 **Web 收件箱捕获没有附件字段**，`deliverInbox` 对无 origin 的 web 消息只发 `entry.Text`。
- 上传本身是共享能力：`POST /api/attachments`（`uploadChatAttachments`）把文件写到工作区设备上。

## 改动

### Web：直接复用 Chat 的附件状态与上传路径

- 把 `features/chat/composer/use-chat-attachments.ts` 提升到共享层
  `apps/web/src/components/conversation/use-chat-attachments.ts`（features 不能互相 import）；Chat 的 `use-chat-feature.tsx`、`use-chat-send.ts` 改为从共享位置引入，行为不变。
- `assistant-home.tsx`：
  - 用 `useChatAttachments({ notify, workspaceId: agent.workspaceId })`，切换到另一个助理时 `reset()`；
  - 把 `attachments`、`attachmentUploading`、`onAttachmentsAdd`、`onAttachmentRemove`、`onAttachmentsRestore` 传给共享 `Conversation`，粘贴/拖放/回形针按钮、预览、移除、上传中状态全部由既有组件处理，没有第二套附件 UI；
  - `send()` 接收 `ChatAttachment[]`：上传未完成时提示并拒绝发送（与 Chat 相同）并返回 `false`；带文件的文本不当固定指令（stop/resume/accept/decline）；成功后用 `removeSent` 清掉已发送的附件，失败则保留以便重试；队列/列表触发的发送用传入的附件列表。
- `use-assistant-conversation.ts`：`send(text, clientId, attachments)` 把附件放进 `capturePersonalAgentInbox`；乐观 pending 行与「已收到」行携带附件，附件单独成条时不再渲染空文本行。
- `assistant-model.ts`：`AssistantLine` 增加 `attachments`；用户消息有附件但无文本时也保留；会话输入事件的合成消息带上 `input.attachments`，聊天记录因此能显示已发送的图片/文件。
- i18n：`personalAgent.conversation.uploadingWait`（en/zh-CN）。

### Server/Protocol：Web 收件箱条目保存附件并随 turn 投递

- `store.PersonalAgentInboxEntry` / `PersonalAgentInboxCapture` 增加 `Attachments []ChatAttachment`（JSON `attachments`）；protocol TS 同步。
- `sqlitestore/personal_agent_inbox.go`：`pa_inbox` 增加 `attachments_json`（幂等 `ALTER TABLE`），列、扫描、插入、idempotency 比较都包含附件；`RetryPersonalAgentInbox` 从原条目复制附件，重试不丢文件。
- `CaptureInboxOrigin` 规范化并保存附件；`flow.Capture` 允许「只有附件、没有文本」的消息（与 Chat 一致），文本为空且无附件仍拒绝。
- `deliverInbox`：无 origin 的 web 消息把 `entry.Attachments` 作为 turn 的 `input.Attachments`；通道消息保持原路径（`PrepareAssistantInbox`）。

## 验证

- Go 定向（byte-dev，`scripts/remote-check.sh`）：
  - `./internal/httpapi -run 'TestAssistantInbox'` PASS；新增
    `TestAssistantInboxDeliversWebAttachmentsWithTheTurn`：纯附件消息经 `DrainInbox` 后，worker 收到的 `Session.Input.Attachments` 为两条（`photo.png`、`notes.txt`），回执仍带附件。
  - `./internal/sqlitestore -run 'TestInbox'` PASS；新增
    `TestInboxKeepsWebAttachmentsAcrossRetry`：附件落库、重放幂等、改附件触发 `ErrIdempotencyConflict`、空文本无附件被拒、重试保留附件。
  - `./internal/personalagent/flow` PASS（新增纯附件消息接受的断言）。
- Web（byte-dev + 本机）：
  - `typecheck` PASS（byte-dev，最终版本）；
  - `test/personal-agent.test.mjs`、`test/turn-handoffs.test.mjs`、`test/assistant-conversation-order.test.mjs` 51/51 PASS；
  - `test/i18n.test.mjs` 3/3 PASS；
  - `pnpm audit:ui` 全部 audits PASS。
- 真实浏览器粘贴/附加检查：本会话的 scratch 栈按编排指示中止并清理（sg-chaos 不适合长时间 web 构建，当晚已有一次 OOM）；该项由编排会话在部署后的 dev 上用真实浏览器完成。

## 验收步骤

1. 打开任一助理首页，输入框左侧有回形针；粘贴一张图片、拖入一个文件或点回形针选择文件：出现缩略图/文件名，可逐个移除；上传中显示「Uploading…」。
2. 只发附件（不输入文字）也能发送；上传未完成时发送被提示而不是丢附件。
3. 发送后消息在对话里显示附件；服务端收件箱条目 `attachments` 含这些文件，等待/失败的「未处理消息」重试后附件仍在。
4. 助理所在电脑在线时，turn 的 `input.Attachments` 就是这些文件（Worker 按既有聊天附件路径放进 `.foundry/attachments`）。
5. Runtime/model/Permissions 控件仍不出现（`composer.mode: "plain"` 未改）；Chat 的附件行为不变。

## 限制

- 真实浏览器端到端（粘贴后 worker 在 `.foundry/attachments` 落盘、模型看到图片）未由本会话执行；Go 测试证明收件箱 → `Session.Input.Attachments`，Worker 落盘是 Chat 已有的同一条路径。
- 助手首页的历史记录现在会显示带附件/纯附件的消息；更早的已发送附件若能从未归档会话读取，也按同一路径显示（未额外迁移历史数据）。

## 部署与线上验证（2026-11-17）

- 已部署 dev（train15-20261117）：Server `8352231b…`，Web `27fa57a4b71c210d`，Worker 未变；部署前备份 DB（`foundry-20261117-0050-pre-dev257.db.gz`）。
- 线上真实浏览器（编排会话代验，e2e-alice，本人账号未碰）：临时用已发布 runtime `.1794816056` 跑 e2e-alice 的合成设备 Worker（`systemd-run --user` 单元 `dev257-dev148-worker`，验后停止，含执行宿主）。
  - 在助理输入框粘贴合成图片 `dev257-paste.png`，用附件按钮加入 `dev257-notes.txt`：输入框里出现图片缩略图和文件卡片，可移除。
  - 发送「DEV-257 合成验证：请只回复你收到的附件文件名」：消息气泡带图片和文件。15 秒内助理回复 `dev257-paste.png dev257-notes.txt`，说明两个文件都随这一轮交给了助理。
  - 截图在 `/tmp/q/shots/`（不入库）。浏览器为临时 headless 上下文，验后登出；密码只由脚本从仓库外文件读取。
- 待本人验收：在 ByteWork 的输入框里粘贴一张图片（或拖入一个文件）再发送，确认助理能看到。
