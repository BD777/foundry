# DEV-298 Foundry MCP 覆盖：助理设置工具（S1）

状态：S1 实现与远端定向检查完成；已部署 dev（2026-11-18）；待本人验收；已合入 main（PR #278）；补丁 `/tmp/DEV-298a.patch`。人在飞书的自聊实测待 dev 部署后进行。

依据：[.foundry/reports/foundry-mcp-coverage.md](../../.foundry/reports/foundry-mcp-coverage.md) §5（设计）、§6（切片）、§4（边界）。

## 问题

人的原则（2026-11-18）：Foundry 自身的每一项操作都应能经 Foundry MCP 完成，让助理替人配置 Foundry，人不必再去点设置页。当时助理没有任何工具能改自己的通知去向、每日摘要、活跃时段、界面模式，也不能发测试通知；`POST /api/personal-agent/notify/chat` 与 `/notify/test` 只有人能调用。

## 写操作的类别（编排者决定，写入代码 `personalagent/assistant_settings.go`）

报告原提议改动为「提议」（人确认）。编排者收窄为：只影响人自己的通知与摘要去向、时机的改动**立即生效**，并有审计与撤销；花钱或扩大外部可达范围的仍是**提议**。

| 类别              | 字段                                                                                                      | 说明                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 立即 immediate    | `notify`                                                                                                  | 通知去向（自聊）与种类                                  |
| 立即              | `activeHoursStart`、`activeHoursEnd`、`urgentAnytime`                                                     | 静默时段，双向                                          |
| 立即              | `dailyDigest`、`dailyDigestTime`                                                                          | 每日摘要开关与时间                                      |
| 立即              | `simpleInterface`                                                                                         | 界面模式                                                |
| 立即              | `homePage`                                                                                                | 打开时进入助理（“打开时进入”）                          |
| 提议 proposal     | `assistantModel`、`delegateModel`、`assistantProfileId`、`executionModels`、`runDefault`、`roleOverrides` | 模型选择，花钱                                          |
| 提议              | `feishuDirectChat`、`feishuAppId`                                                                         | 飞书单聊回复，外部可达                                  |
| 提议（S1 未接入） | 权限包                                                                                                    | 报告归为提议；S1 没有字段与路径，工具拒绝，后续切片接入 |
| 不给工具          | 其余字段（时区、电脑、规则、停止等）                                                                      | 人在设置页自己改                                        |

同一次 `update` 不能混合两类：拒绝并要求分两次提交。

## 工具契约（`assistant_settings`，仅助理会话）

- `op: get`，可选 `sections`（`notify`、`quietHours`、`digest`、`interface`、`models`、`feishu`）。返回 `revision`、各分节字段与两类字段清单；约 1 KB 以内。
- `op: update`，`patch`（按设置字段名）、可选 `expectedRevision`。立即类直接保存并返回 `actionId`；提议类返回 `needs_confirmation` 与 `proposalId`，设置不变。
- `op: update` 加 `undo: <actionId>`：撤销一次已生效的立即类改动。若之后有任何保存（修订号已前进），撤销被拒。
- `op: notify_instances`（DEV-298b）：列出本人的扩展实例，每项 `connectorInstanceId`、`label`、`reason`（能收通知时为空）；不返回 `kind`。助理用它选出 `connectorInstanceId`，再调用下面两个操作。
- `op: notify_find_chat`，`connectorInstanceId`、可选 `chatId`：与 `POST /api/personal-agent/notify/chat` 同一发现逻辑，回填通知会话或给出原因。
- `op: notify_test`，`connectorInstanceId`：与 `POST /api/personal-agent/notify/test` 同一发送函数；每个助理 10 分钟内最多 3 次（内存计数，重启后重新计）。

停止状态下，`update` 与两个通知操作都被拒绝（与写操作的停止拒绝一致）。

## 实现

- 修订号：`store.PersonalAgentSettings.Revision`，存在 `settings_json`，`SavePersonalAgentSettings` 每次保存加一（调用方传入的值被忽略）。未加表列。
- 审计：复用 `pa_actions`，`args_json` 已存在，写入 `{patch, before, revision, class, undo}`，不改表结构。`GetPersonalAgentAction` 读取一行，供撤销使用。
- 写入管线：`update_settings` 作为 `runWrite` 的规划器，继承停止检查、审计、提议卡片与 supersede。`Write.Report` 是新增的可选钩子，让应用结果带上审计 id。
- 保存：HTTP 的 `PUT /api/personal-agent/settings` 与助理的 `update` 都经 `saveAssistantSettings`（通知校验 + `assistant.SaveSettings`）。`Service.SaveSettingsChecked` 把它接给助理服务。
- 提议接受：`applyProposal` 新增 `settings_change` 分支，重新规划并应用当前设置上的补丁（不检查修订号）。

## 对既有代码的改动（说明）

为避免 MCP 与 HTTP 各写一份，把两处 handler 的函数体提成函数，行为不变（状态码与错误文本保持）：

- `handleSavePersonalAgentSettings` 的保存逻辑 → `saveAssistantSettings`。
- `handleFindPersonalAgentNotifyChat` → `findPersonalAgentNotifyChat`。
- `handleSendPersonalAgentTestNotice` → `sendPersonalAgentTestNotice`。唯一差异：空实例 ID 的早退路径现在也带 `Cache-Control: no-store`。

DEV-297（`personal_agent_notify.go` 的实例过滤）与这三个函数在同一文件，合并时注意冲突。

## 测试

`apps/server/internal/httpapi/mcp_assistant_settings_test.go`：

- 工具只对助理会话列出与可调用；帮手、其他对话被拒；门控对 Issue 执行、澄清、验证角色的判定（`mcpToolAllowed`）。
- `get`：小于 1.5 KB，分节过滤，未知分节被拒。
- 立即类 `update`：生效、修订号递增、审计行含前后值与类别；`undo` 恢复，重复撤销被拒。
- 之后有任何保存时 `undo` 被拒。
- 提议类 `update`：生成一条待决提议，设置不变；接受后应用。
- 混合类别、未知字段、空补丁：被拒，不改设置。
- 修订号冲突：被拒，不改设置；正确修订号通过。
- 停止时 `update` 与 `notify_test` 被拒。
- 测试通知限频：单元级（窗口、上限、按助理隔离、窗口过后恢复）与 MCP 级（第四次被拒）。
- 未知操作与缺少实例 ID 的错误文本。
- `notify_instances`：列表含 `reason`，非扩展应用被排除（DEV-298b）。

未覆盖：`notify_find_chat` 与 `notify_test` 的成功路径（对 httptest 上游）。见「限制」。

## 验收（dev，部署后）

1. 在飞书或 Web 与助理对话：「把测试通知发到我的自聊」。助理调用 `notify_find_chat`（若尚未设置）与 `notify_test`。
   期望：本人的飞书自聊收到标题为「[测试] Foundry 通知联调」的一条消息；回复中给出 `status: sent`。
