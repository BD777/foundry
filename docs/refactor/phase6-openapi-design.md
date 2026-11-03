# P2 设计：设备通道与浏览器 REST 迁到 OpenAPI 3.1

日期 2026-11-03。依据：`foundry-int`（origin/main `1d4bdcf3` + 已暂存改动，即已部署版本）的代码，[openapi-spike.md](openapi-spike.md)，[retrospective-cross-cutting.md](retrospective-cross-cutting.md) §1.5 C1–C4、B-15、B-21。

已定（本人决定，本文不再讨论）：OpenAPI 3.1 是唯一 IDL；Go 用生成的类型，含判别联合；设备 REST 与设备 WS 两端严格解码（拒绝未知字段）；Go 空数组编码为 `[]`；不兼容旧 Worker/Server（同批部署，Worker 先）；每个定义只有一个来源；优先用成熟工具，不自己造。

## 0. 结论

- 一套工具链：**OpenAPI 3.1 多文件源 → Redocly bundle → openapi-typescript（TS）+ oapi-codegen v2.8.2（Go，models）+ JSON Schema bundle（Ajv / santhosh-tekuri v6 校验）**。不用 AsyncAPI；WS 消息建模成 components 里两个按 `type` 判别的信封联合。
- oapi-codegen v2.8.2 原生支持 3.1（`codegen.go` 的 `is31`、kin-openapi v0.142，`type: [x, "null"]`），**不需要降级到 3.0**。判别联合生成 `As*/From*/Discriminator()/ValueByDiscriminator()`（`templates/union.tmpl`），但 `As*` 用的是普通 `json.Unmarshal`。所以 **"严格"靠 JSON Schema 校验（所有对象都设 `additionalProperties: false`），不靠 `DisallowUnknownFields`**。两种语言都按 `type` 取对应变体的 schema，只校验那一个变体。
- 顺序：先把工具链和证据换成原生联合（B-21）；再加录制线上流量的 fixture，测出漂移；然后依次迁共享 DTO、WS 类型（行为不变）、WS 严格解码、设备 REST、浏览器 REST 按领域、SSE 与词表，最后删 `audit-contract.mjs`。每步单独可部署，线上字节不变或规范等价，由录制的 fixture 证明。
- 量级：约 18–21 人日（≈4 周），超过复盘里"P2 2–3 周（含拆 httpapi）"的估计。阶段 7 另需 5–7 人日。可压缩的是 S5（见 §4）。

## 1. 现状清单

### 1.1 设备 WebSocket（C1）

| 项                  | 数量                                                                                                                                                                        | 定义方式                                                                                                     | 守护                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 消息类型名          | 139：Server→设备 65（Worker `dispatch.on` 65 处），设备→Server 74（`inboundHandlers` 73 + `reply_chunk`）                                                                   | TS `daemonMessageTypes`（`P/daemon-messages.ts`），Go `ws*Type` 常量（`S/httpapi/daemon_wire.go`），各写一份 | audit 检查 2：只比名字集合，不比方向                                                                                         |
| Server→设备 payload | 47 个 TS 接口 ↔ 46 个 `ws*` 结构 + `CreateAgentProfileInput`                                                                                                                | 两边手写                                                                                                     | audit 检查 4：只比 JSON 字段名，不比类型与可选性；`daemonPayloadKnownDrift` 豁免 1 项，`daemonPayloadsBuiltInline` 豁免 1 项 |
| 设备→Server payload | Go 有 61 个 `ws*` 结构**没有任何 TS 对应**（`wsFileReadPayload`、`wsSessionCompletedPayload`、`wsWorkspaceReadyPayload`…），其中 9 个在 protocol 里有同名类型但不在比对范围 | Worker 在 handler 里直接写对象字面量，`reply()` 的 payload 类型是 `unknown`                                  | **无**                                                                                                                       |
| 注册 payload        | `store.DaemonRegistration`，20 个字段，传递引用约 40 个类型                                                                                                                 | 只有 Go；TS 侧是推导出来的（`W/daemon/workspace-ops.ts:500`）                                                | 无                                                                                                                           |
| WS 传递闭包         | `ws*` 结构 112 个 + store 类型 181 个（其中约 50 个证据类型已经在 OpenAPI 里）                                                                                              | store 类型同时是持久化模型、REST DTO 和 WS DTO                                                               | store 类型靠检查 1（字段名）                                                                                                 |
| 解码                | Go：信封严格、payload 宽松（`request_validation.go:22-30`）；Worker：信封严格（`P/validation.ts`），payload 在 56 处直接 `envelope.payload as X`                            | —                                                                                                            | 没有运行时校验                                                                                                               |
| 上限                | TS 2 MiB，Go 96 MiB（`daemon_conn.go:316`）                                                                                                                                 | 不一致                                                                                                       | —                                                                                                                            |

