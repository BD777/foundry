# DEV-247 纯文本回复里的「来自AI」要显示成引用块

状态：已部署 dev（train11-20261116）；真实自聊检查通过（2026-11-16 13:39 CST）；Agent 代验收（2026-11-16，范围见验收记录）；已合入 main（PR #271）。Server
`1b731cc1cbdb1d830f05c9af167d00dc3b90e5d52314997cfc21a1c393a31953`（05:36:09Z 启动，
`/healthz` 200），Worker `0.5.7-dev.361.gd79e5c06.local.1794807199`，Web 未变更
`9683809a469d555f`。

本人截图（2026-11-16）：助理回复在 Lark 里显示成字面 `> 来自AI`，正文是

```
现在是北京时间 2026-11-16（周一）11:07。

> 来自AI
```

期望左侧灰色引用条包住「来自AI」。根因：这条回复以纯文本发出（请求体没有
`editorType`），Dev-245 只在声明的正文字段末尾追加 `> 来自AI`，没有改变消息格式；纯文本里
`>` 只是字符。

## 1. OpenLark 源码核对

byte-dev `~/workspace/open-lark`，HEAD `e37d342bb`，只读：

- `SendMessageInputSchema` 的 `editorType` 取值是 `simple | post | markdown | rich`
  （`src/shared/contracts/index.ts`）；`olk im reply/send` 默认不带该字段，只有 `--markdown`
  才写 `editorType: "markdown"`（`plugins/open-lark/src/olk/commands.ts`）。
- `editorType: "markdown"` 把正文编码成一个 Lark `MarkdownProperty` 富文本节点（tag 49，
  `ImDomain.encodeMarkdownRichText`，`src/server/lark/domains/im-domain.ts`）。
- `plugins/open-lark/README.md` 明确写该路径「支持……引用……」；OpenLark 自己的渲染器也把
  `>` 行解析为 `blockquote`（`src/ui/message-renderers/markdown-blocks.ts`）。
- `editorType: "rich"` 走结构化编码器，确有 `QuoteProperty`（tag 29，
  `src/server/lark/rich-markdown-encoder.ts`），但它的引用只认私有区的行首标记 `U+E110`，
  且正文要按 rich 语法（列表、围栏、行内代码、链接）重新转义；对普通文字回复，Markdown
  路径更直接。
- 因此采用原生 `editorType: "markdown"` 路径，不做结构化重编码。

## 2. 描述符

写路由的 `footer` 新增 `format`，声明「纯文本写入如何切到 Markdown」：

```json
"footer": {
  "text": "/text",
  "markdown": true,
  "format": {
    "field": "/editorType",
    "value": "markdown",
    "plain": ["simple"],
    "escape": "markdown"
  }
}
```

- `field` 是请求体里选择渲染格式的 JSON pointer；`value` 让它按 Markdown 渲染。
- `plain` 是表示纯文本的取值；字段缺失也按纯文本处理。其他取值（如 `rich`）属于
  描述符没点名的结构化格式，不改写。
- `escape` 目前只有 `markdown`。校验（`descriptor_checks.go`）：`format` 必须配合
  `markdown: true`；`field` 是 pointer 且不能等于正文 pointer；`value` 必填；`plain`
  至多 8 个、互不相同、不能等于 `value`；`escape` 必须是 `markdown`。
- OpenLark 扩展升到 **1.6.3**。描述符随 Worker 打包，需部署 Worker。

## 3. 网关

`ExtensionGateway.Upstream` 对声明了 footer 的写请求：

1. 取声明正文；为空或已以 footer 结尾（幂等）就不动。
2. 没有 `format`：维持 Dev-245 行为，直接追加 `\n\n` + footer。
3. 已 `editorType = markdown`：直接追加。
4. 纯文本（字段缺失/空/在 `plain` 里）：按 Markdown 转义原文，把格式字段设为 `markdown`，
   再追加 footer。
5. 其他格式（`rich`/`post` 等）：保留原文，按原样追加。

Markdown 转义保证纯文本读起来不变：

- 行内语法：`\`、反引号、`*`、`_`、`~`、`[`、`]`、`|` 加反斜杠；`<`/`&` 变成 HTML 实体。
- 行首阻止标题、引用、列表、分隔线、Setext 下划线、有序列表：`# > - + = :` 加反斜杠，
  `1.`/`1)` 在分隔符前加反斜杠。
- 行首空白变成不换行空格，视觉缩进保留，但不会开缩进代码块；`\r\n` 归一成 `\n`。
- 裸 URL 的 `://` 与 GFM 邮箱 `@` 转义，避免自动变成链接。