2. 「每日摘要改到 08:30」。期望：立即生效，设置页显示 08:30；「动态」中有一条 `update_settings` 记录。
3. 对该记录说撤销。期望：摘要时间恢复为 09:00；再次撤销被拒。
4. 「换成某个模型」。期望：不改设置，出现一张待确认卡片；确认后模型变更。

## 检查

- 远端（CanWendeMac-mini，`scripts/remote-check.sh --go`，go1.26.1，基线 e03dfd61 + 共享改动）：
  - `./internal/httpapi -run 'AssistantSettings|MCP|PersonalAgentSettings|Notify|Coverage|Auth'`：通过（`ok`，28s）。
  - `./internal/httpapi -v -run AssistantSettings`：10 个用例全部 PASS。
  - `./internal/personalagent/...`：通过。
- 本机：`gofmt -l` 对改动的 Go 文件无输出；`go vet` 通过；`node scripts/audit-module-boundaries.mjs` 通过（0 个跟踪违规）。
- 未运行：全量 `go test`、Web 检查（本切片未改 Web）。

## 限制

- `notify_find_chat`、`notify_test` 的成功路径没有对 httptest 上游的端到端测试；现有 notify 测试通过 `notifyStub` 覆盖了发现与校验逻辑，MCP 层只测了门控、限频与停止。
- 限频计数在内存中，服务重启即重置。
- 「动态」页面展示 `update_settings` 工具名，尚未做中文标签（Web 未改动）。
- 权限包未接入（见类别表）。
- 提议接受时不检查修订号：提议之后的其他设置改动不会阻止接受。

## S3 与人专属边界（DEV-298c）

状态：实现完成，远端定向检查通过；已部署 dev（2026-11-18）；待本人验收；已合入 main（PR #278）；补丁 `/tmp/DEV-298c.patch`。依据：报告 §4（边界）、§5（设计）、§6 S3。

### assistant_channels（仅助理会话）

| op                | 类别（`personalagent.ChannelOpClasses`） | 行为                                                                   |
| ----------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| `list`            | read                                     | 渠道、状态与可选来源                                                   |
| `peers`           | read                                     | 必填 `accountId`；该来源上渠道见过的会话与发送者                       |
| `test`            | read                                     | 同 `POST /channels/test`，不保存                                       |
| `create`          | proposal                                 | 必填 `channel`（渠道输入）；永远生成 `channel_change` 提议，待本人确认 |
| `update`          | by-patch                                 | 必填 `channelId`、`patch`；按字段分类，见下                            |
| `update` + `undo` | by-patch                                 | 只撤销一次已生效的立即类改动                                           |
| `grant-source`    | person-only                              | 拒绝（DEV-265，权限包与渠道授权）                                      |

字段类别（`personalagent/assistant_channels.go`）：

- 立即 immediate：`name`；`enabled: false`（暂停）。
- 提议 proposal：其余全部，包括 `enabled: true`（恢复）、`resumeFromNow`、来源、过滤、指引、会话、ack、footer、工作区。
- 同一次 update 混合两类、含未知字段或空补丁：拒绝，不改动。

撤销：只撤销立即类改动；若当初改动的字段现在不再是该次设定的值，拒绝（409）。撤销暂停 = 恢复，属于提议，要本人接受。

审计：`pa_actions`，`tool = assistant_channels`，`args_json` 含 `op`、`channelId`、`patch`、`before`（替换前的值）、`class`、`undoOf`。接受提议时，`applyProposal` 用记录的参数重新规划（`store.PersonalAgentProposalChannel = channel_change`）。

保存：助理写入与人的渠道路由共用 `saveMessageChannelInput`，校验相同。停止状态下写入被拒（`runWrite`）。

### 人专属边界（MCP 强制）

一张表：`apps/server/internal/httpapi/mcp_person_only.go` 的 `personOnlyOperations`，在 `mcpToolPreflight` 中对**每个代理角色**的调用检查（人、设备凭据不受影响）。

| 边界（§4）           | 已关闭的现有操作（"今日"）                                                                        | 守卫（无 MCP 操作，防止以后新增）                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 助理提议与写入的批准 | —                                                                                                 | `needs_you` / `assistant_settings` / `assistant_channels` 的 approve、accept、decline、decide |
| Issue 验收与判定     | —                                                                                                 | `get_issue` 的 accept、abandon、verify、verdict                                               |
| 登录与登出           | `sign_in_subscription` 的 `code`；`connector_instances` 的 `revoke`                               | —                                                                                             |
| 改密码               | —                                                                                                 | `assistant_settings` 的 password                                                              |
| 配对                 | —                                                                                                 | `connector_instances` 的 pair                                                                 |
| 密钥录入与清除       | `save_model_provider` 的 `apiKey`、`clearApiKey`（录入与销毁）                                    | —                                                                                             |
| 停止开关             | —                                                                                                 | `assistant_settings` 的 stop、resume                                                          |
| 权限包与渠道授权     | `assistant_channels` 的 `grant-source`                                                            | —                                                                                             |
| 成员与分享           | —                                                                                                 | `update_workspace` 带 `members` 或 `sharing` 参数                                             |
| 删除                 | `connector_instances` 的 `delete`；`edge_access` 的 `delete`；`delete_model_provider`（整个工具） | —                                                                                             |

守卫条目：表中第三列的操作目前没有 MCP 操作；它们是为将来新增的操作设的守卫，由 `TestPersonOnlyBoundariesRefuseAgentsAndNotThePerson` 验证映射，不代表真实路径。

每个现有工具的变化：

- `sign_in_subscription`：`action=code` 对代理拒绝；`start`、`status`、`cancel` 不变。
- `connector_instances`：`revoke`、`delete` 对代理拒绝；create、probe、list、bind、unbind、update、check 不变。`secretValues` 仍只接受会话 worker 的密钥代理（既有行为，未改）。
- `edge_access`：`delete` 对代理拒绝；create、list、replace、provision 不变；`secretValues` 同上不变。
- `save_model_provider`：`apiKey`（录入）与 `clearApiKey`（清除）对代理拒绝；`copyApiKeyFromProviderId`（复制本人已录入的密钥）对代理保留，答复中不含密钥；不带密钥的创建、改模型、努力程度、设备绑定不变。
- `delete_model_provider`：对代理拒绝。
- 已检查、未改：`connector_packages`（list、get、set_devices、disable 不在边界内）、`needs_you`（`resolve` 只回答助理自己的帮手问题）、`assistant_settings`、`worker_groups`、会话与工作区工具。

代码结构改动（行为不变）：`saveMessageChannel`、`handleTestMessageChannelRules`、`handleMessageChannelPeers`、`handleListMessageChannels` 的函数体提成 `ctx` 版本；`cleanMessageChannelInput`、`checkMessageChannelWorkspace`、`invalidPermissionPackageReferences` 不再接收 `*http.Request`，改用 `scopeOfContext(ctx)`（`requestScope` 委托它，HTTP 行为不变）。

### 对既有测试的改动