### 1.2 设备 REST（C2）

- 携带设备凭证的路由 17 条：`/api/daemon/*` 10 条（含 `ws`），Cloudflare 2 条，飞书网关代理 5 条。另有公开路由 4 条（`pair`、`worker/release`、两个 `worker/packages`），WS 升级路由 1 条（`service-tunnels/{streamId}`）。
- 要建模的 JSON 接口 11 个：pair、attachment-previews、chats/sync、chats/running、chats/digests、session-work GET/POST、work-fire、session-tokens、cloudflare session-handle、worker/release。其余是二进制或代理，以 opaque 操作登记。
- Worker 侧用 `postJSON<T>/getJSON<T>`（7 处），直接 `as T`；Go 侧严格解码进匿名结构或 store 类型。没有共享类型。
- Worker 还调用 3 个浏览器路由：`/api/agent-sessions/{id}/conversation`、`/api/skills/catalog/.../package`、`/api/mcp`。MCP 有自己的 `mcp_tools.json`，不在本 P2 范围内。

### 1.3 浏览器 REST（C3）与 SSE（C4）

- `routes.go` 共 310 条注册，去掉设备侧后约 288 条浏览器/Agent 路由，其中 25 条也可由 Agent 调用（`agent(...)`）。按前缀：personal-agent 53、workspaces 40、devices 40、issues 27、agent-sessions 19、chats 15、skill-repositories 11……
- Go 侧：111 处 `decodeJSONRequest`（严格），67 个匿名请求结构，约 40 处 `map[string]any`/匿名响应，DTO 主要是 store 类型。
- TS 侧：protocol 共 404 个接口、184 个类型别名；审计覆盖其中 324 个（检查 1，按名字和字段名）。Web 在 `api/*.ts` 和 `api-types.ts` 里还有 45 个本地 DTO，不在审计内；约 28 个 protocol 导出没有使用方（B-14）。
- SSE：25 个事件名，Go 在 `browserevent/payloads.go`，TS 在 `browser-events.ts`。由检查 3（名字、payload 类型名、字段、notices、Go 字面量禁令）和 `browser-event-fixtures.json` 守护。
- 词表：会话事件与过程标签 51 个（检查 5），会话来源与活跃状态 11 个（检查 6）。能力字符串、错误码（`workspace_needs_git`、`database_busy`…）两边各写一份，**没有任何检查**。

## 2. 目标形态

### 2.1 文件布局（一个逻辑规范，多个源文件）

```
contracts/
  foundry.openapi.yaml       根：info、tags（= 领域）、paths 与 components 全部 $ref 到下面
  models/<domain>.yaml       共享 DTO：sessions chats devices workspaces profiles skills issues
                             evidence(由 evidence.openapi.yaml 迁入) connectors resources
                             personal-agent knowledge vocab(标签/来源/状态/能力/错误码)
  device/ws.yaml             ServerToDeviceMessage / DeviceToServerMessage 及各 payload
  device/rest.yaml           /api/daemon/*、/api/worker/*、cloudflare session-handle
  browser/<tag>.yaml         浏览器 paths，按领域拆
  browser/events.yaml        BrowserEvent 联合（SSE）
  fixtures/{ws,rest,events}/ 录制并脱敏的报文（现有 browser-event-fixtures 迁入）
  redocly.yaml               bundle 与 lint 规则
  oapi-codegen/*.yaml        每个 Go 目标一份配置
  oasdiff-severity.txt, oasdiff-err-ignore.txt
```

