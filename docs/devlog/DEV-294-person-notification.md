# DEV-294 通知本人：OpenLark 投递与答复

状态：已部署 dev（2026-11-18）；Agent 代验收（2026-11-18，范围见验收记录）；已合入 main（PR #278）。范围：DEV-294 切片 1–5 与 DEV-297 已部署 dev（train 62–73）。通道路由与确认经自聊检查验证（2026-11-18 04:39Z、05:24Z、09:27Z）。通知保持关闭，直到 DEV-300 验证通过。本人否决了第一版 OpenLark 自聊文本通知的质量。

规格：`.foundry/reports/person-notification-spec.md`（§3 `notify` 段，§6 切片 1）。

## 问题

待本人处理的事项（提问、审批、交接）只在 Web 待办里出现。规格要求经 OpenLark 的自聊会话通知本人。投递需要描述符声明的 `notify` 段，Foundry 按数据校验、按数据发送，不认识具体产品。

## 切片 1：契约与描述符（本次）

- **契约**：`contracts/models/connectors.yaml` 在 `serverHeld` 下增加可选的 `notify`（与 `events` 同级，指针类型），字段为 `version`、`format`、`target {field, conversationKind}`、`send {method, path, body}`、`sent {messageId}`、`replyTo`。`scripts/generate-contracts.mjs` 生成的 Go 与 TS 已更新（`store/connectors_gen.go`，`contract-schema.json`，`contract.gen.ts`）。
- **校验**（`apps/server/internal/connectors/descriptor_checks.go` 的 `checkServerHeldNotify`）：
  - `version` 大于 1 → 拒绝，提示「this Foundry is too old for notify version N」；`version` 不等于 1 也拒绝。
  - `format` 只能是 `markdown`；`target.conversationKind` 只能是 `self`；`target.field` 必须是 `serverHeld.fields` 里的 `text` 字段。
  - `send` 是写方法，路径位于上游前缀下，正文不超过 1000 字符（与 ack 共用 `checkCatalogedWriteCall`）。
  - 路径只能用 `{target}`、`{notice.id}`，且必须含 `{target}`；正文只能用 `{target}`、`{notice.id}`、`{text|json}`、`{link|json}`，必须含 `{text|json}`，且填入样例后是合法 JSON。`{text}`、`{link}` 在正文里不带 `|json` 时拒绝；`|json` 只能用于正文。
  - `sent.messageId` 为 JSON pointer；`replyTo` 若设置，必须是 `serverHeld.events.envelope` 里的字段，且需要 `events`。
- **共享模板**（`apps/server/internal/connectors/request_template.go`）：`FillRequestTemplate` 填充路径（`url.PathEscape`）与正文（`{name|json}` 做 JSON 字符串转义，填充后必须是 JSON）。描述符检查与运行时填充共用同一占位符语法。
- **ack 修复**（`httpapi/message_channel_ack.go`）：`fillAckTemplate` 改为调用共用函数。之前它对正文的值也做 `PathEscape`，正文只做 `json.Valid`。现在路径与正文分开处理，未知占位符报错。对 OpenLark 现有的 ack 模板，填出的请求与之前相同（有回归测试）。
- **OpenLark 描述符**（`extensions/open-lark/foundry-extension.json`，版本 1.6.5 → 1.6.6）：新增可选 `text` 字段 `notifyChat`（zh-CN 标签「通知会话（自聊）」），加入第二步；新增 `serverHeld.notify`。正文为 `{"clientId":"{notice.id}","editorType":"markdown","text":"{text|json}\n\n[在 Foundry 中处理]({link|json})"}`。已有字段与语义未改。

## 检查

- `go test ./internal/connectors -run 'Notify|Ack|Descriptor|Extension|FillRequest|OpenLark'`（Mac mini，`ok`，约 1.2 s）。
- `go test ./internal/httpapi -run 'TestAckTemplatesFillOpenLarkRequestsAsBefore|MessageChannelAck|ChannelAck'`（Mac mini，`ok`）。
- Worker `test/connector-extensions.test.mjs`（Mac mini，22/22 通过，含 bundled 扩展加载）。
- `generate-contracts.mjs --check`（通过；见限制）。
- `audit-module-boundaries.mjs`（0 个跟踪违规）。
- gofmt、prettier（JSON 与 YAML，已按 prettier 格式化）。

## 限制

- **路由目录只在运行时可查**：规格写「send 必须是路由目录里的写路由」。描述符检查只能验证方法、路径前缀与占位符；路由是否存在要读探测得到的 `data.Routes`，与 `checkMessageChannelAckRoute` 相同。发送路径在切片 3 实现时做这一检查。
- **`notify` 路由还没有运行时检查与发送**：切片 1 只有声明与校验，没有任何通知被发送。
- **`sent.messageId` 的响应形状未核实**（规格 §7）：`/message/id` 是假设，切片 3 需在 dev 上用一次 curl 确认。
- **oasdiff 破坏性变更检查未能在远端运行**：远端作业检出是共享归档，没有基准提交，检查输出 `no contract at …; breaking-change check skipped`。本次变更对 `connectors.yaml` 只有新增（+65 行，0 行删除），只新增可选属性。
- **标签**：规格写 `label` 为「通知会话（自聊）」。仓库惯例是英文 `label` 加 `labels.zh-CN`，这里按惯例实现。
- **模板的额外要求**：`{target}` 必须出现在路径，`{text|json}` 必须出现在正文，`format` 只能是 `markdown`。这三条超出规格原文，但若缺失则通知无法工作。

