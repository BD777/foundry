# DEV-095 由其他会话创建的会话（交接、子会话）也有聊天队列

状态：Server 与 Web 已部署 dev，Agent 自验通过（真实浏览器、合成 Claude 会话）；待人工验收；未提交。负责会话 `sess_1793325310349208118`。

用户 2026-10-30 选择方案 1（“选项1，按你建议修”）：所有由其他会话创建、没有 role 的会话都接入队列。

## 问题

本人在交接会话 `sess_1793310871114448129`（由 `sess_1793063405185071529` 交接，北京时间 2026-10-30 09:54 回合结束）运行中按 Enter 发了一条消息。按 DEV-082，这条消息应在下一个工具步骤插入；实际上它一直留在输入框上方。回合结束后它也没有自动发出，只显示一个手动 “Send” 按钮。

只读查询 dev 数据库：`chat_queue_items` 和所有会话事件里都没有这条消息。消息只在浏览器内存里，没有交给 Server，刷新页面就会丢失。

## 原因

- 该会话的 `source` 是 `agent`。凡是由另一个会话创建的会话（`create_session`、`handoff_session`）都是这个值。
- Server 的聊天队列只认 `source` 为空或 `chat`、且没有 role 的会话（#118）：
  - 队列接口对其他会话返回 404 “not a chat”（`chatQueueChat`）；
  - 回合结束后不会续发（`chatQueueReactions.sessionChanged`）；
  - 不跟踪工具边界（`onChatToolEvent`）。
- Web 端与之对应（#132，`chatHasQueue`）：不给这类会话队列 id。
- 输入框在 Server 队列模式下，没有队列 id 时会把消息放进内存里的待发列表，等会话出现队列。对 `agent` 会话来说，这一刻永远不会到来。
- 在 DEV-082 之前，运行中这一行会显示手动“引导”按钮，所以问题不明显。DEV-082 把 Enter 改成“下一步插入”后，消息就静默地留在原地。

## 修复

- Server（`httpapi/chat_queue.go`）：新增 `hasChatQueue(session)`，取值为“没有 role，且 `source` 为空、`chat` 或 `agent`”。`chatQueueChat`、`sessionChanged`、`onChatToolEvent`（`chat_queue_steer.go`）三处都改用它。naming、digest、verification 等后台会话和带 role 的会话（Personal Agent）仍没有队列。
- Web（`features/chat/chat-session-model.ts`）：`chatHasQueue` 加入 `source === "agent"`。
- 效果：在这类会话中，三种投递方式与普通聊天一致，消息由 Server 保存，刷新不丢，回合结束后自动续发。
- 预期的副作用（用户已知并选择）：
  - 本人排队的消息可能在父会话的下一条 `send_message` 之前开始新回合；
  - 这个回合结束后，DEV-090 也会照常向父会话汇报。

## 测试

- Go：新增 `TestChatQueueCoversSessionsAnotherSessionStarted`，覆盖：
  - `source=agent` 的子会话可以入队；
  - 推理中按 boundary 发送时保持不动，工具开始后引导进回合；
  - 回合先结束时，被保持的消息成为子会话的下一回合；
  - naming 会话的队列返回 404。

  `go test ./internal/httpapi -run TestChatQueue -count=3` 通过。

- Web：`test/chat-session-source.test.mjs` 更新为：`agent` 子会话有队列，naming、digest、verification 和 Personal Agent 没有。
- `scripts/check-changed.sh --files <5 个文件>`：prettier、gofmt、tsc、64 个 Web 测试文件、httpapi 9 个测试、12 项 UI 审计、audit:contract 全部通过。

## 部署

- Server：北京时间 2026-10-30 10:30:00 SIGHUP 交接，新进程 1.5 s 就绪，旧进程 668 ms 后退出，healthz 200。
  - 构建自 main `a0ba354a` 加本项改动；其他会话只有文档未提交，没有代码改动。
  - sha256 `8e40c2b56ad59fee1dde85381d7be6bc8a7797780ba21ba66bfb3ed879897b85`。
  - 回滚副本 `releases/dev023-candidate/foundry-server.pre-dev095`，sha256 `11f0862c…`。
  - 部署时只有本会话在运行。
- Web：10:30:48 `scripts/deploy-web-dev.sh` 发布 `2a789abe3ae764de`，上一版 `3c5a4213c1199f52`，回滚副本在 `releases/dev095-web/previous-20261030T023048Z`。
- Worker：不涉及。

## Agent 自验（真实浏览器，dev）

环境：

- e2e-alice 登录，headless Chromium，独立临时 profile。
- DEV-048 合成设备 Worker 以 `systemd-run --user`（`dev095-dev048-worker`，已发布 runtime）临时运行，工作区为合成工作区 `ws_d4da0f57-…`。
- 合成父会话 `sess_1793327509711466830` 用 `create_session` 建了子会话 `sess_1793327520331970061`（`source=agent`），子会话依次在前台运行 3 个 `sleep 45`。

1. 第二个 sleep 运行时，在子会话页按 Enter 发送 B1：
   - 10:33:00.917 B1 进入 Server 队列（`delivery=boundary`），10:33:00.953 引导进回合；
   - 气泡显示 “Delivered · Claude reads it after Bash finishes”；
   - Claude 回答说它在第 2 个命令结束后读到 B1，并原样引用。
2. 随后按 Alt+Enter 发送 T1：输入框上方一行显示 “After this turn ⌄”。回合于 10:34:33 结束，T1 同一秒自动发出，成为下一回合的输入。
3. 本人原来的场景：让子会话不用工具写一段长文，生成期间按 Enter 发送 B2：
   - 行内显示 “At next step · Waiting for the agent's next tool step…”；
   - 回合 10:35:39 结束，B2 同时成为下一回合的输入。
4. 截图在 `.foundry/attachments/20261030/dev095/`（不入库）。

清理：

- 两条合成会话已归档（批次 `arch_01a18aaa-…`）；
- 合成 Worker 单元及其执行宿主已停止；
- e2e-alice 已登出，临时 cookie、脚本、浏览器 profile 均已删除。

## 限制

- 带 role 的会话（Personal Agent）和后台辅助会话仍没有 Server 队列。在聊天页打开它们时，运行中发送的消息仍会停在浏览器内存里。这些会话本来不是给人对话用的，本项未改。
- 本人 Linux 开发设备上的那条原始消息仍只在浏览器内存里。新 Web 不会自动把它交给 Server，需要本人点 “Send”。如果页面已经刷新，它就丢了。
- 未在窄屏、深色主题下复验。本项没有改动 UI，界面沿用 DEV-082/089 的组件。

## 人工验收步骤

1. 刷新 dev 页面（Web 版本 `2a789abe3ae764de` 或更新）。
2. 打开任一由其他会话创建的会话（例如交接会话，或列表中标注 “Started by …” 的会话），让它运行几个较长的命令，例如“在前台依次运行 `sleep 30` 三次”。
3. 命令运行时输入一句话按 Enter。预期：
   - 消息出现在对话里，气泡底部显示“已送达 · Claude 会在 Bash 结束后读取”；
   - 输入框上方不会留下这条消息。
4. 再输入一句，按 Alt+Enter（Mac 为 ⌥+Enter）。预期：行右侧显示“本轮结束后”；回合结束后它自动发出，不需要点 Send。
5. 让它写一段不用工具的长回答，生成中按 Enter。预期：行内显示“等待 Agent 的下一个工具步骤…”；回答结束后，这条消息自动成为下一条输入。
6. 在第 4 步消息发出前刷新页面。预期：这条消息仍在队列里。