- 每个 `models/*.yaml` 本身是合法的 OpenAPI 文档（`paths: {}`），oapi-codegen 可以单独跑。跨文件引用用 **oapi-codegen `import-mapping`**（原生机制）：同一包内的文件映射为 `"-"`（`importMappingCurrentPackage`），`device/ws.yaml` 引用 models 时映射到 `store`。
- Go 生成目标：`models/*` → `apps/server/internal/store/*_gen.go`（沿用证据的先例，调用点仍写 `store.AgentSession`）；`device/*` → 新包 `internal/devicewire`；`browser/<tag>` 的请求和响应外壳在阶段 7 生成到各领域包。
- TS 生成目标：`redocly bundle` 产出一份临时 bundle，openapi-typescript 生成 `packages/protocol/src/contract.gen.ts`，用 `--root-types --root-types-no-schema-prefix`，沿用 `JSONValue` 的 transform 钩子。现有 `session.ts` 等文件只保留 `export type { … } from "./contract.gen.js"` 和纯函数，Web 和 Worker 的 import 不变。
- JSON Schema：从 bundle 转出一份 2020-12 文档，Go 用 `//go:embed`，TS 放在 `@bd777/foundry-protocol/validation` 子路径导出，只给 Worker 用，避免进 Web 包。原来两份 `evidence-schema.json` 由它取代。
- 生成脚本：`scripts/generate-contracts.mjs` 取代 `generate-evidence-models.mjs`，只做胶水，控制在 300 行以内：
  - 每个属性自动补 `x-order`；
  - 带 `x-stored` 的 schema 自动生成合成操作，喂给 oasdiff；
  - 子集枚举校验（`x-subset-of`）；
  - 给 Ajv 去掉 `discriminator.mapping`；
  - 调 gofmt / prettier；
  - `--check` 做两件事：确认生成文件不过期，对 `x-stored` 跑 oasdiff。
- Go 工具用 `go.mod` 的 `tool` 指令固定版本（go 1.24 已满足），不再 `go run …@v`。

### 2.2 WS 消息怎么建模：OpenAPI 判别联合，不用 AsyncAPI

- 每条消息是一个变体 schema：`{type: enum[<name>], id?, error?, payload: $ref}`，`additionalProperties: false`。两个方向各一个 `oneOf` + `discriminator: {propertyName: type, mapping}`。请求和回复的配对写在请求变体的 `x-reply: <ReplyVariant>` 里，只用于文档和覆盖测试。
- 不用 AsyncAPI 的理由：
  - 会多出第二套工具链。Modelina 生成的 Go/TS 成熟度远低于 oapi-codegen 和 openapi-typescript。
  - oasdiff 和 Redocly lint 都不支持 AsyncAPI。
  - WS 不需要 channel/binding 语义：一条 socket，信封固定。
- 不兼容旧版，所以 **WS 和 REST 不跑 oasdiff 阻断**。oasdiff 只用在 `x-stored` 的 schema 上（证据、落库的会话事件等 SQLite 里的 JSON），因为老数据仍会被新代码读。

| 侧        | 用法                                                                                                                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Go 入站   | 解码成生成的 `DeviceToServerMessage`，再 `ValueByDiscriminator()` + `switch v := v.(type)`，替换 `inboundHandlers` map 与 `answer[T]`。`reply_chunk` 拼装后重新进入同一路径                                                                                                           |
| Go 出站   | 直接 `json.Marshal` 具体变体（`devicewire.ReadFileMessage{Type: …, Payload: …}`）；`callDevice[Resp]` 的类型参数换成生成的回复 payload 类型                                                                                                                                           |
| TS Worker | `DaemonDispatch.on<T extends ServerToDeviceMessage["type"]>(type, (msg: Extract<…,{type:T}>) => …)`。`reply<T>` 的返回值约束为对应变体的 `payload`。删掉 56 处 `as X` 和 `daemonMessageTypes` 常量对象：字面量由编译器对照联合检查，`openapi-typescript --enum-values` 同时导出值数组 |

