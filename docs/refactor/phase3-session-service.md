# 阶段 3 设计：会话服务（工作底稿）

依据：[全景图](code-map.md) §4"创建并派发会话"、[附录：会话与运行时](code-map/sessions.md)。目标是"一种原语一处实现"：所有创建并派发会话的路径走同一个入口，差异显式化为选项；然后把它连同派发、发送、取消、事件观察者一起移出 `httpapi`。行为不变是硬约束。

## 现状：四条路径

| 路径                                                          | 调用方                                                                                                | 做了什么                                                                                                                                                                                                          | 和其他路径的差异                               |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| A `createAndDispatchWith`                                     | REST `POST /api/agent-sessions`、MCP `create_session`、聊天队列、飞书、定时工作、助理 inbox、助理派活 | 工作屏障 → 对账 → 归档拒绝 → 验证者设备检查 → 助理准入 → 创建 → 回报标记 → 助理任务记录 → `sessions.changed` + 聊天列表 → 被领养原生聊天的队列 → 分组命名 → `beforeDispatch` → `dispatchOrWait`（设备离线则等待） | 基准                                           |
| B 助理维护（`personal_agent_maintenance.go`）                 | 后台循环                                                                                              | 验证者设备检查 → `pickSessionDevice` → 创建（`ErrSessionInputExists` 视为已在跑）→ 绑定运行快照 → `sessions.changed` → `dispatchOrFail`（离线即失败）                                                             | 不做准入、不进聊天列表、离线失败、自己处理幂等 |
| C Workspace 摘要（`workspace_digests.go`）                    | 后台循环                                                                                              | `pickSessionDevice` → 创建（重复输入时按 `WorkRunInputSession` 找回）→ 绑定运行快照 → `sessions.changed` → `Claim`（失败则 `failUndelivered`）→ 派发                                                              | 同 B，另有派发前认领                           |
| D 命名任务（`sqlitestore/chat_titles.go`、`group_naming.go`） | 标题服务、分组命名                                                                                    | 在 store 事务里创建会话并写 `chat_titles` 行；派发由 `chat_title_service` 完成                                                                                                                                    | 创建在调用方事务内                             |

## 提案：一个入口，四个选项

```go
// Start creates a session and hands it to its device.
func (s *Sessions) Start(ctx context.Context, input store.CreateAgentSessionInput, opts StartOptions) (store.AgentSession, error)

type StartOptions struct {
	// Who starts it: Person/Agent (today's A) run the work barrier, the
	// archived-workspace refusal, assistant admission and announce the chat;
	// Background (B, C, D) skip admission and the chat-list announcement.
	Origin Origin
	// Device: Resolve (the input names its agent; 400 otherwise) or Fallback
	// (Feishu and background jobs take the workspace's first usable agent).
	Device DevicePick
	// Offline: Wait (queued until the device returns) or Fail.
	Offline OfflinePolicy
	// Existing: what an input id already taken means — an error (default),
	// or the session that took it (B, C), found by Resume.
	Existing func(ctx context.Context, inputID string) (store.AgentSession, bool)
	// BeforeDispatch runs once the store took the session (bind the run
	// snapshot, publish attachments, claim the digest); an error fails it.
	BeforeDispatch func(ctx context.Context, session store.AgentSession) error
}
```

D 保持在 store 事务内创建（它要和 `chat_titles` 行原子写入），只把派发改走 `Start` 的派发部分（`Sessions.Dispatch`）。

## 迁移步骤（每步单独合入，行为不变）

1. 在 `httpapi` 内引入 `StartOptions`，A 的现有行为作为 `Origin=Person` 的默认值；B、C 改走 `Start`。补测试：B 离线失败、C 认领失败时会话失败、两者都不进聊天列表、重复输入找回已有会话。
2. MCP 的 `createAndDispatchForMCP` 与 REST 的 `handleCreateAgentSession` 合并共同的解析（账号选择、设备解析、fork、Issue 限制），各自只保留协议差异。
3. 会话事件反应统一到观察者总线：`onSessionEvent` / `onSessionCompleted` 里内联调用的 Issue、助理运行控制、原生账号暂停等改为注册观察者。
4. `agentRouteAllowed` 由路由表推导（路由声明 `agent: true` 或会话令牌可达范围），删除手写的路径匹配。
5. 抽包：新建 `internal/sessions`，依赖以接口注入（store 子集、设备派发、通知、助理准入），参照 `workspacedigest` 的 `Sources` 模式；`httpapi` 只保留 HTTP/MCP 适配。

## 风险与验证

- 风险集中在第 1 步（后台会话的派发语义）和第 3 步（观察者顺序）。观察者顺序现在由 `server.go` 中的注册顺序决定，迁移时保持顺序并加测试锁定。
- 每步：相关包全量测试、`check-changed.sh`；第 1、3、5 步加 scratch 栈端到端（真实会话一轮 + 助理维护一次 + 摘要一次）。
