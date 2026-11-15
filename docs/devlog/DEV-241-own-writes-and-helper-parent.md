# DEV-241 自写识别从不生效；helper 无法向自己的父会话回报

状态：已部署 dev（train5-20261116）；Agent 代验收（2026-11-16，范围见验收记录）；已合入 main（PR #269）。

2026-11-16 E2E（`sess_1794778276586307621`，第 3 轮）：助理回复被记为 `own_write` 丢弃，发送者的 `/ai` 仍投递。

来源：E2E round 1（`sess_1794771302095655670` 最终报告）的两个缺陷，以及 [assistant-usable-20261116](../briefs/assistant-usable-20261116.md) 的原则：Foundry 只补能力，判断留给 agent，通道自写识别必须是确定性的机制。

## 1. 自写识别从不生效（最高优先级）

### 根因

- `extensions/open-lark/foundry-extension.json` 的 `serverHeld.writes` 写的是 `/messages/:messageId/replies`、`/conversations/:feedId/messages`、`/agent-sessions/:sessionKey/messages`，而同一描述符的路由目录与上游 `pathPrefix` 都是 `/agent/v1/...`。
- 网关把目录模板写进 `call.Route`（`/agent/v1/...`），`extensionCreatedMessagePointer` 却用 `write.Path == route` 精确比较，前缀不同，永远不匹配；于是没有 `extension_write_created_message` 事件，`channels.Ports.OwnWrites` 恒为空，助理回复又作为 `follow_up` 回来（并被标为「发送者是本人」）。

### 修复

- **共享同一个匹配器**：`externalaccounts.ExtensionRoutePathMatches` 导出既有的 `extensionRoutePathMatches`（支持 `:name`/`{name}` 占位符与 `*`/`**` 尾段、路径规范化），`ExtensionRouteFor` 与网关的写声明匹配都走它，不再有第二套比较。
- **描述符路径改为目录里的真实形式**：`/agent/v1/messages/:messageId/replies`、`/agent/v1/conversations/:feedId/messages`；版本 1.6.0 → **1.6.1**。
- **按 OpenLark 代码核对响应指针**（byte-dev `~/workspace/open-lark`，HEAD `252b7136b`，只读）：
  - `POST /agent/v1/messages/:messageId/replies`（`src/server/routes/api.ts`，agent 分支）返回 202 和 `{"feedId":…,"messageId":…,"replyToMessageId":…,"threadRootMessageId":…}` → 顶层 `/messageId` 正确。
  - `POST /agent/v1/conversations/:feedId/messages` 返回 202 和 `{"messageId":…}`（`MessengerService.send` 的返回值）→ `/messageId` 正确。
  - `POST /agent/v1/agent-sessions/:sessionKey/messages` 返回的是 Agent Bridge 的本地 outbox 回声（`AgentMessage.externalId = "local:<clientId>"`，`src/server/agent-bridge/service.ts` 的 `localMessage`），**没有** Lark 消息 id，无法用于自写识别，故从写声明中移除。该路由本来也因前缀不匹配从未生效，移除不改变行为。
  - 目录的权威清单见 OpenLark 的 `catalog/routes.json`；其路由测试（`test/server/agent-routes.test.ts`）给出了上面两个响应体的真实样例。
- **新增网关测试** `TestExtensionGatewayRecordsOpenLarkCreatedMessages`：用 OpenLark 的 `/agent/v1` 目录、真实响应体（202）跑 reply 与 send 两条写路由，断言两条 `extension_write_created_message` 审计记录的 id 与路由模板。

## 2. helper 无法向自己的通道父会话 send_message

### 根因

`send_message` 的准入是通用 `controlledSession`：先按 `agentScope` 判断能否读目标工作区。helper 在 `ws_da716f18`，父会话是通道工作区 `ws_0349bea7`；通道工作区不在助理权限包内，helper 的 scope 到不了，于是父会话被当作「no session … that you can read」。

### 修复

- `messageTarget`（`internal/httpapi/mcp_sessions.go`）：agent 调用者的目标若是自己的 `ParentSessionID`，直接允许——回报路径不受父会话所在工作区限制；其他情况仍走原来的 `controlledSession`。
- 只放宽 `send_message`，不改变 `read_context` 或其他控制操作的可见范围；DEV-234 的「人员不能向通道会话写入」不变（该检查在通道读取/队列入队路径，与本准入无关）。

### 测试

`TestHelperSendMessageReachesItsParent`（`internal/httpapi/assistant_send_message_test.go`）：权限包只含 `ws_alice`，helper 在 `ws_bob`，父会话在包外的 `ws_pa`——helper → 父会话成功；同一 helper 向包外的无关 `ws_pa` 会话仍被拒绝并返回「that you can read」。

## 验证

- `cd apps/server && go test ./internal/connectors/ -run 'TestExtensionGatewayRecordsOpenLarkCreatedMessages|TestExtensionGatewayRecordsTheMessageAWriteCreates|TestExtensionDescriptorsPassServerChecks'`
- `cd apps/server && go test ./internal/externalaccounts/`
- `cd apps/server && go test ./internal/httpapi/ -run 'TestHelperSendMessageReachesItsParent|TestAssistantSendMessageStaysInItsScope'`
- `gofmt` / `go vet` 对应包。

（测试在 CanWendeMac-mini 上通过 `scripts/remote-check.sh` 运行，不在 sg-chaos。）

## 部署后的只读验收

1. **自写识别（不发送任何消息）**：下一次真实助理回复后，查网关审计：应出现 `extension_write_created_message`，`detail.messageId` 等于回复的消息 id，`detail.route` 为 `/agent/v1/messages/:messageId/replies`（或发送时为 `/agent/v1/conversations/:feedId/messages`）。随后通道投递中该消息应为 `dropped/own_write`，不再产生额外的 `follow_up` 回合。编排者会用 E2E 触发这条回复。
2. **helper 回报**：让通道助理派一个 helper 到包外工作区；helper 用 `send_message` 向其父会话发送文本，应成功（不再返回「that you can read」）；无关包外会话仍被拒绝。

## 已知限制

- 自写识别仍依赖描述符声明：走未声明的写路由（例如 `olk im send-file` 的 `/conversations/:feedId/files`）不记录创建的消息 id，其回声仍可能作为后续消息出现。本次只按已确认的三条写路由核对，未扩展声明。
- agent-sessions 写路由的响应不含 Lark 消息 id，因此不参与自写识别；若 OpenLark 以后在响应里返回真实 id，需要在描述符里重新声明。
- 父会话例外只覆盖 `send_message`；父会话对任意子会话的发送仍按原 scope 判定（同一助理派生的 helper 通常在同一权限包内）。