## 验收步骤（切片 1）

1. 在 Mac mini 或 byte-dev 上运行上面列出的 `go test` 与 Worker 测试，全部通过。
2. 检查 `extensions/open-lark/foundry-extension.json` 的 `version` 为 `1.6.6`，`serverHeld.notify.target.field` 为 `notifyChat`，`serverHeld.fields` 含 `notifyChat`。
3. 之后的切片再验收实际发送（需要本人确认是否提醒，见规格 §3 切片 3）。

## Slice 2：核心 notices（DEV-294b）

依据：`.foundry/reports/person-notification-spec.md` §2、§6 切片 2（2026-11-18 编排器批准）。

### 问题

Foundry 需要把「等待本人」的项（question、approval、hand_over、ask）以通知形式发给本人，并记录投递状态。
本切片只实现与具体连接器无关的核心：存储、状态机、出站分发、重试与去重。连接器 sink（OpenLark、内置飞书）留给后续切片。

### 做法

- 存储：`person_notices` 表（迁移 `setupPersonNotices`），`store.PersonNoticeStore` 模块接口，sqlite 实现。
  - 每项同时最多一条活动通知：部分唯一索引 `person_notices_active_item`（`queued` / `sending` / `sent`）。
  - 归属：通过 `item_id` 随待办项所属的 workspace、session、issue 删除（`workspaceOwnedRows`，新 owner 类型 `ownerItem`）；通过 `assistant_id` 随助理删除（`assistantRecordTables`）。
- 核心：`internal/personnotice`。
  - `Sink.Send(ctx, notice)`；错误分类 `Transient` / `Ambiguous`（瞬时且可能已到达）/ `Permanent`；未分类错误按 Permanent 处理，避免未知失败被重发。
  - `EnqueueNotice`：先持久化 `queued`，ID 即幂等键；项非 open 时不入队。
  - `Pump`：回收超时的 `sending`（视为歧义），到期发送，成功记 `sent` 与 `ProviderMessageID`。
  - 瞬时失败：同一 ID 重试；最多 4 次发送；歧义失败超过 1 小时不再重发。
  - 永久失败：直接 `failed`，保留原因。
  - `Supersede(itemID)`：活动通知转 `superseded`；尚未发送的不会发送。
- 后台：`httpapi/background.go` 新增 `person-notices` 任务（每 10 秒 `Pump`）；`httpapi/server.go` 的 `Backend` 组合 `store.PersonNoticeStore`。
- 边界：`scripts/audit-module-boundaries.mjs` 声明 `personnotice: ["store"]`。

本切片不接入待办项的创建与答复（`pending_items.go`、`mcp_needs_you.go`、`assistant_questions.go`、`chat_queue.go` 未改动，留给切片 4）。

### 验证

基于 HEAD `e03dfd61` 的 worktree，远端 CanWendeMac-mini 运行（日志在 `/tmp/remote-check-20261117T220632-4054128.log`、`…220745-4070694.log`、`…220853-4077013.log`、`…221018-4084306.log`；首轮 httpapi 因 worktree 的 server.go 误用了未提交的 live 改动而编译失败，已还原为 HEAD 后重跑通过）：

- `go test ./internal/sqlitestore -run 'Notice|Migration|Deletion'`：通过（首轮日志 `…220632-…`）；其中 `TestNoticeMigrationIsIdempotent`、`TestNoticeOneLiveNoticePerItem`、`TestNoticeRoundTripsItsOptionsAndTimes`、`TestNoticeDeletionRemovesRowsWithItsWorkspace` 全部 PASS。
- `go test ./internal/sqlitestore -run 'Device|Orphan|Owned|Owner|Assistant|Workspace'`：通过（设备清除、孤儿清理、归属表与助理删除的 SQL 均被执行）。
- `go test ./internal/personnotice`：11 个用例全部 PASS（同 ID 重试、退避 30s/2m/10m 与上限、永久失败不重试、每项一条活动通知、supersede 前不发送、歧义失败超 1 小时不重发、发送中断后以同 ID 重新排队、未 open 项不入队、未注册 sink 失败）。
- `go test ./internal/httpapi -run 'Background|Notice'`：通过。
- `go vet ./internal/store ./internal/sqlitestore ./internal/personnotice ./internal/httpapi`：通过。
- `node scripts/audit-module-boundaries.mjs`：通过，0 条跟踪违规，`store.Store` 73 个方法。

迁移：`person_notices` 与索引用 `CREATE … IF NOT EXISTS`，重复执行安全（见 `TestNoticeMigrationIsIdempotent`）。

### 验收步骤（人工）

本切片没有用户可见的界面或入口，无人工验收步骤；验收留给切片 3–5。

### 限制

