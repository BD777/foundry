# DEV-243 实例描述符快照过期；自写范围过宽；通道回执会清掉「等你处理」

状态：已部署 dev（train7-20261116）；Agent 代验收（2026-11-16，范围见验收记录）；已合入 main（PR #269）。

2026-11-16 E2E（`sess_1794778276586307621`，第 3 轮）：实例描述符刷新为 1.6.1（2 条写声明），自写按该助理的会话范围丢弃，卡片只在本人引用回复时解析。

来源：E2E round 2（`sess_1794776456356919583` 最终报告）的三个缺陷，以及 [assistant-usable-20261116](../briefs/assistant-usable-20261116.md) 的原则：Foundry 只补确定性机制，判断留给 agent。

## 1. 实例一直使用创建时的描述符快照（F2 的根因）

### 根因

- `ExtensionInstanceData` 把 `Descriptor` 连同 `Values`、`ProbeValues`、`Routes` 等一起存进 `external_provider_apps.extension_data`。创建和人工「检查」时写入，之后没有任何东西比较**当前已安装的扩展描述符**。
- 生产实例 `xapp_8ef44948…` 仍是 2026-11-11 创建时的 1.2.1 快照（`serverHeld.writes = null`），设备早已升级到 1.6.1。`ExtensionData` 原样返回快照，于是网关 `extensionCreatedMessagePointer` 读不到写声明，DEV-241 的记录逻辑从未运行。
- 快照里有两类东西：
  - **描述符派生**：`Descriptor`（`serverHeld` 的写声明、访问声明、上游头/限制、事件映射等）与由它即时计算的 `Access`。这些必须跟随已安装版本。
  - **实例自身**：`Values`（本人填写）、密封密钥、`Account`、`Network`/`ProbeDeviceID`（设备绑定）、`ProbeValues`/`Version`/`FieldOptions`/`Routes`（对连接器探针的结果，不是描述符本身）。

### 修复

- `externalaccounts.Service` 新增 `ExtensionDescriptor` 解析器（`module.New` 接到 `DeviceHeld.ServerHeldDescriptorForOwner`，即「本人任意设备上最新已安装版本」）。
- `ExtensionData` 读取时若发现当前描述符与快照不同，就**用当前描述符重算描述符派生数据**（`Descriptor`、`Access`），保留实例自身数据（字段值、账户、网络与设备绑定、探针结果），并把刷新后的快照持久化。刷新只发生一次：下一次读取时存储已是新描述符，不再写。连接器实例列表也走 `ExtensionData`，所以部署后打开 Connectors 就能看到 1.6.1 的快照，不必先发生一次网关调用。
- 放开/上游不可用导致解析失败时返回旧快照，不阻塞网关请求。

### 为什么选「实时读取并刷新」，不自动跑 CheckExtensionInstance

- `CheckExtensionInstance` 会重新探针上游；失败时会把账户标成 `needs_reauth`。在每次扩展升级时自动跑它，会把一次临时网络抖动变成「连接器坏了」，而且把网络 I/O 塞进连接器读取路径。
- 已安装描述符来自设备注册时上报的连接器元数据（本地库读取），离线也能拿到；它正是这次要跟随的数据，确定、无副作用。
- `Routes` 是探针（连接器响应）的产物，不是描述符字段，单靠描述符无法重新验证；它保持上次验证通过的目录。需要重新验证路由时仍由本人在「检查」里跑 `CheckExtensionInstance`。本次验收只需要静态的写声明跟随版本，已满足。

## 2. 自写范围按账号而非会话（F2 修复后会误伤）

### 根因

`messageChannelOwnWrites` 只按来源账号 + 48 小时取 `extension_write_created_message`，不区分是哪个会话写的。E2E 的发件人 `sess_1794776556880746530`（同一账号、和通道助理无关）经网关发出的 `/ai` 触发也会被当成自写丢弃；DEV-241 生效后，这会让测试甚至真实场景里其他 agent 会话的正常写入消失。

