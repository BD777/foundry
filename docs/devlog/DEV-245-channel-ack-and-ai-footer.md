# DEV-245 处理中给消息加表情；AI 回复末尾加「来自 AI」说明

状态：已部署 dev（train9-20261116）；真实检查通过（E2E 第四轮：处理中 `OnIt` 反应出现并在回复后移除，回复以 `> 来自AI` 结尾）；Agent 代验收（2026-11-16，范围见验收记录）；已合入 main（PR #271）。

本人的原话（2026-11-16）：

> 1. 开始处理之后给原消息点一个 onit reaction，处理完之后去掉这个 reaction 2. AI 回复的消息在最后加一行引用格式的说明：`> 来自AI`

两条都是确定性机制，不含语义判断：通道的生命周期与传输行为，和续聊过滤、自写识别同类。Foundry 仍不决定助理是否回复、回复什么。

## 1. OpenLark 路由核对

在 `nwverse/open-lark`（`main`，GitHub CLI 只读）核对：

- 目录 `plugins/open-lark/catalog/routes.json` 有 `POST /messages/:messageId/reactions`、`DELETE /messages/:messageId/reactions/:key`（都是 `im`、`access: write`）。
- `src/server/routes/api.ts`：POST 读 `ReactionInputSchema` 的 `{ key }`，调用 `messenger.react(messageId, key)`；DELETE 走 `messenger.react(messageId, key, true)`。
- `src/server/services/messenger-service.ts` 的 `react` 返回 `{added: true|false}`，**按 key 删除，不需要 reaction id**，所以没有声明响应指针。
- OpenLark 自己的代班机制就用同一个接口给触发消息加 `OnIt`（`src/shared/contracts/stand-in-defaults.ts` 的 `STAND_IN_CLAIM_REACTION = "OnIt"`，`stand-in-service.ts` 调 `messenger.react(messageId, "OnIt")`）。

回复/发送的正文在 `text` 字段（`SendMessageInputSchema`），`editorType: "markdown"` 时按 Markdown 渲染（`plugins/open-lark/src/reply.ts` 的 `replyRequest`）；`olk im reply`/`send` 默认纯文本，加 `--markdown` 才是 Markdown。因此「引用格式」在 Markdown 下是引用行，纯文本下显示为 `> 来自AI` 字面，两者都可读。

## 2. 处理中表情（ack）

### 描述符

`serverHeld.events.ack`（与 `poll`/`envelope`/`context`/`reply` 同一通道块）声明：

```json
"ack": {
  "reaction": "OnIt",
  "add": { "method": "POST", "path": "/agent/v1/messages/{message.id}/reactions", "body": "{\"key\":\"{reaction}\"}" },
  "remove": { "method": "DELETE", "path": "/agent/v1/messages/{message.id}/reactions/{reaction}" }
}
```

`add` 必填，`remove` 可选；路径/正文模板只认 `{message.id}` 与 `{reaction}`。校验（`descriptor_checks.go`）：写方法、位于 upstream 前缀下、正文是合法 JSON、拒绝其他占位符。OpenLark 扩展升到 **1.6.2**。

### 生命周期

- **加**：`channels.Runner.handOver` 把一批消息交给通道会话、投递成功之后，对批内每条消息（触发或续聊；被过滤/超限/自写的不在批内）调用一次；失败只记日志，不阻塞投递。
- **去**：`dispatchChannel` 跟随投递时，记录从 queued/delivered 变成 done/failed（完成、失败、取消、inbox 过期/取消）时，清除该批消息的表情。
- 调用在 `httpapi.messageChannelAck`：解析实例与描述符、按目录确认路由是 write 且实例访问级别允许、按网络绑定选在线设备，然后用 `DoExtensionRequest`（与网关上行同一套密钥/设备转发）发请求。失败写入 `extension_ack_failed` 审计（`channelId`/`messageId`/`action`/`error`），通道的投递活动（`MessageChannelAction`，kind `channel_ack_failed`）可见；不影响投递。
- 反应事件不进通道：OpenLark 的 `/changes?kinds=message` 本来只返回 message；描述符再声明 `skipWhen: /kind == "reaction"`，`decide` 也把 `kind: reaction` 的信封挡掉（纵深防御）。表情回执不会开启新回合或续聊。

### 通道配置

`MessageChannel.ack`（缺省即开，源声明了 ack 时才生效）；来源能力新增 `capabilities.ack`。编辑器在能力存在时显示「处理中给消息加表情」开关，默认开。

## 3. AI 回复说明（footer）

### 描述符

`serverHeld.writes[]` 的每条写路由可声明 `footer`：

```json
"footer": { "text": "/text", "markdown": true }
```