- 没有任何 sink 注册，生产中不会发送任何通知；`EnqueueNotice` 尚未被调用。
- 退避表为 30 秒、2 分钟、10 分钟。规格第四档 1 小时需要第 5 次发送，与「最多 4 次」冲突，本切片按「最多 4 次」实现，1 小时档未启用（待编排器确认）。
- 「用户删除」列表：仓库中没有用户删除路径（用户只被禁用），因此未登记用户级删除。
- `Supersede` 与正在发送的通知竞争：发送中被 supersede 的通知，其消息仍会送达，状态保持 `superseded`。

## 切片 3：OpenLark 出站与回声抑制（DEV-294c）

依据：`.foundry/reports/person-notification-spec.md` §2（出站、回声）、§3（描述符 `notify`）、§6 切片 3。基线：共享工作树（HEAD `e03dfd61` 加未提交改动，含切片 1）加切片 2（`/tmp/DEV-294b.patch`，不含其 devlog）。

### 问题与证据

- **响应体形状**（OpenLark 源码，`nwverse/open-lark`，只读）：`POST /agent/v1/conversations/:feedId/messages` 在 `src/server/routes/api.ts:5593-5625` 等待 Lark 往返完成后返回 `202 {"messageId": "<真实 id>"}`；`messenger-service.ts:9346-9366`、`9727` 解析的是 Lark 返回的真实 id。该路由不返回 `local:<clientId>`，因此发送结果即真实 id，无需后续替换。`local:` 只出现在 `/api` 路由（`enqueueSend`，`:9237`）。
- **描述符指针修正**：`sent.messageId` 由 `/message/id` 改为 `/messageId`。同一扩展 `writes` 中该路由的 `createdMessageId` 已是 `/messageId`，与源码一致。
- **clientId**：变更流（`agent-plane/change-rows.ts`、`change-view.ts:95-118`）不带 `clientId`，也无 `replacesMessageId`。变更行的 `id` 即真实 message id，`item.signals.mine` 标记本人发出的消息。因此回声按真实 id 比对，不需要 clientId 对齐。
- **回声**：自聊里的通知回流为 `sender.isSelf` 的消息。原有过滤只丢弃 `IsOwnWrite` 与会话写入记录（`ExtensionWriteCreatedMessage`），通知不经网关，不会被丢弃，因此必须新增检查。

### 做法

- `personnotice`：
  - `Dispatcher.SetSinkResolver`：未注册的 sink id 按需解析。`ext:<instanceId>` 由 `httpapi` 解析；sink 在发送时读取实例，实例被删后该通知永久失败。
  - `Classify` 导出（原 `classify`），供测试与其他包判断失败类别。
  - `render.go`：`RenderText` 输出标题、正文、编号选项（按 `item.Options` 顺序）与回复说明（中文）；`Redact` 把 `x@y.z` 改为 `x [at] y.z`，标题与正文都脱敏。
- `httpapi/person_notice_sink.go`（新文件，不含任何连接器名）：
  - `planNoticeRequest`：按描述符 `notify` 段填写 `send.path`（`{target}`、`{notice.id}`，路径转义）与 `send.body`（`{notice.id}`、`{text|json}`、`{link|json}`，JSON 转义），并校验 `version == 1`、通知会话非空、路由在目录中且可写。链接缺省时为 `<AllowedOrigin>/pending`（待办项没有单独的 Web 地址，见限制）。
  - `sendNotice`：经 `DoExtensionRequest` 发送（测试中替换为 httptest 桩）。错误分类：超时（`context.DeadlineExceeded` 或 `net.Error.Timeout`）→ Ambiguous；网络错误、5xx、429 → Transient；其他 4xx → Permanent；2xx 但响应缺少 `notify.sent.messageId` 指向的 id → Permanent（重发只会重复）。
  - `extensionNoticeSink.Send`：实例不存在、非本人扩展实例、描述符不支持通知 → Permanent；读取失败、设备离线 → Transient。
  - `messageChannelNoticeEchoes`：通道账号所属实例的已发送通知 id（最近 48 小时）。
- `channels/runner.go`：新增端口 `NoticeEchoes`，`decide` 在助理收件箱之前丢弃回声（记录为 `own_write`，正文清空）。
- `store`：`PersonNoticeSentIDs(sinkID, since)`，sqlite 实现。
- `connectors`：导出 `PointerText`（复用扩展内的 JSON 指针读取）。
- `httpapi/server.go`、`message_channels.go`：注册解析器与回声端口。
- 描述符：`extensions/open-lark/foundry-extension.json` 的 `notify.sent.messageId` 改为 `/messageId`。

### 检查

基于共享工作树加切片 2 的工作树（`~/workspace/fdy-dev294c`），远端 CanWendeMac-mini（最终一轮日志 `/tmp/dev294c/run4-go.log`、`/tmp/dev294c/run4-vet.log`）：

- `go test ./internal/personnotice ./internal/connectors ./internal/channels ./internal/httpapi ./internal/sqlitestore -run 'Notice|Notify|Channel|Ack|Echo|Render|Redact|Sent|Resolver|Sink'`：全部通过（httpapi 的新用例见 `person_notice_sink_test.go`）。
- `go vet` 同上各包及 `store`：通过。
- `node scripts/audit-module-boundaries.mjs`：通过，0 条跟踪违规，`store.Store` 73 个方法。
- 中途一轮曾因 `externalaccounts` 进入非连接器 HTTP 文件被审计拒绝（`httpapi/person_notice_sink.go`）；路由写入检查已移入 `connectors.CheckWriteRoute`，httpapi 不再直接导入 `externalaccounts`。
- 本地 `gofmt -l` 对改动文件无输出。

