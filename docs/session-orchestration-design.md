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
| 随包 Skill                     | `packages/worker/skills/foundry-orchestrator/SKILL.md`                                                |
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
@foundry/worker（随 daemon 安装天然到达每台 Device）
├── bin foundry-worker …… 运维命令（setup/connect/install-service …）
└── bin foundry        …… 人与 Agent 的统一入口
    ├── foundry mcp                 stdio MCP server（Agent 主用）
    ├── foundry session <verb>      人 / 脚本用 CLI，默认 JSON 输出
    ├── foundry profile list
    └── foundry skill               打印 foundry-orchestrator SKILL.md
```

- **会话如何拿到工具（2026-09-26 起）**：Session Runtime 在启动持有会话令牌的
  Claude 会话（Chat、编排子会话；命名等工具性会话除外）时，把 Server 的 HTTP
  MCP（`POST /api/mcp`，`Authorization: Bearer <会话令牌>`）注册为 `foundry`
  MCP，并预先放行 `mcp__foundry`：这些能力由 Foundry 授予、由 Server 按令牌
  逐次授权，无人值守的会话没有人去点"允许"。每轮派发都会重铸令牌，复用的长驻
  运行时在每轮开始前用 SDK 的 `setMcpServers` 换上本轮令牌；MCP 配置不进运行时
  复用的身份，所以不会因为令牌变化而丢掉长驻运行时。Codex 会话尚未注入（待
  M2-2，本机 Codex 登录失效，无法实测）。
- 工具目录只有一份：`apps/server/internal/httpapi/mcp_tools.json`，带完整的
  参数类型定义，与实现它的处理函数放在一起。stdio 的 `foundry mcp` 目前仍是
  独立实现（多出 `list_models`、`handoff_session`），供在 Foundry 之外手动配置
  使用；M2-2 把它改为转发 Server 的目录与调用。
- stdio MCP **无状态、不监听端口**；凭据只从环境变量来（MCP 规范的本地
  stdio 模式）。

### 身份环境变量

Worker 启动 Session 时统一注入（Claude SDK、Codex、custom-command 三条执行
路径都经 `sessionEnvironment()`）：

| 变量                     | 内容                                              |
| ------------------------ | ------------------------------------------------- |
| `FOUNDRY_SERVER_URL`     | Server 地址（本机栈或公网 https）                 |
| `FOUNDRY_SESSION_ID`     | 当前 Agent 自己的 Foundry session id              |
| `FOUNDRY_SESSION_SOURCE` | `chat` / `agent` / `naming` / …                   |
| `FOUNDRY_WORKSPACE_ID`   | 当前 Workspace id（`FOUNDRY_WORKSPACE` 仍为路径） |
| `FOUNDRY_SESSION_TOKEN`  | 会话级 Bearer 令牌，仅内存                        |

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

- 表 `agent_session_tokens`：
  `session_id PRIMARY KEY, token_hash, created_at, last_used_at, expires_at`；
  明文只在内存。
- **dispatch 时铸造**：派发 `run_session` 前调用
  `MintAgentSessionToken(sessionID)`（`crypto/rand` 256-bit，存 SHA-256），
  明文放入 `run_session` payload 的 `sessionToken`。首次投递与断线重投都
  得到新令牌（重铸即吊销旧令牌），queued 但从未投递的 session 不产生有效
  令牌。
- Session 进入终态（completed/failed/canceled）时在保存状态的同一事务删除
  令牌行；会话被删除后令牌同样失效。
- 防御性 `expires_at`（30 天）；过期行在解析时删除。
- Worker 不持久化该令牌：只作为执行环境变量注入；MCP 子进程随会话生灭。
- 令牌只接受 `Authorization: Bearer` 头；唯一例外是 SSE `GET /api/events`
  允许 `access_token` query 参数（EventSource 无法设置头）。
- 无效/过期 → 401；身份有效但越权 → 403。

### 4.3 Agent Policy（同 Workspace 前提下）

| 操作                                            | 规则                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `create_session`                                | 目标 workspace 与 caller 相同，且只能在 caller 自己的设备上启动             |
| `list_sessions` / `list_group_sessions`         | 强制限定 caller 的 workspace                                                |
| `read_context`（session/thread/subagents/chat） | 目标是自己、自己的后代，或与自己**同组**的 Session                          |
| `steer` / `cancel`                              | 目标是自己、自己的后代，或由自己监管（adopt）的 Session；**不能动同组兄弟** |
| `rename`                                        | 仅限自己与自己的后代；Agent 不能写 layout                                   |
| `list_profiles` / `list_models`                 | 仅返回 caller 本设备的 profile                                              |
| SSE `/api/events`                               | agent actor 强制按 workspace 过滤                                           |

后代判定走 `parent_session_id` 的递归 CTE（`IsSessionDescendant`）；同组
判定查 chat layout 的 positions。人（account / daemon actor）对会话的读取与
控制按 Workspace 角色判定：成员可控制自己创建的会话，Maintainer 可控制任意
会话。

“列全组、读全组”放开，“控制”收窄到血缘：新编排者可以无耦合地通过
`list_group_sessions` + 读上下文接手了解情况，但不能操控别人派出的
Session，除非人在 Web 上把监管权交给它。

## 5. 血缘与自动入组

### 5.1 数据模型

- `agent_sessions.parent_session_id`（带索引），在 payload JSON 中以
  `AgentSession.parentSessionId` 暴露；监管者为 `supervisorSessionId`。
- `source = "agent"`：由 Session（携带 session token）创建的子 Session 一律
  落 `agent`；浏览器创建的仍是 `chat`；只读 verifier 为 `verification`。
- `threadId`（同一会话续聊）与 `parentSessionId`（编排血缘）正交，不复用。
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
- `list_group_sessions` 加同组读权限，让新编排者读完上下文即可接手。
- 显式 `adopt`（`POST /api/agent-sessions/{id}/adopt`）设置监管者字段，
  出生 parent 永不改；只有人能分配监管权（Web 行菜单「由当前会话接管」）。

## 6. MCP 工具面

工具描述中写明：写者唯一、并行写同一仓库的风险、上下文默认截断、Codex
活动 turn 不支持 steer（语义为下一轮排队）。

| 工具                  | 映射                                | 备注                                                                                                                                                   |
| --------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_profiles`       | `GET /api/agent-profiles`           | 按本 device 过滤                                                                                                                                       |
| `list_models`         | `POST /api/agent-profiles/models`   |                                                                                                                                                        |
| `create_session`      | `POST /api/agent-sessions`          | `parentSessionId` 默认取自身；不指定 profile 与 runtime 时沿用父会话的；可选 `issueId`、`forkSessionId`、`verification`、`wait?`（等到结束并带回回答） |
| `list_sessions`       | `GET /api/agent-sessions`           | 支持 `parentOnly`                                                                                                                                      |
| `list_group_sessions` | layout + session 列表               | 接手编排用                                                                                                                                             |
| `get_session`         | `GET /api/agent-sessions/{id}`      | 摘要档                                                                                                                                                 |
| `read_context`        | session / thread / chat / subagents | `scope=summary\|thread\|transcript`，`tail?`、`maxBytes?` 默认截断                                                                                     |
| `handoff_session`     | 创建新 Session 并交接事实           | 只带事实，不带污染上下文                                                                                                                               |
| `steer_session`       | `…/steer`                           |                                                                                                                                                        |
| `cancel_session`      | `…/cancel`                          | 不级联                                                                                                                                                 |
| `wait_session`        | SSE `/api/events` + 轮询兜底        | `until`、`timeoutMs`；结束时带回回答                                                                                                                   |
| `rename_session`      | `POST /api/chats/{id}/title`        | 自己/后代                                                                                                                                              |