`text` 是请求体里正文的 JSON pointer（OpenLark 的 reply/send 都是 `/text`），`markdown` 说明该字段按 Markdown 渲染。**只有声明了 footer 的写路由才是 IM 消息**，文档等其他写路由永远不追加（OpenLark 描述符只给两条消息写路由声明）。

### 网关

`ExtensionGateway.Upstream` 对写请求：路由声明了 footer、请求体非空、会话存在时，向 `UseWriteFooter` 注入的钩子问「这个账号 + 会话是否有 footer」。钩子（`httpapi.messageChannelWriteFooter`）用与 DEV-243 自写相同的归属判定（`permission.Resolve`：助理的 home 对话、通道会话、其 helper）找到该助理在此账号上的通道，返回通道的 footer 文本；同账号其他会话（本人的工具、E2E 发送器）不下发。
有文本时把声明 pointer 处的字符串追加 `\n\n` + footer；**幂等**——正文已经以该行结尾就不再加；pointer 不到、正文为空、非 JSON 原样转发。因此写失败不受影响。

### 通道配置

`MessageChannel.footer`：缺省 `> 来自AI`，可编辑，空字符串关闭；编辑器在来源有 footer 能力时显示「AI 回复说明」输入框（占位符 `> 来自AI`，留空即关闭）。来源能力新增 `capabilities.footer`。

## 测试

CanWendeMac-mini（`scripts/remote-check.sh lease_9209cceeac72085b0a50 --tree ~/workspace/foundry-dev245`）：

- `./internal/channels`（`TestAckFollowsTheHandOverAndTheTurn|TestAnAckFailureDoesNotBlockTheHandOver|TestAReactionChangeIsNotAMessage|TestCapabilitiesComeFromTheEnvelopeMapping|TestDispatchHandsOneTurnPerConversationAndFollowsIt`）通过：批量投递时对 m1、m2 加、对被过滤的 m9 不加；完成与失败两种结束都去掉；ack 失败仍投递；反应变化不产生投递记录/回合；能力来自 `ack` 与写声明。
- `./internal/connectors`（footer 与描述符）通过：追加只在声明的 `/text`、一次（幂等）；非消息写路由与空 footer 原样；描述符校验拒绝空 reaction、GET 方法、越界路径、未知占位符、非法 JSON、非 pointer 的 footer text；bundled OpenLark 1.6.2 清单合法。
- `./internal/httpapi`（`TestMessageChannelWriteFooterOnlyForItsAssistantsSessions|TestMessageChannelOwnWritesFollowTheAssistantsSessions|TestQueuedChannelTurnNeedsThePersonsOwnWords|TestMessageChannelSessionsAreNarrowedToTheChannelScope`）通过：home 对话、通道会话、helper 得到默认/自定义 footer；同账号无关会话与其他账号不下发；空字符串关闭。
- Web：`--web test test/message-channel-model.test.mjs`（15/15）与 `--web typecheck` 通过；本地 `pnpm audit:ui` 通过（默认 footer 作为数据用行级 `i18n-ignore` 标注）。

截图（scratch 栈从本工作树构建，`http://127.0.0.1:40555`，登录 e2e-alice，注入合成来源/通道）：

- `/home/windeng/workspace/dev245-channel-ack-footer-light.png`（1440×900，浅色）
- `/home/windeng/workspace/dev245-channel-ack-footer-narrow.png`（390×844，浅色）

## 验收步骤

1. 设备安装扩展 1.6.2 后，通道编辑器出现「聊天里的标记」：开关默认开，回复说明默认 `> 来自AI`。
2. 在聊天里发触发词消息：助理接手后该消息出现 `OnIt`；这一轮结束（完成或失败）后消失。
3. 被规则过滤或超限的消息不出现 `OnIt`。
4. 助理回复的正文末尾有 `> 来自AI`（Markdown 下是引用行）；同账号下本人其他会话的写入没有这一行；把说明清空后不再追加。
5. 反应变化（别人或助理加表情）不会开启新回合。

## 已知限制

- ack 与 footer 依赖描述符声明和目录路由；OpenLark 之外的来源不声明就没有这两个能力，编辑器也不显示。
- 只读令牌的实例无法写表情：ack 调用会失败并记入通道活动，不影响投递。扩展升级后仍需设备安装 1.6.2 描述符（DEV-243 的实时刷新会让实例跟上）。
- 删除通道时若仍有在途回合，已经加上的表情不会被清除（投递记录随通道删除）。
- footer 追加会让正文变长；极端接近来源长度上限的回复可能被来源拒绝。
- 同一助理在同一来源账号上有多个通道时，网关取第一个匹配通道的 footer 文本。