- `connector_extension_instances_mcp_test.go`：agent 的 revoke、delete 改为断言被拒、账户与实例保留；审计计数 11 → 9（被拒的调用不执行，不产生审计行）；删除未用的 `errors` 导入。
- `connectors_edge_access_mcp_test.go`：agent 的 delete 改为断言被拒。
- `mcp_model_providers_test.go`：录入密钥（创建、以及与复制并存的冲突探针）、清除密钥、删除改由本人以已登录身份经 MCP 执行（`providerTools.cookie`，`personProviders()`）；复制（`copyApiKeyFromProviderId`）仍由代理执行，并断言答复中不含密钥；缺源探针由代理执行，保留原错误文本断言；Bob 的探针保持原样。
- `mcp_model_providers_test.go` 的 `TestSignInSubscriptionRelaysTheDevicesSignIn` 改为断言代理提交验证码被拒（本人专属边界）：该用例原先只覆盖「action=code 缺 operation 时返回错误」，没有成功的验证码转交可保留；本人经 MCP 调用 `sign_in_subscription` 的放行由 `mcp_person_only_test.go` 覆盖。

### 测试

- `mcp_assistant_channels_test.go`：仅助理可见与可调用；读操作；暂停立即生效并审计、撤销为提议且接受后生效；改名撤销在之后被改过时拒绝；扩大与新建进入提议、保存次数为 0；混合、未知、空补丁被拒；`grant-source` 被拒；停止时被拒。
- `mcp_person_only_test.go`：每个边界条目对代理拒绝（403、点名边界）、对本人放行；每个边界至少一条；非边界调用不受影响；真实 MCP 路径上的已开放操作被拒。
- `personalagent/assistant_channels_test.go`：字段分类、混合与未知与空补丁、操作类别、提议摘要。

### 检查（远端 CanWendeMac-mini，go1.26.1，基线：当前共享树，见补丁）

- `go vet ./internal/httpapi ./internal/personalagent/... ./internal/store`：通过。
- `go test ./internal/personalagent/...`：通过。
- `go test ./internal/httpapi -run 'AssistantChannels|PersonOnly|MCP|Tool|Hint|Description|MessageChannel|Boundary|Coverage|Auth'`：通过（`ok`）。
- `pnpm typecheck`（`--web typecheck`）：通过。
- `node --import ./test/register-bundler-resolve.mjs --test test/personal-agent.test.mjs`：通过（含新增的渠道提议类别用例）。
- Web 构建（`remote-build.sh --web`）：通过。
- `node scripts/audit-module-boundaries.mjs`：通过（0 个跟踪违规）。
- `gofmt -l` 对改动的 Go 文件无输出。
- 未运行：`generate-contracts --check`（协议的提议类型是手写联合类型，未经生成；store 只新增一个常量）；全量 `go test`；Web 全量审计。

### 限制

- 守卫条目（审批、Issue 验收、停止、成员、改密、配对）对应的 MCP 操作不存在；测试只验证表与门控，不是真实路径。
- 人的成功路径在 MCP 上只覆盖了密钥、模型供应商部分；`revoke`、`delete` 的成功路径（本人）没有测试。
- 助理不能录入或清除模型密钥，只能复制本人已录入的密钥。录入保持人专属，是编排者确认的决定（secret entry）。
- `sign_in_subscription`：`start`、`status`、`cancel` 对代理开放，`code` 拒绝（编排者确认）。
- 测试中渠道的保存使用内存替身（直接写 store），因为真实保存需要连接器来源；真实校验由既有的渠道路由测试覆盖（它们经过重构后的函数）。
- 提议接受时，工作区检查用的是接受者（本人）的范围，未单独测试。
- 提议卡片：`channel_change` 显示一行“类别：消息通道”（en：Kind: Message channel），与账号行同样式。协议的 `PersonalAgentProposalKind`（`packages/protocol/src/personal-agent.ts`，手写联合类型）加入 `channel_change`。`proposal-card` 的测试覆盖英文文案；中文由 i18n 键 `proposal.kind` 与 `proposal.kinds.channel_change` 提供。

### 验收（部署 dev 后，本人在飞书或 Web 操作）

1. 对助理说“把运维群的消息通道暂停”。期望：立即生效，渠道页显示已暂停；动态中有一条 `assistant_channels` 记录。
2. 对该记录说撤销。期望：助理回复一张待确认卡片；未接受前渠道仍是暂停。
3. 说“新增一个消息通道读取某来源”。期望：只出现待确认卡片，渠道数量不变。
4. 说“把某来源授权给权限包”。期望：助理回复被拒（权限包与渠道授权归本人）。
5. 说“把 Relay 的密钥改成……”（或让助理保存模型密钥）。期望：被拒，提示在设置中录入。

## S4 Foundry 设置工具（foundry_settings）

状态：实现与测试完成（编排者复核后修订，见「复核修订」）；已部署 dev（2026-11-18）；Agent 代验收（2026-11-18，范围见验收记录）；已合入 main（PR #278）；补丁 `/tmp/DEV-298d.patch`（相对基线树 `b3ec2465…`，即复核时的共享树）。依据：报告 §3、§4、§5、§6 S4。

### 覆盖范围

工具 `foundry_settings`：`area`（枚举）加 `op`（`get` / `update` / `undo`）。只给人自己的会话与人派出的会话（角色为空的聊天与其帮手），不给助理、Issue 执行、澄清与验证会话（`mcpToolAllowed`）。

| 区域                                      | get                                   | update                                                                             |
| ----------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------- |
| `execution`（全局，或 `workspaceId`）     | 是                                    | 拒绝：没有 MCP 工具写入执行默认，人在设置页设置                                    |
| `workspace_defaults`（工作区 agent 默认） | 是                                    | 拒绝：同上                                                                         |
| `worker_groups`                           | 是（全部或 `id`）                     | `label` 立即；`members` 不改，返回 `not_applied` 与 `worker_groups` 的 `save` 调用 |
| `devices`                                 | 是（本人拥有的设备与标签，`id` 可选） | `name`、`labels` 立即                                                              |

删除工作组：人专属（边界表 `mcp_person_only.go` 的 `deleting` 守卫）。

### 复核修订

编排者复核要求：凡是既有 MCP 工具已让人的会话做到的事，不标为人专属，改为指向该工具。按此核对：

- **工作组成员**：`worker_groups`（`action: save`，带 `members`）已由人的会话使用，`foundry_settings` 的 `worker_groups.members` 现在返回 `not_applied` 指针，参数为 `{action: save, id, members}`，不改任何数据。测试中运行了该指针指向的调用，确认映射正确。
- **执行默认与工作区默认**：编排者建议指向 `set_model_defaults`。**核对后不成立**，因此未照做：
  - `set_model_defaults` 写的是某个订阅或启动环境（`saveDeviceProfile`，设备上的 agent 配置默认）。
  - API 端点的默认由 `save_model_provider` 写（该工具描述明说）。
  - 执行默认只由 `saveExecutionDefault` 写入（`PUT /api/execution-default` 与 `PUT /api/workspaces/{id}/execution-default`），**没有任何 MCP 工具**写它；`get_execution_default` 只读。
  - 工作区 agent 默认（`PUT /api/workspaces/{id}/agent-defaults`）同样没有 MCP 写入口。
  - 因此这两个区域的 `update` 仍是拒绝，文案改为事实（「没有 Foundry 工具设置它，人在设置页设置」），不再写「人专属」。把它们开放给 agent 是新能力（会花钱、改变执行位置），应作为提议类单独决定，留待编排者。
