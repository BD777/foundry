# Session 间协作（CHAT-01）：Agent 编排与设备侧鉴权

[项目 Roadmap](../README.md#roadmap) · [文档索引](README.md) ·
上游需求：[Chat 体验 · Session 间协作](chat-experience.md#session-collaboration)

状态：P0–P2 已交付（见第 9 节）。代码权威优先于本文，验收以测试为准。

## 1. 目标

让一个 Foundry Chat 中的 Agent（编排者，Orchestrator）能够像人一样管理其他
Session：发现本设备可用的 Profile、创建专项 Session、读取上下文、steer、
取消、观察完成状态，并让被创建的 Session 在会话列表中自然成组。Session 是
一等公民：被创建出来之后独立存续，编排者消失不连带终止它们。

运行形态：Foundry Server 部署在某处（本机或公网主机），Device 上运行
Worker Daemon，Agent 在 Device 上执行。Agent 操作 Server 读写接口时必须携带
**由 Server 在派发时签发、经 Daemon 转交的会话级凭据**；Server 据此知道
“是谁在操作”，再按同 Workspace 与血缘关系授权。

### 不做

- 不做 Issue 多 Agent 协作；子 Session 默认运行在 Workspace 根目录，只有
  显式传 `issueId` 时才进入该 Issue 的候选 worktree，并与 Issue 执行器在同一沙箱中
  运行（`issue-sessions.ts`，见[模块化架构 §5.4](architecture-modules.md) 5b）；会话令牌
  随之进入沙箱，子会话可以继续编排。
- 不做配额计费；HTTP MCP 的 OAuth 2.1 尚未实现（见第 9 节）。
- 不隐式转移血缘；Parent 取消不级联。

## 2. 代码位置

| 关注点                         | 位置                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `foundry` CLI / stdio MCP      | `packages/worker/src/foundry-cli.ts`、`foundry-mcp.ts`、`foundry-client.ts`                           |
| 会话身份环境变量               | `packages/worker/src/session-ambient.ts`、`profiles.ts` `sessionEnvironment()`                        |
| 内置 Skill                     | `apps/server/internal/builtinskills/foundry/`（随包同一份：`packages/worker/skills/foundry/`）        |
| Actor 与鉴权中间件             | `apps/server/internal/httpapi/actor.go`、`security.go`                                                |
| Policy                         | `apps/server/internal/httpapi/policy.go`                                                              |
| HTTP MCP                       | `apps/server/internal/httpapi/mcp.go`                                                                 |
| 会话令牌                       | `apps/server/internal/sqlitestore/session_tokens.go`                                                  |
| 血缘、自动入组、深度与并发上限 | `apps/server/internal/sqlitestore/session_lineage.go`                                                 |
| 会话生命周期接口               | `apps/server/internal/httpapi/routes.go`（`/api/agent-sessions…`、`/api/chats…`、`/api/chat-layout`） |

分组是 **workspace 级、单层、revision-CAS 的一份 layout 文档**
（`store/chat_layout.go`、`sqlitestore/chat_layout.go`）：
`{groups:[{id,name}], positions:[{chatId,groupId}], revision}`，空 `groupId`
表示未分组。

## 3. 总体形态

一个分发工件，两个使用面，一份 Skill：

```text
@bd777/foundry-worker（随 daemon 安装天然到达每台 Device）
├── bin foundry-worker …… 运维命令（setup/connect/install-service …）
└── bin foundry        …… 人与 Agent 的统一入口
    ├── foundry mcp                 stdio 桥，转发 Server 的 /api/mcp
    ├── foundry session <verb>      人 / 脚本用 CLI：每个命令调用一个 MCP 工具，打印它的回答
    ├── foundry issue list / get
    ├── foundry workspace list / device list
    ├── foundry profile list / model list
    └── foundry skill [name]        打印 / 安装随包 Skill（foundry，含 references/）
```

- **会话如何拿到工具（2026-09-26 起）**：Session Runtime 在启动持有会话令牌的
  Claude 会话（Chat、编排子会话；命名等工具性会话除外）时，把 Server 的 HTTP
  MCP（`POST /api/mcp`，`Authorization: Bearer <会话令牌>`）注册为 `foundry`
  MCP，并预先放行 `mcp__foundry`：这些能力由 Foundry 授予、由 Server 按令牌
  逐次授权，无人值守的会话没有人去点"允许"。每轮派发都会重铸令牌；新进程在第一轮
  之前、复用的长驻运行时在每轮开始前，都用 SDK 的 `setMcpServers` 经输入流拿到本轮
  令牌（2026-10-12 起），令牌不进 `--mcp-config` 参数，也不进 Claude 的环境变量，
  Claude 运行的命令看不到它；MCP 配置不进运行时复用的身份，所以不会因为令牌变化而
  丢掉长驻运行时。
- **Codex 会话（2026-09-27 起）**：同一个 HTTP MCP 以 Codex 配置注入
  （`mcp_servers.foundry.url`，通过 SDK 的 `config`），令牌由 Codex
  从自己的环境变量 `FOUNDRY_SESSION_TOKEN` 读取（`bearer_token_env_var`），不进配置和
  命令行；`default_tools_approval_mode = "approve"` 对应 Claude 的预先放行。Codex 运行的
  命令看不到这个变量（2026-10-12 起）：`shell_environment_policy.exclude` 排除它，并关掉
  `features.shell_snapshot`——快照把整个环境（包括被排除的变量）写进 `CODEX_HOME` 下
  每条命令都会 source 的文件。令牌跟会话走，复用的 Codex 线程拿着的旧令牌在会话活跃时
  同样有效。Codex 不能 steer 进行中的一轮，消息排到下一轮。
- 工具目录与实现只有一份：`apps/server/internal/httpapi/mcp_tools.json` 带完整
  的参数类型定义，与实现它的处理函数（`mcp.go`）放在一起。stdio 的
  `foundry mcp`（2026-09-26 起）只是转发桥：把每行 JSON-RPC 原样 POST 到 Server 的
  `/api/mcp` 并写回回复，不含任何工具定义或策略，供在 Foundry 之外手动配置的客户端
  使用。`foundry` CLI 的每个命令也只调用这些工具（2026-10-11 起），不再有 REST
  实现；CLI 不加进会话的 PATH，会话用 MCP 工具。
- stdio 桥 **无状态、不监听端口**；凭据来自会话令牌环境变量，没有令牌时用本机
  配对的设备凭据（此时补上配置的 `FOUNDRY_WORKSPACE_ID`）。会话里运行的命令
  （设置了 `FOUNDRY_SESSION_ID`）不回退到设备凭据：那会以设备主人的身份越过会话的
  范围；会话用自己的 Foundry 工具。

### 身份环境变量

Worker 启动 Session 时统一注入（Claude SDK、Codex、custom-command 三条执行
路径都经 `sessionEnvironment()`；Claude 的环境去掉令牌，Codex 不把它传给命令）：

| 变量                     | 内容                                              |
| ------------------------ | ------------------------------------------------- |
| `FOUNDRY_SERVER_URL`     | Server 地址（本机栈或公网 https）                 |
| `FOUNDRY_SESSION_ID`     | 当前 Agent 自己的 Foundry session id              |
| `FOUNDRY_SESSION_SOURCE` | `chat` / `agent` / `naming` / …                   |
| `FOUNDRY_WORKSPACE_ID`   | 当前 Workspace id（`FOUNDRY_WORKSPACE` 仍为路径） |
| `FOUNDRY_SESSION_TOKEN`  | 会话级 Bearer 令牌，仅内存；Agent 的命令看不到    |

## 4. 鉴权与授权

### 4.1 Actor 与凭据种类

| 凭据                     | Actor                                             | 权限                                                            |
| ------------------------ | ------------------------------------------------- | --------------------------------------------------------------- |
| 浏览器登录会话（cookie） | `account`                                         | 按账号的 Workspace 角色（见[账号与权限](security.md#accounts)） |
| 设备凭证                 | `daemon`（`deviceId` + 设备所属账号）             | daemon 通道；本机 `foundry` CLI 无 token 时以此身份代理         |
| **session token**        | `agent`（`sessionId`、`workspaceId`、`deviceId`） | 窄权限，见 4.3                                                  |

`agent` actor 只能访问 `agentRouteAllowed()` 列出的端点，其余直接 403。
所有写路径从 request context 取 actor，人和设备的会话按账号归属授权。

### 4.2 Session token 生命周期

- 表 `session_tokens`：`token_hash PRIMARY KEY, session_id, created_at,
last_used_at, expires_at`（`session_id` 有索引）；只存 SHA-256，明文只在内存
  （`sqlitestore/session_tokens.go`）。
- **每次派发铸造**：派发 `run_session` 前调用 `MintAgentSessionToken(sessionID)`
  （`crypto/rand` 256-bit），明文放入 payload 的 `sessionToken`。首次投递、
  后续每条输入、断线重投都会铸造新令牌；**旧令牌不吊销**，因为复用的长驻
  运行时（Codex 线程的环境）仍拿着先前的令牌。从未投递的 queued 会话没有令牌。
- **有效期（2026-10-12 起）**：会话处于 queued / running / blocked 时其令牌都有效
  （一轮可以几小时不调用工具）；否则令牌在最后一次使用（或铸造）后 24 小时失效。
  这样终态会话里还活着的 Claude 进程（被定时器或后台任务留住）只要在用工具就不断，
  被复制出会话的令牌很快作废。Server 派发的定时器轮次随派发铸造新令牌；Claude 进程
  自己触发的定时器轮次在开始时（`UserPromptSubmit`）由设备向
  `POST /api/daemon/sessions/{id}/session-tokens` 要一个新令牌，经 `setMcpServers`
  交给进程。会话被删除（`chat_deletions`）后其令牌不再解析。
- 防御性 `expires_at`（30 天）上限；失效行在解析时删除。
- Worker 不持久化该令牌：Claude 经输入流拿到，Codex 经自己的环境变量，只有
  custom-command 把它作为环境变量交给命令。
- Worker 记住它拿到的令牌和设备凭据的明文，在会话事件、最终回答和原生会话记录里
  替换成 `[REDACTED]`，同时去掉常见的密钥形状（`secret-redaction.ts`）。
- 令牌只接受 `Authorization: Bearer` 头；唯一例外是 SSE `GET /api/events`
  允许 `access_token` query 参数（EventSource 无法设置头）。
- 无效/过期 → 401。MCP 工具里，不可达的会话与不存在的会话一样回答 not found，
  不可达的 workspace 回答 `workspace not found`；可读但不可控制的会话（Viewer、
  Issue 外的会话）回答 403 并说明原因。

### 4.3 Agent Policy（§5.6 方案 A，2026-09-28 确认）

Agent 代表启动它的人：可达范围 = 这个人所在的全部 Workspace，角色封顶 Member。
判定只在 `access.go` 的 `agentScope` 一处；选方案 B 只改这一个函数。

| 操作                                              | 规则                                                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `list_workspaces`                                 | 列出可达 Workspace 及角色                                                                                                     |
| `create_session` / `handoff_session`              | 默认 caller 的 workspace（handoff：来源的）；可指定可达 workspace（需 Member），跑在该 workspace 的设备上                     |
| `list_sessions` / `list_group_sessions`           | 默认 caller 的 workspace；可指定可达 workspace（需 Viewer）                                                                   |
| `read_context` / `send_message` / `cancel` / 改名 | 读：可达 Workspace 内的任意会话（需 Viewer）；控制（含 handoff 的来源）：只限这个人创建的会话（含其 agent 启动的），需 Member |
| `list_profiles` / `list_models`                   | 默认本设备；可指定承载可达 workspace 的设备                                                                                   |
| SSE `/api/events`                                 | agent actor 按单个 workspace 过滤（默认自己的，可指定可达的）                                                                 |

跨 workspace 的子会话保留血缘（深度、扇出上限照算），但不进入父会话的编排分组
（分组布局按 workspace 存）。不可达的 workspace 一律 404，不泄露存在性。

REST `POST /api/agent-sessions` 对会话令牌执行与 MCP 相同的可达范围：拒绝
`nativeSessionId`；`chatId` 只能接管新会话所在 workspace（需 Member）里的原生会话，
未归属 workspace 的原生会话对令牌不可见。对所有调用方：`agentId` 只在请求所在
workspace 内解析（store 层 `getAgent`），按原生会话 id 续接只认同一 workspace 的会话，
fork 在来源会话的 workspace 运行并在那里检查 Member。

血缘只作记录（界面归属、深度与扇出上限），不是权限来源；adopt / 监管机制已删除。
这样 `handoff_session` 之后的接替者、同一对话的后续输入都能继续管理之前派出的会话。
人（account / daemon actor）对会话的读取与控制按 Workspace 角色判定：成员可控制
自己创建的会话，Maintainer 可控制任意会话。Agent 的控制不超过它代表的人作为 Member
能做的（2026-10-12 起，D1）：只控制这个人创建的会话，子会话继承父会话的创建者，所以
包括这个人的 agent 启动的全部会话；`handoff_session` 的来源同样要可控制。读取不受影响。
没有创建者的旧会话的 agent 只控制同样没有创建者的会话。

## 5. 血缘与自动入组

### 5.1 数据模型

- `agent_sessions.parent_session_id`（带索引），在 payload JSON 中以
  `AgentSession.parentSessionId` 暴露。
- `source = "agent"`：由 Session（携带 session token）创建的子 Session 一律
  落 `agent`；浏览器创建的仍是 `chat`；只读 verifier 为 `verification`。
- 一个会话就是一行，续聊是给同一会话发新输入（[会话模型](session-model.md)）；
  `parentSessionId` 指向派出它的会话。
- 派生深度上限 4，每个 parent 最多 8 个活动子会话。

### 5.2 创建事务

`POST /api/agent-sessions` 接受可选 `parentSessionId`。Store 单个事务内完成：

1. parent 存在、可见、与解析出的 workspace 相同；否则 400/404。
   agent actor 调用时 workspace 强制取 actor workspace，parent 必须在其中。
2. 创建 queued session 行，写 `parent_session_id`。
3. 同事务改写该 workspace 的 chat layout（服务端权威，内部 revision+1，
   不走 expectedRevision CAS，避免与浏览器抢 409）：
   - parent 已在某组：child 以 position 追加到该组末尾；
   - parent 未分组（包括没有 position 记录）：新建一个组，parent 与 child
     一起放入，组内顺序 parent 在前。
4. layout 校验沿用 `ValidateChatLayout` 的不变量（组 id 唯一、position 引用
   合法、限额）。

### 5.3 自动组命名

创建时先用确定性规则命名，保证快且可重放（`autoGroupBaseName`）：

1. 取 parent 当前 title，去除首尾空白与前导符号；
2. 按宽度截断（预算 24，汉字计 2，即约 12 个汉字或 24 个拉丁字符）；
3. 结果为空或为占位标题（`New chat` / `新聊天` 等）时退化为「新建分组」；
4. workspace 内重名追加「 2」「 3」。

随后 naming service 异步生成 AI 组名；失败时静默保留规则名。

### 5.4 孤儿与接手

- Parent 取消/失败不影响 children：token 不连带吊销，不级联 cancel。
- 新编排者用 `list_group_sessions` / `list_sessions` 找到会话，读完上下文即可
  直接接手：同 Workspace 内无需额外授权。

## 6. MCP 工具面

工具目录与描述在 `apps/server/internal/httpapi/mcp_tools.json`，实现在 `mcp.go`、
`mcp_sessions.go`、`mcp_inspect.go`、`mcp_outputs.go`（会话产出）、`mcp_issues.go`
（Issue 只读）、`mcp_attachments.go`（交给子会话的文件）、`mcp_verification.go`。
不改变任何东西的工具在目录里带 MCP 的 `annotations.readOnlyHint`。描述写明可达范围（可达 Workspace，控制需
Member 且只限这个人的会话；Issue 内只限该 Issue）、共享目录下并发写的竞争、子会话数与
深度上限、其他设备读不到调用方的文件、Codex 活动 turn
不支持 steer（语义为下一轮排队）。

**按角色列出工具**：`tools/list` 只列调用方可调用的工具，`tools/call` 同样拒绝
列表外的工具。Issue 澄清会话只有 `list_sessions`、`read_context`（与 Worker 的
`session-roles.ts` 一致）；verifier 只有标了 `readOnlyHint` 的工具；`ask_person`
只给 Issue 执行会话；其余会话和设备凭据得到其余全部工具。

**会话参数**：作用于会话的工具都用 `sessionId`，接受 id、Foundry 链接或已被会话
接管的原生会话 id；读不到的会话与不存在的一样回答 not found。改名保留旧参数名作
别名：`handoff_session` 的 `fromSessionId`、`send_message` 的 `message`（现为
`prompt`，与 `create_session` 一致）。

| 工具                  | 行为                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_workspaces`     | 可达 Workspace 及调用方角色；设备不再服务的标 `unavailable`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `list_resources`      | 可达设备、是否在线、提供的资源（浏览器、macOS 屏幕控制）及其上的可达 Workspace                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `list_profiles`       | 默认调用会话所在设备；可指定承载可达 workspace 的设备                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `list_models`         | 某 profile 的模型目录（兼容端点只读 `/models`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `create_session`      | 默认 caller 的 workspace；可指定可达 workspace（需 Member）；血缘父会话取自身；同 workspace 不指定 profile 与 runtime 时沿用父会话 profile，跨 workspace 只沿用 runtime；可选 `issueId`、`forkSessionId`、`verification`（见下文 verifier）、`attachments`（见下文）、`wait`。不再接受未写入目录的 `nativeSessionId`（无调用方；它可绕过读权限 fork 或接管原生会话）                                                                                                                                                                                                                                                          |
| `handoff_session`     | 只带事实（原始目标、最后结果、状态）开新会话；会话令牌调用时来源须是可控制的会话（D1），其他调用方为任一可读会话；默认在来源的 workspace，可选 `workspaceId`（需 Member）；不指定 profile 时同设备沿用来源 profile，否则只沿用 runtime                                                                                                                                                                                                                                                                                                                                                                                        |
| `list_sessions`       | 一行一个会话的精简摘要（id、title、status、runtime、profile、device、workspaceId、parentSessionId、activityAt 等），按活动时间倒序；`limit`（默认 30，至多 100）+ `cursor` 翻页；`parentOnly`（自己派出的）与 `parentSessionId`（任一可读会话派出的，默认在该会话的 workspace）在 SQL 中先于 limit 过滤；不含 naming 会话                                                                                                                                                                                                                                                                                                     |
| `list_group_sessions` | 一个编排分组按列表顺序的同样精简摘要（组内原生会话标 `kind: native_chat`）；接手编排用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `get_session`         | 与 `read_context` scope=summary 相同的紧凑摘要（`mcp_inspect.go`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `read_context`        | `scope=summary\|events\|thread\|transcript\|subagents\|changes\|file\|background`；`events` 每行一事件，`levels`/`labels`/`query` 过滤，`tail`/`limit` 与 `after`/`before` 游标翻页，`maxBytes` 内整行截断。会话产出（与 Web 上下文面板同一来源与可达规则）：`changes` 按路径合并 worker 的 sessionFile 账本（变更类型、增删行数、轮次），带 `path` 时从设备读该文件的 diff（`inputId` 限一轮）并在服务端生成 unified diff（`internal/textdiff`）；`file` 读文件当前内容；`background` 列后台任务，带 `taskId` 读输出末尾（需 Member）。工具写的文件与 workspace 内文件 Viewer 可读，仅被回答提到的 workspace 外文件需 Member |
| `list_issues`         | 一个 workspace 的 Issue，一行一个：状态、合同状态与已确认修订号、最新执行状态、等待人回答的问题种类、必需标准通过数；可按 `status` 过滤；Issue 内的会话只看到该 Issue                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `get_issue`           | 一个可读 Issue：请求、已确认合同（无则草稿）及每条标准在该修订上的最新验证结论、待确认的新草稿、等待中的问题、验证汇总与最新 review 是否可接受、最新执行（会话 id、状态、错误）。只读                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `send_message`        | 运行中则 steer；空闲则作为下一条输入继续同一原生会话，可切换 runtime；Issue 自己的执行与澄清会话除外；可选 `attachments`、`wait`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `cancel_session`      | 不级联；会话仍可继续                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `wait_session`        | 服务端每 1.5 秒查一次状态直到 `until`（默认终态）或 `timeoutMs`（至多 600000）；结束时带回回答                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `rename_session`      | 可控制的会话，1–120 字符                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ask_person`          | 仅 Issue 执行会话：向人提问或请求许可，Issue 等待回答后在同一候选中恢复                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

工具只在服务端实现一次，会话经注入的 HTTP MCP 调用；stdio 桥只转发（有会话令牌时
不改参数，用设备凭据时补上配置的 `FOUNDRY_WORKSPACE_ID`）。人用的 CLI 同样只是
这些工具的客户端：`foundry-cli-commands.ts` 的命令表写明每个命令调用哪个工具、位置
参数和每个 flag 设哪个参数，CLI 按表调用 `/api/mcp` 并打印工具的回答；`session wait`
在 `--timeout-ms` 超过一次调用的 10 分钟时接着再等。

**交给子会话的文件**（`attachments`，`create_session` 与 `send_message`）：调用方
会话自己 workspace 目录里的路径（绝对或相对），或它收到过的附件 id（`att_…`）。
Server 经 daemon 通道从调用方设备分块读出（worker 能力 `attachment_files`：
`attachment_read` 带 `scope:"workspace"`，worker 解析链接后要求仍在 workspace 内），
写进目标会话所在 workspace 设备的 `.foundry/attachments`（与人上传附件同一写入
路径），作为这条输入的附件交付，所以另一台设备上的会话也能读到。每条至多 10 个、
单个 25 MB；需要会话令牌。

**Verifier**（`verification:true`）：独立核查者，可以读 workspace、运行只读命令
（测试、lint、类型检查、git status/diff），但改不了 workspace。约束在操作系统层面：
worker（能力 `verification_sessions`；旧 worker 所在设备上的 verifier 被拒绝并提示
更新）用 `writable_tree` 沙箱（Linux bubblewrap / macOS Seatbelt）运行整个 agent
进程，workspace 只读挂载，唯一可写的是 workspace 外的私有 scratch（agent 的 HOME、
原生会话记录和 `$TMPDIR`，`$TMPDIR` 每轮开始清空，一周未用的 verifier 目录删除）；
用户自己的文件可读（跑项目自己的工具链）。运行时一层的限制叠加其上：Claude 为
`dontAsk`，预先放行 Read/Grep/Glob/Bash/Skill、foundry 工具以及
Write/Edit、Task/Agent、WebFetch/WebSearch 等（2026-10-12 起，D3：写只会落在 scratch，
不再禁用写工具与子 agent，也不再限制每条消息的轮数）；Codex 不再套自己的
沙箱（`danger-full-access`，同 Issue 执行）：它的 `workspace-write` 要在 workspace
里为 `.git`/`.agents`/`.codex` 建挂载点，在只读 workspace 里建不了，macOS 也不允许
嵌套沙箱；命令只能写 `$TMPDIR` 由外层沙箱保证。Server 存下的会话记录就是实际运行的
设置（2026-10-12 起）：Claude `dontAsk`，Codex `danger-full-access` + `never`，不再把
Codex 记成 `read-only`。
Claude Agent SDK 的 `sandbox` 选项只隔离 Bash、Linux 上还依赖 socat，因此没有采用。
Foundry 工具只有只读的那些，device notes 换成 verifier 自己的说明（只写事实：workspace
只读、`$TMPDIR` 可写、只读的 Foundry 工具）。

内置 `foundry` Skill（`builtinskills/foundry/`）随每个派发的会话交付，是唯一入口。
它只讲能力和事实，不讲流程（2026-10-12 起，revision 4）：SKILL.md 讲会话是谁、代表谁、
可达范围与可控制的会话、启动会话的代价（设备槽位、模型用量、对话列表、可能是别人的设备；
是否启动由 agent 自己决定，D2）、工具描述里看不到的事实（共享目录与写竞争、会话只知道
brief 和附件、其他设备读不到你的文件、8 个活跃子会话与 4 层的上限、cancel 不级联、
verifier 的只读沙箱）；`references/diagnosing.md` 只解释错误和状态的含义，按需读取。
每个工具怎么用写在工具描述里，Skill 不再重复。CLI 只一句话提到是给人用的。
`packages/worker/test/foundry-skill.test.mjs` 保证 Skill 只写存在的工具和参数（枚举值
也核对）、不写 CLI 命令，并保证 CLI 命令表里每个命令调用的工具、参数都在
目录中，且除 `ask_person` 外每个工具都有命令。

## 7. 端到端流程

```text
① Browser/Parent ──POST /api/agent-sessions + 登录会话 / Bearer(session token)──▶ Server
② Server 事务：建 queued 行（parent_session_id, source=agent）+ layout 自动入组
③ dispatch：铸造 session token（哈希入库），run_session.payload.sessionToken 下发
④ Worker 执行：注入 FOUNDRY_SERVER_URL/SESSION_ID/WORKSPACE_ID/SESSION_TOKEN
⑤ 子 Agent 经注入的 foundry MCP（或 stdio 桥）以 Bearer 调用 /api/mcp
⑥ Server 鉴权中间件：token → Actor → agentRouteAllowed + Policy → 既有 handler
⑦ SSE 回推 agent_session_*；wait_session 据此唤醒编排者
⑧ 终态事务：状态落库 + 删除 token；children 不受影响
```

## 8. 验收场景

1. 未分组 Session 创建子 Session：自动建组，两者同组、parent 在前；浏览器
   刷新后分组关系保留。
2. 已分组 Session 创建子 Session：复用当前组，child 排在组末。
3. 运行中的子 Session 收到 steer 后后续执行受影响（Claude 活动 turn；
   Codex 记录为下一轮语义）。
4. 页面/列表刷新后，血缘、分组、消息均保留。
5. Parent cancel：children 继续运行到终态（孤儿不级联）。
6. 无 token / 坏 token → 401；血缘不是权限：可达 Workspace（Member）内的任意
   会话可读；可 steer/cancel/改名的只有同一个人创建的会话（D1，其他人的会话 403
   并说明原因）；只读可达（Viewer）的会话可读不可控制（403 并说明原因）；不可达的会话或 workspace 与不存在的一样回答 not found。
7. Session 终态后其 token 立即失效；重新 dispatch 的 queued session 获得新
   token。
8. `list_profiles` 对 agent actor 只返回本设备 profile。
9. 执行环境中存在五个身份 `FOUNDRY_*` 变量；Claude SDK、Codex、
   custom-command 三条执行路径一致。
10. `foundry session list` 与 `foundry mcp` 的 tools/list 在已配对设备上可用；
    既无 session token 也无本机设备凭证时给出明确错误。

## 9. 分期与交付状态

- **P0（已交付）**：会话令牌与 Policy、血缘与自动入组、`foundry` CLI / stdio
  MCP、编排 Skill（现为内置 `foundry` Skill 的一部分）；第 8 节全部场景。
- **P1（已交付）**：worktree-backed 子 Session（`issueId`，在候选 worktree
  执行，校验 Issue 处于活动状态）；UI 血缘 badge；`blocked` 状态（模型限流
  等待时由 worker 上报、恢复时清除）；派生深度与活动子会话上限。显式
  `adopt` 已于 2026-09-27 随会话模型重构删除。
- **P2（已交付）**：服务端 HTTP MCP（`POST /api/mcp`）；`handoff_session`；
  verifier（`verification:true`；2026-10-11 起在只读沙箱里运行只读命令，见第 6 节）；
  session fork（`forkSessionId` 续接原生 transcript、开新 Foundry thread）；
  自动组 AI 异步命名。
- **未实现**：HTTP MCP OAuth 2.1（PKCE + Authorization Server Metadata +
  scoped tokens）；按 actor 限频。
