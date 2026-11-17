# DEV-265 通道会话的写入只限会话拿到的授权；其余写入进「等你处理」

2026-11-17。本人截图反馈：在 OpenLark 自聊里写 `/ai 发个"hello"消息给高逸斌`，通道会话 sess_1794886314214617318 直接把 "hello" 发进了高逸斌的单聊。网关审计 04:51:47Z 记录 `POST /agent/v1/conversations/:feedId/messages`。本人：「糟了，不是说好的不允许通过 channel 给 channel 发送吗」。

状态：实现与定向测试完成；已部署 dev（2026-11-17）；Agent 代验收（2026-11-17，范围见各自验收记录）；已合入 main（PR #**PR**）。

## 问题

通道会话的账号级 `writes: direct` 开关把「在来源会话里回复」和「写到任何地方」混成了一个权限。输入来自消息通道时，它的副作用必须限制在那个对话里，并且由服务端机械执行，不能靠提示词。

## 设计（与本人及编排确认）

- **授权是会话上的服务端状态**（`session_connector_grants`）：账号 + 对象（例如 conversation / message）。助理的消息通道层在每次把回合交给通道会话时写入「来源账号 + 来源会话」；子会话通过父链继承，不复制。授权从不展示给 agent。
- **描述符声明每条写路由触碰的对象**：`serverHeld.writes[].objects`（路径参数 `:feedId` 或请求体 JSON 指针，`each` 表示数组），`auxiliary` 只用于「别人还看不到的准备动作」（上传）；`serverHeld.resolvers` 声明 `message → conversation` 的只读解析路由（OpenLark：`GET /agent/v1/messages/:messageId`，指针 `/item/feedId`），按账号缓存。未声明的写路由一律视为「不在任何授权内」，失败即关闭。
- **网关只做一次通用检查**：`pipeline.go` 里原来的 `WritesWithoutConfirmation` 换成「本会话在这条账号上的授权是否覆盖这次写入要碰的全部对象」，只检查 `need.Write`；读取保持今天的行为（只看 access level，不产生提案）。覆盖 → 直接写、无卡片；否则 → 走既有 `Confirm.Review` 生成提案，并在「等你处理」里出现。非通道会话行为不变（风险写入照旧确认）。
- **非消息写入也说清楚做什么**：路由目录的 `routes.json` 只有 method/path/access/domain/src/surfaces，没有 summary/title/description；因此操作名优先取探测路由的 `summary`（`probe:routes` 新增可选指针，来源提供时使用），其次取描述符 `serverHeld.writes[].summary`（OpenLark 为「新建云文档」「上传文件到云盘」「编辑文档」「发表文档评论」「新建群聊」「新建日程」等声明），都没有才退回 `METHOD path`。提案还保存请求体的顶层字符串字段预览与完整 JSON（受长度限制），卡片用 `ClampedText` 显示预览、`<details>` 放完整内容，原始 body 不做标题。卡片元信息里的时间写明是什么：有提案过期时间时显示「48 分钟后过期」（未过期/已过期都带词），旧提案没有过期时间时显示「提出于 …」。
- **卡片所见即所得**：描述符新增 `serverHeld.labels`（对象类型 → 只读路由 + 名称指针，按账号缓存），提案创建时就解析并随 spec 保存；卡片不再需要发请求。解析失败时明确显示「未知会话（oc_…）」，绝不用裸 id 冒充名字。带消息正文的写入说「助理想在 OpenLark 给 Gao Yibin 发消息：hello」（英文 "The assistant wants to message Gao Yibin on OpenLark: hello"），并注明来源「来自 OpenLark 单聊里的 /ai」；表情回应说「…对 … 的消息加表情」，其他写入才用「…写入 …」。
- **确认后由 Foundry 重放一次**：提案保存生效请求（method/path/query/生效 body/账号/设备），`DecideProposal` 的 Pending→Accepted 状态转换就是「只发一次」的闸门；过期提案拒绝重放。允许 / 不允许都只给请求会话一条事实性通知，不再让 agent 重试。只有扩展网关的写入带 `replay: true`；其他网关（Feishu 等）保留「批准后再发一次」的旧契约，由 `replay` 字段区分。
- **凭据收敛**：通道血统里非只读的会话在 `run_session` 带 `userFiles: "hidden"`，Worker 用可写工作区的 `writable_tree` 沙箱跑，`~/.config` 等本人文件不可见；沙箱不可用时失败关闭，和只读会话一致。
- **迁移**：移除通道 scope 的 `writes` 开关；在来源会话里回复由授权覆盖，其余写入进「等你处理」。旧记录里多余字段被忽略。