- **其余**：`devices.name`、`devices.labels`、`worker_groups.label` 仍为立即类，审计与撤销不变；删除工作组仍拒绝。`get` 保留四个区域。

### 每个字段的类别（代码：`mcp_foundry_settings.go` 的 `foundryAreas`）

| 字段                                                                                           | 类别                    | 结果                     |
| ---------------------------------------------------------------------------------------------- | ----------------------- | ------------------------ |
| `execution.*`（providerKind、providerId、runtime、model、workerGroupId、effort、alternatives） | 人（无工具）            | 拒绝，文案说明无工具写入 |
| `workspace_defaults.*`（scope、routeId、profileId、runtime、model、effort）                    | 人（无工具）            | 拒绝，同上               |
| `worker_groups.label`                                                                          | 立即                    | 改名，审计，可撤销       |
| `worker_groups.members`                                                                        | 有工具（worker_groups） | 指针，不改数据           |
| `devices.name`                                                                                 | 立即                    | 改名，审计，可撤销       |
| `devices.labels`                                                                               | 立即                    | 改标签，审计，可撤销     |
| 删除工作组                                                                                     | 人专属                  | 拒绝（边界表）           |

类别「提议」没有实现：提议卡片挂在助理的 `pa_proposals` 上，只有助理会话有范围创建；聊天没有。

### 设备所有权（与路由规则的差异）

设备路由的规则是 `scope.ownsDevice`。但 agent 会话的访问范围（`agentScope`）从不填 `owned`，所以聊天与帮手无法通过路由规则拥有任何设备。MCP 路径因此按**本人的设备身份**判定（`DevicesOwnedBy(本人)`，再要求设备现在可用，即 `store.RequireDeviceAvailable`）。管理员对无主设备的例外不在 MCP 路径里（更严）。路由的访问代码未改。

### 立即类的审计与撤销

- 审计：写入 `pa_actions`，`assistant_id` 为本人默认助理，`tool = foundry_settings`，`args_json` 含 `op`、`area`、`id`、`field`、`class`、`before`、`after`、`undoes`。理由：本人的助理已是「动态」页读取的变更日志，不新建表。没有默认助理时，立即类改动被拒绝（409）。
- 撤销：`op: undo` 与 `actionId`。读取字段现值，与审计的 `after` 字节相同才回滚到 `before`；否则 409。撤销本身也写一条审计行。
- 每次调用只改一个字段（`patch` 只能有一个键）。

### 重构（路由行为不变）

- `devices_http.go`：`handleRenameDevice` 的校验与改名提为 `renameDevice(ctx, id, name)`；400 文本与状态不变。
- `device_placement.go`：`handleSetDeviceLabels` 的标签校验、查找与保存提为 `setDeviceLabels(ctx, id, labels, updatedBy)`；顺序与状态码不变（标签 400 → 设备 404 → 保存）。
- `routes.go`：未改（早先的草稿改过，已撤回）。

### 类别标签（DEV-299）

代码里的类别前缀是英文（`models & execution:`、`devices & resources:`），测试与 ToolSearch 匹配的都是英文。本工具跨多个区域，用通用标签 `foundry settings:`，并在 `docs/where-things-live.md` 列出。`anthropic/searchHint`：`foundry settings: execution default, workspace agent defaults, worker groups, device names and labels, undo`。不常驻。

### 改动文件

- `apps/server/internal/httpapi/mcp_foundry_settings.go`（新）：工具、类别表、get/update/undo、指针、审计、撤销。
- `apps/server/internal/httpapi/mcp_foundry_settings_test.go`（新）。
- `apps/server/internal/httpapi/mcp_tools.json`：新增工具条目（59 个）。
- `apps/server/internal/httpapi/mcp.go`：登记；`mcpToolAllowed` 对非空角色拒绝。
- `apps/server/internal/httpapi/mcp_person_only.go`：删除工作组守卫。
- `apps/server/internal/httpapi/mcp_tool_hints_test.go`：类别列表加入 `foundry settings:`。
- `apps/server/internal/httpapi/mcp_sessions_test.go`：Issue 执行的工具清单排除 `foundry_settings`（既有测试按名列出排除项）。
- `apps/server/internal/httpapi/devices_http.go`、`device_placement.go`：重构（见上）。
- `docs/where-things-live.md`：类别列表一行。
- `docs/devlog/DEV-298-foundry-mcp-coverage.md`：本节。

## S4 测试

`mcp_foundry_settings_test.go`，使用 `newAssistantFixture`：

- 列出与门控：聊天与帮手列出 `foundry_settings`；助理不列出；Issue 执行、澄清、助理角色与验证会话被拒。
- get：四个区域均可读；设备列表只含本人的 `dev_alice`，不含 `dev_bob`；不可见的工作区与未知工作组被拒。
- 立即类 update：设备改名生效，pa_actions 出现一行 applied，撤销恢复原名，第二次撤销被拒。
- 标签与工作组名称：立即生效，撤销恢复。
- 成员指针：`members` 返回 `not_applied` 与 `worker_groups` 的调用；无审计行；运行该调用后成员已保存。
- 拒绝：`execution`、`workspace_defaults` 的 update 与 `op: delete` 被拒，字段不变，无审计行。
- 每次一个字段；未知字段、未知区域、缺少 id 被拒。
- 撤销在之后有改动时被拒（409 语义）；未知 actionId 被拒。

## 检查

远端（CanWendeMac-mini，`scripts/remote-check.sh --go`，go1.26.1，基线树 `b3ec2465…`）：结果见下方「检查结果」。

## 限制

- 「提议」类未实现；执行默认与工作区默认的 update 是拒绝，不是提议。开放给 agent 需要编排者决定（会花钱，应是提议类）。
- 既有 `worker_groups` 工具（`save`）对聊天与助理仍可改成员：它是既有能力，本片不收回。
- 助理停止开关不作用于聊天会话的 `foundry_settings`。
- 没有默认助理时，立即类改动被拒，而不是改为不审计。
- 设备所有权按本人的设备身份判定，不经访问范围；管理员对无主设备的例外不适用于 MCP。

## S5 Issue 工具（issues）

状态：实现与远端定向检查完成；已部署 dev（2026-11-18）；待本人验收；已合入 main（PR #278）；补丁 `/tmp/DEV-298e.patch`。依据：报告 §2/§3（Issue 缺口）、§4（边界）、§6 S5；`docs/foundry-conversation-release-gate.md` 已整篇阅读，本片不改变准出标准覆盖的 Issue 行为，只给既有操作加 MCP 入口。

