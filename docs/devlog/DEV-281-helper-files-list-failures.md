# DEV-281 助理：帮手文件交接、通道会话列表、工具失败原因

状态：已部署 dev（2026-11-18）；Agent 代验收（2026-11-18，范围见验收记录）；已合入 main（PR #TBD）。

来源：`.foundry/reports/assistant-review-20261117-channel.md` D8、`.foundry/reports/assistant-review-20261117-web.md` D6、D7；派工 `.foundry/briefs/assistant-fixes-20261118.md`。编排者审阅后返工（D8 方案改为附件路径，D6 定为助理自己的通道 workspace）。本 patch 基于 DEV-280 已应用后的树。

## 问题与证据

- **D8 文件交接**：帮手把图交回为 `/tmp/...pie.png`，助理在自己的沙箱里读不到，绕了约 7 分钟，并误判成「另一台机器」。文件交接只能靠 `send_message` / `create_session` 的附件，而它们只接受 workspace 内的路径，不接受会话自己的临时目录（TMPDIR）。
- **D6 列通道会话失败**：助理在 home 里对自己的通道 workspace 调 `list_sessions` 失败，原因没有记录。通道 workspace 建在助理 home 的 `channels/<slug>`（`createMessageChannelWorkspace`）；`agentScope` 只保留权限包允许的 workspace 与会话自己运行所在的 workspace，权限包收窄后，通道 workspace 不在其中，返回 404 `workspace not found`。
- **D7 工具失败无原因**：Claude 的 `Tool failed` 事件只记录调用参数，错误文本丢失。

## 改动

1. **会话临时目录可作附件**（`apps/server/internal/httpapi/mcp_attachments.go`，`daemon_attachments.go`，`packages/protocol/src/daemon-messages.ts`，`packages/worker/src/daemon/handlers/files.ts`，`packages/worker/src/workspace/workspace-attachments.ts`，`packages/worker/src/resources/resource-pool.ts`）：`send_message` / `create_session` 的 `attachments` 也接受调用会话自己临时目录里的绝对路径，数量与大小上限不变。服务端对 workspace 外的绝对路径改用 `attachment_read` 的 `session_temp` 范围读取，设备侧只在该会话的临时目录内读取。另一会话的临时目录、以及两者之外的路径被拒绝，错误文本只陈述事实，例如：「…/pie.png is in another session's private temp folder; attachments are files in your workspace or your own temp folder; the session that made it can attach it with send_message」。工具描述同步写明可用路径。
2. **D6：助理自己的通道 workspace 对其 home 可读**（`apps/server/internal/httpapi/access.go`）：`agentScope` 对助理自己的顶层会话（`permission.Access.Home`），额外放行该助理所有通道的 `WorkspaceID`，仍按用户在该 workspace 的角色授予，不扩大其他范围。权限包和通道 scope 的其他判断不变。
3. **Codex 失败工具的错误文本**（`packages/worker/src/session/runner/sdk-messages.ts`）：Codex 的 MCP 调用失败时已带 `Error` 段，本次只把它限制为 1,024 字符，避免无界文本。命令失败的输出已有上限。
4. **Claude 失败工具的错误文本**（`packages/worker/src/session/runner/claude-messages.ts`，同前一版）：失败的工具调用在参数之后追加脱敏、截断到 1,024 字节的 `Error` 段。
5. 撤回上一版的子报告 `<image path>` 方案：`child_reports.go`、`session_questions.go` 恢复原状，`child_report_files*.go` 删除。

## 测试

- Worker：`turn-liveness.test.mjs`（失败工具错误文本、脱敏、截断）；`session-temp-attachments.test.mjs`（自己的临时目录可读，他人的被点名拒绝，两者之外与无临时目录的拒绝）；`codex-tool-failure-detail.test.mjs`（Codex 失败调用的错误文本有界）。
- Server：`assistant_channel_scope_test.go`（助理 home 读自己的通道 workspace，权限包排除的其他 workspace 不可读）；`mcp_attachments_temp_test.go`（路径是否在 workspace 内、三种拒绝文本）。

## 未解决 / 限制

- **帮手仍可能把图写在 `/tmp`**：本 patch 只让会话能把自己 TMPDIR 里的文件交出去；让帮手把交付物放进可交出的位置，属于指令或 skill 修改，不在本 patch 内。
- **D6 的权限语义**：只放行助理自己通道的 workspace，已按编排者决定实施；未实测 ByteWork 的权限包内容，结论基于代码路径。
- **Codex 的通道工具失败**：Codex 路径的错误文本只做了长度上限，没有单独脱敏（依赖既有的事件脱敏）。
- README 中 DEV-280 的行未包含在本 patch（DEV-280 的 README 改动由其自身 patch 带入时需人工合并）。

## 验收与检查

- 远端（byte-dev，`res_309405e6874f83ccd87c`）通过：Worker `turn-liveness`、`session-temp-attachments`、`codex-tool-failure-detail` 共 25/25；Server `./internal/httpapi` 定向 `TestAssistantHomeReadsItsOwnChannelWorkspaces`、`TestPathWithinWorkspaceFolder`、`TestTempFolderRefusalsStateWhereTheFileIs`，以及既有回归 `TestAssistantPackageGatesDispatchReadsAndCreatedWorkspaces`、`TestClarificationTokenOnlyReads`。
- 未部署 dev，未做真实浏览器或 e2e 验收。期望的 e2e 验收：帮手把图写进自己的 TMPDIR，`send_message` 带该路径附件后，父会话收到附件；指向他人临时目录的路径得到上文的拒绝文本。

## 时间线

| 日期       | 事项                                                                                                                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-18 | Agent 代验收（编排者，e2e-alice）：(a) 子会话 $TMPDIR 中的文件以 att_dmxokzkv16gt 到达父会话；(b) 失败的 get_session 事件记录「no session or chat … that you can read」；(c) 自聊 7709203376021441813 中，通道助理在话题内列出了它通道工作区的会话（18:08Z）。 |