`wsEnvelope` 退化为只读 `type` 的预解析。联合用法有一条规定：只用 `ValueByDiscriminator`，不直接调用 `As*`（spike §3c：对错误变体调用 `As*` 不报错）。审计里加一条 grep 禁令。

### 2.3 Go 生成选项

| 选项 / 规则                                                                           | 作用                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate: models`，`skip-prune: true`，`name-normalizer: ToCamelCaseWithInitialisms` | 取代现在胶水里的 `goName`                                                                                                                                                                                                                                                                                                                                                                           |
| `prefer-skip-optional-pointer: true`                                                  | 可选标量生成 `string` + `omitempty`，与今天的 store 一致                                                                                                                                                                                                                                                                                                                                            |
| `x-go-type-skip-optional-pointer: false`                                              | 只给"缺省 ≠ 零值"的字段（证据里的 `MaxEvidenceAgeSeconds` 一类）保留指针                                                                                                                                                                                                                                                                                                                            |
| `prefer-skip-optional-pointer-on-container-types: true`                               | 可选的切片和 map 不加指针                                                                                                                                                                                                                                                                                                                                                                           |
| 枚举生成类型化常量 + `Valid()`                                                        | `x-enum-varnames` 沿用今天的键名（如 `userMessage`）。子集（活跃状态、回合结束标签、工具类会话来源）各自是一个枚举 schema，标 `x-subset-of`，由胶水校验确实是子集                                                                                                                                                                                                                                   |
| **空数组 `[]`**                                                                       | 必填数组的 nil 会编码成 `null`。spike §3a.1 已证明这会改变证据 digest。胶水给每个必填、非 nullable 的数组属性加 `x-go-type: jsonlist.List[T]`（约 10 行的泛型具名切片，`MarshalJSON` 把 nil 输出成 `[]`；`[]T` 可以直接赋值给它，`range`/`append` 照常用）。Go 测试对所有出站 fixture 跑 schema 校验兜底。等 `encoding/json/v2` 在工具链里稳定（它默认就把 nil 切片编码成 `[]`）后，可以删掉 `List` |
| 被移出的现有代码                                                                      | 胶水不再展平联合，`marshalEvidenceUnion` 删除（B-21）；store 闭包里只有 3 个 `json:"-"` 字段、3 个 `time.Time` 字段、少量方法，搬到同包手写文件里                                                                                                                                                                                                                                                   |

### 2.4 运行时严格校验

| 位置                                                             | 机制                                                                                                                                                                                                                                                                             | 失败时                                                                                                                                         |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Go WS 读循环（`daemon_conn.go:257` 之后、`handleEnvelope` 之前） | 按 `type` 取变体 schema，santhosh-tekuri v6 校验原始字节                                                                                                                                                                                                                         | 回 `error{code: invalid_message, 指出出错路径}`，算作"永久拒绝"：Worker 的发件箱丢弃该条并记一条 WorkerFailure，**不重发**，避免 outbox 死循环 |
| Go 设备 REST                                                     | 中间件按路由找到 operation，校验请求体，取代 `decodeJSONRequest` 里的 `DisallowUnknownFields`                                                                                                                                                                                    | 400 + 路径                                                                                                                                     |
| Worker WS（`transport.ts` 里 `parseProtocolEnvelope` 之后）      | Ajv 按 `type` 首次用到时编译该变体的校验器并缓存                                                                                                                                                                                                                                 | 对带 id 的请求回 `error`，让 Server 的 `rpc.reject` 立刻唤醒调用方                                                                             |
| Worker REST 响应                                                 | openapi-fetch 的 `onResponse` 中间件跑 Ajv                                                                                                                                                                                                                                       | 抛错                                                                                                                                           |
| 浏览器 REST                                                      | 请求：Server 端同一个中间件（今天已经严格）；响应：只在 Go 的 httpapi 测试里校验（记录器中间件 + kin-openapi router 查 operation + jsonschema v6）。Web 不做运行时校验，免得包变大                                                                                               | —                                                                                                                                              |
| 握手                                                             | `hello` 带 `contractDigest`（bundle 的 sha256，两边生成同一常量）。Server 先比较 digest，不一致就回 `error{code: contract_mismatch}` 并关闭；Worker 在状态里显示"Server 与 Worker 契约不同，需更新"，按现有退避重连。这不是兼容，只是让"Worker 先部署"的那段窗口出错时有明确原因 | —                                                                                                                                              |

开销：Go 侧校验要先把报文解码成 `any`，等于每条消息多解码一次。高频和大报文的类型有 `session_event`、`reply_chunk`（按拼装后整条校验）、`attachment_chunk_read`/`file_read`（约 1 MiB base64），`skills_scanned`（linux-dev 上约 620 KB，见 `daemon_conn.go` 的注释），以及注册时的 `hello`。用 S1 录制的数据加 `daemon_traffic.go` 的按类型统计做基准测试。预算是读循环 CPU 增加不超过 5%。超出时，只对超大字符串字段（`dataBase64`）关掉 `pattern`/`maxLength`，**不**对任何类型免校验。

### 2.5 取代 `audit-contract.mjs`

| 检查                        | 去向                                                                                                                                                                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 DTO 字段一致              | 两边都生成后就消失；每迁完一个文件，从 `tsDtoPaths`/`goDtoPaths` 里删掉。迁移 PR 期间，旧手写类型与生成类型之间放一个 tsc 双向可赋值检查（spike `assignability.ts` 的做法），合入后删除                                                                                                                   |
| 2 消息名、4 WS payload 一致 | S3a 后删除                                                                                                                                                                                                                                                                                                |
| 3 SSE                       | 名字和 payload 由 `BrowserEvent` 联合生成；Go 字面量禁令保留                                                                                                                                                                                                                                              |
| 5 标签、6 会话分类          | 改成 vocab 枚举 + `x-subset-of`；Go 字面量禁令保留                                                                                                                                                                                                                                                        |
| 剩下的字面量禁令            | 合成约 150 行的 `scripts/audit-wire-literals.mjs`，值从 bundle 读，另加"禁止直接调用联合 `As*`"一条                                                                                                                                                                                                       |
| 新增门禁                    | 生成文件 `--check`；Redocly lint（对象必须 `additionalProperties: false`，数字必须带 `format`，变体的 `type` 必须是单值枚举）；fixtures 在 Ajv 和 jsonschema v6 下结果相同；`x-stored` 的 oasdiff；覆盖测试：每个入站变体都有 case，每个出站变体在 Worker 都有 handler，`routeTable` 与 spec 操作一一对应 |

## 3. 迁移步骤

每步：同批部署（Worker 先），`scripts/check-changed.sh` 通过，dev 实测，devlog 记录。"线上不变"的证明统一用 S1 的 fixture：

- Server 发出的消息：旧编码与新编码**逐字节相同**。x-order 按今天 Go 的字段顺序写。
- Worker 发出的消息：分别用旧 Go 类型和新 Go 类型解码再编码，两者规范化 JSON（键排序后）相同，并且通过 schema 校验。
- 证据：`evidence-digest-fixtures.json` 的 digest 不变。

| 步                                                                                        | 范围                                                                                                                                                                                                                                                                                                                                                  | 删除的手写定义                                                                                                                                                         | 不变的证明                                                                                                             | 量级            |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------- |
| **S0 工具链 + 证据原生联合**                                                              | 建 `contracts/` 新布局、redocly、`generate-contracts.mjs`、go tool 指令、`jsonlist.List`；证据改用 oapi-codegen 联合，改写 12 个调用点。同时验证几项假设：import-mapping `"-"`、`x-go-type` 写泛型、`prefer-skip-optional-pointer` 能被单字段关掉、Redocly bundle 保留组件名、kin-openapi router 读 3.1                                               | 展平联合的胶水、`marshalEvidenceUnion`、两份 `evidence-schema.json`                                                                                                    | spike 的 24 条落库数据和 42 个往返用例逐字节相同；digest fixtures 不变                                                 | 2 天            |
| **S1 录制与漂移报告**                                                                     | dev 专用 `FOUNDRY_WIRE_RECORD_DIR`：在 Server 读写两侧把信封写成 JSONL；按键名正则脱敏（token/credential/apiKey/secret），超长字符串截断；跑 live-session、live-web 回归脚本，再浸泡 1 天。输出每个类型的覆盖情况，缺的类型从现有 Go/Worker 测试的假对端补齐。**用草拟的严格 schema 跑一遍，列出今天被宽松解码吞掉的未知字段**，逐条修掉或写进 schema | 无                                                                                                                                                                     | 覆盖 139/139；严格校验的违规数为 0，否则不能进入 S3b                                                                   | 1 天 + 1 天浸泡 |
| **S2 共享 DTO**（按领域 3 个 PR：会话/聊天，设备/工作区/profile/技能，Issue/连接器/资源） | WS 闭包里约 120 个非证据 store 类型，写进 `models/*.yaml`，生成到 `store` 和 protocol                                                                                                                                                                                                                                                                 | 对应的 store 结构和 protocol 接口（相关文件里的 `export interface`）；从审计的 `tsDtoPaths` 中移除                                                                     | fixtures 往返；httpapi 测试；`prompt/testdata/*.golden` 不变；迁移期 tsc 可赋值检查                                    | 3–4 天          |
| **S3a WS 类型生成**（行为不变，仍宽松）                                                   | `device/ws.yaml`：139 个变体、约 110 个 payload；`devicewire` 包；Go 用 type switch 分发；Worker 用类型化 `on`/`reply`                                                                                                                                                                                                                                | `daemon_wire.go` 里 107 个 `ws*` 结构和 139 个常量，`daemon-messages.ts` 的 48 个接口和常量对象，audit 检查 2、4，`daemon-message-contract.test.mjs` 对应部分          | Server 发出的 fixture 逐字节相同；Worker 发出的 fixture 规范化相同；覆盖测试                                           | 2.5–3 天        |
| **S3b WS 严格**                                                                           | 两端 schema 校验，`contractDigest` 握手，`invalid_message` 永久拒绝的语义，Worker 显示 WorkerFailure；统一消息上限（定一个值，C1）                                                                                                                                                                                                                    | `decodeWebSocketPayload` 的宽松分支                                                                                                                                    | S1 浸泡违规数为 0；故意加一个未知字段、删一个必填字段，两端都拒绝；Worker 先部署时窗口内出现明确的 `contract_mismatch` | 1.5 天          |
| **S4 设备 REST**                                                                          | `device/rest.yaml` 11 个 JSON 操作，二进制和代理用 opaque 登记；Worker 改用 openapi-fetch；Server 用校验中间件                                                                                                                                                                                                                                        | Worker 的 `postJSON<T>/getJSON<T>` 及其局部类型；Go 侧对应的匿名结构                                                                                                   | 录制的 REST fixture；worker 测试                                                                                       | 1 天            |
| **S5 浏览器 REST**（每个 tag 一个 PR，约 8–10 个）                                        | 约 288 个操作；请求体生成类型，替换 67 个匿名结构和约 40 个 map 响应；错误响应统一成 `Error{code: ErrorCode}`；Web 的 `api/*.ts` 改用 openapi-fetch（`apiFetch` 作为自定义 fetch 保留 cookie 和 401 处理）                                                                                                                                            | 45 个 Web 本地 DTO、约 28 个无人用的导出、审计检查 1 的剩余部分                                                                                                        | 测试中所有响应都通过 operation schema 校验；live-web-regression；`pnpm typecheck`                                      | 5–7 天          |
| **S6 SSE 与词表**                                                                         | `BrowserEvent` 联合；标签、过程标签、来源、状态、能力、错误码进 `vocab.yaml`（排在 P0 统一标签之后）                                                                                                                                                                                                                                                  | `browser-events.ts` 和 `browserevent/payloads.go` 的手写部分、`session_event_labels.go`/`session_classes.go` 的常量、audit 检查 3、5、6，最后删掉 `audit-contract.mjs` | fixtures 在两端都通过校验；Go 字面量禁令脚本仍然有效                                                                   | 1.5–2 天        |

**阶段 7（S5 之后）怎么接**：

- spec 的 tag 就是领域，也就是 Go 包。每个领域包放自己的 handler 和路由，加上从 `browser/<tag>.yaml` 生成的请求/响应外壳（`include-tags` + import-mapping 到 `store`）。
- `httpapi` 只留认证、`guard`、SSE hub、静态资源。设备 hub 和 `devicewire` 合成 `internal/devicelink`。
- 访问规则仍写在 Go 的 `routeTable` 里，以 operationId 为键；覆盖测试保证 spec 操作、路由和规则三者一一对应。
- oapi-codegen strict-server 先在 resources（4 条路由）上试点：它的中间件能拿到 `operationID`，正好用来取访问规则，还能省掉 writeJSON/decode 的样板。但它解码时不严格，所以前面仍要挂校验中间件。只有试点证明 handler 写起来不比今天差，才推广。
- 量级 5–7 天。

## 4. 风险

| 风险                                                                                                                                           | 影响 | 对策                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------ |
| 严格解码 + Worker 先部署：今天被宽松解码吞掉的漂移会直接变成设备掉线（`request_validation.go` 的注释记录过一次全部 Worker 掉线）               | 高   | S1 违规数为 0 才能做 S3b；`contractDigest` 让出错原因明确；部署 runbook 把 Worker 到 Server 的窗口压到分钟级             |
| 校验失败后 outbox 重发形成死循环                                                                                                               | 中   | `invalid_message` 作为永久拒绝，记 WorkerFailure，不重发                                                                 |
| 校验开销（多一次解码成 `any`，大报文）                                                                                                         | 中   | 用 S1 的数据做基准，按 §2.4 的预算；只按变体校验，不对 74 路 `oneOf` 整体求值                                            |
| nil 切片编码成 `null`（会改变证据 digest）                                                                                                     | 中   | 用 `jsonlist.List` 加出站 fixture 校验；Worker 严格校验会把这类问题当场暴露                                              |
| 生成类型带来的改动量：类型化枚举的赋值要转换，`ToCamelCaseWithInitialisms` 的命名与今天不同（如 `BaseURL`/`BaseUrl`），TS 的字面量联合比 Go 窄 | 中   | 每个领域一个 PR；命名不同的字段用 `x-go-name` 钉住；规则是 spec 写真实约束，TS 更窄时以枚举为准                          |
| oapi-codegen 的联合对错误变体调用 `As*` 不报错                                                                                                 | 低   | 只用 `ValueByDiscriminator`，审计里加 grep 禁令                                                                          |
| S0 列出的几项工具假设不成立（import-mapping `"-"`、`x-go-type` 写泛型、Redocly 保留组件名、kin-openapi 读 3.1）                                | 中   | 都在 S0 第一天验证。退路：单文件 bundle 生成单个 Go 包，用 `exclude-schemas` 分包；空数组改用出站校验兜底                |
| 规范体量（约 600 个 schema、约 300 个操作）手写容易出错                                                                                        | 中   | Redocly lint；S1 的 fixtures 都必须通过；迁移期可赋值检查                                                                |
| 工期超出复盘估计（约 4 周对 2–3 周）                                                                                                           | —    | 可以把 S5 降为"只做匿名结构、map 响应和 Web 本地 DTO，不写 paths"，省 2–3 天，但阶段 7 就失去由 operation 驱动的路由覆盖 |

不在本 P2 范围：MCP 工具 schema（`mcp_tools.json`）、连接器扩展协议（`connector-extensions.ts`）、飞书网关代理。它们以后可以 `$ref` 这份规范，但不阻塞本计划。