## 4. 测试

CanWendeMac-mini（`scripts/remote-check.sh`，`--tree ~/workspace/foundry-dev247`）：

- `lease_1881edf524d6616557f8` `--go ./internal/connectors -run
'TestExtensionAppendFooter|TestExtensionEscapeMarkdown|
TestDescriptorChecksTheAcknowledgementAndFooter|TestExtensionGatewayAppendsTheChannelsFooter'`
  → PASS（9s，log `/tmp/remote-check-20261116T132654-1480206.log`）。
- `lease_166d550dafeaf66b8725` `--go ./internal/httpapi -run
'TestMessageChannelWriteFooterOnlyForItsAssistantsSessions|
TestMessageChannelOwnWritesFollowTheAssistantsSessions'`
  → PASS（18s，log `/tmp/remote-check-20261116T132746-1482918.log`）。

覆盖：纯文本切 Markdown 并转义、显式 `simple` 同样处理、`markdown` 原样追加、`rich` 保留原格式、
旧描述符不加 `editorType`、幂等、嵌套 pointer、缺失字段/pointer 不到原样；转义用例覆盖
``* _ ~ `code` [link](url) # > - + 1. --- === URL 邮箱 < &``、行首缩进与换行；描述符校验
覆盖缺少 `markdown`、非法 field/escape/重复 plain/plain 等于 value；bundled OpenLark 1.6.3
清单合法；httpapi 的 footer 归属规则不变。

## 5. 验收步骤

1. 设备安装 OpenLark 扩展 1.6.3 后，在聊天里发 `/ai 现在几点？`。
2. 助理回复的正文末尾「来自AI」显示为 Lark 引用块（左侧灰条），不再是字面 `> 来自AI`。
3. 用 `olk` 读回该条回复：存储格式应为 Markdown（`MarkdownProperty`），并含引用元素。
4. 本人自己会话发出的消息没有 footer；把通道的「AI 回复说明」清空后不再追加。
5. 助理自带 Markdown 的回复末尾同样追加引用行；原本的 `*`、`_`、反引号、链接在纯文本
   回复转成 Markdown 后显示不变。

## 6. 真实自聊检查（2026-11-16 13:39 CST）

按 `.foundry/briefs/e2e-assistant-20261116.md` 第 1 轮硬规则，在 ccm-omh-integration
（`ws_56c549f3-a9cf-482e-a699-286c860b190c`，byte-dev）起一个只负责发送的 session
（`sess_1794807538226976963`，完成后已归档）：

- 先确认 self-chat `7207688166424231939` 的 `memberCount = 1`，成员只有本人
  （邓灿文 / Canwen Deng，`userId` 7207619158707617820）。
- 只发一条 `/ai 现在几点？`：消息 id `7708639803079658686`（05:39:27Z）。
- 助理回复 id `7708639889390161133`（05:39:47Z，`parentId` 为发送消息）。
- `olk im message` 读回：`messageType = 2`、`messageTypeName = POST`、
  `contentTypeName = entities.PostContent`，单一 part 为
  `{ kind: "text", metadata: { markdown: true }, text: "现在是北京时间 2026-11-16（周一）13:39。\n\n> 来自AI" }`。
  即存储格式是 Markdown/Post，正文里是 `>` 引用行（由 Lark 渲染为引用块）。
- 网关审计：`extension_write_created_message`（event 7460，messageId
  `7708639889390161133`）和写路由 `/agent/v1/messages/:messageId/replies` 202
  （event 7461，`createdMessageId` 同上）；回显投递 `dlv_695e36eba4960087afb39a72`
  为 `dropped / own_write`。
- 发送 session 已归档；没有改动通道设置或文件，没有向其他会话发消息，未打印令牌。

## 已知限制

- 转义依赖来源的 Markdown 渲染器支持反斜杠转义。OpenLark 的 Markdown 路径与其文档/
  上下文包都用这套转义。真实自聊检查已确认存储格式是 Markdown/Post；若本人在某个客户端
  仍看到字面 `> 来自AI`，那是该客户端没有按 `MarkdownProperty` 渲染，而不是消息格式没切。
- 已经以 `> 来自AI` 结尾的正文视为已加 footer，保持原样（幂等优先），不会再改写成引用块。
- 结构化 `rich`/`post` 写入不切换格式；OpenLark 的助理回复工具默认只产生纯文本或
  Markdown，因此不受影响。
