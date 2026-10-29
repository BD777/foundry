# DEV-058 外部连接的用量展示：调研与设计

状态：设计完成，等待决策。没有改产品代码。

问题（用户，2026-10-28）：“私有网关类的 provider，是否有办法获得 usage 的信息？如果有的话，也像 subscription 那样展示到我们的 Foundry 的看板上面去。”这里的 provider 指设备上的外部连接（external connection，DEV-044/045）：Worker 用原生 Claude Agent SDK 运行，连接由设备本地的外部连接 helper 准备。

范围：只读调研。依据是本仓库代码、`@anthropic-ai/claude-agent-sdk@0.3.201` 的类型定义、dev Server DB（`mode=ro`）、本机外部连接的原生 transcript，以及本机已安装 helper 的发布包（只读，私有实现细节不写入本仓库）。没有发起模型请求，也没有用任何凭据访问 provider 端点。

## 结论

**能展示，但要分两层，额度数字目前拿不到。**

1. **Foundry 侧记账：现在就能做，不依赖 helper。** Worker 已从每个回合的 SDK `result` 里提取 token 用量和 Claude 标价估算，写进事件的 `metadata.turnUsage`。按“设备 + 连接 profile”聚合，就能在看板上显示近 5 小时、今日、近 7 天的回合数、输入/输出/缓存 token 和估算费用。dev DB 中 `gateway_default` 自 10-25 起有 12 个会话、95 个回合、输入 4.39 亿 token（含缓存读）、输出 80 万、估算 $123（其中 26 个回合没有费用）。
2. **额度/限额（像订阅那样的百分比和重置时间）：Foundry 单方面拿不到。** 订阅看板用的 SDK `get_usage` 控制接口经外部连接走 helper 的代理，而已安装的 helper 只转发推理和启动设置请求，不转发计划用量查询；即便转发，查到的也是网关上游账号的计划额度，可能被多人共享，不是这个人的额度。外部连接 protocol v1 也没有 usage 动词。
3. **两条可行的额度来源：**
   - **被动采集 `rate_limit_event`**：CLI 在订阅请求的响应头带有计划限额信息时发出这个 SDK 消息（百分比、窗口类型、重置时间）。Worker 现在直接丢弃它。改为记录后，零额外请求；能否在外部连接上收到，取决于网关是否透传这些响应头，需要实测（自然会话即可观察）。
   - **helper usage 动词（推荐的长期方案）**：在 `foundry.connection.v1` 增加可选的 `usage` 请求，由 helper 自己用它持有的凭据向自己的网关查询，再以统一结构回答。Foundry 不持有凭据、不访问端点。需要 helper/网关维护方实现（不在本仓库）。

推荐 Phase 2 范围：先做第 1 层 + 被动采集 `rate_limit_event`；同时在 `docs/external-connections.md` 定义 usage 动词并在 Foundry 侧按能力声明接入，helper 端由其维护方后续实现。

## 现有订阅用量看板

