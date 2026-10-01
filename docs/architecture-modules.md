# 模块化架构与开发切分

[项目 Roadmap](../README.md#roadmap) · [文档索引](README.md) · [当前状态](current-status.md)

状态：设计，2026-09-25 确定方向。本文同时是**系统框架的模块划分**和**开发进度的切分依据**：
每个 milestone 交付一个模块的协议，并用一个真实使用方场景验收。现状描述基于 `0649fe7`
的源码阅读（code-evidence，路径已附），未重新运行服务。

## 1. 为什么要切

现在的问题不是某个模块写得不好，而是**切分维度错了**：代码按进程分层（web / server /
worker / protocol），不按领域分。每个功能都要纵穿四层，并经过同几个枢纽文件，于是
任何改动都牵连其他模块。

| 现象                         | 证据                                                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 同一原语多处实现：启动 Agent | Chat 走 `runner.ts`；Issue 执行走 `issue-executor.ts` → `issue-executor-child.ts`（复用 runner 但另起进程、另拼环境）；澄清与判定走 `evidence-agent.ts` `runEvidenceStageSession`（直接调 SDK、自拼 env、自拷凭据） |
| 同一原语多处实现：沙箱       | `execution-sandbox.ts`（候选写）、`evidence-agent-sandbox.ts`（阶段只读，仅 macOS）、`evidence-command-sandbox.ts`（检查命令，macOS + Linux）、`evidence-http-service.ts`（受控服务，仅 macOS）                     |
| 同一概念两套记录             | Server 有 `Run`（Issue 执行，`store/models.go`）与 `AgentSession`（Chat/编排）两套执行记录；daemon 消息也分 `run_issue/run_event/issue_completed` 与 `run_session/session_*` 两条管线                               |
| 枢纽文件                     | `daemon_ws.go` 1896 行、`daemon-connection.ts` 1927 行、`runner.ts` 1753 行；`httpapi/` 平铺 74 个文件；daemon 消息约 60 种类型共用一个无命名空间的词表（`protocol/src/daemon-messages.ts`）                        |
| 上层概念渗入下层             | 沙箱按 evidence 阶段命名和分支；session 需要认识 `issueId`；平台判断散落在 `evidence-acceptance.ts:38` 等调用处                                                                                                     |

直接后果（此前讨论中已确认）：

- **Orchestrator 进不了 Issue**：会话令牌与 foundry MCP 只随 `AgentSession` 注入
  （`profiles.ts` `sessionEnvironment()`），Issue 执行走 `Run`，`issue-executor.ts` 只注入
  repository socket。
- **Linux 上澄清、判定、合入不可用**：Linux 支持只补在了其中两处沙箱，阶段沙箱和 HTTP
  服务仍是 macOS 专有，合入处单独做了平台拒绝。（第 2 步已开放澄清、判定与合入；第 2b 步
  开放了 HTTP 服务。）
- **编排出的 Issue 子会话不受隔离**：带 `issueId` 的子会话在候选目录中运行
  （`daemon-connection.ts` `sessionExecutionPath`），但走 Chat 的 runner，没有经过
  `sandboxCommand`；同一个候选里，Issue 执行被隔离，子会话却不被隔离。（5b 已修复。）
- **Linux 候选沙箱没有控制面端口限制**：macOS profile 拒绝访问 Server/Web 端口
  （`controlNetworkRestrictions`），Linux bwrap 分支未 unshare 网络，也没有等价限制。
  第 2 步核实：沙箱内确实能连到控制面；之后复查确认这条规则已不必要并取消（见 §5.1）。
  同时发现并修复了
  三个 Linux 问题：沙箱内无法解析域名（未挂载 `/etc`，Agent 连不上模型 API）、候选沙箱能
  读到 Server 数据目录（数据库与 `foundry-secret.key`）、Issue Agent 连不上 Worker 的仓库
  工具 socket。

## 2. 分层与依赖规则

```mermaid
flowchart TB
    L4["L4 入口<br/>Web · 飞书 Adapter"]
    L3["L3 Workflow<br/>Chat · Issue Loop"]
    L2["L2 Agent 能力面<br/>Foundry MCP / CLI · Skills"]
    L1["L1 执行原语<br/>Session Runtime · Sandbox · Resource Pool · Material Store"]
    L0["L0 平台<br/>Identity & Access · Device & Transport · Workspace Registry · 事件与存储"]
    L4 --> L3 --> L2 --> L1 --> L0
    L3 --> L1
```

规则：

1. **依赖只能向下。** 下层不 import、不命名、不分支于上层概念（不出现 `issue`、
   `evidence`、`chat` 字样的分支）。上层差异通过参数（role、policy、profile）传入。
2. **跨模块只经公开接口。** 模块内部文件不被外部 import；协议类型放在
   `packages/protocol` 中按模块分文件。
3. **一种原语一处实现。** 启动 Agent 只经 Session Runtime；包装 `sandbox-exec` / `bwrap`
   只在 Sandbox 模块；平台判断只在 Sandbox 后端。
4. **边界由审计锁住。** 仿照 Web 的 `audit-feature-architecture.mjs`，给 Worker 和 Server
   加依赖方向审计；已存在的违例登记为只减不增的基线。

## 3. 模块清单

| 层  | 模块               | 负责                                                                  | 不知道                 | 现有代码                                                                                           |
| --- | ------------------ | --------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------- |
| L0  | 平台基础           | 配置、私有状态根、原子写、通用工具；共享协议包                        | 任何业务概念           | `config.ts`、`state-root.ts`、`storage.ts`、`utils.ts`、`packages/protocol`                        |
| L0  | Identity & Access  | 账号、actor、角色、policy、会话令牌                                   | 具体业务对象的流程     | `internal/accounts`、`httpapi/actor.go`、`policy.go`、`access.go`、`sqlitestore/session_tokens.go` |
| L0  | Device & Transport | 配对、daemon 通道、RPC 关联、按设备路由                               | 消息的业务含义         | `daemon_ws.go`、`daemon_rpc.go`、`daemon-connection.ts`、`transport.ts`                            |
| L0  | Workspace Registry | Workspace 身份、所在设备、仓库清单、登记与移除                        | 候选、Issue            | `workspace-*.ts`、`repository-registry.ts`                                                         |
| L1  | 候选存储与 Git     | 执行根目录布局、锁、worktree 与 Git 操作                              | Issue 的状态与流程     | `execution-storage.ts`、`execution-git.ts`、`execution-types.ts`（现以 Issue 命名，实为共享底层）  |
| L1  | Harness Profiles   | Claude / Codex profile、原生登录与账号检查、模型目录                  | 会话如何启动与运行     | `profiles.ts`、`native-*.ts`（除 `native-chat*`）、`models.ts`、`provider-health.ts`               |
| L1  | Skills             | Skill 扫描、下载、物化、按 Workspace 隔离                             | 哪个会话在用           | `skill-*.ts`、`internal/skillarchive`、`sqlitestore/skill*.go`                                     |
| L1  | Sandbox            | 按隔离 profile 包装进程；平台后端；探测与 fail closed                 | 谁在用、为什么用       | 见 §1 四处实现                                                                                     |
| L1  | Session Runtime    | 以统一规格启动 Claude/Codex，事件流、steer、cancel、恢复、transcript  | Issue、Chat 的流程语义 | `runner.ts`、`sdk-messages.ts`、`session-*.ts`、`evidence-agent.ts` 中的启动部分                   |
| L1  | Material Store     | 按内容寻址的材料存储、摘要校验、归属与可用性                          | 判定规则               | `evidence-store.ts`、`evidence-uploads.ts`                                                         |
| L1  | Resource Pool      | 发现 → 登记 → 使用 → 回收；资源身份与占用（独占与排队待 M4）          | 由哪个 Workflow 使用   | `resource-pool.ts`、MCP `list_resources`                                                           |
| L2  | Agent 能力面       | Agent 唯一的对外 API（MCP / CLI），capability 注册，统一经 policy     | 调用它的 Workflow      | `foundry-cli.ts`、`foundry-mcp.ts`、`foundry-client.ts`、`httpapi/mcp.go`                          |
| L3  | Chat               | 会话列表、分组、对话 UI 所需的投影                                    | 沙箱与启动细节         | `sqlitestore/chat_*.go`、`apps/web/src/features/chat`                                              |
| L3  | Issue Loop         | 契约、候选、采集、判定、准出规则、Accept、合入；loop graph 与信号入口 | 沙箱与启动细节         | `issue-*.ts`、`evidence-*.ts`（除启动与沙箱部分）、`sqlitestore/issue*.go`、`evidence*.go`         |
| L4  | 入口               | Web、飞书；未来的通用 IM Adapter                                      | 执行细节               | `apps/web`、`internal/feishu`                                                                      |

两个不单列为模块的能力：

- **Orchestrator** = Session Runtime + Agent 能力面。任何经 Session Runtime 启动、policy
  允许的会话都自动具备编排能力，不为 Issue 另做一套。
- **跨设备** = Transport 按 `deviceId` 路由 + Session / Resource 可以落在其他设备。上层
  只多一个目标设备参数。

## 3.1 依赖图

箭头表示"依赖于"。按拓扑序从没有依赖的模块开始往上叠：下一层只依赖已经做好的层。

```mermaid
flowchart BT
    P["第 0 层<br/>平台基础"]
    ID["第 1 层<br/>Identity & Access"]
    SB["第 1 层<br/>Sandbox"]
    CS["第 1 层<br/>候选存储与 Git"]
    TR["第 2 层<br/>Device & Transport"]
    WR["第 2 层<br/>Workspace Registry"]
    MS["第 2 层<br/>Material Store"]
    HP["第 2 层<br/>Harness Profiles"]
    SK["第 3 层<br/>Skills"]
    RP["第 3 层<br/>Resource Pool"]
    SR["第 4 层<br/>Session Runtime"]
    AS["第 5 层<br/>Agent 能力面"]
    CH["第 6 层<br/>Chat"]
    IL["第 6 层<br/>Issue Loop"]
    EN["第 7 层<br/>入口"]
    ID --> P
    SB --> P
    CS --> P
    TR --> ID
    WR --> CS
    WR --> ID
    MS --> CS
    HP --> ID
    SK --> TR
    SK --> HP
    RP --> SB
    RP --> TR
    SR --> SB
    SR --> HP
    SR --> SK
    SR --> CS
    SR --> TR
    SR --> RP
    AS --> SR
    AS --> RP
    CH --> SR
    CH --> AS
    IL --> SR
    IL --> AS
    IL --> MS
    IL --> WR
    EN --> CH
    EN --> IL
```

图中省略了指向第 0 层和 Identity 的大部分边。Resource Pool 在第 3 层，于 M3 实现（§5.6）。

### 现状中的违例

以下来自 `0649fe7` 的 Worker import 扫描（按上表把文件归入模块后统计跨模块 import）。
Server 的 `httpapi` 是单个 Go 包，模块之间没有编译期边界，这部分只能按文件核对。

| 违例                          | 证据                                                                                                                               | 处理                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Sandbox 依赖上层类型          | `execution-sandbox.ts` 接收 `IssueEnvironment`；`evidence-command-sandbox.ts` 引用 `evidence-collectors.ts` 的 `CommandInvocation` | 改为只接收 `SandboxProfile`（M1 第 1 步）            |
| 共享底层以 Issue 命名         | `execution-storage.ts`、`execution-git.ts`、`execution-types.ts` 被沙箱、材料、工作区、会话共用                                    | 独立为"候选存储与 Git"，类型中去掉 Issue 概念        |
| Harness Profiles 依赖 Session | `profiles.ts` 导入 `session-ambient.ts`，并定义 `sessionEnvironment()`                                                             | 会话环境变量移入 Session Runtime                     |
| Workspace 依赖 Issue 与 Chat  | `workspace-ops.ts` 导入 `issues.ts`、`native-chat.ts`                                                                              | 它实际上是 daemon 请求处理，归入组装层               |
| 通道与装配混在一起            | `daemon-connection.ts` 既收发消息，又装配所有模块的请求处理                                                                        | 拆成通道与组装层：通道只管收发，各模块注册自己的处理 |

组装层（composition root）不是模块：`cli.ts`、`daemon-connection.ts` 中的装配部分、
`workspace-ops.ts` 这类请求处理可以依赖任何模块，但任何模块都不能依赖它。

## 4. Milestone 切分

每个 milestone：一个模块的协议 + 迁移现有调用方 + 删除重复实现 + 一个端到端使用场景。
模块自身的契约测试通过但场景未跑通，不算完成。

| Milestone              | 模块                           | 验收场景                                                                                                     | 依赖           |
| ---------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------ | -------------- |
| **M1 执行内核** ✅     | Sandbox + Session Runtime      | 见 §5.5：模块测试与依赖审计为零；Chat 真实浏览器回归；执行内核真实模型端到端                                 | —              |
| **M2 Agent 能力面** ✅ | Foundry MCP / CLI              | Chat 中的 Agent 经 MCP 派出、观察、steer 子会话与只读 verifier，按角色授权                                   | M1             |
| **M3 资源与跨设备**    | Resource Pool + Transport 路由 | Chat 中的 Agent 用设备上已有的浏览器截图给人看，用完回收；按资源选设备，经 Server 中转在另一台设备上启动会话 | M1、M2         |
| **M4 Issue Loop**      | Issue Loop                     | 开始前按 §6 重新审视内核缺口；Issue 内编排、loop graph 与准出规则、外部信号、Issue Web 体验的真实浏览器闭环  | M1–M3          |
| 并行轨道               | Identity & Access              | 账号 P3 / P4（个人连接授权、飞书身份绑定、审计、所有权转移）                                                 | 与主线无强依赖 |

**内核不依赖 Issue（2026-09-26 定）。** Issue 是建在内核之上的编排层，放在内核之后做。
内核功能用 Chat 与编排子会话验收；做 Issue 时再按它的需求补内核，而不是让内核功能等待
完整的 Issue 逻辑。内核里现有的"Issue 形状"部分（Sandbox 目前只由 Issue 使用、
`startSession` 只服务澄清与判定、候选存储的类型名）暂视为 Issue 的附属，不再扩展。

M2–M4 的接口在各自开始前补充到本文，不提前设计。

**M2 Agent 能力面**（已完成，2026-09-27，验收见[实机回归](live-regression.md) C1–C6、C13–C15）。起点是一个实测发现：Session 编排的服务端能力（令牌、
Policy、血缘、分组）都已具备，但**会话从未拿到 Foundry 工具**——Session Runtime 没有
为会话注册 `foundry` MCP，`foundry` 命令也不在 PATH 上，所以 Chat 里的 Agent 无法编排。

- **M2-1**（已完成）：Session Runtime 为持有令牌的 Claude 会话注入 Server 的 HTTP MCP
  并预先放行，复用的运行时逐轮换上新令牌；HTTP MCP 按协议处理通知、把工具失败作为
  可读结果返回、协商协议版本；工具目录带类型定义并成为唯一一份；子会话默认沿用父会话
  的 profile，等待结束时带回回答。以真实 Chat 验收：派出子会话、等待、复用运行时的
  下一轮继续编排。
- **M2-2**（已完成）：Server 的 MCP 补齐 `list_models`、`handoff_session`、
  `read_context` 的 `subagents` 范围，以及 `create_session` 的运行时参数与
  `list_profiles` 的 runtime 过滤；模型目录查询抽成 HTTP 与 MCP 共用的一个方法。stdio
  `foundry mcp` 改为纯转发桥，删掉 TypeScript 里重复的工具定义与处理（约 300 行），
  工具只剩 Server 一处实现。`foundry session` 命令保持 REST（它是人和脚本的界面，
  不是 MCP）。REST 与 MCP 创建会话时"选哪个 Agent、在哪台设备"的判断也合并为一个方法，
  只给 profile 时由它确定运行时；`handoff_session` 未指定 profile 时沿用被接替会话的。
  实测中顺带修复：自定义命令不读 stdin 就退出时，Worker 写 prompt 触发的 `EPIPE`
  未被处理，会让执行进程崩溃。
- **M2-3**（已完成）：Codex 会话注入同一套 foundry 工具，预先放行，令牌从 Codex 自己的环境
  变量读取。实测 Codex 作为编排者完成派出、取消、继续子会话与 handoff 接管。
- **会话模型重构**（2026-09-27，[设计](session-model.md)）：一个会话就是一个原生会话，
  一行到底；续聊是给会话发新输入，"轮"降为派发用的输入 id。令牌跟会话走，权限改为
  同 Workspace 内任意 Agent 可操作任意会话，adopt 删除。它纠正了此前"每轮一行"导致的
  编排血缘、令牌、恢复和列表问题，是 L4 Session Runtime 的内核改动。
- HTTP MCP 的 OAuth 2.1 只在出现 Foundry 之外的远程 Agent 时再做。

**M3 资源与跨设备**（进行中）。起点：工作区在设备上，但 Server 里有几处直接读写**自己的
磁盘**上的 `workspace.LocalPath`，只在 Server 与设备同机时成立；设备通过公网连上时，Chat
附件上传直接失败（实测：Mac 连 dev.foundryapp.app，上传返回 500）。

- **M3-1 设备上的工作区文件**：Chat 附件的上传与图片读取改经设备通道分块转发
  （`attachment_write` / `attachment_read`，每块 1 MiB，低于 Worker 2 MiB 的消息上限）。
  Server 只负责鉴权与命名，路径由设备按真实路径校验（`workspace-attachments.ts`），
  Server 不再触碰工作区路径。它也是之后"截图给人看"的传输基础。
- **M3-2 会话恢复问设备**：Worker 重连时，Server 对仍记为运行中、但新进程未声明在跑的输入
  发 `recover_session`；设备按自己的完成标记回报结果，没有标记就回报"结果随上一个进程丢失"，
  输入立刻结束，不再等 30 分钟超时。重新派发一个已有完成标记的输入时，设备直接回报而不重跑。
  Server 不再读取任何工作区路径；不声明执行中会话的旧 Worker 不会被询问，仍走超时判定。
  Issue 会话随 Issue 恢复，不在此列。
- **两项决定**（见 §5.6）：跨设备的授权边界（方案 A）与 Resource Pool（设备已有资源的发现、登记与回收），均已于 2026-09-28 确定并实现。

## 5.6 M3 提案

### Resource Pool（已定，2026-09-28）

资源是设备上**已有**、会话可以用的能力，例如装好的浏览器、macOS 的屏幕控制。Foundry
不自带、不下载资源，只做四件事：发现、登记、告诉会话、回收。早先"Worker 为会话挂一个
自带 Chromium 的 Playwright MCP"的提案已放弃：设备上本来就有浏览器，挡住会话使用它们的
是 Foundry 自己的默认权限与配置隔离（已修正，见 `docs/development.md`）。

- **资源描述** `DeviceResource`：`id`（设备内唯一，如 `browser:google-chrome`）、`kind`
  （`browser` | `computer_use`）、`name`、`available`（此刻能否用）、`detail`（不可用的
  原因）、`attributes`（如浏览器的 `path`）。
- **发现**（`packages/worker/src/resource-pool.ts`）：Worker 在每次向 Server 注册（启动与
  重连）时探测，会话启动时再探测一次。浏览器按各平台标准安装位置与 `PATH` 查找；
  `computer_use` 仅 macOS，实际查询 Worker 进程上下文的屏幕录制与辅助功能授权
  （`CGPreflightScreenCaptureAccess`、`AXIsProcessTrusted`，不弹窗），不以"是 Mac"推断。
- **目录**：随注册上报，作为设备的一部分保存（`DeviceProjection.resources`）。读取方共用
  同一份：会话的设备说明（可用的浏览器与屏幕控制、截图放到哪里才能在聊天里显示）、
  MCP `list_resources`（按调用方可达的设备列出资源、在线状态与可进入的工作区，编排时据此
  选设备）、Web 设备页的 Resources。
- **租约与回收**：Daemon 派发的会话各有一个临时目录（作为它的 `TMPDIR`），Worker 在里面
  为每个可用浏览器生成启动器；会话说明里给 Agent 的是启动器。启动器把自己的进程号记入
  该会话的租约文件后 `exec` 成真正的浏览器（进程号不变），这就是"申请"。一次输入结束时，
  Worker 关闭租约中仍在运行的浏览器（核对可执行文件，防止进程号复用），这就是"释放"。
  Agent 绕过启动器直接启动浏览器时，按会话环境变量或会话临时目录识别，并上溯到同一浏览器
  的顶层进程关闭。之所以需要租约：Chrome 在 Linux 上会改写自己的环境，macOS 上读不到
  签名应用的环境，headless Chrome 也不一定写 `TMPDIR`，只凭进程上的痕迹靠不住。
- **独占与排队**：第一版没有独占资源。带登录态的浏览器资料、模拟器、预览端口等独占资源，
  在第一个实际场景（M4 验收取证：预览服务 + 浏览器截图）中加入显式的申请 / 释放与排队。

### 跨设备会话（已定：方案 A，2026-09-28）

设备与工作区一一绑定，所以"在另一台设备上启动会话"就是"在另一个工作区里启动会话"，
而当前规则是"同一 Workspace 内任意 Agent 可操作任意会话"。两种扩展方式：

| 方案                  | 规则                                                                                                   | 优点                                                                    | 代价                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------- |
| **A. 跟人走（采用）** | Agent 代表启动它的人：能在这个人有 Member 以上权限的任何工作区（包括其他设备上的）启动、读取与控制会话 | 与人工操作一致，不需要新的授权配置；覆盖"用我的 Mac 跑、在服务器上派活" | 一个被注入恶意指令的 Agent 能触及这个人所有的工作区 |
| B. 显式授权           | 工作区设置里列出允许派活进来的其他工作区                                                               | 边界清楚、最小权限                                                      | 需要新的设置界面与存储；每加一台设备要配置一次      |

两种方案下，底层都要做的是：`create_session` 等工具接受目标 `workspaceId`；子会话在目标
工作区，血缘跨工作区记录；`list_profiles` / `list_models` 可按目标设备查询；派发本来就按
设备路由（`DispatchAgentSession`），无需改传输。

## 5. M1 接口草案

### 5.1 Sandbox

已实现，代码在 `packages/worker/src/sandbox/`。沙箱在 Worker 一侧，限制 Worker 为 Issue
启动的进程能读写哪些文件；Server 没有沙箱，Chat 不经沙箱。

**沙箱只管操作系统才拦得住的两件事（2026-09-26 定）：**

1. **写边界**：Issue 只写自己的候选与 scratch，保护真实 Workspace 与并行的 Issue；澄清与
   判定对所看内容只读。
2. **治理状态不可读**：Foundry 自己的状态目录（设备凭据、daemon 配置、其他 Issue 的候选与
   证据、各开发栈的状态）和运行目录下的 Server 数据（数据库、`foundry-secret.key`）。

其余的不归沙箱：

- **职责分离**（干活的 Agent 不能判定自己的结果）由身份与流程保证：Agent 的会话令牌只能
  访问会话相关接口（`httpapi/policy.go` `agentRouteAllowed`），确认准出条件、验证结果和
  Accept 都不对它开放；Verifier 的结论之所以算数，是因为 Worker 为已封存的候选启动独立
  会话并记录其输出，而不是 Verifier 持有凭据。
- **控制面端口不再封锁。** 这条规则来自 Server 允许免登录、能连上就有全部权限的时期；
  2026-09-23 起所有接口都要求登录，它已不再必要。编排中的 Agent 凭会话令牌访问 Server。
  （复查时发现的 Vite 开发服务器泄露 Server 数据的问题，已在 Vite 配置中修复。）
- **任务凭据按发起人决定。** `WritableTreeProfile.userFiles`：Issue 由设备所有者本人发起
  时为 `readable`，进程能像在本人终端里一样读取 home、配置与凭据（如 feishu-cli、ssh）；
  其他人发起的 Issue 为 `hidden`，只能看到系统目录、读根与写根。由 Server 在派发
  `run_issue` 时判断。给他人 Issue 使用某项凭据的显式授权属于账号 P3；外部副作用的按次
  确认属于后续 Tool Use。`readable` 下浏览器 cookie 等宿主上的其他凭据同样可读，需要更强
  隔离时使用 `hidden` 或计划中的 Docker 后端。
- **能运行自己的工具。** `WritableTreeProfile.executables` 列出进程要运行的程序（如 Agent
  CLI），无论 `userFiles` 如何，其安装目录都可读；Session Runtime 在宿主上解析 harness
  CLI 的真实路径后传入。此前 CLI 装在 home 下（原生安装器默认 `~/.local`）时，Issue 执行
  在沙箱内找不到 CLI。

**对使用方：一种调用形态。** 调用方只描述路径和限制，四种 profile、所有后端都用同样的
调用；后端由模块选择，调用方看不到。

```ts
// 四种 profile，按用途区分，字段只有路径和限制
type SandboxProfile =
  | WritableTreeProfile //   Issue 执行、preview：只写候选与 scratch；userFiles 决定能否读用户文件
  | ReadonlyAgentProfile //  澄清、判定：只读 Workspace / 候选，只写私有 home
  | OfflineCommandProfile // 检查命令：断网，只写输出目录
  | LoopbackServiceProfile; // 受控 HTTP 目标：只能在本机回环上监听

function sandboxLaunch(profile, command, args): SandboxLaunch; // 命令行
function sandboxLauncher(profile, command, launcherFile): string; // 给只接受可执行路径的 SDK
function sandboxAvailable(kind): boolean;
// 无可用后端或输入无效时抛 SandboxError（带 code），永不回退到无隔离执行
```

**对实现方：一个后端接口。** 每种隔离技术实现 `SandboxBackend`：声明自己验证过哪些
profile，并把 profile 翻译成本平台的规则。与平台无关的步骤（解析可执行文件、校验工作目录、
生成启动脚本、命令安装目录可读）在模块公共层完成，后端拿到的是已规范化的输入。

```ts
interface SandboxBackend {
  id: string;
  kinds: readonly SandboxKind[];
  launch(
    profile: SandboxProfile,
    command: string,
    args: string[],
  ): SandboxLaunch;
}
```

| 后端                 | writable_tree | readonly_agent | offline_command | loopback_service        |
| -------------------- | ------------- | -------------- | --------------- | ----------------------- |
| macOS Seatbelt       | ✅            | ✅             | ✅ 断网         | ✅ 只能回环监听         |
| Linux bubblewrap     | ✅            | ✅             | ✅ 断网         | ✅ 断网，经 Unix socket |
| Docker（计划，见下） | —             | —              | —               | —                       |

原来的四个文件（`execution-sandbox.ts`、`evidence-agent-sandbox.ts`、
`evidence-command-sandbox.ts`、`evidence-http-service.ts`）现在只负责把 Issue / evidence 的
信息翻译成 profile，属于 Issue 模块（`evidence-agent-sandbox.ts` 已并入 Session Runtime）。

**Chat 不经沙箱，这是设计而非缺口。** Chat 是最基础的能力，可以接到任意 cwd：Web 上和
飞书话题里发起的 Chat 直接在原始 Workspace 中工作，产生的变更直接生效，不经候选、验证与
Accept。隔离、证据和人工接受是 Issue 这类编排流程提供的保证，不泛化到 Chat。Session
Runtime 把这一点显式写成 `sandbox: { kind: "host" }`，而不是"没写就是不隔离"。

**Docker 后端（计划，不在 M1）。** 作为第三种 `SandboxBackend`，按 Workspace 选择，面向
Linux 服务器、团队共用机器和需要可复现环境的项目：独立根文件系统与资源限额，宿主上的其他
凭据天然不可见。取舍：Agent 只能用镜像里的工具链；macOS 上经虚拟机运行，文件性能下降，
也做不了 iOS / macOS 项目，所以 macOS 默认仍用 Seatbelt；worktree 的 `.git` 指向主仓库
绝对路径，主仓库 `.git` 需按同一路径挂载；Worker 本身跑在容器里时需要挂载宿主
docker.sock，等于把宿主 root 权限交给 Worker。

### 5.2 Session Runtime

一个启动入口，差异全部由 role 推导出的 policy 表达。已实现的部分见 §5.4 的 5a：目前
`SessionRole` 只有 `clarification` / `verification`，其余角色随 5b、5c 迁入；下面的接口是
迁移完成后的目标形态。

```ts
type SessionRole =
  | "chat"
  | "orchestrated" // 由其他会话经 MCP 创建
  | "issue_execution"
  | "clarification"
  | "verification"
  | "utility"; // 命名、标题等

interface SessionSpec {
  sessionId: string; // Server 分配的 AgentSession id
  role: SessionRole;
  harness: "claude" | "codex";
  profileId: string;
  model?: string;
  cwd: string;
  sandbox: SandboxProfile | { kind: "host" };
  prompt: string;
  systemPrompt?: string;
  resume?: { nativeSessionId: string };
  responseSchema?: Record<string, unknown>;
  persistTranscript: boolean;
  foundryToken?: string; // 存在即注入 FOUNDRY_* 与 foundry MCP；是否下发由 Server 按 role 决定
  skills?: ManagedSkillRuntime;
}

interface SessionHandle {
  events: AsyncIterable<SessionEvent>; // 统一 delta / tool / blocked / native-id 事件
  steer(message: string): Promise<void>;
  cancel(): Promise<void>;
  result: Promise<SessionResult>; // text、structured、reportedModel、activity
}

function startSession(spec: SessionSpec): SessionHandle;
```

role 到 policy 的映射集中在一处（草案，实施时以现有行为为准逐项核对）：

| role            | 沙箱                                                                      | 工具                           | foundry MCP    | 项目指令 / Skills         |
| --------------- | ------------------------------------------------------------------------- | ------------------------------ | -------------- | ------------------------- |
| chat            | host                                                                      | profile 默认                   | 是             | 是                        |
| orchestrated    | Workspace 根目录为 host；带 `issueId` 为候选写（**现状未隔离，M1 补上**） | profile 默认                   | 是             | 是                        |
| issue_execution | 候选写                                                                    | profile 默认                   | **是（新增）** | 是                        |
| clarification   | 阶段只读                                                                  | Read / Grep / Glob             | 否             | 读项目指令，不加载 Skills |
| verification    | 阶段只读                                                                  | Read / Grep / Glob + 只读 Bash | 否             | 否                        |
| utility         | host（无工具，不需要沙箱）                                                | 无                             | 否             | 否                        |

进程模型按沙箱推导，不作为独立选项：

- **host 会话**（chat、不带 `issueId` 的 orchestrated、utility）：和现在一样在 Worker
  进程内运行，没有额外进程。
- **沙箱会话**（issue_execution、带 `issueId` 的 orchestrated、clarification、
  verification）：Worker 另起一个 Node 子进程运行 SDK，整个子进程在
  `sandbox-exec` / `bwrap` 内启动。这是 Issue 执行现在的做法。判定阶段现在的做法是只把
  `claude` / `codex` 可执行文件包进沙箱，SDK 本身留在沙箱外，M1 统一改为前者：一种机制
  同时约束 SDK 和它拉起的工具进程，stdio 上的 steer 协议和进程组回收都已有实现。

### 5.3 Server 侧：Run 与 AgentSession 统一

移到 M4（见 §5.4 第 6 步）：它服务于 Issue 内编排，M1 的目标不依赖它。以下是届时的设计要点。

- Issue 执行、澄清、判定都创建 `AgentSession`，带 `role` 和 `issueId`。会话令牌、血缘、
  分组、transcript 读取全部复用现有实现。
- `Run` 保留为 Issue 侧的投影：`sessionId` + 环境信息（`environmentId`、`revision`、
  `executionCwd`），不再承载事件流。
- daemon 消息：`run_issue` / `run_event` / `issue_completed` 收敛到 `run_session` /
  `session_*`，Issue 相关字段作为 payload。旧记录只读兼容，按现有 `normalizeIssueStatus`
  的方式在读取时归一。
- 令牌按 role 下发：只有 chat、orchestrated、issue_execution 会得到 `foundryToken`；
  issue_execution 的令牌在 policy 中额外限定于本 Issue 的候选。

### 5.4 迁移顺序

按 §3.1 的层序自下而上，每一步都能单独合入，并保持现有行为：

0. **依赖审计**（已完成）：`pnpm audit:modules`（`scripts/audit-module-boundaries.mjs`）
   按 §3.1 检查 Worker 的跨模块 import、SDK 与沙箱命令的位置、Server 的包依赖和
   `store.Store` 方法数上限；现有违例记录在 `scripts/module-boundaries-baseline.json`，
   只能减少。之后每一步都应让基线缩短。
1. **Sandbox（第 1 层）**：建模块和 macOS 后端，把四处实现迁进去，只接收
   `SandboxProfile`；输出与现在逐字节一致的 profile（用快照测试锁定）。
2. **Sandbox 后端接口与 Linux 只读阶段**（已完成）：后端统一实现 `SandboxBackend`；
   Linux 实现 `readonly_agent`，修复 DNS、Server 数据可读、仓库工具 socket 与嵌套只读
   目录问题；`evidence-acceptance.ts` 的平台拒绝改由 `sandboxAvailable()` 决定。
   **2b.**（已完成）Linux 的 `loopback_service`（受控 HTTP 目标）：服务放进无网络的
   命名空间，只在一个私有目录里的 Unix socket 上监听，Worker 用本机回环端口转接。
   `SandboxLaunch.endpoint` 告诉调用方服务在哪里监听（macOS 回环 TCP，Linux Unix
   socket），调用方始终拿到 `127.0.0.1` URL。
3. **候选存储与 Git（第 1 层）**：并入第 5 步按需处理。第 2 步之后 Sandbox 已不再依赖
   这些类型，剩下的只是把 `IssueEnvironment` 等类型改名（11 个文件、41 处引用），不消除
   任何违例；等 Session Runtime 真正需要时再调整。
4. **Harness Profiles（第 2 层）**（已完成）：`sessionEnvironment()` 移入 Session Runtime
   的 `session-ambient.ts`，附件提示移入 `session-prompt.ts`，profiles 不再依赖会话。
5. **Session Runtime（第 4 层）**，分三步：
   - **5a**（已完成）：新建 `src/session/`，对外只有 `startSession(spec)`；角色决定工具、
     项目指令与轮数（`policy.ts`），harness 适配器（`claude.ts`、`codex.ts`）实现同一个
     内部接口。澄清与判定迁入，`evidence-agent.ts` 不再接触 SDK，Worker 违例基线清零。
   - **5b**（已完成）：Session Runtime 增加工作区会话入口 `runWorkspaceSession`（Chat、
     编排子会话、Issue 执行），带沙箱时在沙箱内的宿主子进程（`session/host-child.ts`）
     中运行 SDK，steer 与取消仍经通用登记表。带 `issueId` 的编排子会话由 Issue 模块
     （`issue-sessions.ts`）决定：在候选工作区（不再是候选环境根目录）内、与 Issue 执行器
     同一沙箱中运行，并携带会话令牌，可继续编排。进程组管理移到平台层 `process-group.ts`。
   - **5c**（不做，移入 §6）：原计划把 `startSession` 与 `runWorkspaceSession` 合并。
     复查后，`startSession` 只服务 Issue 的澄清与判定，它是否需要独立存在、判定者能用哪些
     工具，是 Issue 产品的问题，放到 M4 决定。
6. **Server 侧统一**（移到 M4）：Run → AgentSession，会话相关的 daemon 消息收敛；Issue
   执行获得 foundry MCP。它服务于 Issue 内编排。

### 5.5 M1 验收

M1 验收不依赖 Issue 产品（2026-09-26 调整；原先要求用浏览器跑完整 Issue 闭环，但 Issue
入口隐藏、Issue 也放到 M4）。验收记录在 PR 与 release notes 中。

- **模块测试与审计**：Sandbox 各 profile 在 Linux 上的真实读写边界、macOS 规则文本；
  Session Runtime 的角色策略、取消、沙箱内工作区会话；依赖审计违例为零。
- **Chat 真实浏览器回归**：在隔离的本机环境中，Chat 在原始 Workspace 中读写文件、流式
  回复、steer 注入进行中的回复、取消后继续对话。
- **执行内核真实模型端到端**：`scripts/verify-issue-live.mjs`（含 `--interrupt`）在
  Linux 上用 Claude 通过：沙箱内执行、按需准备子仓库、中断恢复、会话续接、多仓合入与清理。
- **已知限制**：macOS 只做过规则层面的验证（新旧产物比对、规则文本检查），尚未实机运行；
  Codex 的真实运行受本机登录失效所阻，待重新登录后补跑。

## 6. M4 计划（2026-09-28 确认）

M4 的交付是[对话式准出标准](foundry-conversation-release-gate.md) G1–G5 的真实浏览器闭环，
加上 Issue 内编排。下面几项已按推荐确认；在 M3 收尾后按"实施顺序"逐步合入。
（原 §6 的"受控 HTTP 目标仅 macOS"已在 2026-09-28 完成，见 §5.4 第 2b 步。）

### 决定

| #   | 决定                     | 现状                                                                                                        | 推荐                                                                                                                                                                                             |
| --- | ------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | M4 的范围                | 路线图写了 Issue 内编排、loop graph 与准出规则、外部信号、Web 闭环                                          | **M4 = G1–G5 闭环 + Issue 内编排**（执行者能派子会话、判定者独立）。loop graph（多步骤依赖图）与外部信号（CI、Webhook 触发）移到 M5：它们没有具体场景，先让单 Issue 闭环可信                     |
| D2  | Issue 的会话统一（§5.3） | 执行走 `Run`（`run_issue` / `run_event` / `issue_completed`），执行者没有会话令牌；澄清与判定各自一次性启动 | **做**，且放在最前：执行、澄清、判定都成为带 `role` 与 `issueId` 的 `AgentSession`，复用令牌、血缘、transcript、steer、取消、以及 M3-2 的恢复；`Run` 退为 Issue 侧投影。这是"Issue 内编排"的前提 |
| D3  | 澄清与判定的会话入口     | `startSession`（`src/session/`）只服务这两个角色，与 `runWorkspaceSession` 分开                             | 随 D2 **合并为一个入口下的角色**：角色只决定工具、项目指令、是否续接与沙箱 profile（`session/policy.ts` 已是这个形状）。判定仍是全新会话、不保存原生上下文                                       |
| D4  | 判定者可用的工具         | 只读工具；不加载 MCP、Skills、插件与项目指令                                                                | **放开 Workspace 选定的 Skills**（来自 Server 目录的已选版本，不来自候选，不会被候选削弱）；**MCP 仍不给**，包括 foundry 工具（判定者不派活）。"不写、不读候选里的指令、全新会话"保持不变        |
| D5  | 澄清可用的工具           | 同判定，但读项目指令，不能运行命令                                                                          | **接近普通 Chat 但只读**：项目指令 + 选定 Skills + 只读 foundry 工具（`list_sessions`、`read_context`，便于引用已有对话）；仍在 `readonly_agent` 沙箱内，不写、不跑命令（G1）                    |
| D6  | 执行者的编排范围         | 带 `issueId` 的编排子会话已在候选工作区、同一沙箱中运行并携带令牌                                           | 执行者的令牌**限定于本 Issue**：只能派出同 Issue 的子会话（落在同一候选），不能在 Issue 之外开会话或跨工作区（M3 方案 A 不适用于 Issue 执行者）；判定者没有令牌                                  |

### 实施顺序

1. **D2 Server 侧**：Issue 执行创建 `AgentSession(role=issue_execution)`，`Run` 只保留环境
   投影；旧 `Run` 记录只读兼容。daemon 消息收敛到 `run_session` / `session_*`。
2. **D2/D3 Worker 侧**：澄清、判定改走统一入口的角色；`startSession` 删除。
3. **D4/D5/D6 策略**：按角色调整工具与令牌范围；policy 单测覆盖每个角色的允许与拒绝。
4. **重新开放 Issues Web 入口**，按 G1–G5 修到真实浏览器准出；证据记录在 PR。
5. 候选存储类型改名（`IssueEnvironment` 等）只在上面某步真正需要时顺带做。

**第 1 步已落地**（2026-09-30）：认领 Issue 时在同一事务里创建执行会话（`source=issue`、
`role=issue_execution`），经 `run_session` 派发并附带 Issue 与已确认契约；会话的
started / event / completed 驱动原有的 `Run` 投影（`Run.id` 即会话 id，`runs` 表保留为
尝试历史），完成消息以 `issueResult` 携带候选与验收产物。`run_issue` / `run_started` /
`run_event` / `issue_completed`、HTTP 轮询模式与 `recover-claim` 已删除；中断恢复走
`recover_session`（Worker 回放 `completion.json` 或报告中断）。Worker 以
`capabilities: ["issue_sessions"]` 声明能力，旧 Worker 不会被派发 Issue。执行会话不能作为
会话被发消息或取消（经 Issue 控制）。

**D6 已落地**（2026-09-30）：在 Issue 候选中工作的会话（执行者，以及它派出的会话）的令牌
只到达该 Issue 所在的 Workspace（不适用 M3 方案 A），只能控制同 Issue 的会话，派出的会话
一律落在同一候选（点名其他 Issue 或 Workspace 返回 403）；执行者因此拿到会话令牌，Worker
把它交给执行沙箱里的 Foundry 工具。

**D3/D5 澄清部分已落地**（2026-10-01）：澄清是 Issue 的一条会话（`role=issue_clarification`），每条消息是一次新输入，
续接原生上下文；Server 立即记录消息并派发，回复随 `session_completed` 的 `clarificationResult` 到达，失败可“重新提问”，
中断经 `recover_session` 补报。Worker 侧它与 Chat 走同一入口（`executeAgentSession` → `runWorkspaceSession`），
角色只决定工具与沙箱（`session-roles.ts`、`issue-clarification.ts`）：Workspace 只读、项目指令与选定 Skills、只读
foundry 工具；令牌在 Server 端为 Viewer。`startSession` 只剩判定者使用。
判定（D4）的建议（待确认）：只放开 Workspace 选定的 Skills，仍无 MCP、无令牌，并留在 Worker 的验收流程里，不升级为 Server
会话——它夹在候选版本两次校验之间、全新且不续接，会话化带来的续接、引导与编排它都用不上，完整过程已作为材料封存。

**D2 的现状与落点**（2026-09-28 核对代码）：

- 三个角色在 Server 上都没有 `AgentSession`：执行只有 `Run`（`runs` / `run_events` 表，
  `StartIssueRun` / `AppendRunEvent` / `CompleteIssue`）；澄清与判定经 `evidence_request`
  RPC 一次性启动，结果只落在证据记录里（原生 session id 存在响应字段中）。
- Worker 执行每轮合成一个 `${runId}_${turn}` 的临时会话再调 `runWorkspaceSession`，与 Chat
  共用的只有这一层；中断恢复另有一套（`issue-recovery.ts`、`completion.json` 回放）。
- 已有的连接点：`AgentSession.IssueID`、带 `issueId` 的编排子会话已在候选与 Issue 沙箱内
  运行（`issue-sessions.ts`）；`AgentSession` 还没有 `role` 字段。
- 读 `Run` 的地方：Issue 投影与详情页（`issue-data-projection.ts`、`issue-detail/*`）、
  steer 的 `expectedRunId`、删除 Workspace / 移除设备的在跑检查、若干证据对齐逻辑；
  `/api/runs`、`/api/run-events` 与 `features/runs` 已无调用方。
- 因此第 1 步按"执行会话 = AgentSession(role, issueId)，`Run` 由它投影"落地，
  `claimAndSend` 的容量与认领逻辑保留，只把派发从 `run_issue` 换成 `run_session`；
  恢复改由 M3-2 的 `recover_session` 覆盖，删除 `issue-recovery.ts` 的平行实现。

## 7. 不做

- 不一次性重排目录。先让接口和依赖方向成立，再按模块搬文件。
- 不在 M1 引入 Issue 多 Agent、loop graph、Resource Pool 或跨设备。这些都在后续 milestone，
  M1 只保证它们将来有唯一的落点。
- 不让内核功能依赖 Issue 的完整逻辑。
- 不为统一抽象重写 Harness。Session Runtime 只是对现有原生 SDK / CLI 调用的收拢，模型
  请求仍只经原生 SDK 或 CLI。