### 限制

- 链接只能到 `/pending`：待办项没有 Web 深链，切片 4 或后续需要为单项增加路由后再把 `notice.Link` 指向它。
- 编号选项只是显示：答复解析（含编号）属于切片 4。
- 429 按 Transient 处理，与规格的「4xx → Permanent」不同：限流应当重试，否则通知会被永久放弃。
- 超时按 Ambiguous 处理（属于 Transient 的子类），1 小时歧义规则由 `personnotice` 执行。
- 若 OpenLark 将来让该路由返回 `local:<clientId>`，`sendNotice` 会原样记录，回声比对随之失效；当前源码不返回 `local:`，此项未经实测，也未做替换逻辑。
- 「是否提醒」（自聊消息是否提醒本人）无法由代理验证，需 dev 上一次真实发送后由本人确认。
- 没有部署，没有提交；未在 dev 上发送合成通知。

### 验收步骤（待部署后）

1. 在 dev 配置一个 OpenLark 实例，填写自聊会话 ID（`notifyChat`）。
2. 由编排器或测试入口发一条合成通知（标题、两个选项、一个邮箱样式字符串）。
3. 预期：OpenLark 返回 202，自聊出现一条消息，文字为编号选项与「引用本条消息…」说明，邮箱显示为 `[at]`，末尾有 Web 链接。
4. 预期：通知记录 `state=sent`，`provider_message_id` 为 202 返回的 `messageId`；该消息随后在通道中以 `own_write` 丢弃，不进入助理收件箱。
5. 观察并记录：自聊消息是否提醒本人（人工项）。

## Slice 5：通知设置与自聊发现（DEV-294e）

依据：`.foundry/reports/person-notification-spec.md` §4、§6 切片 5。

### 问题

助理设置「入口与通知」里没有「通知你」的选项，本人无法选择把通知发到哪个连接器。选中连接器后，还需要自动找到本人与自己的会话，免得本人去查会话 ID。

### 做法

- **设置形状**：`PersonalAgentSettings.notify.sinks[]`（协议 `PersonalAgentNotifySettings`，Go `store.PersonalAgentNotifySettings`）。目前最多一个连接器；每个 sink 的 `kinds` 取自 `question`、`approval`、`hand_over`、`ask`，留空时默认四种全选。内置飞书私聊设置不变。
- **自聊发现**（只读，经服务器持有的扩展请求路径，先查描述符的路由目录）：
  1. `GET /agent/v1/me` 取得登录账号的 `userId`；
  2. `GET /agent/v1/conversations?scope=p2p&limit=100`，最多翻 10 页，找 `chatMode == "direct"` 且 `peerUserId == userId` 的会话；
  3. 找到后用 `ReplaceExtensionInstance` 把会话 ID 写入实例的 `notifyChat` 字段（其它字段与封存的密钥保持不变）。
  - 手动填写的会话 ID 走同一判断：`GET /agent/v1/conversations/:feedId`，要求 `chatMode == "direct"` 且 `peerUserId == userId`。
- **保存时校验**：`PUT /api/personal-agent/settings` 对新增或更换的 sink 重新检查实例（支持通知、已有会话 ID、会话仍是本人自聊）；未变的 sink 不访问连接器，保存其它设置不依赖连接器。
- **接口**（个人限定）：`POST /api/personal-agent/notify/chat`（发现或校验，失败以 `reason` 码返回，Web 映射文案）；`POST /api/personal-agent/notify/test`（直接经 `ext:<instanceId>` sink 发送一条合成通知，标题「[测试] Foundry 通知联调」，返回 `sent`+`messageId` 或 `failed`+原因）。
- **Web**：`features/personal-agent/settings-notify.tsx`，放在「入口与通知」的「通知你」分组中：连接器选择（可选「不通知」）、四种类型的复选框、发现中提示、找到的会话名、找不到时的警告与会话 ID 输入（「使用这个会话」）、「发一条测试通知」按钮及结果提示。只列出描述符声明了 `notify` 的扩展实例。
- **边界**：`connector_extension_instances_channels.go` 新增 `extensionReadAllowed`（与消息通道共用的路由目录检查），新文件通过它访问 `externalaccounts`，满足 `audit:modules`。

本切片不创建待办项的通知（切片 4 调用 `EnqueueNotice`，并决定 kind 对应关系）；未改动 `pending_items.go`、`mcp_needs_you.go`、`assistant_questions.go`、`chat_queue.go`、通道 runner、`person_notice_sink.go`。

### 验证

基于 HEAD `e03dfd61`、加上当前共享树未提交改动与 `/tmp/DEV-294c.patch`（不含其 devlog）的 worktree，远端 CanWendeMac-mini 运行（租约 `lease_f76cd6a9a443cf9c56ca`）。

