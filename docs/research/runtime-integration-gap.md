# 原生 Agent 运行时：现状与改造边界

日期：2026-10-16。代码基线：`69d5834`。本文是代码核对后的设计分析，不代表已经实现新的运行时或完成端到端验收。

## 结论与对上一版方案的修正

Foundry **已经封装了 Codex 和 Claude**，并且有统一执行入口、输入身份、控制接口、原生会话恢复、运行状态、事件转换、可靠传输和服务端队列。不是一个需要从零补齐运行时层的系统。

上一版方案将已有机制和新增能力混在一起，也把“网络连接中断”和“Worker 进程退出”混在一起，夸大了差距。应该保留现有会话模型和模块职责。真正需要新增或补强的部分是：

1. Codex 通过原生 app-server 实现活动 turn 的控制。
2. 将当前分散的运行时差异收束为明确的能力及控制契约。
3. 补强控制命令的接受语义、投递结果不确定状态和重启后的核对。
4. 如果要求更新 Worker 时任务不中断，再单独建设可重连的独立执行进程；这不是 steer 的前置条件。

## 逐模块对照

以下路径相对仓库根目录，均以代码为依据。

| 能力                | 现有实现                                                                                                                            | 实际差距                                                                                        | 建议                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 统一运行入口        | `packages/worker/src/session/workspace.ts` 的 `runWorkspaceSession`；统一传入 workspace、session、profile、emit、原生 ID 回报和沙箱 | 入口已经统一，但具体控制对象和能力仍分散                                                        | 保留入口，逐步收束运行时控制契约，不新增平行执行入口                                         |
| Codex / Claude 封装 | `runner/codex-turn.ts`、`codex-thread.ts`、`codex-stream.ts`；`claude-turn.ts`、`claude-runtime-start.ts`、`claude-messages.ts`     | Codex 走 SDK 流式执行，当前路径未接活动 turn 的 steer                                           | 在 Codex 适配器内迁移到 app-server，Claude 继续走原生 SDK                                    |
| 产品会话与输入      | `packages/protocol/src/session.ts` 的 `SessionInput`；`apps/server/internal/sqlitestore/session_input.go`；生命周期消息带 `inputId` | 输入已是独立派发单位，不缺第二套“执行输入”对象                                                  | 保留稳定的 Foundry session/input 身份；确有重复尝试需求时再增加 attempt 标识                 |
| 原生会话恢复        | `packages/worker/src/native-session.ts` 的 `runOnNativeSession`、`decideNativeSession`                                              | 已支持 resume、缺失记录和拒绝恢复时的显式重建；不是没有恢复设计                                 | 复用策略，验证 app-server 恢复旧线程的兼容性；重建仍须记录原因，不伪称原生续跑               |
| Steer / Cancel      | `packages/worker/src/session-control.ts`；Claude 的 `runner/claude-turn-controls.ts`                                                | 公共控制注册表已经有；Codex 在 `daemon/session-execution.ts` 明确拒绝 steer，沙箱路径也排除了它 | 扩展控制实现、目标 turn 身份和能力声明；覆盖普通会话及沙箱 host 转发                         |
| 服务端排队          | `apps/server/internal/httpapi/chat_queue.go` 及 `internal/sqlitestore/chat_queue*.go`                                               | 已持久化队列、修订冲突及发送状态；不是浏览器临时队列                                            | 保留一份服务端队列，不在新运行器再造业务队列                                                 |
| 运行去重与归属      | `packages/worker/src/session-state.ts` 的 `SessionExecutionRegistry`；设备连接报告活动执行                                          | 已按 session/input 去重；注册表及最近完成集合驻留进程内                                         | 补强跨进程接管时的代次和核对，而不是宣称完全没有执行所有权                                   |
| 网络断线重传        | `packages/worker/src/transport.ts` 的 `ReliableSessionTransport`                                                                    | 已有 ACK、重传、退避、背压和服务端去重；待确认 outbox 是内存 Map                                | 同进程重连机制继续使用；若要跨进程恢复，才增加持久 outbox 与确认游标                         |
| 事件与产物          | `sdk-messages.ts`、`context-usage.ts`、`turn-usage.ts`、`session-files.ts`；原生消息日志和完成标记                                  | 已有事件映射与落盘，但原生日志不等于可重放的传输 outbox                                         | 增加 app-server 到既有产品事件的映射；不要把原生 RPC 类型传播到前端                          |
| 进程治理            | `agent-processes.ts`、`agent-process-host.ts`、`process-group.ts`                                                                   | 当前刻意保证 Agent 随 Worker 退出；重启不是无损接管                                             | 此策略用于防孤儿进程是合理的；若要求不中断升级，需要新的独立执行生命周期，不能只删除清理逻辑 |
| 独立执行 host       | `session/workspace.ts`、`session/host-child.ts` 已为沙箱执行建立子进程和控制转发                                                    | 有执行 host，但仍从属于 Worker 生命周期，不能当作已有可接管守护服务                             | 以现有 host 为基础评估独立化，不必先规定增加一个全局 supervisor 服务                         |
| 运行时后台工作      | `session-state.ts` 的 `ActiveClaudeContinuation`、后台任务和定时器跟踪                                                              | Foundry 输入、原生模型轮次、后台续跑不是严格一对一                                              | 新接口必须保留这些语义，不能为了对齐 Codex turn 简化掉 Claude 的后台工作                     |
| 模型与窗口          | `native-inspection.ts`、`published-codex-models.ts`、`context-window.ts`、`runner/codex-options.ts`                                 | 已分目录与配置解析；最新公布目录、客户端支持、账号可用性仍需区别；官方账号窗口编辑 UI 尚未补齐  | 单独交付模型设置；运行时实报不能被期望值覆盖，不依赖 app-server 大迁移                       |