| 位置       | 代码                                                                                         | 说明                                                                                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话右侧栏 | `apps/web/src/features/chat/chat-account-usage.tsx`，挂在 `chat-context-card.tsx` 的“用量”段 | 只在 `accountUsageTarget()` 成立时显示：`connectionType === "local_login"`、无 `baseUrl`、设备来源、当前用户拥有该设备。外部连接被排除。结果 `authMode !== "subscription"` 时不渲染。 |
| 设备页     | `apps/web/src/features/devices/account-inspection.tsx`                                       | 账号检查结果，同样用 `AccountUsageWindows` 画窗口。                                                                                                                                   |
| 窗口组件   | `apps/web/src/components/account-usage-windows.tsx`                                          | 输入 `NativeAccountUsage[]`（`usedPercent`、`windowMinutes`、`resetsAt`），进度条 + 重置时间。                                                                                        |
| Server     | `POST /api/devices/{deviceId}/accounts/{runtime}/inspect`（`deviceOwner`）                   | 转给 Worker 的原生账号检查。                                                                                                                                                          |
| Worker     | `native-claude-quota.ts`、`native-inspection.ts`、`native-quota.ts`                          | Claude：不带 prompt 打开一个 SDK query，调用 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`（`get_usage` 控制请求）。Codex：app-server `account/rateLimits/read`。     |

刷新：60 秒 TTL；页面聚焦、回合完成时检查，手动刷新按钮；定时器只重算陈旧状态，不启动原生进程。状态：离线、失败、续期中、不支持、不可用、陈旧、可能是缓存快照。

## 数据源盘点

### a. Claude Agent SDK 每回合报告的内容（SDK 0.3.201）

| 来源                                                   | 内容                                                                                                                                                | 外部连接上是否可得                                                                                                                                                                                                               | Foundry 现状                                                                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `result` 消息：`usage`、`modelUsage`、`total_cost_usd` | 本回合 token（输入、缓存读/写、输出）、按模型拆分、Claude 标价估算                                                                                  | 是。与连接方式无关，是 CLI 本地统计                                                                                                                                                                                              | 已提取为 `metadata.turnUsage`（`turn-usage.ts`、`context-usage.ts`），历史会话可从原生日志回填（`session_usage.go`）     |
| `rate_limit_event`（`SDKRateLimitEvent`）              | `status`（allowed / allowed_warning / rejected）、`rateLimitType`（five_hour、seven_day、seven_day_opus…）、`utilization`、`resetsAt`、overage 状态 | 未验证。CLI 根据订阅请求的响应头生成；外部连接的凭据对 CLI 来说是订阅式凭据，所以只要网关透传这些响应头就会出现                                                                                                                  | 未处理：`sdk-messages.ts` 没有这个分支，事件被丢弃；原生 transcript 也不持久化它（已核对本机连接的 transcript 记录类型） |
| `get_usage` 控制请求                                   | 会话累计费用 + `subscription_type` + 计划限额窗口（`rate_limits_available`）                                                                        | 预计不可用：CLI 向 Claude 的计划用量接口查询，经 helper 代理；已安装的 helper 只为连接账号转发推理和启动设置请求。即使网关放行，返回的是上游账号的计划额度，网关可能多人共用一个上游账号，数字既不代表本人额度，也会暴露他人用量 | 只用于本地订阅登录                                                                                                       |
| 原生 transcript 的 `cost-state` 记录                   | 进程累计费用、按模型 token                                                                                                                          | 是                                                                                                                                                                                                                               | 不需要：与 `result` 重复                                                                                                 |

关于规则：`get_usage` 和 `rate_limit_event` 都不是推理请求，也都在 CLI 内部完成，Foundry 不接触凭据。但对外部连接周期性调用 `get_usage`，实质是借连接凭据去查询上游账号，接近“用存储的凭据探测 provider”，且结果误导，**不建议做**，除非网关明确声明支持。被动读取 CLI 已发出的 `rate_limit_event` 没有额外请求，没有这个问题。

### b. 外部连接 helper 协议

- `docs/external-connections.md` 的 `foundry.connection.v1` 只有准备/释放：Foundry 发一行请求，helper 回一行环境变量后常驻，stdin EOF 即释放。没有 usage、quota、capabilities 之类的请求。
- 已安装的 helper 只实现了上述协议，其管理接口只涉及密钥管理，没有用量或额度查询。所以 helper 侧的 usage 需要 helper 和其网关一起改。
- 这条路符合边界：helper 是连接自己的程序，持有并使用自己的凭据，Foundry 只拿到结构化结果。建议扩展（草案，Phase 2 写入协议文档）：

```json
// Foundry → helper（独立的一次性调用，stdin 一行，回复后 helper 退出）
{ "protocol": "foundry.connection.v1", "request": "usage", "runtime": "claude", "identity": "…" }
// helper → Foundry
{
  "protocol": "foundry.connection.v1",
  "identity": "…",
  "usage": {
    "observedAt": "2026-10-28T10:00:00Z",
    "scope": "connection",            // connection | account | shared_pool
    "plan": "team-default",           // 可选，展示用
    "windows": [
      { "id": "five_hour", "label": "5h", "usedPercent": 42, "windowMinutes": 300, "resetsAt": 1793120000 }
    ],
    "budget": { "unit": "usd", "used": 12.3, "limit": 50, "resetsAt": 1793200000 } // 可选
  }
}
```

helper 不支持时回 `{"error":{"code":"unsupported"}}` 或以约定退出码退出；Foundry 视为“不支持”。能力可在 `connection add --capability usage` 时登记，也可在首次调用时探测并缓存。超时 15 秒，回复上限沿用 256 KiB，stderr 不转发，响应不记日志。

### c. `/models` 目录与响应头

- `/models` 只返回模型目录，不含额度。外部连接本来也不发 `/models`（见协议文档）。
- 响应头只有 CLI 看得到；其中的计划限额信息正是 `rate_limit_event` 的来源（见 a），Foundry 不另读。

## 设计

### 看板显示什么

外部连接的会话，在右侧栏现有“用量”段显示一个块（与订阅同一位置、同一窗口组件），设备页的外部连接行显示同样内容的紧凑摘要。每个连接一块，不与本地订阅混排。

| 层                     | 内容                                                                                                                                                | 来源                                               | 何时有                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------- |
| Foundry 记账（始终）   | 近 5 小时 / 今日 / 近 7 天：回合数、输入（含缓存）/ 输出 token；估算费用标“按 Claude 标价估算，非网关计费”；口径说明“本设备上经 Foundry 发起的用量” | Server 聚合 `turnUsage`                            | 有过回合即有                  |
| 连接报告的额度（可选） | 百分比窗口 + 重置时间，复用 `AccountUsageWindows`；注明来源：“网关报告”或“最近一次响应”                                                             | helper usage 动词；否则最近一次 `rate_limit_event` | helper 支持或网关透传响应头时 |

状态（复用订阅看板的文案体系）：可用、暂无数据（还没有回合/观察）、不支持（helper 未声明 usage 且从未观察到限额事件）、陈旧（超过 TTL 或已过重置时间）、离线（设备未连接，仅影响 helper 查询，记账仍可显示）、失败。

### 数据流

1. **记账**：Server 新增查询，按 `agent_sessions.payload_json.profileId` + 设备聚合 `agent_session_events.metadata.turnUsage`。为避免会话中途换 profile 造成错算，Worker 今后在 `turnUsage` 上附带 `profileId` 和连接身份指纹（不是身份原文）；历史回合按会话的 profile 归属。
2. **被动额度**：Worker 处理 `rate_limit_event`，保留每个窗口最新的 `utilization`、`resetsAt`、`status`，随会话事件元数据（或单独的 daemon 消息）上报；Server 按（设备、profile、身份指纹）保存最近一次观察和观察时间。此改动对所有 Claude 会话生效，本地订阅也能顺带获得“最近一次响应”的新鲜度。
3. **helper usage**：新 daemon 请求 `read_connection_usage`（同 `inspect` 模式），Worker 以 `request: "usage"` 一次性启动 helper，校验 identity 与协议，裁剪为 `NativeAccountUsage[]` 后返回；Worker 声明能力 `external_connection_usage_v1`。
4. **Web**：`GET /api/devices/{deviceId}/connections/{profileId}/usage`（`deviceOwner`）返回 `{ accounting, observed?, reported?, status }`；`chat-account-usage-model.ts` 为外部连接构造目标，新组件与 `ChatAccountUsage` 共用标题、状态行和 `AccountUsageWindows`。

### 刷新节奏

- 记账：页面打开、聚焦、回合完成时重算，60 秒 TTL；只是 DB 查询。
- helper usage：打开/聚焦/手动，60 秒 TTL，不设定时器；单次 15 秒上限，失败退避同订阅看板。
- `rate_limit_event`：被动，随回合到达；超过重置时间即标陈旧。

### 隐私

- 仅设备所有者可见（`deviceOwner`），与订阅看板一致；外部连接本身就是设备所有者的私有配置。
- 共享设备上，其他成员用这个连接跑的回合计入总量（只有数字，无会话明细）；所有者看到的是“这个连接被消耗了多少”。如需只看本人，可加筛选，见未决决策。
- 不显示 identity 原文、凭据、端点或网关内部信息；helper 回复中的 `plan`、`label` 截断到 160 字符，与现有 `native-quota.ts` 一致。
- 只支持 Claude 外部连接（与现状一致）。

## 未决决策

1. **Phase 2 范围**：推荐“记账 + 被动 `rate_limit_event` + 协议扩展与 Foundry 侧接入”；helper 端实现交给其维护方。也可只做记账。
2. **是否显示估算费用**：它是 Claude 标价，不等于网关计费，可能误导。推荐 token 为主，费用作次要信息并标“估算”；或干脆不显示。
3. **窗口**：5 小时 / 今日 / 7 天是否合适，还是跟随网关自己的窗口。
4. **共享设备归属**：总量包含其他成员的回合（推荐，并注明），还是只算本人。
5. **helper/网关负责人**：谁负责确认网关是否透传计划限额响应头、是否有按密钥的用量接口、并实现 usage 动词。
6. **验证方式**：被动观察 `rate_limit_event` 只需要自然会话；如需立即确认，可对外部连接做一次显式 Check（一次简短 SDK 对话，消耗少量额度），是否允许。
