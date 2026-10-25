# Foundry Roadmap

[项目主页](../README.md) · [文档索引](README.md) · [Devlog](devlog/README.md)

本页是**唯一的 Roadmap 与待办清单**，按[架构图](#架构)的层组织，2026-10-26 校准到 main。每个模块写四件事：
它负责什么、现在能做什么、接下来做什么（带完成标准）、详细设计在哪里。

- **一项待办只在这里出现一次。** 模块文档保留设计与[实现边界](README.md#modules)（以代码与验证为准的现状），
  不再各自维护待办清单；Devlog 记录已启动事项的执行过程与证据（部署、自验、验收），用 `DEV-NNN` 编号，
  在这里的“详情”列链接过去。一项待办的分步细节（例如 WF-1–WF-5）写在设计文档里，这里只链接。
- **状态**：`进行中`（已有负责会话或分支）· `待验收`（已交付到 dev 或 main，等真实账号或本人确认）·
  `下一步`（已确定要做，未开工）· `待定范围`（要做，但范围或方案要先定）· `探索`（未排期）· `暂停` · `等外部`。
- **编号**一经使用不再复用；事项移到别的模块时保留原编号（例如 EK-2 现在在“信任”下）。
  新增模块要同时更新架构图（`assets/architecture.mjs`）、本页与[文档索引](README.md#modules)。

## 架构

<p align="center">
  <img src="assets/architecture.svg" alt="Foundry 架构：入口、Personal Agent、工作流建立在基础能力之上，全部围绕 Workspace 演进" width="900" />
</p>

Foundry 的核心是**基础能力**；**工作流**是基础能力的组合（Chats 是最直接的一条路径，Issues 加上隔离、验证与接受，自定义工作流是规划中的插件）；
所有工作都围绕 **Workspace** 演进。图由 [architecture.mjs](assets/architecture.mjs) 生成。层规则与代码模块见[模块架构](architecture-modules.md)。

| 层                                    | 模块                                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [入口](#入口)                         | Web · 外部 Agent（经 [Foundry MCP / CLI](#foundry-mcp--cli)）· 渠道入口（经[渠道](#渠道)）                            |
| [Personal Agent](#助理personal-agent) | [Personal Agent](#personal-agent)                                                                                     |
| [工作流](#工作流)                     | [Chats](#chats) · [Issues](#issues) · [自定义工作流](#自定义工作流)                                                   |
| [基础能力](#基础能力)                 | 执行：[原生 Agent 会话](#原生-agent-会话) · [设备与 Daemon](#设备与-daemon) · [Foundry MCP / CLI](#foundry-mcp--cli)  |
|                                       | 隔离与合入：[候选与 Sandbox](#候选与-sandbox) · [合入队列与冲突解决](#合入队列与冲突解决)                             |
|                                       | 验证：[证据与判定](#证据与判定)                                                                                       |
|                                       | 能力供给：[Resources](#resources) · [Skills](#skills) · [模型与账号](#模型与账号) · [连接器](#连接器) · [渠道](#渠道) |
|                                       | 信任：[身份与共享](#身份与共享)                                                                                       |
| [Workspace](#workspace唯一真相源)     | [Workspace](#workspace)                                                                                               |
| 跨模块                                | [文档](#文档)                                                                                                         |

## 入口

人和外部 Agent 从哪里进来。入口本身没有单列待办：Web 的结构见 [Web 架构](../apps/web/src/ARCHITECTURE.md)；外部 Agent 经 [Foundry MCP / CLI](#foundry-mcp--cli)；飞书 Bot 是[渠道](#渠道)能力的入口用法。

## 助理（Personal Agent）

跨 Workspace 的一层：判断落到哪里、按需新建或调整 Workspace，再派出并监督会话。它本身也是一个 Workspace。

### Personal Agent

**负责**：人只说想要什么，由它判断落到哪个 Workspace、按需新建或调整，再派出并监督会话。**设计**：[personal-agent.md](personal-agent.md)。

**现在**：测试中（2026-10-15 起本人在 dev 试用）。设计中的全部工作包已实现并集成；验收 A1–A11 中 A3（排序 top-1 ≥ 90%）与 A4（两个候选接近时只问一句）未达标；端到端路由约 80%（[实现边界](personal-agent.md#实现边界)）。交付记录：[DEV-023](devlog/DEV-023-implementation.md)。

| ID   | 事项                                   | 状态   | 依赖                                    | 完成标准                                                                   | 详情                                            |
| ---- | -------------------------------------- | ------ | --------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------- |
| PA-1 | 路由准确率                             | 下一步 | —                                       | 评测集上 A3、A4 达标（[§13](personal-agent.md#13-评测)），留出集上同样提升 | DEV-011                                         |
| PA-2 | 试用收尾：账号选择、监督行为、完整评测 | 下一步 | —                                       | 按 [§13](personal-agent.md#13-评测) 跑完整评测并复核验收清单               | DEV-011                                         |
| PA-3 | 没有自己电脑的人：在共享执行端安放助理 | 探索   | [EK-2](#身份与共享)（非所有者会话隔离） | 非所有者的会话在 Sandbox 中运行后再立项                                    | [personal-agent · 后续](personal-agent.md#后续) |
| PA-4 | 语音入口；按评测结果放宽默认策略       | 探索   | PA-1                                    | —                                                                          | 同上                                            |

## 工作流

工作流是基础能力的组合，决定什么时候隔离、要什么证据、在哪里由人决定。

### Chats

**负责**：在所选 Workspace 中直接与原生 Claude Code / Codex 对话，一个 Foundry 会话就是一个原生会话。这是让 Workspace 演进的最直接路径：改动直接写入 Workspace，隔离与验证由人自己把关。**设计**：[chat-experience.md](chat-experience.md)，相关的[会话模型](session-model.md)、[会话列表](chat-list-design.md)、[对话管线](chat-transcript-design.md)、[轮次导航](chat-turn-navigator-design.md)。

**现在**：附件、Server 侧排队、steer、中断恢复、会话产出与 diff、后台任务与定时器、分组与检索、Session 间协作。交付记录：[DEV-036 发送恢复](devlog/DEV-036-workspace-registry-recovery.md)（已合入，待本人收发验收）、[DEV-022 原生持续工作面板](devlog/DEV-022-native-work.md)、[DEV-039 错误诊断展示](devlog/DEV-039-worker-failure.md)（已合入，待验收）。

| ID     | 事项                                                     | 状态     | 依赖                    | 完成标准                                                                                  | 详情                                                          |
| ------ | -------------------------------------------------------- | -------- | ----------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| CHAT-1 | 跟随原生 Agent 演进（持续）                              | 进行中   | —                       | 每个新 stable 版本：transcript 不丢、不重复、未知事件可读降级；新能力按接入顺序登记到本行 | [跟随原生 Agent 演进](chat-experience.md#跟随原生-agent-演进) |
| CHAT-2 | 输入框文本动作：翻译、润色、选词释义                     | 待定范围 | —                       | 三个内置预设；结果以 diff 或浮层呈现，用户点击接受才写回草稿；推理只走 Agent SDK          | [插件体系调研](research/plugin-system.md)、DEV-010            |
| CHAT-3 | 实机回归补齐：Worker 重启用例 C10、C20 自动化，C19 进 CI | 下一步   | —                       | 三个用例无需手工步骤即可运行并有最近一次通过记录                                          | [实机回归 §3](live-regression.md#3-覆盖缺口待补)              |
| CHAT-4 | Issue 对话的排队消息移到 Server（与 Chat 一致）          | 下一步   | —                       | 关闭所有标签页后 Issue 的排队消息仍恰好发送一次                                           | [chat-experience · 实现边界](chat-experience.md#实现边界)     |
| CHAT-5 | 隔离模式的 Chat：在候选中工作，接受后经合入队列          | 探索     | [WF-3](#候选与-sandbox) | 普通 Chat 行为不变；隔离模式的改动未经接受不进入 Workspace                                | [工作流与基础能力](workflow-platform.md)                      |

### Issues

**负责**：内置的可信交付工作流：人提出目标与准出条件，Agent 在候选中实现并拿出证据，人基于证据接受后合入。它组合了隔离与合入、验证两组基础能力。**设计**：[issue-workflow.md](issue-workflow.md)，相关的 [Issue 对话与状态](issue-conversation-design.md)、[Evidence & Verify v1](evidence-and-verify-v1.md)、[多仓执行](issue-workspace-execution.md)、[准出标准](foundry-conversation-release-gate.md)。

**现在**：澄清 → 确认契约 → 候选中执行（可派协作会话、`ask_person`）→ 证据采集、程序检查与独立 Agent 判定 → 人接受 → 对齐并逐仓合入；Claude 与 Codex、macOS 与 Linux 都跑通过真实闭环。**新功能暂停**，等真实使用反馈（DEV-018）。

| ID    | 事项                                | 状态   | 依赖                    | 完成标准                                                                                           | 详情                                                     |
| ----- | ----------------------------------- | ------ | ----------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| ISU-1 | 2026-10-04 之后改动的端到端回归     | 下一步 | —                       | 按[准出标准](foundry-conversation-release-gate.md) G1–G5 在真实浏览器重跑一次 Claude 与 Codex 闭环 | [issue-workflow · 验证情况](issue-workflow.md#实现边界)  |
| ISU-4 | CI 结果作为反馈来源                 | 探索   | —                       | 候选在 CI 上的结果带来源记录回到 Issue                                                             | [issue-workflow · 后续](issue-workflow.md#后续)          |
| ISU-5 | 同一 Issue 的不同步骤交给不同 Agent | 探索   | [WF-3](#候选与-sandbox) | 对用户仍是一段对话；每一步可选 Harness 与模型                                                      | [Issue Multi-Agent](issue-workflow.md#issue-multi-agent) |
| ISU-6 | Issue 成为内置工作流                | 探索   | [WF-4](#自定义工作流)   | 见[自定义工作流](#自定义工作流)                                                                    | [工作流与基础能力](workflow-platform.md)                 |

Evidence v1 收口（ISU-2）与工具类证据（ISU-3）属于[证据与判定](#证据与判定)。

### 自定义工作流

**负责**（规划）：让用户用基础能力组合自己的工作流，Issue 成为第一个按同一接口注册的内置工作流。**设计**：[workflow-platform.md](workflow-platform.md)（提案，未实现）。

**现在**：未实现。工作流的路由、MCP 工具、页面与渠道命令都直接写在 Issue 模块中。

| ID   | 事项                                              | 状态 | 依赖 | 完成标准                                            | 详情                                      |
| ---- | ------------------------------------------------- | ---- | ---- | --------------------------------------------------- | ----------------------------------------- |
| WF-4 | 工作流宿主：Issue 经注册接入路由、MCP、导航、渠道 | 探索 | WF-3 | 去掉 Issue 模块其余产品仍能编译运行；Issue 行为不变 | 同上                                      |
| WF-5 | 声明式或第三方工作流                              | 探索 | WF-4 | 第二个内置工作流上线并有真实需求后再立项            | [插件体系调研](research/plugin-system.md) |

## 基础能力

Foundry 的核心。工作流只组合它们；保证 Workspace 安全演进的规则（只有被接受的候选才合入、Agent 不能批准自己的工作）由基础能力自己执行，任何工作流都不能绕过。

### 执行

#### 原生 Agent 会话

**负责**：以统一方式启动设备上的原生 Claude Code / Codex 会话（Session Runtime），负责事件流、steer、取消、存活判断与重启后的恢复。**设计**：[execution-kernel.md](execution-kernel.md#session-runtime)，相关的[会话模型](session-model.md)、[会话隔离与 Skill 草稿](session-isolation-design.md)、[Daemon 生命周期](daemon-lifecycle.md)。

**现在**：一个会话就是一个原生会话；Claude 经 Agent SDK、Codex 经 app-server；Worker 跟随官方 stable 自动更新。交付记录：[DEV-038 启动准备复用](devlog/DEV-038-skill-preparation.md)、[DEV-039 Worker 错误诊断](devlog/DEV-039-worker-failure.md)（已合入，待验收）。

暂无单列待办；跟随原生能力演进见 [CHAT-1](#chats)。

#### 设备与 Daemon

**负责**：Daemon 连接、配对与更新，多设备、多 Workspace 登记，跨设备启动会话，部署形态。**设计**：[devices-and-workspaces.md](devices-and-workspaces.md)，相关的 [Daemon 生命周期](daemon-lifecycle.md)、[并行开发栈](dev-stacks.md)、[Docker 部署](../deploy/README.md)。

**现在**：Daemon 主动连接 Server；配对、登录时启动、由 Server 下发 Worker 更新；跨设备启动会话；Workspace 本地 Web 服务经账号鉴权的隧道访问。交付记录：[DEV-032 设备生命周期](devlog/DEV-032-device-lifecycle.md)、[DEV-034 服务隧道](devlog/DEV-034-authenticated-service-tunnels.md)（同站加固已上线，公网未准出）。

| ID   | 事项                       | 状态   | 依赖 | 完成标准                                          | 详情    |
| ---- | -------------------------- | ------ | ---- | ------------------------------------------------- | ------- |
| WS-1 | Workspace 服务隧道公网准出 | 待验收 | —    | 公网访问按 Workspace 三级归属鉴权，真实浏览器验收 | DEV-034 |

#### Foundry MCP / CLI

**负责**：Agent 调用 Foundry 的唯一接口（Foundry MCP 与 `foundry` CLI），工具只在 Server 实现一次。**设计**：[session-orchestration-design.md](session-orchestration-design.md)。

**现在**：Claude 与 Codex 会话注入同一套 MCP：派出、观察、steer、交接会话，读其他会话及其产出，租用资源，使用连接器，查看模型服务（`list_profiles` / `list_models`）。交付记录：[DEV-027 子会话与原生委派的边界](devlog/DEV-027-delegation-policy.md)、[DEV-040](devlog/DEV-040-provider-endpoint.md)（已合入，待验收）。

| ID    | 事项                                    | 状态   | 依赖 | 完成标准                                                  | 详情                                                 |
| ----- | --------------------------------------- | ------ | ---- | --------------------------------------------------------- | ---------------------------------------------------- |
| MCP-1 | `foundry` CLI 在真实的外部 Agent 中验证 | 下一步 | —    | 一个 Foundry 之外的 Agent 经 CLI 完成派出、观察与读取产出 | [实现边界](session-orchestration-design.md#实现边界) |
| MCP-2 | HTTP MCP 的 OAuth 2.1                   | 探索   | —    | 出现 Foundry 之外的远程 Agent 时再立项                    | 同上                                                 |

### 隔离与合入

#### 候选与 Sandbox

**负责**：每项任务一份候选 Workspace（Git worktree，不做整份复制），以及按隔离 profile 施加写边界、隐藏 Foundry 治理状态的 Sandbox。**设计**：[execution-kernel.md](execution-kernel.md#sandbox)、[多仓执行](issue-workspace-execution.md)、[工作流与基础能力](workflow-platform.md)。

**现在**：Sandbox 在 macOS（Seatbelt）与 Linux（bubblewrap）实现同一接口，其他系统 fail closed。候选已可用，但实现在 Issue 内部、以 Issue 命名（`IssueEnvironment`）；Chats 不经候选与 Sandbox 是设计。

| ID   | 事项                                  | 状态   | 依赖 | 完成标准                                                                    | 详情                                                |
| ---- | ------------------------------------- | ------ | ---- | --------------------------------------------------------------------------- | --------------------------------------------------- |
| WF-1 | 共享底层去掉 Issue 命名，审计锁住边界 | 探索   | —    | 新审计规则通过；Issue 测试不改断言全部通过；两个平台各跑一次真实 Issue 闭环 | [迁移步骤](workflow-platform.md#迁移步骤)、DEV-021  |
| WF-3 | 候选成为平台 API，第二个使用方落地    | 探索   | WF-2 | Issue 与第二个使用方（例如 CHAT-5）都只经平台接口；旧 Worker 仍能执行 Issue | 同上                                                |
| EK-1 | Docker 容器隔离后端                   | 下一步 | —    | 作为第三种 `SandboxBackend` 按 Workspace 选择；容器内 Worker 能执行 Issue   | [execution-kernel · 后续](execution-kernel.md#后续) |

#### 合入队列与冲突解决

**负责**：被接受的候选逐个合入 Workspace；Workspace 已前进时在候选中对齐，冲突交给 Agent 解决并重新验证；部分合入可检测并恢复。**设计**：[Issue · 合入约束](issue-workflow.md#合入约束)、[工作流平台 · 合入队列](workflow-platform.md#合入队列)。

**现在**：已在 Issues 中实现：锁内核对、逐仓 fast-forward、journal 与恢复、对齐与“让 Agent 解决冲突”。“队列”只是 Worker 上每个 Workspace 一把锁，Server 上没有可见的队列对象。

| ID   | 事项                                      | 状态 | 依赖 | 完成标准                                                              | 详情 |
| ---- | ----------------------------------------- | ---- | ---- | --------------------------------------------------------------------- | ---- |
| WF-2 | 合入队列放到 Server，可见、可取消、可恢复 | 探索 | WF-1 | 两个已接受的 Issue 按顺序排队、依次合入；重启后队列与部分集成都能恢复 | 同上 |

### 验证

#### 证据与判定

**负责**：对候选实际运行命令、请求与检查并保存原始材料，由程序或独立的只读 Agent 逐条判断，结论绑定具体候选版本；人基于证据接受。**设计**：[Evidence & Verify v1](evidence-and-verify-v1.md) 与[字段表](evidence-and-verify-v1-fields.md)、[Issue · Evidence and Verify](issue-workflow.md#evidence-and-verify)。

**现在**：采集器（命令、项目命令、受控本地 HTTP、上传、候选导出）、封存的候选快照、独立判定会话、绑定审阅快照的人工接受；目前只由 Issues 使用。

| ID    | 事项                                                         | 状态 | 依赖                | 完成标准                                                       | 详情                                                    |
| ----- | ------------------------------------------------------------ | ---- | ------------------- | -------------------------------------------------------------- | ------------------------------------------------------- |
| ISU-2 | Evidence v1 收口：通用输入绑定与 Accept 前复核、完整中途恢复 | 暂停 | —                   | [v1 §9](evidence-and-verify-v1.md#9-尚需收口的实施项) 各项关闭 | DEV-018                                                 |
| ISU-3 | 浏览器、桌面、模拟器类证据                                   | 暂停 | [RES-2](#resources) | 至少一条真实工具证据链贯通，过期与失败不显示为通过             | [Tool Use 与证据契约](resources.md#tool-use-与证据契约) |

### 能力供给

会话需要的外部能力，按 Workspace 选用，凭据不跟着会话走。

#### Resources

**负责**：设备上的资源被发现、登记、租用与回收，可跨设备使用。**设计**：[resources.md](resources.md)。

**现在**：Computer Use（macOS）与远程命令经 Server 由会话独占租用、排队与回收；浏览器由会话在本机按需启动。交付记录：[DEV-028 Mac 指定 App 操作](https://dev.foundryapp.app/chats/sess_1792510285202880973)（随 #142 合入，正向实机待基线窗口）。

| ID    | 事项                                   | 状态   | 依赖 | 完成标准                                                     | 详情                                                    |
| ----- | -------------------------------------- | ------ | ---- | ------------------------------------------------------------ | ------------------------------------------------------- |
| RES-1 | 模拟器、真机接入同一生命周期           | 下一步 | —    | 申请 → 使用 → 释放 → 清理，沿用 fencing 与重置确认           | [resources · 后续](resources.md#后续)、DEV-015          |
| RES-2 | 资源操作接上证据契约                   | 下一步 | —    | 选定场景的操作结果能对应到任务、候选与环境，供证据与判定引用 | [Tool Use 与证据契约](resources.md#tool-use-与证据契约) |
| RES-3 | 多台机器共享执行与验证资源（异地验证） | 探索   | —    | 在一台机器构建、另一台验证，材料可追溯                       | [resources · 后续](resources.md#后续)                   |

#### Skills

**负责**：Skill 库、Workspace 选用与固定版本、设备物化与所需程序。**设计**：[skills.md](skills.md)，相关的[会话隔离与 Skill 草稿](session-isolation-design.md)。

**现在**：设备扫描与 git 跟随入库；Workspace 选用并可固定版本；个人默认 Skill；Workspace 草稿可试用；启动时复用已校验内容。交付记录：[DEV-006/007](devlog/DEV-006-007-isolation-drafts.md)、[DEV-038](devlog/DEV-038-skill-preparation.md)。

| ID   | 事项                             | 状态   | 依赖 | 完成标准                                                 | 详情                                     |
| ---- | -------------------------------- | ------ | ---- | -------------------------------------------------------- | ---------------------------------------- |
| SK-1 | 从 Foundry 安装 Skill 缺失的程序 | 下一步 | —    | 沿用 bundle 工具的安装路径：按设备、人点击、https 与校验 | [skills · 后续](skills.md#后续)、DEV-013 |
| SK-2 | Server 直接读取私有来源          | 下一步 | —    | 不依赖设备在线；凭据按 sealed secret 规则保存            | 同上、DEV-014                            |
| SK-3 | 原生子 Agent 的 Skill 隔离验证   | 下一步 | —    | 有独立验证后，Skill 试验可改用原生子 Agent               | [skills · 后续](skills.md#后续)          |
| SK-4 | 自动提炼与推荐 Skill             | 探索   | —    | 产物仍经人发布进库                                       | 同上                                     |

#### 模型与账号

**负责**：设备自己的 Claude Code / Codex 登录与安装、模型服务（API 或网关）、模型目录。**设计**：[models-and-accounts.md](models-and-accounts.md)。

**现在**：使用设备原生登录，缺失时按官方方式安装；模型服务保存时纠正常见的 Base URL 错误；模型目录经原生 SDK 读取并缓存。交付记录：[DEV-040](devlog/DEV-040-provider-endpoint.md)（已合入并部署，待验收）、[DEV-031 订阅额度侧栏](https://dev.foundryapp.app/chats/sess_1792568479405969993)。

| ID    | 事项                           | 状态     | 依赖                  | 完成标准                                       | 详情                                                      |
| ----- | ------------------------------ | -------- | --------------------- | ---------------------------------------------- | --------------------------------------------------------- |
| MOD-1 | Claude 登录的在线有效性        | 等外部   | 官方 SDK 提供读取方式 | 在此之前保持“本地登录，在线有效性未验证”的表述 | [models-and-accounts · 后续](models-and-accounts.md#后续) |
| MOD-2 | MacBook 真实 Keychain 登录验收 | 待定范围 | —                     | 核对旧补丁状态，在真实账号上验证登录与检查     | DEV-016                                                   |

#### 连接器

**负责**：Agent 在会话里以某个人的身份使用的外部服务。**设计**：[connectors.md](connectors.md)，统一抽象见[连接器抽象](connectors.md#连接器抽象)：连接器类型 → 持有方式（Server 持有 / 设备持有）→ 身份 → Profile（同一账号下的多个身份或范围）→ 附加授权组（同一账号下子系统的另一份授权）→ Workspace 绑定 → 会话使用。

**现在**：Server 持有型飞书、Cloudflare；设备持有型 bytedcli、AWS CLI；附加授权组框架（bytedcli 的 Meego 网页会话）；Cloudflare 的 zone 范围。交付记录：[DEV-029](devlog/DEV-029-connector-authorization.md)、[DEV-035](devlog/DEV-035-cloudflare-connector.md)、[DEV-037](devlog/DEV-037-aws-cli-connector.md)。

| ID    | 事项                                                                       | 状态   | 依赖                | 完成标准                                                                                                      | 详情                                                                          |
| ----- | -------------------------------------------------------------------------- | ------ | ------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| CON-1 | 真实账号验收：Meego 附加授权、Cloudflare 批准与资源读取、AWS STS 身份      | 待验收 | 本人操作            | 每种连接器有一次本人账号的真实完成记录；只读范围内的调用成功                                                  | DEV-029、DEV-035、DEV-037                                                     |
| CON-2 | Profile 成为一级对象：同一账号下的多个 profile 或范围可分别绑定            | 下一步 | —                   | AWS 命名 profile、bytedcli 站点可分别显示状态并绑定到 Workspace；会话只拿到所绑 profile；未绑的被隔离变量覆盖 | [连接器抽象](connectors.md#连接器抽象)                                        |
| CON-3 | 附加授权组推广到 Server 持有型                                             | 下一步 | —                   | 飞书需审批的 scope、Cloudflare 写权限按授权组单独申请、显示与撤销，不扩大基础登录                             | 同上                                                                          |
| CON-4 | 连接器的运维面：设备绑定审计、后台到期检查并经渠道提醒、Web 上查看网关审计 | 下一步 | —                   | 三项各有入口与测试                                                                                            | [connectors · 实现边界](connectors.md#实现边界)                               |
| CON-5 | 把自己的连接授权给协作者的会话使用                                         | 下一步 | [ID-1](#身份与共享) | 协作者执行记录可追溯到凭证来源；未授权的连接不可用                                                            | [账号与权限 §3.1](accounts-permissions-design.md#31-协作者的执行用谁的凭证p3) |

新连接器不需要新的待办类型：Server 持有型按 `externalaccounts.Provider` 接入，设备持有型加一条 `catalog.json` 数据和一个 Worker 适配器。

#### 渠道

**负责**：Foundry 与 IM 之间的收发：既是入口（飞书 Bot），也是工作流可用的能力（通知人、等人回复）。飞书连接器提供的其他能力（文档、日历等）属于[连接器](#连接器)。**设计**：[channels.md](channels.md)。

**现在**：飞书 Bot 把群或单聊配对到 Workspace，话题对应会话，回复以流式卡片更新，图片和文件作为会话附件；群以生成配对码的账号身份和权限执行；单聊默认交给 Personal Agent。飞书话题中的 Issue 已实现，只用模拟事件测试过。

| ID   | 事项                          | 状态   | 依赖                | 完成标准                                                                                                   | 详情                                                                                |
| ---- | ----------------------------- | ------ | ------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| CH-1 | 飞书话题中的 Issue 真实群验收 | 待验收 | —                   | 真实群中走完发起、澄清、`/confirm`、执行者提问与回答、等待验收、Web 接受，每个阶段都回到话题               | [channels · 后续](channels.md#后续)、DEV-012                                        |
| CH-2 | 按发送者本人授权              | 下一步 | [ID-1](#身份与共享) | 未绑定 Foundry 账号的飞书用户不能触发执行；群成员身份本身不授予 Workspace 或 Accept 权限；解绑后旧映射失效 | [账号与权限 §8](accounts-permissions-design.md#8-飞书bot-沿用配对人的权限)、DEV-012 |
| CH-3 | 通用 IM Adapter               | 探索   | —                   | 入站事件与出站动作有平台无关的契约；接入第二个 IM 不改任务逻辑                                             | DEV-020                                                                             |

### 信任

#### 身份与共享

**负责**：账号、设备凭证、资源归属、Workspace 四角色共享，以及凭据与外部副作用的边界。**设计**：[accounts-permissions-design.md](accounts-permissions-design.md)，安全规则见[安全边界](security.md)。

**现在**：P1 身份与隔离、P2 共享已实现：所有接口要求登录，按 Viewer / Member / Maintainer / Owner 共享，撤销立即生效。

| ID   | 事项                                                                     | 状态     | 依赖 | 完成标准                                                                                           | 详情                                                                                                    |
| ---- | ------------------------------------------------------------------------ | -------- | ---- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| ID-1 | P3 凭证与生态：个人连接 + Workspace 授权、执行凭证解析顺序、飞书身份绑定 | 下一步   | —    | 协作者执行记录可追溯到凭证来源；未授权连接不可用；未绑定飞书用户不能触发执行                       | [§9 分期](accounts-permissions-design.md#9-分期)                                                        |
| ID-2 | P4 治理：审计视图（含接受操作）、所有权转移、Admin 处置被禁用账号的资源  | 探索     | ID-1 | —                                                                                                  | 同上                                                                                                    |
| ID-3 | 设备密钥对认证                                                           | 探索     | —    | 设备凭证不再是可被未沙箱会话读取的共享秘密                                                         | [§4.1](accounts-permissions-design.md#41-设备身份与凭证)                                                |
| EK-2 | 未沙箱会话读不到设备凭据；凭据不以明文交给 Agent                         | 待定范围 | —    | 选定方向（所有会话加 OS 隔离，或把凭据移出 Agent 可读范围）；未沙箱会话读不到 `daemon-config.json` | [安全边界 · Known risk](security.md#known-risk-the-device-credential-is-readable-by-unsandboxed-agents) |
| EK-3 | 部署、发消息等外部副作用按次授权                                         | 下一步   | —    | 副作用在执行当时单独授权；之后的 Accept 不能追认                                                   | [execution-kernel · 后续](execution-kernel.md#后续)                                                     |

## Workspace（唯一真相源）

### Workspace

**负责**：项目已接受状态的唯一真相源，也是 Agent 的上下文：代码、文档、数据、研究或小说，以及 Skill、工具与规则。版本与候选基于 Git（worktree 不做整份复制）。**设计**：[总纲](workspace-sandbox-overview.md)、[理念](philosophy.md)、[设备与 Workspace](devices-and-workspaces.md)。

**现在**：Workspace 是设备上的一个目录，可以包含任意深度的多个 Git 仓库；登记与 Chat 不改动目录；没有 Git 的目录在创建第一个 Issue 时经本人确认初始化（[多仓执行](issue-workspace-execution.md)）。

| ID   | 事项                                                    | 状态     | 依赖 | 完成标准                                                                                                                                     | 详情                                                                 |
| ---- | ------------------------------------------------------- | -------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| WS-2 | 云端 Workspace                                          | 探索     | —    | 更换或断开执行端不丢已接受状态；本地与远程遵守相同的候选、验证与接受语义                                                                     | [云端 Workspace](devices-and-workspaces.md#cloud-workspace)、DEV-019 |
| WS-3 | 非代码项目：在 Git 之上用好文稿、研究、小说类 Workspace | 待定范围 | —    | 候选审阅可预览 Markdown、图片、PDF 等原文件而不只看文本 diff；二进制文件冲突在候选中有明确的取舍方式；大文件（LFS 或忽略规则）不拖慢候选创建 | [候选文件系统调研](research/workspace-candidate-filesystem.md)       |

## 文档

| ID    | 事项                             | 状态   | 依赖 | 完成标准                                                                                                                                                      | 详情    |
| ----- | -------------------------------- | ------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| DOC-1 | 模块文档实现边界的日期与代码校准 | 进行中 | —    | 本次已校准 Roadmap、连接器与 Chats；其余模块文档的“截至”日期早于 2026-10-15 的，逐个对照 main 更新（例如执行内核仍写 Codex SDK，main 上 Codex 走 app-server） | DEV-017 |

## 已迁入的历史清单

2026-10-18 盘点的待启动事项（[Devlog](devlog/README.md#待启动暂停及历史待核实事项)）已全部并入上表：

| Devlog  | 本页                          | Devlog  | 本页                       |
| ------- | ----------------------------- | ------- | -------------------------- |
| DEV-010 | [CHAT-2](#chats)              | DEV-016 | [MOD-2](#模型与账号)       |
| DEV-011 | [PA-1、PA-2](#personal-agent) | DEV-017 | [DOC-1](#文档)             |
| DEV-012 | [CH-1、CH-2](#渠道)           | DEV-018 | [Issues](#issues) 暂停说明 |
| DEV-013 | [SK-1](#skills)               | DEV-019 | [WS-2](#workspace)         |
| DEV-014 | [SK-2](#skills)               | DEV-020 | [CH-3](#渠道)              |
| DEV-015 | [RES-1](#resources)           | DEV-021 | [WF-1–WF-5](#自定义工作流) |