- `go test ./internal/httpapi -run 'TestNormalizePersonalAgentNotify|TestSelfChat|TestTypedChat|TestNoticeDiscovery|TestTestNotice|TestNotice' -v`：通过（`ok … 0.707s`，13 个用例 PASS，日志 `/tmp/remote-check-20261117T225042-77322.log`）。覆盖：默认四种类型、未知类型与两个 sink 被拒绝、分页找到本人自聊（httptest 桩）、无自聊返回未找到、手动会话 ID 必须是本人自聊、未列入路由目录的读取不发出、测试通知回报已发送消息 ID。
- `go vet ./internal/httpapi ./internal/store`：通过；`node scripts/audit-module-boundaries.mjs`：0 条跟踪违规（日志 `…225001-73716.log`）。首轮审计因新文件直接导入 `externalaccounts` 而失败，已改为经 `extensionReadAllowed`。
- `pnpm --filter web typecheck`（`tsc -p tsconfig.json`）：通过（修正 `request` 的 body 写法与 `Alert` 的 `title` 后，日志 `…224834-64894.log`）。
- `node --import ./test/register-bundler-resolve.mjs --test test/assistant-settings-notify.test.mjs`：5 个用例 PASS（渲染已保存的连接器与四种类型、测试通知失败与成功的提示、取消最后一种类型不保存、发现接口的返回原因；日志 `/tmp/remote-check-20261117T224910-68560.log`。更早一轮 `…224809-62543.log` 失败，原因是测试 harness 的断言与 API 路径，已修正）。
- `pnpm audit:ui` 与 `pnpm build`：通过（`WEB-UI-BUILD-OK`，日志 `/tmp/remote-check-20261117T225020-75464.log`）。
- `prettier --check`：本次改动的 Web 与协议文件全部通过。`gofmt -l`：无输出。
- 契约：`PersonalAgentSettings` 与 `packages/protocol` 类型手写、不由 `contracts/` 生成，本切片未改动契约，未运行 `generate-contracts --check`。

### 验收步骤（人工，待部署后）

1. 助理设置 →「入口与通知」→「通知你」，选择 OpenLark 连接器。预期：显示「已找到你与自己的会话：…」，四种类型默认全部勾选。
2. 点「发一条测试通知」。预期：提示「测试通知已发出」，并且在本人与自己的会话里看到标题为「[测试] Foundry 通知联调」的消息。
3. 将类型只保留「提问」后保存、刷新页面。预期：设置保留，且通知类型仍只有「提问」。

### 限制

- **未部署、未在 dev 实测**：自聊的判断依据是 OpenLark 源码（`a6f4506`）中的 `chatMode`、`peerUserId` 与 `/agent/v1/me` 路由，未在真实账号上验证。若自聊的 `peerUserId` 不等于本人 `userId`，发现会失败并返回 `self_chat_not_found`，需要本人确认后调整。
- **截图未产出**：`.foundry/attachments/20261118/dev294e/` 下的浅色、深色、390 px 截图需要运行中的 Web 与真实数据，本次未完成。
- 「找不到自聊」的 Web 警告（含会话 ID 输入）只有 API 层测试，未在渲染测试中点选连接器复现；发现失败的文案映射未经过界面验证。
- 保存时校验（`checkPersonalAgentNotify`）依赖完整 Server，未单独写单元测试。
- 测试通知直接经 sink 发送，不入库、不排队；因此无重试，也不会出现在待办通知记录中。
- 测试通知与保存错误的服务端原因为英文文本，直接显示在界面上，未本地化。
- 每次写入 `notifyChat` 都会对实例做一次探测（`ReplaceExtensionInstance`），连接器不可达时发现会失败。
- 切片 4 需要把助理的 kind 对应到 `question`、`approval`、`hand_over`、`ask` 并读取 sink 设置；本切片未实现这一步。

## Slice 4：答复回路与待办通知（DEV-294d）

依据：`.foundry/reports/person-notification-spec.md` §2（入站回复、审批）、§6 切片 4。基线：共享工作树（HEAD `e03dfd61` 加未提交改动，含切片 1–3、5）。

### 做法

- **开通知**：待办开启或被助理交给本人时，`recordPendingItem` / `handPendingItem`（`httpapi/person_notice_items.go`）调用 `queueItemNotice`。只有能由通知回答的项会通知：助理的提问（`ask`）、帮手或助理会话的问题（`question`；带 `approval` 标记的是 `approval`）、连接器写入的允许/拒绝（`approval`）、交接（`hand_over`）。没有消息的问题、失败、提醒和账号项不通知。通知只发给助理设置里包含该类型的 sink；每项最多一条通知（已有任何状态的通知则不再发）。
  - 标题与正文取自项：问题标题与摘录；交接取助理的说明；连接器写入取「需要你批准一次写入」与操作内容。
  - 选项：问题取项的选项；审批固定为「同意 / 拒绝」（下标 0 批准、1 拒绝）。`AllowFreeText` 为 true。
  - 链接：`<AllowedOrigin>/pending?item=<id>`。网页的待办页读取 `item`，展开并滚动到该项（`pending-feature.tsx`）。
  - 目标会话：通知记录的 `Target` 在入队时取自连接器实例的 `notifyChat`，入站回复据此判断会话。
