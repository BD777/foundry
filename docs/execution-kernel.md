# 执行内核：Session Runtime 与 Sandbox

[项目 Roadmap](../README.md#roadmap) · [文档索引](README.md)

执行内核是 Worker 一侧的两个模块：**Session Runtime** 以统一方式启动原生 Claude Code / Codex 会话，负责事件流、steer、取消、存活判断与重启后的恢复；**Sandbox** 按隔离 profile 包装进程，只施加写边界并隐藏 Foundry 自己的治理状态。它不负责流程语义（谁、何时启动会话，结果算不算数，由 Chats、Issues 与 Agent 能力面决定），也不负责凭据从哪里来（[模型与账号](models-and-accounts.md)）、启用哪些 Skill（[Skills](skills.md)）、资源的发现与租约（[Resources](resources.md)）。在分层图中它位于 Agent 能力面之下、能力供给之上：被 Chats、Issues 和经 Foundry MCP 派出的会话使用，依赖能力供给各模块与[设备与 Workspace](devices-and-workspaces.md)（派发通道与 Workspace 路径）。依赖方向由 `pnpm audit:modules`（`scripts/audit-module-boundaries.mjs`）检查，Worker 违例基线为零（`scripts/module-boundaries-baseline.json`）。

## 设计

### Session Runtime

- **一个会话就是一个原生会话**，续聊是给它追加输入（[会话模型](session-model.md)）。只经原生 SDK（Claude Agent SDK、Codex SDK）驱动设备上的 `claude` / `codex`；2026-10-05 起没有 CLI 回退，SDK 的错误就是会话的错误（#109）。profile 配置的自定义命令是另一条路径（`runner/profile-command.ts`）。
- **一个派发入口，执行位置由会话决定。** Server 发 `run_session`，Worker 的 `executeAgentSession`（`daemon/session-execution.ts`）调用 `sessionExecution()`：带 `issueId` 的会话由 Issue 决定目录与沙箱（`issue-sessions.ts`、`issue-clarification.ts`）；verifier 由 `verification-session.ts` 决定；其余（Chat、Issue 之外的编排子会话）直接在 Workspace 根目录、在 Worker 进程内运行。随后统一进入 `runWorkspaceSession`（`session/workspace.ts`）：没有沙箱时在本进程跑 `runner/claude-turn.ts` / `runner/codex-turn.ts`；有沙箱时在沙箱内启动宿主子进程 `session/host-child.ts`，经 stdin/stdout 的 JSON 行传递 steer、事件与结果，整个 SDK 与它拉起的工具进程都受同一沙箱约束。
- **Issue 判定另有入口。** `startSession`（`session/index.ts`）只服务一种角色 `verification`：为每次独立判定启动全新、只读的会话，工具与轮数来自 `session/policy.ts`，进程在 `readonly_agent` 沙箱内（[§5.4 第 5 步](architecture-modules.md#54-迁移顺序)；5c 合并两个入口已决定不做）。
- **角色决定工具，不另起一套运行时。** `session-roles.ts` 按角色收窄工具：澄清只读（Read / Grep / Glob 与只读的 foundry 工具），verifier 的写入只落到自己的 scratch。Chat 没有角色，行为与本人终端里的 Agent 一致：除非 profile 更严格，Claude 用 `bypassPermissions`，Codex 用 `danger-full-access`（见[开发指南](development.md)）。Foundry 自己的工具会话（命名、诊断）不写文件、最多 3 轮，Claude 以 `dontAsk` 运行而不是 plan 模式（plan 模式的系统提示会让模型写计划文件而不回答；`runner/claude-options.ts`，未提交，2026-10-14，测试 `chat-naming.test.mjs`）。
- **steer 与取消**经通用登记表（`session-control.ts`），沙箱内外相同；尚未开始的输入被取消时不再启动。Claude 的 steer 注入进行中的回复；Codex SDK 不支持 steer 进行中的回合，消息留在队列等下一回合（`daemon/session-execution.ts`）。
- **存活不看静默。** 回合在 Agent 进程还在时就算活着；超出运行时自身上限的操作只发 Notice、不杀进程；只有启动阶段卡住才失败，12 小时为最后上限（`watchdog.ts`，细节见 [Daemon 生命周期 §6](daemon-lifecycle.md#6-liveness-layers)）。空闲的 SDK 运行时按 TTL 回收，忙的不回收（`runner/active-runtimes.ts`）。
- **恢复问设备（M3-2，2026-09-28）。** Worker 重连时在 hello 中声明本进程正在执行的会话，Server 只认精确的（设备，会话）声明；仍记为运行中、但新进程未声明的输入，Server 发 `recover_session`，设备按每个输入的完成标记回报结果，没有标记就回报"结果随上一个进程丢失"（`daemon/handlers/sessions.ts`、`apps/server/internal/httpapi/agent_session_recovery.go`）。Issue 的会话随 Issue 恢复。
- **凭据进会话的方式**见[安全边界 · Agent Credentials](security.md)：会话令牌交给 Agent 而不交给它运行的命令；沙箱会话只拿到设备 Claude / Codex 登录的 access token、从不拿 refresh token（`session/provider-credentials.ts`）；transcript 离开设备前去掉已知令牌与常见密钥形态（`secret-redaction.ts`）。

### Sandbox

**沙箱只管操作系统才拦得住的两件事（2026-09-26 定）**：写边界（Issue 只写自己的候选与 scratch，澄清与判定对所看内容只读），以及治理状态不可读（`~/.foundry`、`~/.foundry-stacks` 与当前状态根，运行目录下的 Server 数据；`sandbox/host.ts` 的 `governanceStatePaths`、`runtimeServerData`）。职责分离由身份与流程保证（Agent 令牌够不着确认、判定与 Accept 接口），控制面端口不再封锁，设备上已安装的软件始终可读。理由与取舍见[模块化架构 §5.1](architecture-modules.md#51-sandbox)。

调用方只描述路径与限制，四种 profile（`types.ts` 的 `SandboxProfile`）、两个后端用同样的调用：`sandboxLaunch` / `sandboxLauncher` / `sandboxAvailable`（`sandbox/index.ts`）。没有已验证的后端或输入无效时抛带 code 的 `SandboxError`，**永不回退到无隔离执行**。

| profile            | 限制                                                                 | 使用方                                                                                          |
| ------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `writable_tree`    | 只写写根；治理状态不可读；`userFiles` 决定能否读用户自己的配置与凭据 | Issue 执行、preview、带 Issue 的编排子会话；澄清与 verifier（Workspace 只读，只写私有 scratch） |
| `readonly_agent`   | 只读系统目录与读根，只写私有 home                                    | Issue 的独立判定（`startSession`）                                                              |
| `offline_command`  | 断网，只写输出目录                                                   | 程序检查、按锁文件离线准备依赖                                                                  |
| `loopback_service` | 不写、不出网，只在本机提供服务                                       | 受控 HTTP 目标                                                                                  |

| 后端                                   | 实现                                                                                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS Seatbelt（`sandbox/darwin.ts`）  | `sandbox-exec` 规则文本；`loopback_service` 只能在回环上监听                                                                                                                                                                                |
| Linux bubblewrap（`sandbox/linux.ts`） | 启动前探测 user namespace；独立 user / pid / ipc 命名空间，挂载 Node 与 CLI 的安装前缀、重建 merged-`/usr` 链接；`offline_command` 用 `--unshare-all`；`loopback_service` 有自己的网络命名空间，经 Unix socket 由 Worker 转接到 `127.0.0.1` |
| 其他系统                               | 无后端，`unsupported_platform`，需要沙箱的工作被拒绝                                                                                                                                                                                        |

**`userFiles` 按发起人决定。** Issue 由设备所有者本人发起时为 `readable`（像在本人终端里一样读 home 与凭据），他人发起时为 `hidden`，由 Server 在派发 `run_issue` 时判断（`execution-sandbox.ts`、`daemon/handlers/issues.ts`）。澄清固定为 `hidden`；verifier 为 `readable`，以便运行本人安装的工具链（`verification-session.ts`）。

**Chat 不经沙箱，这是设计而非缺口。** Chat 是最基础的能力，直接在原始 Workspace 中工作，变更直接生效；隔离、证据与人工接受是 Issue 这类流程提供的保证。Issue 之外的编排子会话同样在宿主上运行，verifier 例外。

## 实现边界

截至 2026-10-14（`3092162`）。

**已实现**

- Session Runtime：两个入口 `runWorkspaceSession`（`packages/worker/src/session/workspace.ts`）与 `startSession`（`session/index.ts`）；Claude / Codex 适配（`runner/`、`session/claude.ts`、`session/codex.ts`）；steer / 取消登记（`session-control.ts`）；回合存活（`watchdog.ts`）；输入的完成标记与 `recover_session`；进程组回收（`process-group.ts`）。
- Sandbox：四种 profile 在 macOS 与 Linux 两个后端上均已实现（`sandbox/darwin.ts`、`sandbox/linux.ts` 的 `kinds`）。Issue 与 evidence 侧只把自己的信息翻译成 profile（`execution-sandbox.ts`、`evidence-command-sandbox.ts`、`evidence-http-service.ts`）。
- Linux 上的受控 HTTP 目标（2026-09-28，`c671f3c`）；以 root 运行的 Worker 也能执行 Issue，执行环境如实声明自己在沙箱内（2026-10-04，#93，`executorEnvironment`）。

**未实现 / 已知缺口**

- 没有 Docker 后端，Docker 只是部署方式；容器里的 Worker 没装 bubblewrap，不能执行 Issue（[部署指南](../deploy/README.md)）。
- 不在沙箱里的会话（Chat、Issue 之外的编排子会话）能读到设备凭据 `~/.foundry/daemon-config.json`，以及同一用户其他进程的环境与内存；两个方向（所有会话都加 OS 隔离、把凭据移出 Agent 可读范围）尚未选定（[安全边界 · Known risk](security.md)）。
- 沙箱会话拿到的 provider access token 仍是 Agent 可读的明文；`userFiles: readable` 时，宿主上的其他凭据（如浏览器 cookie）同样可读。
- 部署、发消息等外部副作用没有按次授权。
- 执行、澄清、verifier 与判定的沙箱不限制网络出站（模型调用需要网络）；只有程序检查与受控 HTTP 目标断网。
- 只支持 macOS 与 Linux 两种后端，其他系统上需要沙箱的工作被拒绝。

**验证情况**

- 有真实运行记录：M1 验收（2026-09-26 收尾）用 `scripts/verify-issue-live.mjs` 在 Linux 上以 Claude 跑通沙箱内执行、中断恢复与多仓合入，并做了 Chat 真实浏览器回归（[§5.5](architecture-modules.md#55-m1-验收)）；2026-10-02 Linux 上以 Codex 跑通 Issue 闭环（澄清、执行、程序检查、独立判定、接受与合入）；2026-10-04 Mac 真机（0.5.2）上 Worker 测试套件（含 Seatbelt）通过，一个真实 Issue 在 Mac 沙箱中执行并接受合入（[实机回归](live-regression.md)）。只读 verifier（C15）与 Worker 重启后的孤儿输入（C19）最近一次通过是 2026-09-29。
- 只有代码与测试：此后 verifier 的改动（#122、#123：沙箱内 verifier、Codex verifier 可运行命令）、沙箱会话只拿 access token（#123）、以 root 运行（#93）没有带日期的实机回归记录。模块测试见 `packages/worker/test/sandbox.test.mjs`、`session-runtime.test.mjs`、`session-recovery.test.mjs`、`evidence-agent-sandbox.test.mjs`。
- 不在 CI 中的：C10、C20 仍是手工步骤，C19 只在显式 `--kill-worker` 时运行。

## 后续

配置来源隔离、公共启动准备的封装重构及已知回归修复，见[会话隔离与 Workspace Skill 草稿方案](session-isolation-design.md)（实施中；[第一批范围与验证](session-isolation-implementation-20261019.md)、[草稿与生命周期接续验证](session-isolation-drafts-20261019.md)）。方案保留普通执行和独立判定两个入口，共用配置、凭据和材料准备，不改变现有 Chat 文件权限边界。

与 [Roadmap](../README.md#roadmap) 一致，下一步是 Sandbox 隔离补全：

- **Docker 容器隔离**：作为第三种 `SandboxBackend`，按 Workspace 选择，面向 Linux 服务器、团队共用机器与需要可复现环境的项目；独立根文件系统与资源限额。取舍（只能用镜像里的工具链、macOS 上经虚拟机运行、worktree 的 `.git` 路径挂载、容器内 Worker 需要宿主 docker.sock）见[模块化架构 §5.1](architecture-modules.md#51-sandbox)。
- **凭据不以明文交给 Agent**：模型与内部服务的凭据留在设备或受控的密钥存储中（[总纲 §4.1](workspace-sandbox-overview.md#41-隔离)），并收口上面"不在沙箱里的会话能读设备凭据"的已知风险。
- **外部副作用按次授权**：部署、发消息、写外部数据需要执行当时单独授权，接受不能追认此前的副作用。

## 代码位置

- Session Runtime：`packages/worker/src/session/`（`index.ts`、`workspace.ts`、`host-child.ts`、`policy.ts`、`provider-credentials.ts`）、`runner/`、`session-roles.ts`、`session-control.ts`、`watchdog.ts`、`sdk-messages.ts`、`daemon/session-execution.ts`、`daemon/handlers/sessions.ts`
- Sandbox：`packages/worker/src/sandbox/`（`index.ts` 对外接口，`types.ts` profile，`host.ts` 平台无关的路径规则，`darwin.ts`、`linux.ts` 后端）
- 把业务翻译成 profile 的调用方：`execution-sandbox.ts`、`issue-sessions.ts`、`issue-clarification.ts`、`verification-session.ts`、`evidence-command-sandbox.ts`、`evidence-http-service.ts`
- Server 侧：`apps/server/internal/httpapi/session_dispatch.go`（派发）、`agent_session_recovery.go`（恢复）、`policy.go`（`agentRouteAllowed`）
- 符号级流程：[Daemon 生命周期](daemon-lifecycle.md)