### 覆盖范围

工具 `issues`（类别 `issues & knowledge:`，不常驻），`op` 取值：

| op         | 对应人的路由                               | 说明                                                                                   |
| ---------- | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `validate` | `POST /api/issues/{id}/contracts/validate` | 只检查，不写；`confirming` 同路由的 confirming 检查                                    |
| `create`   | `POST /api/issues`                         | Issue 表单；`requestId` 即 Idempotency-Key；runtime 必填 claude 或 codex               |
| `draft`    | `POST /api/issues/{id}/contracts`          | 草案（可基于已有修订，`baseRevision`、`changeReason`）；存为助理/会话的 agent_proposal |
| `comment`  | `POST /api/issues/{id}/messages`           | 同一路由：状态问句、澄清草案、执行反馈；不能回答 Issue 正在等待的问题                  |
| `retry`    | `POST /api/issues/{id}/clarify/retry`      | 重送最近一条消息给失败的澄清                                                           |

人专属（`mcp_person_only.go`，`issues` 工具上的守卫，由 `TestPersonOnlyBoundaries…` 校验）：

- 验收与判定（边界 `boundaryIssueAcceptance`）：`accept`、`abandon`、`cancel`（即放弃）、`verify`、`verdict`。原先挂在 `get_issue` 上，`get_issue` 没有 op，守卫移到实际承载这些操作的 `issues` 工具。
- 确认与决定（新边界 `boundaryIssueDecision`）：`confirm`（即“确认标准并开始”）、`start`、`discard`（丢弃草案）、`answer`（回答 Issue 等待的问题）。

运行时守卫（不在表中）：`comment` 遇到处于 blocked 且有问题的 Issue 时，若发送方是代理（`Via = agent`），`issues.Service.Message` 返回 `ErrAgentMayNotAnswer`（403）。这是服务层判定，因为 `DecisionRole` 把创建者视为 Member 决定者，代理以创建者账号行事时否则能经 `comment` 回答问题。

角色门控：`issues` 只对角色为空的聊天与其帮手开放（`mcpToolAllowed`，与 `foundry_settings` 同规则）；Issue 执行、澄清、验证、助理会话均拒绝。Issue 内部派出的协作会话（session.IssueID 非空）在 `mcpToolAvailability` 中从列表里隐藏，调用时也被拒。

### 代码结构（路由行为不变）

- `evidence_requests.go`：`decodeEvidenceRequest` 的体解码提成 ctx 无关函数 `decodeEvidenceJSON(raw, name, target)`（模型 schema 校验、禁止未知字段、单个 JSON 对象）。HTTP 路由与 MCP 共用；错误文本与状态码不变。
- `issues_http.go`：`handleIssueMessage` 的匿名请求结构提成 `issueMessageRequest`，字段与 JSON 标签不变。
- `issues/message.go`：新增 `ViaAgent = "agent"` 与 `ErrAgentMayNotAnswer`；`Message` 在 blocked 分支对 `Via == ViaAgent` 直接拒绝。人的路径不变。
- `sqlitestore/issue_contracts.go`：`CreateContract` 按 actor 种类设 origin：`agent` → `agent_proposal`，其余仍为 `user`。
- `mcp.go`：注册 `issues`；`mcpCallerRole` 多返回一个 Issue 绑定标志；`mcpToolAllowed` 增加角色门控。
- `mcp_tools.json`：新增 `issues` 条目（工具总数 59 → 60）。

### 与 HTTP 的差异（有意）

- 草案来源：HTTP 由人保存为 origin `user`；MCP 由代理保存为 origin `agent_proposal`，actor 为 agent。内容、修订号、状态、contentDigest 与 HTTP 一致。理由：代理起草的草案不应被记成人本人的草案（G2：代理只提议，人确认）。这是编排者需确认的语义点。
- `comment` 写入 `via: "agent"`。Web 的会话转录只对 `feishu` 显示来源标签，因此代理转述的消息目前显示与人的消息相同。Web 标签属于 Issue UI，本片不改。
- `initializeGit` 不经 MCP：工作区无 Git 时返回 409 并给出目录，由人在 Foundry 确认。
- 请求体与 HTTP 同样严格：未知字段被拒（例如 `initializeGit`）。

### 测试

`mcp_issues_write_test.go`（新）：

- `TestIssuesToolIsOfferedOnlyToThePersonsOwnSessions`：聊天与帮手列出；助理、执行会话、Issue 内协作会话不列出；角色表与验证会话的 `mcpToolAllowed` 判定。
- `TestIssueCreateOverMCPMakesTheSameIssueAsTheRoute`：缺 requestId、带 initializeGit、缺 runtime 被拒；重放同一 requestId 返回同一 Issue；创建者为本人账号；与 HTTP 创建比较 workspaceId、title、sourceInput、runtime、status、contractState。
- `TestIssueDraftOverMCPSavesTheRoutesContractAsAProposal`：草案与 HTTP 比较 revision、status、contentDigest；origin 分别为 agent_proposal 与 user；不完整内容被拒；`validate` 对完整与不完整内容的结果；已确认契约的修改生成 r3 草案，Issue 仍显示 r2 为当前契约。
- `TestIssueCommentOverMCPNeverAnswersTheQuestion`：blocked 且有问题时 `comment` 被拒，问题未被回答，状态仍为 blocked；状态问句 `status?` 路由为 `status`。
- `TestIssueRetryOverMCPMatchesTheRoute`：无可重试澄清时 MCP 与路由都失败。
- `TestIssuesToolRefusesThePersonsDecisionsOverMCP`：accept、abandon、cancel、verify、verdict 按边界名拒绝；confirm、start、discard、answer 按边界名拒绝；未知 op 被拒。

既有测试调整：`mcp_person_only_test.go`（边界列表加 `boundaryIssueDecision`；门控放行列表加 `issues` 各 op），`mcp_sessions_test.go`（Issue 执行的工具清单排除 `issues`）。

### 检查（远端 CanWendeMac-mini，go1.26.1，基线 e03dfd61 + 共享改动，`scripts/remote-check.sh --go`）

- `./internal/httpapi -run 'Issue|MCP|Tool|Hint|Description|PersonOnly|Coverage|Auth'`：通过（`ok`，约 47 秒）。前几轮失败均为测试夹具问题（缺 Origin、缺 changeReason、执行会话未 StartAgentSession、未完成执行回合），已修正，未改产品代码。
- `./internal/issues ./internal/sqlitestore -run 'Issue|Contract|Question|Message|Review'`：通过。
- 本机：`go vet ./internal/issues` 通过；`gofmt -l` 对改动的 Go 文件无输出；`node scripts/audit-module-boundaries.mjs` 通过（0 个跟踪违规）。
- 未运行：`go vet ./internal/httpapi`、`generate-contracts --check`（未改契约与协议类型）、全量 `go test`、Web 检查（本片未改 Web）。