## 改动

### 合同与存储

- `contracts/models/connectors.yaml`：`ConnectorServerHeldWrite` 的 `createdMessageId` 改为可选（保留原语义），新增 `objects`、`auxiliary`、`ConnectorServerHeldWriteObject`、`ConnectorServerHeldResolver`、`serverHeld.resolvers`。
- `contracts/models/message_channels.yaml`：`MessageChannelConnectorScope` 删除 `writes`。
- 重新生成 `packages/protocol` 与 `store/*_gen.go`、两个 JSON Schema。
- 新表 `session_connector_grants`（`sqlitestore/session_connector_grants.go`，幂等迁移），接口在 `store/session_connector_grants.go`。

### 服务端

- `permission.Access` 增加 `Grants`，`Resolve` 沿父链最多 8 层取最近祖先的授权；通道会话在没有显式行时按其 `Input.ChannelOrigin` 推导同一授权（部署时在途会话的迁移路径）。新增 `WriteInsideGrant(accountID, objects, auxiliary)`，删除 `WritesWithoutConfirmation`。
- `gateway.Need` 增加 `Objects`、`Auxiliary`、`Body`、`Text`；`ConfirmationRequest` 增加 `Body`、`Objects`、`Auxiliary`、`Text`；新增原因 `write_outside_grant`、`too_large`。网关在 `Classify` 之后按授权决定「直接写 / 待确认」，越权时 403 的 body 只含 `code`、`message`、`reason`、`refused`、`proposalId`，不含 `where`。
- `connectors/extension_objects.go`：读取生效 body（含通道 AI 页脚，只加一次）、解析路径参数/JSON 指针、经声明路由解析对象，按账号缓存（默认 10 分钟、最多 1024 条、失败缓存 1 分钟）。
- `connectors/confirmations.go`：提案保存生效请求与来源对象，body 上限 256 KiB，超过时 413、不建提案。`confirmations_replay.go`：重放精确请求、记录 `extension_write_created_message`（通道据此丢掉自己写入的回声）、拒绝过期提案。
- `assistant.DecideProposal`：connector_write 接受时调用重放回调，按结果把提案置 applied/failed，并只发一条事实性 notice；Pending→Accepted 的转换保证双击/重试不会重发。
- `personalagent/assistant/inbox.go`：通道回合在 `beforeDispatch` 写入来源账号 + 会话的授权。
- `httpapi`：新 `PendingSourceConnectorWrite`，「等你处理」按 DEV-254 的 reconcile-on-read 从待定提案生成一项，结构化字段（`connectorWrite`: 账号、目标类型/ID、消息文本、通道/会话种类/名称、是否子会话），新增 `POST /api/pending-items/{id}/decide {allow}`；列表与助理概览都会对账。
- `session_dispatch.go`：通道血统会话带 `userFiles: "hidden"`（Issue 执行保持自己的规则）。

### Worker / Web / 扩展

- Worker：`sessionExecution` 接受 `userFiles`；新增 `channelLineageSessionExecution`（`writable_tree`、工作区可写、本人文件隐藏、无沙箱失败关闭）。
- Web：`PendingSource` 增加 `connector_write`，新卡片 `ConnectorWriteItemCard`（允许 / 不允许，两种语言的措辞），`usePendingItems` 增加 `decide`；通道设置移除 direct/confirm 三选一，只留只读 / 读写。
- `extensions/open-lark/foundry-extension.json` 1.6.3 → 1.6.4：声明发送、回复、图片/文件/视频/语音、表情回应为对应对象；已读位置类路由（`read-position`、`read-thread-position`、`threads/:threadId/read-position`、`local-read-position`）按会话对象声明——已读回执对别人可见，所以它们不是 auxiliary；没有对象 id 的 `read-all`、`pins/read-state` 等保持未声明（需要本人确认）。`image-uploads` 为 auxiliary，新增 message→conversation resolver。路由形状按 `~/workspace/open-lark/plugins/open-lark/catalog/routes.json`（commit 09d2ce66）核对。

