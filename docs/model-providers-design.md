# Model providers：模型来源的唯一入口

状态：P1 已部署（DEV-116）；2026-11-04 本人纠正模型后，P2 按本文实现中。实现与验证流水见 [DEV-116](devlog/DEV-116-model-access-connectors.md)。

## 问题

“对话能用哪些模型”的配置散在三处：Model providers 页（服务端 API）、每台设备的 Models 子标签（订阅登录、本机配置、默认模型），以及 Connectors 页（Limen 这类提供模型的连接器）。同一件事要去三个地方做，订阅还得一台台设备进去授权。

P1 曾把订阅做成内置的连接器（`claude-code`、`codex` 目录条目）。2026-11-04 本人指出这不对：订阅就是 model provider，没有 connector 的性质。Connector 是 Agent 干活时以人的身份**用**的外部服务和工具（工具在会话的 PATH 上、Workspace 绑定、不能用的会话要隔离）；订阅回答的是 Agent **跑在什么模型上**，和服务端 API 是同一类东西，只是凭据在设备上。两者共用的只是“在设备上跑 CLI 登录”的机制。

## 原则

1. **Model providers 是对话能用到的所有模型来源的唯一页面。** 官方订阅、服务端 API、设备上发现的本机 API、连接器提供的启动环境，都在这一页看。设备页不再承担模型来源的配置。
2. **页面专门面向业界标准的来源。** 官方订阅（Claude、ChatGPT）和 Anthropic / OpenAI 兼容的 API 端点在这一页管理（登录、验证、设默认、提升）。第三方连接器（如 Limen）提供的模型以“启动环境”出现在这一页，但它的登录与设置留在 Connectors。
3. **不为任何工具写特化逻辑。** 页面按数据模型（下文）取数据，代码里不出现具体连接器的名字。
4. **登录机制只有一套实现。** 设备上运行 CLI 登录、读状态、登出的代码共用；它是底层能力，不是“connector”，界面和文案也不这样称呼订阅。
5. **凭据在哪只是一个属性**（在 Server / 在各台设备），用一行说明表示，不再用它切分页面。
6. **“本机已登录”和“已验证可用”分开显示。** 验证始终是一次显式的短对话，经官方 agent 发起（`packages/worker/src/session/provider-check.ts`：Claude Agent SDK `query()`、Codex app-server），从不自动发起，也从不直接调用 `/v1/messages`、`/responses` 等推理接口。
7. **出口在设备。** 登录和换取 token 都由设备上的 CLI 完成，用设备的出口 IP；授权页在人自己的浏览器里打开；Server 只转达链接和码，从不访问 Anthropic 或 OpenAI。

## 数据模型

每个模型来源 = **runtime × access × launch layers**。它是 Web 的视图派生（`apps/web/src/lib/model-provider-shape.ts`），从 profile 投影的 `connectionType`、`origin`、`connector` 只读推出，不存储、不经任何接口传输：

```
ModelProviderShape {
  runtime: "claude" | "codex"
  access:  { kind: "official_login" }
         | { kind: "endpoint", protocol: "anthropic" | "openai", baseUrl?, credential: "server" | "device" }
         | { kind: "environment" }      // 端点与凭据全部来自启动层
  layers:  LaunchLayer[]                // 有序
}
LaunchLayer {
  source:   { kind: "connector", connectorKind, label } | { kind: "device_config" }
  provides: ("endpoint" | "credential" | "proxy" | "certificates" | "telemetry")[]
}
```

派生规则（不点名工具）：`local_login` → `official_login`；`anthropic_compatible` / `openai_compatible` → `endpoint`（协议按连接类型，Server 上的为 `server` 凭据，否则 `device`）；`external` → `environment` 加一个连接器层（来自行的 `connector`，没有则 `device_config`），提供 `endpoint`、`credential`；`env`、`custom_command` 没有 shape。

例子：

| 来源                  | shape                                     |
| --------------------- | ----------------------------------------- |
| Claude subscription   | claude × official_login × []              |
| hell-tw（服务端 API） | claude × endpoint(anthropic, server) × [] |
| Limen · default       | claude × environment × [Limen 连接器层]   |
| 以后：订阅 + 代理     | claude × official_login × [proxy 层]      |
| 以后：Codex 经网关    | codex × environment × [网关连接器层]      |

分期：现在只有一层，没有 Codex 的启动环境（扩展的模型接入只服务 Claude）；以后支持叠加多层、Codex 白名单，并把连接类型 `external` 改名。

## 页面结构（P2）