### 限制

- `draft` 的 origin 与 HTTP 不同（见上），需编排者确认。
- 助理（personal_agent）不拥有 `issues`：助理是否应创建 Issue 未在本片决定。
- 验收（`accept`）等人专属操作仍只在 Foundry 中完成。
- `discard` 归人专属：代理只能用新草案取代旧草案。
- `comment` 的 `via: "agent"` 在 Web 不可见（见上）。
- 观察（S4 范围，本片未改）：`foundry_settings` 的角色门控只看角色为空，未排除 Issue 内协作会话；与本片的 `issues` 不同。需要单独决定是否同样收紧。
- 运行时守卫 `ErrAgentMayNotAnswer` 没有单独的 HTTP 对照测试，只有 MCP 路径测试。

### 验收（部署 dev 后，本人在飞书或 Web 操作）

1. 对助理说“在 ws_… 里建一个 Issue：把首页问候改得更友好”。期望：助理不能直接创建（助理不拥有 `issues`）；改为在普通聊天中要求创建。
2. 在普通聊天中让助理创建 Issue。期望：Web 出现新 Issue，状态 pending，契约为草案，创建者为本人；澄清开始。
3. 让助理为该 Issue 起草契约。期望：草案 origin 显示为助理提议；未确认前不执行。
4. 让助理回答 Issue 等待的问题。期望：被拒，提示由本人回答；问题仍在 Web 上等待。
5. 让助理确认或放弃 Issue。期望：被拒，提示由本人在 Foundry 中完成。

## DEV-298f issues 工具自描述（draft 的字段与取值）

状态：实现与远端定向检查完成；已部署 dev（2026-11-18）；Agent 代验收（2026-11-18，范围见验收记录）；已合入 main（PR #278）；补丁 `/tmp/DEV-298f.patch`。来源：live 检查（train 82）：agent 写的草案只有一个标准，`validate` 正确指出缺 `proofKind`、`evaluationMode`、`rubric`、`evidenceRequirements`，但 agent 找不到允许值而放弃。

### 改动

- `issues` 新增 `op: schema`，`part` 取 `contract`（默认）、`criterion`、`richContent`、`evidence`。每个 part 是紧凑 JSON：`required`、`fields`（每个字段的类型、枚举值与备注、`see` 指向的 part、`minItems`）与 `rules`（schema 表达不了的跨字段规则，按 `ValidateContractContent` 的顺序，用文字写）。`evidence` 另附 `carriersBySource`（每个来源产出的 carrier）。
- 大纲与校验读同一份嵌入的 `contract-schema.json`（`store/contract_outline.go`），字段、必填与枚举不会与校验漂移；枚举备注（如 `evaluationMode`、`source`）是少量手写文字。
- 校验错误（`draft` 被拒、`validate` 的问题）在提到枚举字段名时追加 `[allowed: proofKind: functional, …; evaluationMode: deterministic, agent]`。只在 MCP 路径生效；HTTP 路由的错误文本不变。
- 工具描述加一句：草案的字段与允许值在 `op schema` 中。`mcp_tools.json` 只改了描述、`op` 枚举与 `part` 属性。

### 测试

- `store/contract_outline_test.go`：每个 part 可解析、≤ 2500 字节，`proofKind` 与 `evaluationMode` 的值与 schema 相同；未知 part 被拒；问题中的枚举字段获得允许值，无枚举字段的问题原样返回。
- `httpapi/mcp_issues_write_test.go`：
  - `TestAgentDraftFromTheSchemaOutlineIsValid`：测试里的 agent 只通过 `op schema` 读取 contract、criterion、richContent、evidence 四个 part，按其中的必填字段与允许值构造草案；`validate` 无问题，`confirming` 仍报告缺证据来源，`draft` 保存为 agent_proposal，修订号为 2。
  - `TestIssueProblemsNameTheAllowedValues`：缺 `proofKind` 与 `evaluationMode` 的标准，`validate` 与被拒的草案都给出允许值。
  - `TestIssueSchemaAnswersParts`：各 part 按名应答，未知 part 被拒。

### 检查（远端 CanWendeMac-mini，go1.26.1，基线：当前共享树）

- `./internal/store ./internal/httpapi -run 'Contract|Outline|Issue|MCP|Tool|Hint|Description|PersonOnly|Coverage|Auth|Schema'`：通过。
- 新增用例单独 `-v` 运行：`TestContractOutlineAnswersEachPartWithTheSchemasValues`、`TestContractOutlineRefusesAnUnknownPart`、`TestContractProblemHintsNameTheAllowedValues`、`TestAgentDraftFromTheSchemaOutlineIsValid`、`TestIssueProblemsNameTheAllowedValues`、`TestIssueSchemaAnswersParts` 全部 PASS。
- `go vet ./internal/store ./internal/httpapi ./internal/issues`：通过。

### 限制

- `deterministic` 标准需要 checker 才能确认；大纲的备注写明这一点，本工具不起草 checker，因此 agent 只能起草 `agent` 标准。
- 大纲给出的是字段与取值，不给完整示例；测试中的 agent 对字符串字段填字段名，足以通过校验，但不代表人会写的标准文案。
- 备注文字与规则文字是手写的；字段与枚举值来自 schema，规则变化时需要同步更新 `contractOutlineRules` 与 `contractEnumNotes`。

## DEV-298g Issues 关闭时 MCP 与 CLI 不写 Issue（与 web 的 `issuesEnabled` 对齐）

状态：实现与远端定向检查完成；已部署 dev（2026-11-18）；Agent 代验收（2026-11-18，范围见验收记录）；已合入 main（PR #278）；补丁 `/tmp/DEV-298g.patch`（相对共享树）。

依据：web 的 `issuesEnabled = false`（DEV-148，`39348563`）把 Issues 隐藏，但 train 82/83 的 `issues` 工具（create、draft、comment、retry）仍能写 Issue 与草案，人在 Web 里既看不到也确认不了。隐藏的流程不应经 MCP 写入。

### 改动

- Server 开关 `FOUNDRY_ISSUES_ENABLED`（`cmd/foundry-server/config.go` 唯一读取处，映射到 `ServerOptions.IssuesEnabled`），默认关闭，与 web 标志含义一致。
- `mcpToolAvailability`：关闭时 `issues` 不进入 `tools/list`，调用被拒绝，返回「Issues are turned off on this Foundry server: the issues tool is not available」。这是 `tools/list` 与调用共用的同一判断。
- CLI 的 `issue` 写动作（create、draft、comment、retry、schema、validate）都经 `issues` 工具，因此同样被服务端拒绝；CLI 代码与 `foundry-cli` 测试表不需要改。
- 读工具 `list_issues`、`get_issue` 保留：只读，它们在 Issues 隐藏期间已经可见（DEV-148 只隐藏 web 入口）。注意：它们会返回人在 web 中看不到的 Issue 记录；如要收紧，需由编排者决定。
- Web 的 `issuesEnabled` 仍是编译期常量；`feature-flags.ts` 的注释写明与服务端开关成对设置。后续：由认证状态接口下发该值，web 运行时读取（未做，改动面涉及约 12 处引用）。
- HTTP 的 Issue 路由（`/api/issues`，人的 Web 与飞书路径）不改：本次只关 agent 的 MCP 写入。