## 验证

- 远端定向 Go（CanWendeMac-mini，`scripts/remote-check.sh`）：
  - `internal/connectors`：PASS（含新增 `TestExtensionChannelGrantLimitsWrites`、`TestReplayConfirmedWriteSendsTheRecordedRequest`、`TestDescriptorChecksWriteObjectsAndResolvers`、`TestProposalKeepsTheRequestWithinItsBodyLimit`，以及既有 footer/确认/描述符用例）。
  - `internal/permission`、`internal/gateway`：PASS。
  - `internal/httpapi -run 'TestConnectorWrite|TestMessageChannel|TestInbox|TestPending|TestTurnFailure'`：PASS（含新增 `TestConnectorWriteProposalIsANeedsYouItemAndReplaysOnce`、更新后的 `TestMessageChannelSessionsAreNarrowedToTheChannelScope`）。
  - `internal/sqlitestore -run TestSessionConnectorGrants`：PASS。
  - `internal/connectors -run TestExtensionDescriptorsPassServerChecks`（含 open-lark 1.6.4 描述符）：PASS。
  - 授权内的回复仍记录创建的消息 id（`TestExtensionGatewayRecordsOpenLarkCreatedMessages`：回复写入 `om_reply` 被记录，通道据此丢掉回声），发送仍带通道页脚（`TestExtensionGatewayAppendsTheChannelsFooter`），两项均在上述定向运行中通过。读取不产生提案（授权账号、另一账号、通道子会话在另一账号）由 `TestExtensionChannelGrantLimitsWrites` 覆盖。
- Web（同一 runner）：`pnpm typecheck` PASS；`pending-items.test.mjs` 通过，含「connector write」通用卡片用例（操作名、预览行、完整 JSON 在 `<details>`、标题不含原始 body；消息卡片不变）。真实浏览器截图（Vite 预览页，真实组件与样式，1440px，中文）：`.foundry/patches/dev265-card-zh.png`——上为「助理想在 OpenLark 执行「新建云文档」」+ `docType: docx`/`title: DEV-265 授权测试（可删）` + 请求内容折叠，下为「助理想在 OpenLark 给 高逸斌 发消息：hello」，两张卡的元信息都以「48分钟后过期」标明时间。
- Worker（byte-dev）：`read-only-workspace-session.test.mjs` 12/12 通过，含新增的通道血统沙箱用例（工作区可写、`userFiles: hidden`、只读会话不受影响）。在 CanWendeMac-mini 上同文件有 5 个既有的运行时租约用例失败（`Cannot identify runtime lease owner`，`processIdentity` 在该 runner 下取不到进程启动时间）；新增用例本身通过，与本次改动无关。
- 未做真实浏览器与真实 OpenLark 实例检查（按编排要求：上线前由编排做自聊 `/ai` 越权尝试）。

## 限制与未覆盖

- OpenLark 图片/文件/视频/语音写的响应是否含 `/messageId` 未在真实实例上核对；声明了指针，缺失时只是不记录回声（不会误发）。
- 目标名字来自描述符声明的只读路由（OpenLark：`GET /agent/v1/conversations/:feedId` → `/name`）；取不到名字时卡片明确说「未知会话（oc_…）」，不会展示成名字。
- 已部署 dev（2026-11-17）；Agent 代验收（2026-11-17，范围见各自验收记录）；已合入 main（PR #**PR**）。

2026-11-17 夜（提交前全量测试）：新表没有登记为会话拥有的数据（`workspaceOwnedRows`），删除设备会留下它的行（`TestRemovedDeviceLeavesNothingBehind` / `TestEveryTableNamingAnOwnerIsOwned` 失败）。已补登记；同批把这次新增的存储方法从 `store.Store` 移到模块接口（`audit:modules`），随 Server train 40 部署。