### 修复

- 事件必须来自**属于该通道助理的会话**才计入自写：`permission.Resolve` 解析会话归属，覆盖
  - 助理的通道会话（`message_channel_sessions`），
  - 助理 home 工作区的顶层对话，
  - 上述会话派生的 helper（沿 `ParentSessionID` 向上找到）。
- 同一批内按 `SessionID` 缓存解析结果；没有 `SessionID` 的事件无法归因，不计入自写。账号过滤仍在 SQL（`kind + account + since`）完成。

## 3. 「等你处理」卡片被助理自己的回声清掉

### 根因

`sessions.Queued` 把任何排队中的通道输入当成本人回答并 `resolve`。DEV-241 未生效时，助理自己的 IM 回显被当作本人消息；卡片在回复后几秒就变成 `person_answered`。

### 修复

- 队列事件带 `ChannelOrigin` 时，只有批内存在 **`sender is the person: yes` 且不是 Foundry 自写（`IsOwnWrite`）** 的消息，才解析可回答的 pending item。
- 没有 `ChannelOrigin` 的直接消息保持原行为；别人的消息、自写回声都不清卡片。
- 这是 DEV-241 之后的纵深防御：正常路径下回声已在 `channels.Runner.decide` 里以 `own_write` 丢弃，不会入队。

## 测试

- `internal/httpapi`：
  - `TestMessageChannelOwnWritesFollowTheAssistantsSessions`：home 对话、helper、通道会话的写入计入自写；同一账号下无关会话的写入、49 小时前的事件、其他账号的事件都不计入；600 条其他 kind 的网关事件不影响结果。
  - `TestQueuedChannelTurnNeedsThePersonsOwnWords`：自写回声与别人的消息都不清卡片；批内含本人消息（即使旁边有回声）才解析。
  - 原有 `TestPendingItemsFollowWhatSessionsRecord` 回归通过。
- `internal/connectors`：
  - `TestExtensionInstanceFollowsAnUpgradedDescriptor`：在真实 sqlitestore 上创建 v1 实例并探针；把解析器切到 v2（新增 `serverHeld.writes`、版本 1.1.0）后，下一次 `ExtensionData` 即返回 v2 的写声明并持久化；字段值、网络、探针设备、探针版本、路由目录与账户状态均不变。
- 运行方式：`FOUNDRY_LEASE_TOKEN=… scripts/remote-check.sh <lease> --tree ~/workspace/foundry-dev243 --go ./internal/httpapi ./internal/connectors -run '<上述用例>'`（CanWendeMac-mini，`go1.26.1`；PASS）。

## 部署后的只读验收

1. 下一次真实助理回复后，网关审计应出现 `extension_write_created_message`（`detail.route` 为 `/agent/v1/messages/:messageId/replies` 或 `/agent/v1/conversations/:feedId/messages`），对应投递为 `dropped/own_write`，不再多一个 `follow_up` 回合；实例的 `extension_data.descriptor.extension.version` 应为 1.6.1、`serverHeld.writes` 非空。
2. 用另一个与助理无关的会话向自聊发 `/ai`，该消息不应被丢弃。
3. 助理回复后，其 `hand_over` 卡片应留在「等你处理」；只有本人再发消息才解析。

## 已知限制

- 扩展升级不会自动重新探针：探针派生的 `Routes`、`ProbeValues`、`Version`、`FieldOptions` 保持上次「检查」的值；新版本新增的路由要等本人点「检查」才会进入目录。描述符派生的写声明、访问声明、上游头/限制会立即跟随。
- 描述符解析以本人任意设备上的最新已安装版本为准；所有设备都卸载该扩展时保留旧快照（会话此时也无法通过网关使用该实例）。
- 自写归因依赖 `permission.Resolve`：助理权限包缺失等解析错误按「不属于该助理」处理，宁可多投递也不吞掉无关会话的写入。