### 测试

- `httpapi/mcp_issues_write_test.go`：`TestIssuesToolIsRefusedWhileIssuesAreTurnedOff`：关闭时 `tools/list` 不含 `issues`、含 `list_issues` 与 `get_issue`；`create` 被拒且错误包含 `Issues are turned off`；重新打开后再次列出。
- 测试服务器（`auth_test.go` 的 `newAccountsTestServer`）与 `mcp_sessions_test.go` 的 `TestToolsListFollowsTheSessionsRole` 显式设为开启，其余测试行为不变。
- `cmd/foundry-server/config_test.go`：默认关闭；`FOUNDRY_ISSUES_ENABLED=1` 开启。
- 工作树里 `packages/worker` 未改，未运行 worker 测试。

### 检查（远端 CanWendeMac-mini，`scripts/remote-check.sh --go`，基线：当前共享树）

- `./internal/httpapi -run 'Issue|MCP|Tool|Description|Coverage'`：通过（首轮 `TestToolsListFollowsTheSessionsRole` 失败：该测试用默认选项的 `NewServer`，聊天角色的工具表缺 `issues`；已在该测试中显式开启，复跑通过）。
- `./cmd/foundry-server -run LoadConfig`：通过（默认关闭、`FOUNDRY_ISSUES_ENABLED=1` 开启）。
- `go vet ./internal/httpapi ./cmd/foundry-server`：通过。

### 限制

- 服务端开关与 web 常量需要人一起设置；只改服务端时，web 仍隐藏 Issues，但 agent 可写。
- Foundry 技能文档仍描述 `issue` 命令；关闭时 agent 会收到拒绝信息。技能文本未改（跨两个副本，需同步的 worker 测试）。
- 未部署；dev 环境需要决定是否设置 `FOUNDRY_ISSUES_ENABLED`（默认关闭，无需设置即符合本次目标）。

### 验收（部署 dev 后）

1. 默认配置下，本人聊天中 `tools/list` 不含 `issues`；调用 `issues`（如 `op: create`）返回「Issues are turned off」，Issue 未创建。
2. `foundry issue list` 与 `foundry issue get` 仍可用。
3. 设置 `FOUNDRY_ISSUES_ENABLED=1` 并重启 Server 后，`issues` 重新出现，行为与 DEV-298f 相同（Web 端仍隐藏 Issues，因此只在 agent 侧可见）。

## DEV-298h MCP 与 CLI 隐藏全部 Issue 工具（2026-11-18）

状态：已部署 dev（2026-11-18）；待本人验收；已合入 main（PR #278）。

人的决定（2026-11-18）：「那先把所有 issue 相关的功能都从 MCP 里面去掉啊」；「写死就行，不用搞成开关，因为这个 issue 短期内不用。就算要用，也要对它进行代码上的改造。」

### 改动

- `apps/server/internal/httpapi/mcp_issues_write.go`：编译期常量 `issuesEnabled = false`（与 web 的 `issuesEnabled` 对齐），以及 `issueMCPTools`：`issues`、`list_issues`、`get_issue`、`ask_person`。
- `mcp.go` `mcpToolAvailability`：`issueMCPTools` 在 `!issuesEnabled` 时既不列出（tools/list），也在调用时拒绝（「Issues are turned off on this Foundry server: <tool> is not available」）。
- 删除环境变量 `FOUNDRY_ISSUES_ENABLED` 与 `ServerOptions.IssuesEnabled`（`security.go`、`cmd/foundry-server/config.go`）。
- CLI：`packages/worker/src/agent-surface/foundry-cli-commands.ts` 删除 `issue` 命令组（list/get/create/draft/comment/retry/schema/validate）。`foundry-cli.test.mjs` 删除对应用例；`foundry-skill.test.mjs` 的「每个工具都有命令」允许 `ask_person`、`issues`、`list_issues`、`get_issue` 无命令，并断言没有 `issue` 命令组。
- 技能：`packages/worker/skills/foundry/SKILL.md` 与 `apps/server/internal/builtinskills/foundry/SKILL.md`（两副本逐字相同）的「Issues and questions」改为说明 Issue 工具关闭。
- web 注释 `apps/web/src/lib/feature-flags.ts` 改为指向服务端常量（不改值）。
- 未删除：Issue 实现、`mcp_tools.json` 中的工具定义、`clarificationMCPTools` 等角色表。

### 隐藏的工具

`issues`、`list_issues`、`get_issue`、`ask_person`。Issue 会话无法启动，因此角色表中的 Issue 执行／澄清条目保留不动（它们只对 Issue 会话生效）。

### 测试

- 通过 MCP 路由调用 Issue 工具的测试，在工具隐藏期间无法运行，已加 `skipWhileIssuesHidden(t)` 跳过（并注明原因）：`TestExecutionAsksThePersonThroughFoundryTools`、`TestIssueToolsReadIssuesWithinReach`、`TestIssuesToolIsOfferedOnlyToThePersonsOwnSessions`、`TestIssueCreateOverMCPMakesTheSameIssueAsTheRoute`、`TestIssueDraftOverMCPSavesTheRoutesContractAsAProposal`、`TestIssueCommentOverMCPNeverAnswersTheQuestion`、`TestIssuesToolRefusesThePersonsDecisionsOverMCP`、`TestIssueProblemsNameTheAllowedValues`、`TestIssueSchemaAnswersParts`。恢复 Issue 时删除这些跳过（`mcp_issues_write.go` 的常量改动即需要同步代码）。
- 期望列表更新：`TestIssueToolsAreHiddenWhileIssuesAreDisabled`（原「关闭时拒绝」用例，改为对常量的断言，不再切换字段）、`TestVerifierToolsAndDevice`（只读工具不再含 Issue 读工具）、`TestToolsListFollowsTheSessionsRole`（聊天与 Issue 执行的工具表不含隐藏工具）。
- `TestLoadConfig*` 删除 `FOUNDRY_ISSUES_ENABLED` 用例。

### 检查（远端 CanWendeMac-mini，go1.26.1，基线 e03dfd61 + 共享改动）

- `go test ./internal/httpapi -run 'Issue|MCP|Tool|Description|Coverage|PersonOnly|FoundrySettings|Feishu|Pair|Ask|Question|Verifier|Sessions'`：通过（含 pair_code 测试）。
- `go test ./cmd/foundry-server -run 'LoadConfig|Config'`：通过。
- `packages/worker` `node scripts/run-worker-tests.mjs -- foundry-skill.test.mjs foundry-cli.test.mjs`：通过。
- `go vet ./internal/httpapi ./cmd/foundry-server`：通过；`node scripts/audit-module-boundaries.mjs`：通过（0 条违规）。