```
Model providers                                        [+ Add provider ▾]
对话能用的所有模型：你各台设备上的官方登录、存在这台 Server 上的 API，以及连接器提供的启动环境。
[ All runtimes | Claude | Codex ]   [ All devices ▾ ]

设备上的登录 ─────────────────────────────────────────────────────
 (C) Claude subscription · 凭据在各台设备     3/7 台已登录 · 1 已验证  [ ⌄ ]
 (X) ChatGPT subscription · 凭据在各台设备    1/7 台已登录            [ ⌄ ]

服务端 API ───────────────────────────────────────────────────────
 (C) hell-tw · https://beta.example · claude-opus-5-5
     凭据在 Server · 分配给 4 台                 Configured   [Assign…] [⋯]

启动环境 ─────────────────────────────────────────────────────────
 (C) Limen · default · 来自 Limen 连接器 · 4 台               在 Connectors 管理 ↗

在设备上发现 ─────────────────────────────────────────────────────
 (C) CC Relay · https://relay.example · 来自 macbook 的配置
     已提升为 relay ↗                                                 [⋯]
 (X) …       · 来自 byte-dev 的配置                      [Promote to server]
```

每一行固定组成：runtime 图标、名称、一行元信息（runtime · 凭据在哪 · 默认模型或来源），右侧依次是状态摘要、主操作、展开箭头。展开后是平铺的子列表，不在卡片里套卡片，一台设备一行：

```
 (C) Claude subscription                       3/7 台已登录 · 1 已验证 [ ⌃ ]
     sg-chaos          已验证 · 10-26 检查                  [Verify] [⋯]
     macbook           本机已登录 · 未验证                   [Verify] [⋯]
     cottoncpp         未登录                                [Sign in]
     limen-canada      离线 · 上次读取 3 小时前              （操作禁用，附原因）
```

- 服务端 API 展开后列出分配给哪些设备、每台设备的检查结果；“Assign…”打开设备多选对话框。
- 启动环境只读：按设备列出连接器给出的 profile 与状态，登录、加入另一个 profile、移除都在 Connectors 里做。
- 设备筛选选中某台设备时，所有分组只显示这台设备的行（原设备页 Models 标签的全部用途）。

## 关键交互

| 场景              | 交互                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 登录订阅          | 设备行的 “Sign in”：Claude 给出链接，人批准后把页面上的码粘贴回来（`claude auth login --claudeai`）；ChatGPT 给出链接和一次性码（`codex login --device-auth`）。完成后该行显示“本机已登录 · 未验证”和 “Verify”。 |
| 登出              | 设备行菜单 “Sign out” 运行 CLI 自己的登出（`claude auth logout` / `codex logout`），先确认。                                                                                                                     |
| 验证              | “Verify” 先说明会消耗一次额度，再经官方 agent 发起一次短对话，结果写进这一行；进行中 busy，失败给出原因和“重试”。                                                                                                |
| 新增来源          | “+ Add provider”：**API 端点**（现有表单）。启动环境来自连接器，在 Connectors 里添加。                                                                                                                           |
| 提升              | “在设备上发现”的行点 “Promote to server”，打开预填的 API 表单；提升后这一行移到“服务端 API”，原处只留“已提升为 …”。                                                                                              |
| 默认模型和 effort | 设备行菜单的 “Defaults…”，按“设备 × 来源”分别保存，取代设备页的 “Account & defaults”。                                                                                                                           |
| 新建服务端 API    | 保持现在的显式分配：新建时不自动分配给任何设备。                                                                                                                                                                 |
| 离线设备          | 显示最后一次读取的状态加“离线”，操作禁用并说明原因，上线后自动刷新。                                                                                                                                             |
| 窄屏              | 设备行的操作换到下一行，展开箭头保持可见；hover、focus 不改变布局。                                                                                                                                              |

## 其他页面

- **设备页**：去掉 Models & accounts 里的 Official accounts / Model providers 子标签，换成只读摘要（“这台设备可用的模型：……”）加 “在 Model providers 管理 →”，链接打开已筛选到这台设备的 Model providers 页。系统、Worker、资源、技能不变。
- **Connectors 页**：只放给会话用的工具与服务（飞书、Cloudflare、AWS、GitHub，以及扩展提供的连接器）。订阅不再出现。Limen 这类提供启动环境的连接器仍在这里登录与设置，页面上注明它给出的模型在 Model providers 里可见。
- **对话里的模型选择器**：按同样的分组排列，只列这台设备可用的；不可用的显示原因和“去设置”。选择器只负责选。

## 数据与后端

1. **订阅是设备账号，不是连接器目录条目。** 连接器目录只有飞书、Cloudflare、AWS、GitHub；扩展的模型接入只服务 Claude（`connectors/catalog.go`）。订阅的登录走设备账号的接口（`httpapi/native_sign_in.go`），和连接器的登录接口同形，Web 用同一套登录流程：
   - `POST /api/devices/{deviceId}/accounts/{runtime}/sign-in` `{requestId}`：开始；同一个 `requestId` 返回同一个正在进行的登录。回答 `NativeSignInStep`（`status`、`operationId`、`verificationUrl`、`userCode`、`codeEntry`、`expiresAt`、`error`）。
   - `…/sign-in/poll` `{operationId}`、`…/sign-in/code` `{operationId, code}`、`…/sign-in/dismiss` `{operationId}`：回答同样的 step。
   - `…/sign-out`：运行 CLI 的登出，回答 `{}`。
   - 设备消息 `native_sign_in` / `native_sign_in_reply`（`contracts/models/profiles.yaml` 的 `NativeSignInRequestPayload` / `NativeSignInReplyPayload`）。登录完成或登出后，回答带上设备的新注册，本机登录立刻刷新。