- **收敛**：`savePendingItem`（`sqlitestore/pending_items.go`）在任何路径把项写为已关闭时，把该项未答的通知（queued、sent）转为 `superseded`。网页作答、卡片、插话、`resolve`、自动结算都经过这一写入点。正在发送（sending）的通知不被改动，发出后由入站路径检查项状态。
- **入站回复**：`channels/runner.go` 的 `decide` 在回声丢弃与本助理自写丢弃之后、助理收件箱之前调用新端口 `NoticeReply`（`httpapi/person_notice_items.go` 的 `messageChannelNoticeReply`）。条件：引用的 `replyTo`（描述符 `notify.replyTo`）等于某条已发送通知的 provider id；回复来自本人账号（`IsSelf` 且非自写）；会话等于通知的 `Target`；通知仍为 sent；项仍为 open。
  - 解析（`personnotice/reply.go` `MatchOption`）：去首尾空白后精确等于选项，或等于审批的别名（同意 / 批准、拒绝 / 不同意），或等于通知列出的编号（1、2……）。其余为自由文本。
  - 结算（同一路径，按项的来源）：助理的问题 → DEV-293 的 `answerAssistantQuestion`；问题与交接 → 带答案信封的聊天插话（与网页相同：`agentQuestionReplyText` + `steer`，经 `EnqueueChatMessage`）；连接器写入 → `DecideProposal`，项记为本人已答；审批问题 → 信封中的选项是 `Approve` / `Deny`。
  - 先用比较交换把通知由 sent 改为 answered（`AnswerPersonNotice`），只有第一条回复生效；随后结算项。结算失败则把通知改回 sent（`ReopenPersonNotice`），回复不被消费，交给助理收件箱，不阻塞轮询。
  - **审批的自由文本不决定**：作为补充信息送入审批所在的会话（`addDecisionNote`，`foundry_notice` / `decision_note`，发送者为会话自身，因此不会结算项），项保持打开，通知保持 sent，本人仍可以用选项决定。这是编排器默认值，单一分支（`settleNoticeReply` 中 `itemIsApproval` 判断）便于改动。
  - 回复无法匹配（另一发送者、另一会话、通知已答、项已在别处关闭）→ 不消费，走助理收件箱，与之前相同。
  - 确认：消费后对该回复调用既有的 ack 端口（描述符声明的 `OnIt` 表情），失败只记日志。
- **回声**：仍先于一切丢弃（`NoticeEchoes`）。

### 与规格不同之处

- `ask` 是通知的种类名（与设置的 kinds 一致），规格中的 `assistant_question` 是项的来源名。
- 编号回复（1、2）也被接受：切片 2 的限制注明编号解析属于切片 4，而通知正文列出了编号，不接受的话，本人回复「1」会被当成自由文本（对审批即是补充信息，不决定）。
- 问题项缺少消息 id 时不通知（无法发出信封）；`issue_question` 不通知（答复走 Issue，不在本切片）。
- 连接器写入的结算使用 `DecideProposal`，调用方式与网页相同，但 `via` 为 `reply`，并以本人答复作为项的答案。

### 检查

远端 CanWendeMac-mini（租约 `lease_1e447ad2485171a63b7f`），基线为共享工作树的 worktree `~/workspace/fdy-dev294d`：

- `go test ./internal/httpapi -run 'Notice|Notify|Pending|Answer|Question|MessageChannel|Echo|Approval|Unsettled|Reply'`：`ok`（36 s）；另以 `-v` 运行本切片新增的 10 个用例，全部 PASS（`PersonNoticeKind`、`AnOpenItemIsNoticed`、`OptionReply`、`FreeTextReply`、`FreeTextOnAnApproval`、`OnlyThePersons`、`UnsettledRepliesAreNotConsumed`、`ReplyToAnItem`、`UnsettledAnswerReopens`）。
- `go test ./internal/personnotice`：`ok`（含 `MatchOption` 用例）。
- `go test ./internal/channels`（整包）：`ok`（含 `TestNoticeEchoIsDroppedBeforeReplySettlement`、`TestUnsettledReplyGoesOnToTheInbox`）。
- `go test ./internal/sqlitestore -run 'Notice|Pending'`：`ok`（含 `TestClosingAnItemEndsItsUnansweredNotices`、`TestOnlyTheFirstAnswerSettlesASentNotice`）。
- `go vet ./internal/store ./internal/personnotice ./internal/channels ./internal/sqlitestore ./internal/httpapi` 与 `gofmt -l`：通过。
- `node scripts/audit-module-boundaries.mjs`：0 条跟踪违规，`store.Store` 73 个方法。
- Web：`pending-items.test.mjs` 37 通过、0 失败（1 跳过，既有）；`typecheck` 通过；`remote-build --web`：`SHA256SUMS` 校验通过。

未运行全量测试、`generate-contracts --check`（本切片未改契约：`PendingItem.approval` 是存储与 Go 结构字段，不在 `contracts/`）。

### 限制

- 连接器写入的结算（`DecideProposal`）只有代码路径，没有测试：构造 proposal 需要完整的助理与写入记录。
- 自由文本的补充信息投递为 `foundry_notice`/`decision_note`，不计入记忆的「本人的话」（`PersonWords` 只识别 `question_answer`）。
- 批次重试：若同一批次在该回复之后的记录步骤失败，批次会被重读。此时该回复的通知已答，回复不再匹配，会作为收件箱消息再投递一次。项的结算不会重复（比较交换），但助理会看到这条回复。
- 「是否提醒」仍未实测（同切片 3）。
- 网页 `?item=` 的滚动与展开只在本地测试与构建中验证，未在浏览器中打开通知链接；链接能否在应用路由切换后保留查询串未实测。
- 没有部署，没有提交。