### 限制

- 跳过的 9 个测试是 Issue 实现的覆盖，隐藏期间不运行；重新开启 Issues 时需恢复。
- 已部署 dev（2026-11-18）。

## DEV-305 会话生成飞书配对码（foundry_settings pair_code）

状态：已部署 dev（2026-11-18）；待本人验收；已合入 main（PR #278）。

人的授权（2026-11-18）：「可以啊，就用这个，你自动搞完，我授权你。」

### 改动

- `foundry_settings` 新增 op `pair_code`，area `feishu`，参数 `workspaceId`。返回配对码与过期时间；配对码 10 分钟有效。
- 配对码生成抽成 `generateFeishuPairingCode`（`feishu.go`），HTTP 路由 `POST /api/workspaces/{id}/feishu/pair-code` 与 MCP 共用；行为不变（未选飞书应用时 409）。
- 角色：只允许本人的聊天与本人启动的会话（沿用 `foundry_settings` 的角色门槛）；助理的 helper 会话被拒绝（`HelperOf`）；Issue、验证、助理会话被拒绝。
- 工作区权限：需要 Maintainer（与 HTTP 路由一致）。
- 审计：写入助理的 pa_actions（`Op: issue`，`Class: issued`）。撤销无意义：配对码只绑定发送它的会话，10 分钟后失效；`undo` 对 issued 改动拒绝，并说明「does not undo」。
- 类别表：`foundryClass` 新增 `foundryIssued`（见 `mcp_foundry_settings.go` 文件头）。`get`/`update` 不接受 area `feishu`。
- 人员专属表（`mcp_person_only.go`）：没有配对码条目（其中 `boundaryPairing` 只指设备/连接器配对），因此未改动。
- `mcp_tools.json`：`foundry_settings` 的 op、area 枚举与说明更新。

### 测试

- `TestFoundrySettingsPairCodeIsRefusedToMembersAndHelpers`：Member 被 Maintainer 规则拒绝；助理 helper 被拒绝；area 错误、缺 workspaceId、`get feishu`、`update feishu` 被拒绝。
- `TestFoundrySettingsUndoRefusesAnIssuedPairingCode`：issued 改动不可撤销。
- 成功路径（生成配对码并审计）未有单元测试：HTTP 路由测试（`feishu_test.go`）只覆盖 409 与 200 的生成，共用同一函数；MCP 成功路径未做端到端验证。

### 如何把助理/会话的配对码送到飞书机器人（OpenLark 调研）

依据 `nwverse/open-lark`（commit b66693b，`gh repo clone` 后本地检索）：

1. 找到机器人的用户 ID：`olk api GET '/contacts/bots?offset=0'`（机器人目录，可能为空或被租户隐藏）。注意 Foundry 路由表里的 `app_id`（`xapp_…`）是 Foundry 连接器 ID，不是飞书 `cli_` 应用 ID，也不是这里需要的 user ID。
2. 建立或取回单聊：`olk api POST /conversations --data '{"type":"p2p","userIds":["<机器人 user ID>"]}'`，返回 `{created, feedId}`；已存在时 `created:false`。写路由，先加 `--dry-run` 校验，再加 `--yes` 执行。依据：`.agents/skills/open-lark/references/groups.md` §1，服务端 `src/server/routes/api.ts`（`POST /conversations`）。
3. 发送文本：`olk im send <feedId> --text "/pair <配对码>"`（同样先 `--dry-run`）。Foundry 的 `/pair` 处理器见 `feishu/ws_manager.go` `handlePairCommand`。

未执行：没有对真实机器人发送消息，也没有在 OpenLark 账号中建立单聊。

### 改动文件

见本次补丁 `/tmp/DEV-298h-305.patch`。

### 检查

同 DEV-298h 的检查（pair_code 测试包含在 `internal/httpapi` 运行中）。

### 限制

- 已部署 dev（2026-11-18）。
- 机器人的飞书 user ID 需要从 `contacts/bots` 或已有单聊取得；未验证该目录能否列出 Foundry 机器人。
- 一次性配对码的端到端（生成→olk 发送→绑定）未验证。

## DEV-305b pair_code 按人的 Maintainer 角色判断（2026-11-18）

状态：已部署 dev（2026-11-18）；待本人验收；已合入 main（PR #278）。

### 问题

`foundry_settings` 的 `pair_code` 用会话的 agent scope 判断 Maintainer。agent scope 按设计封顶为 Member（`access.go` `agentScope`：agent 不管理），所以每个 agent 都被拒绝：「You are a Member in this workspace; this action needs Maintainer or higher.」直播中失败两次。

### 改动

- `pairCodeRefusal`（`mcp_foundry_settings.go`）：只有 `pair_code` 走这条路径。agent 先用原 scope 判断可见性（不可见 404），再读取会话所属人（`CreatedByUserID`）未封顶的工作区角色，要求 Maintainer 或更高。其余操作仍用封顶后的 scope。
- Issue 会话（`issueID` 非空）与无人发起的会话（`userID` 为空）一律拒绝，避免 Issue scope 借此放宽。
- 助理 helper、assistant/Issue/verifier 会话的拒绝保持原样（helper 检查与 `mcp.go` 的 `foundrySettingsMCPTools` 角色闸门不变）。
- 非 agent 的 actor 仍用原 scope 判断 Maintainer。

### 测试

- `TestFoundrySettingsPairCodeIsRefusedToMembersAndHelpers`：人只是 Member 时被拒绝（Maintainer 文案）；人是 Owner 时，其助理 helper 仍被拒绝；其余既有拒绝不变。
- `TestFoundrySettingsPairCodeIsIssuedForAWorkspaceOwnerThroughTheirChat`：工作区 Owner 的聊天会话拿到 `status: issued` 与 `FND-` 配对码（测试中绑定了 ws_alice 的飞书应用）。

### 检查

见本次补丁的检查记录（`go vet ./internal/httpapi`、`go test ./internal/httpapi -run 'FoundrySettings|Pair|Feishu|PersonOnly|MCP'`）。

### 限制

- 已部署 dev（2026-11-18）。补丁 `/tmp/DEV-305b.patch`，基线为共享树（train 88）。
- Issue 会话的拒绝依赖 `mcp.go` 角色闸门与本函数的 `issueID` 检查双重保证；未单独写 Issue 会话的测试。

## 2026-11-18 dev 验收记录（Agent 代验收，DEV-298d / f / g）

- DEV-298d（sess_1794997697068504438）：foundry_settings `get` 返回四个区域。添加设备标签后经 `paa_2b04c03a…` 撤销，sg-chaos 的标签恢复为 `[]`；执行更新被拒绝，并给出事实原因。
- DEV-298f（sess_1794999903993907336）：只用 `op schema`（约 3 KB），agent 写出的草案首次校验即通过。
- DEV-298g（train 85 之后）：新会话的 ToolSearch 找不到 issues 工具。
- 待本人验收：DEV-298a、298c、298e、298h、305、305b（见各自小节状态）。