2. **Worker**（`packages/worker/src/harness/native/native-sign-in.ts`）：用 Worker 自己找到的 CLI（`native-cli.ts`，含 ChatGPT 应用里的 Codex），清空 API key 与端点变量（`nativeLoginEnvironment`），`BROWSER=true` 不在设备上开浏览器；失败只返回 CLI 的最后一句话，不含页面地址、state 或码；Claude Code 拒绝不完整的码时结束这次登录并返回它的原话；每个 runtime 同时只有一个登录，sign-in 进程的 pid 记在 `native-sign-ins.json`，下一次登录或 daemon 启动时结束上一个 Worker 留下的。登录写进 Worker 会话实际用的那份配置（Worker 服务环境里的 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`，未设置即默认目录）。
3. **页面读实时投影**：Model providers 页读 Workspace 的实时投影（`agentProfiles`、`providerHealth`、`devices`、`profiles`、`deviceProfiles`），不另设聚合接口。设备在登录或登出后重新报告，投影随之推送更新。分组：设备上的登录（`local_login` 行）、服务端 API、启动环境（连接类型 `external` 的行）、在设备上发现（没有连接器的设备端点行）。
4. **设备重新报告**：本机登录变化（登录、登出、安装，或检查读到不同的结果）会让设备在下一次心跳重新报告 profile（`nativeLoginRevision`）。

## 经 Agent 管理（DEV-151）

人可以让自己的 Agent（主要是助理）代为管理模型来源。Foundry 工具与页面跑同一段代码（`httpapi/profiles.go`、`profile_checks.go`、`agent_profiles_http.go`、`native_sign_in.go`），工具层（`httpapi/mcp_model_providers.go`）只决定谁能调用和回答的形状：

| 工具                    | 对应页面操作                                                      |
| ----------------------- | ----------------------------------------------------------------- |
| `list_model_providers`  | 四类来源及其设备、状态、默认值与检查（分页，最多 50）             |
| `save_model_provider`   | API 端点的新建 / 编辑、密钥、默认模型与 effort、分配给哪些设备    |
| `delete_model_provider` | 删除 API 端点及其密钥                                             |
| `check_model_provider`  | Verify：API 端点与启动环境经设备的官方 SDK 短对话；订阅读登录状态 |
| `set_model_defaults`    | 订阅、启动环境在某台设备上的 Defaults…                            |
| `sign_in_subscription`  | 设备行的 Sign in：设备 CLI 登录，Agent 只转交链接与码             |

- **谁能用**：本人自己的对话和助理（会话创建者即本人；Issue 的执行与澄清、它们派出的会话、verifier、命名等工具会话都不行），只作用于本人拥有的 API 端点和设备。另一个成员的会话以那个成员的身份行事，看不到也改不了。
- **密钥**：只经 `save_model_provider` 的 `apiKey` 传入，封存在页面使用的同一处（`agent-profile:<id>`），回答只有 `keySet`。Worker 记录工具调用的各处（会话事件及其 metadata、审批卡、Foundry 自己的 SDK 日志、子代理与原生对话的读取）按字段名脱敏。
- **API 端点的检查**：Server 把定义和解封的密钥像 `run_session` 一样交给设备（`check_agent_profile`，Worker 声明 `profile_check` 才发），设备用 Claude Agent SDK / Codex 跑一回合；结果按“端点 × 设备”存在 Server（表 `profile_checks`），出现在投影行的 `check` 上，改端点、模型、密钥或取消分配即清除。Web 在端点编辑器的设备行上显示并提供 Verify（`POST /api/profiles/{id}/check`）。
- **范围**：模型来源只按设备分配，没有按 Workspace 生效的设置（Workspace 选用哪个账号由“默认智能体”决定）。提升、登出、移除启动环境仍只在页面上做。

## 分期

| 期  | 内容                                                                                                                                                              | 时机              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| P1  | 订阅登录（曾以连接器目录条目的形式，已纠正）与一个聚合接口（P2 撤掉，页面改读实时投影）                                                                           | 已部署（DEV-116） |
| P2  | 订阅改为设备账号的登录接口；Model providers 页按本文和数据模型重做（订阅、API 端点与设备上发现、启动环境）；设备页“模型与账号”改为只读摘要；Connectors 不再有订阅 | 已实现（DEV-116） |
| P3  | 对话里的模型选择器按同样的分组排列；多层启动环境、Codex 白名单、`external` 改名                                                                                   | P2 验收后         |