人用 CLI 与这些工具共用同一客户端核心（`foundry-client.ts`），命令一一对应，
默认输出 JSON。HTTP MCP（`httpapi/mcp.go`）在服务端实现同一 Policy 下的
工具子集，不含 `list_models` 与 `handoff_session`。

## 7. 端到端流程

```text
① Browser/Parent ──POST /api/agent-sessions + 登录会话 / Bearer(session token)──▶ Server
② Server 事务：建 queued 行（parent_session_id, source=agent）+ layout 自动入组
③ dispatch：铸造 session token（哈希入库），run_session.payload.sessionToken 下发
④ Worker 执行：注入 FOUNDRY_SERVER_URL/SESSION_ID/WORKSPACE_ID/SESSION_TOKEN
⑤ 子 Agent 以 stdio 拉起 foundry mcp；MCP 仅从 env 取凭据，Bearer 调用
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
6. 无 token / 坏 token → 401；同 workspace 但操控非后代 Session 的
   steer/cancel → 403；跨 workspace 访问 → 403。
7. Session 终态后其 token 立即失效；重新 dispatch 的 queued session 获得新
   token。
8. `list_profiles` 对 agent actor 只返回本设备 profile。
9. 执行环境中存在五个身份 `FOUNDRY_*` 变量；Claude SDK、Codex、
   custom-command 三条执行路径一致。
10. `foundry session list` 与 `foundry mcp` 的 tools/list 在已配对设备上可用；
    既无 session token 也无本机设备凭证时给出明确错误。

## 9. 分期与交付状态

- **P0（已交付）**：会话令牌与 Policy、血缘与自动入组、`foundry` CLI / stdio
  MCP、`foundry-orchestrator` Skill；第 8 节全部场景。
- **P1（已交付）**：worktree-backed 子 Session（`issueId`，在候选 worktree
  执行，校验 Issue 处于活动状态）；UI 血缘 badge；`blocked` 状态（模型限流
  等待时由 worker 上报、恢复时清除）；派生深度与活动子会话上限；显式
  `adopt`。
- **P2（已交付）**：服务端 HTTP MCP（`POST /api/mcp`）；`handoff_session`；
  只读 verifier（`verification:true`，复用 naming 同构的 utility 限制）；
  session fork（`forkSessionId` 续接原生 transcript、开新 Foundry thread）；
  自动组 AI 异步命名。
- **未实现**：HTTP MCP OAuth 2.1（PKCE + Authorization Server Metadata +
  scoped tokens）；按 actor 限频。