## 哪些边界需要调整

### 运行时能力散落在 provider 分支中

`daemon/session-execution.ts` 注册 Codex 不支持 steer 的处理，`session/workspace.ts` 又在沙箱路径排除 Codex steer。它们在现有 SDK 限制下有依据，但接入 app-server 后不能继续把所有 Codex 固定当作不支持。

应由活动运行实例给出能力，例如 `steer`、`interrupt`、`resume`、附件类型与实际配置。上层消费能力，不猜测 provider 名称。无需为了两个运行时建设通用插件框架，也不要求二者暴露完全相同的底层接口。

### 控制命令的“接受”不能夸大成“已经影响模型”

Claude 当前向 `AsyncInputQueue` 写入内容，然后记录 `Steered into active turn`；这足以说明输入交给了本地输入队列，不足以证明模型已读取并执行。Codex app-server 的 `turn/steer` 确认也只应按原生协议承诺解释。

`steerActiveSessionOnce` 已按 session/steer ID 去重，拒绝后可重试，但集合是内存态。控制成功后确认丢失、进程重启或淘汰去重记录，仍可能存在不确定窗口。需要明确“本地接受 / 原生确认 / 拒绝 / 结果未知”，而不是承诺没有原生协议支撑的恰好一次投递。

目标轮次应绑定 native thread/turn 与当前执行身份。轮次已经结束时不能假装 steer 成功；是否转为下一轮应服从既有队列操作或用户明确选择。

### 当前生命周期有产品限制，但不是随意写坏的设计

断开 WebSocket 时，运行注册表和传输 outbox 保持在 Worker 内，任务可以继续。Worker 进程退出时，`agent-processes.ts` 会终止所管 Agent，后继 Worker 也会清理失主进程。这是在没有可接管执行协议时避免双写和孤儿执行的保护。

所以“更新连接进程不能打断任务”是一个新增产品保证，不能靠 `detached: true`、改 systemd KillMode 或取消清理实现。

若要实现，应先补本机执行 host 的认证控制通道、状态查询、事件持久化、归属代次、凭据更新、取消与回收，然后允许连接进程重连它。必须考虑 Claude 后台任务、Issue 沙箱、资源租约、宿主退出及两个 Worker 同时接管的情况。保留 Server 的业务调度权，不新增第二个业务调度器。

## 建议分成两个独立改造

### A：Codex 原生控制接入（中等规模）

- 保留 `runWorkspaceSession`、`SessionInput`、服务端队列、权限、执行产物和公共控制入口。
- Codex 适配器通过原生 CLI 的 app-server 统一执行和控制，同一执行只有一个所有者。
- 不允许 SDK 执行、另启 app-server 控制同一原生线程；迁移期间可按执行选择实现，但运行中不静默换路重跑。
- 映射文本、工具、文件、用量、错误与终态；对齐模型/profile、技能、MCP 和沙箱配置。
- 接入能力声明与 native turn 定位；测试晚到 steer、重复投递、附件、interrupt、旧会话 resume。
- 验证当前 CLI 版本协议。现有 `withCodexControl` 是短时目录/账号查询助手，不能未经生命周期和事件设计直接用作完整运行器。

这条路线不要求更改业务会话模型，也不要求先做无损升级。

### B：执行生命周期独立化（较大规模，独立验收）

- 从已有 execution host 和进程管理发展出可重连执行，而不是从零建立另一套运行平台。
- 将需跨重启保存的命令状态、执行归属和 outbox 持久化；保留现有 ACK、去重和补传语义。
- 明确本机 IPC 权限、账号与执行隔离，不能把进程分离当成多租户安全边界。
- 管理器升级先 drain；不能同时接管同一 native thread。旧事件和旧代次控制须被拒绝。
- 核心验收是 Worker 更新/崩溃/重连时不断任务、不重复工具执行、事件可追溯、显式取消可回收完整进程树。

A 和 B 可以共享契约，但不应捆成一个巨型迁移。更换 Codex 传输接口不自动解决 B，也不应以 B 延迟已有模型目录和窗口修复。

## 发布快照与验证

发布功能快照为 `69d5834`，225 个文件；本分析是之后的独立文档改动。

- `scripts/check-changed.sh` 覆盖协议构建/测试、Web 类型检查与 559 个测试、Worker 构建及选定测试、数据库及 Server 包测试、UI/契约/模块审计。
- 初次检查有两项非通过：研究文档格式问题已经修正并复查；`evidence-api-e2e.test.mjs` 在整批运行时超出 90 秒，单独通过隔离 launcher 复跑约 8 秒通过。不能将初次整批结果描述为全绿。
- Web 生产构建通过；有产物体积提示。
- 本轮没有重新执行所有功能的真实浏览器验收，也没有重启正在执行任务的 Worker。代码推送不等于线上版本已生效。
- 尚未实现 app-server 执行迁移、运行时能力契约或执行生命周期独立化。