### 验收步骤（dev，待部署后）

e2e-alice 没有 OpenLark 账号，因此实际验收只能在本人自聊中进行，需要本人参与：

1. 助理设置 →「入口与通知」→「通知你」选择 OpenLark 连接器，四种类型全部勾选，保存。
2. 在本人的助理会话中让助理提问（`needs_you ask`，带两个选项）。预期：自聊出现编号选项与「引用本条消息…」说明，末尾有 `/pending?item=…` 链接；通知记录 `state=sent`。
3. 在自聊中引用该通知回复选项文字（例如「同意」或其编号）。预期：助理会话收到 `[Foundry] the person answered your question …`；待办显示已答，`answeredBy=person`；自聊收到一条回执（OnIt 表情）；通知记录 `state=answered`。
4. 对同一通知再回复一次。预期：不再结算，该回复进入助理收件箱。
5. 在网页待办里回答同一项：通知记录变为 `superseded`，之后的引用回复进入助理收件箱。
6. 人工观察项：自聊消息是否提醒本人（规格 §7，尚未实测）。

## DEV-297：通知连接器列表为空

状态：根因已确认，修复已在 Mac mini 上检查通过；已部署 dev（2026-11-18）；待本人验收；已合入 main（PR #278）。

### 问题

助理设置「入口与通知」→「通知你」的下拉只有「不通知」，提示说还没有连接器接收通知。该账号有 OpenLark 扩展实例（`xapp_8ef44948…`，标签「byte-dev OpenLark（内网）」，网络经 byte-dev，描述符 1.6.6 含 `notify`），消息通道 `mch_0e47207b6ad14d91bade` 也在用它。

### 根因（证据）

- 页面只从 `/api/external-accounts` 的 `apps` 里找 `createdVia == "extension"` 的应用，取其 `provider` 作为种类，再按种类请求实例（`apps/web/src/features/personal-agent/settings-notify.tsx`，原 `useNoticeInstances`）。
- 服务端 `apps/server/internal/externalaccounts/apps.go` 的 `ListApps` 明确剔除 `createdVia == "extension"` 的应用（101–105 行）。扩展实例只经按种类的 `/api/connectors/extensions/{kind}/instances` 列出。
- 因此前端的种类集合恒为空，不发出任何按种类的请求，列表为空，页面显示「还没有可接收通知的连接器」。截图与此一致。
- 只读 DB 核对：该实例 `created_via=extension`、`provider=openlark`、`network=device`，快照为 1.6.6 且含 `serverHeld.notify`；两台设备（dev_ab62…、dev_d783…）上报的 openlark 同为 1.6.6 且含 notify，状态 installed。快照 `updated_at` 为 2026-11-18T04:07，说明已被 `ExtensionData` 刷新。
- 用设备上报的同一份描述符跑 `DefaultCatalog().ExtensionConnectorsWithErrors`：保留 1 条，拒绝 0 条。描述符校验不是排除条件。
- 排除之外的条件：权限包不参与通知路径（默认助理的包 `connectorDefault=write`）；助理设置中尚无任何 `notify` sink，没有已保存设置受影响。
- 「1.6.5 无 notify」的快照：DEV-268 的描述符经 `ExtensionData` 在每次读取时用已安装的目录描述符刷新快照（`externalaccounts/extension_instances.go` 的 `currentExtensionDescriptor`），连接器模块在 `connectors/module.go:62` 接线。新列表接口也经过 `ExtensionData`，旧快照会在列表时刷新。
- 旧 Web 测试用一个 `createdVia: "extension"` 的应用模拟 `/api/external-accounts`，真实服务端从不返回这种应用，所以测试通过而真实流程为空。

### 修复

- 服务端：新增 `GET /api/personal-agent/notify/instances`（助理别名 `/api/assistants/{assistant}/notify/instances`）。共享函数 `listPersonalAgentNotifyInstances(ctx, ownerUserID)` 列出该人的全部扩展实例，每个带 `reason`：
  - 空：可接收通知；
  - `connector_not_notifiable`：已安装的描述符没有 `notify`；
  - `waiting_device`：网络经设备且没有在线的可达设备；
  - `instance_unavailable`：无法读取实例（写日志）。
    判断由纯函数 `notifyInstanceReason` 完成。
- Web：`useNoticeInstances` 改用该接口。不可用的实例显示为禁用选项（打开菜单时显示原因），下拉下方逐条说明「X 暂时不能接收通知。原因」。只有完全没有扩展实例时才显示「添加并校验…」。接口失败显示加载失败，而不是空列表。
- 协议与 API：`PersonalAgentNotifyInstance`、`PersonalAgentNotifyInstancesResult`，`getPersonalAgentNotifyInstances`；中英文文案。

### 变更文件

- `apps/server/internal/httpapi/personal_agent_notify.go`：类型、`notifyInstanceReason`、`listPersonalAgentNotifyInstances`、`notifyInstanceOf`、handler。
- `apps/server/internal/httpapi/routes.go`：一行路由。
- `apps/server/internal/httpapi/personal_agent_notify_instances_test.go`：新增。
- `packages/protocol/src/personal-agent.ts`、`apps/web/src/api/personal-agent.ts`。
- `apps/web/src/features/personal-agent/settings-notify.tsx`。
- `apps/web/src/i18n/locales/en/personalAgent.ts`、`apps/web/src/i18n/locales/zh-CN/personalAgent.ts`。
- `apps/web/test/assistant-settings-notify.test.mjs`。
- `docs/devlog/DEV-294-person-notification.md`（本节）。

### 检查

- `go test ./internal/httpapi -run 'NoticeInstances|PersonalAgentNotify|SelfChat|TypedChat|NoticeDiscovery|TestNotice|Notify|Notice'`：通过（11 个用例，含新增 `TestNoticeInstancesListEveryExtensionInstanceWithItsReason`：五类实例的原因、旧快照刷新、粘贴应用与他人应用被排除）。
- `go vet ./internal/httpapi`：通过。`gofmt -l`：无输出。
- `node scripts/audit-module-boundaries.mjs`：0 条跟踪违规，73 个 `store.Store` 方法。
- Web：`typecheck` 通过；`test/assistant-settings-notify.test.mjs` 10/10 通过；`pnpm audit:ui` 通过；`pnpm build` 通过；prettier 通过。
- 远端运行于 CanWendeMac-mini（租约 `lease_a9cf67634d51d57924bf`）。

### 限制

- 未部署，未在 dev 上用真实账号验证。
- 新接口的 `reason` 只在请求时计算，不随连接器状态推送；需重新加载页面才会更新。
- `assistant_settings` MCP 工具的 `get` 尚未返回该列表；共享函数 `listPersonalAgentNotifyInstances` 可直接复用。
- 「是否提醒」仍未实测（同 DEV-294 切片 3 的限制）。
- 未更新 `docs/devlog/README.md`（任务要求只写本文件）。

### 验收步骤（dev，待部署）

1. 助理设置 → 入口与通知 → 通知你：下拉列出「byte-dev OpenLark（内网）」。byte-dev 在线时可选。预期：不再显示「还没有可接收通知的连接器」。
2. byte-dev 离线后刷新页面：该实例禁用，下方显示「… 暂时不能接收通知。没有在线的设备能连接它…」。预期：不出现「添加并校验 OpenLark」。
3. 选择该实例后，按 DEV-294e 的验收步骤发一条测试通知。预期：自聊收到测试消息。

## DEV-301：daemon-message-contract 字段一致性修复

- 现象：`packages/protocol/test/daemon-message-contract.test.mjs` 的「checked-in DTOs are in field parity」失败。共四类报错：
  - `PersonalAgentNotifyChatResult`、`PersonalAgentNotifyTestResult`、`PersonalAgentNotifyInstance`、`PersonalAgentNotifyInstancesResult` 「no matching Go struct」：这些 Go 结构在 `apps/server/internal/httpapi/personal_agent_notify.go`，而 `scripts/audit-contract.mjs` 的 `goDtoPaths` 没有列出该文件。
  - `PersonalAgentSettings`：Go `store.PersonalAgentSettings.Revision`（JSON `revision`，无 omitempty，总会返回）在 TS 中缺失。
  - 登记 Go 文件后又暴露：`PersonalAgentNotifyChatResult.chat` 写成内联对象类型 `{ feedId; name }`。`parseTsInterfaces` 以 `\{([^}]*)\}` 取接口体，在内联类型的 `}` 处截断，`reason` 字段丢失。
- 修复（对齐来源，不改测试和解析器）：
  1. `scripts/audit-contract.mjs`：`goDtoPaths` 加入 `apps/server/internal/httpapi/personal_agent_notify.go`。
  2. `packages/protocol/src/personal-agent.ts`：新增具名接口 `PersonalAgentNotifyChat`（对应 Go 具名结构），`chat?` 改引用它；`PersonalAgentSettings` 增加 `revision: number`。
- 注意：TS 接口体不能含内联对象类型（解析器按第一个 `}` 截断）。需要嵌套结构时用具名接口。
- 检查（worktree = HEAD + 共享改动，`node_modules` 链接自共享树）：
  - `packages/protocol`：`tsc` 构建通过；`node --test test/*.test.mjs` 90/90 通过。
  - `node scripts/audit-contract.mjs`：231 个 TS 接口与 Go 结构一致。
  - `node scripts/audit-module-boundaries.mjs`：0 条跟踪违规。
  - `node scripts/generate-contracts.mjs --check`：通过，无破坏性变更。
  - Web `tsc --noEmit`：见下方结果记录。
  - 未改 Go 代码，未运行 `go test`。未提交，未部署。

## 2026-11-18 dev 验收记录（Agent 代验收，DEV-294 / 297）

- 通道在 train 62–79 之后仍能路由并确认（自聊检查 2026-11-18 04:39Z、05:24Z、09:27Z）。
- OpenLark 自聊通知已发出并被本人看到；本人否决了它的质量，因此通知保持关闭，直到 DEV-300（卡片通知）验证通过。
- 范围外：DEV-300 的卡片通知、DEV-301 的协议对齐待本人验收。
