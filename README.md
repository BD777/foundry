<h1 align="center">
  <img src="apps/web/public/foundry-icon.png" alt="" width="48" height="48" align="absmiddle" />
  Foundry
</h1>

<p align="center"><strong>以 Workspace 为唯一真相源，让 Agent 并发工作，经验证与人工接受，推动项目成果与工作能力共同演进。</strong></p>

<p align="center">简体中文 | <a href="docs/README.en.md">English</a></p>

<p align="center"><a href="#快速开始">快速开始</a> · <a href="#文档">文档</a> · <a href="#roadmap">路线图</a> · <a href="https://github.com/BD777/foundry/issues">反馈问题</a></p>

Foundry 是一个围绕 Workspace 演进的 AI 工作平台：在你自己的设备上运行原生 Claude Code / Codex，让 Agent 在同一个项目中并发工作，被接受的成果回到 Workspace，成为下一次工作的起点。

## Foundry 是什么

**任何项目都需要一个 Workspace。** 写代码、写小说、做研究、整理文档，Agent 都要从项目当前的状态开始工作。Workspace 是项目的唯一真相源，也是 Agent 的上下文：其中既有成果（代码、文稿、数据），也有方法（Skill、工具与规则）。每一次被接受的改动都让 Workspace 前进一步，下一次工作就站在更好的上下文上。Foundry 要做的，是让这种演进可以由多个 Agent 安全、持续地推动。

<p align="center">
  <img src="docs/assets/architecture.svg" alt="Foundry 架构：入口、Personal Agent、工作流建立在基础能力之上，全部围绕 Workspace 演进" width="900" />
</p>

- **基础能力是 Foundry 的核心。** 执行（原生 Agent 会话、多设备、Foundry MCP / CLI）、隔离与合入（Git worktree 候选、Sandbox、合入队列与冲突解决）、验证（证据、独立判定、人工接受）、能力供给（Resources、Skills、模型、连接器、渠道）与信任（身份、角色、凭据边界）。
- **工作流是基础能力的组合。** **Chats** 是最直接的路径：Agent 直接改 Workspace，隔离与验证由人自己把关，这也是最常用的方式。**Issues** 在此之上组合隔离、证据、人工接受与合入，是一条可信交付流程。以后可以用同样的基础能力搭自己的工作流（插件，尚在设计）。
- **Personal Agent 在工作流之上。** 人只说想要什么，它判断落到哪个 Workspace、按需新建，再派出并监督那里的会话。
- **入口**：Web、外部 Agent（经 `foundry` CLI / MCP）与 IM 渠道（飞书 Bot）。

隔离、合入与证据目前由 Issues 实现，正在抽成独立的基础能力，让其他工作流也能使用（[设计](docs/workflow-platform.md)）。

## Roadmap

各层模块现在能做什么。每个模块的待办、依赖与完成标准只在 **[docs/roadmap.md](docs/roadmap.md)** 维护，模块名链接到对应小节。

### 工作流

- **[Chats](docs/roadmap.md#chats)**：直接在所选 Workspace 中对话；附件、Server 侧排队、steer、中断恢复、会话产出与 diff、后台任务、分组与检索。设计：[chat-experience.md](docs/chat-experience.md)
- **[Issues](docs/roadmap.md#issues)**：准出条件 → 候选中执行 → 证据与独立判定 → 人接受 → 合入；Claude 与 Codex、macOS 与 Linux 都跑通过真实闭环，新功能暂停等真实使用反馈。设计：[issue-workflow.md](docs/issue-workflow.md)
- **[自定义工作流](docs/roadmap.md#自定义工作流)**：规划中，未实现。设计：[workflow-platform.md](docs/workflow-platform.md)

### 基础能力

- **执行**
  - [原生 Agent 会话](docs/roadmap.md#原生-agent-会话)：一个会话就是设备上的一个原生会话，事件流、steer、取消与恢复，跟随官方 stable 更新。设计：[execution-kernel.md](docs/execution-kernel.md)
  - [设备与 Daemon](docs/roadmap.md#设备与-daemon)：Daemon 主动连接、配对与自动更新，多设备多 Workspace，跨设备会话，[Docker 部署](deploy/README.md)。设计：[devices-and-workspaces.md](docs/devices-and-workspaces.md)
  - [Foundry MCP / CLI](docs/roadmap.md#foundry-mcp--cli)：Agent 调用 Foundry 的唯一接口：派出、观察、steer、交接会话，租用资源，使用连接器。设计：[session-orchestration-design.md](docs/session-orchestration-design.md)
- **隔离与合入**
  - [候选与 Sandbox](docs/roadmap.md#候选与-sandbox)：每项任务一份 Git worktree 候选；Sandbox 在 macOS 与 Linux 实现同一接口，只许写候选，其他系统 fail closed。
  - [合入队列与冲突解决](docs/roadmap.md#合入队列与冲突解决)：接受后逐个合入；Workspace 已前进时在候选中对齐，冲突交给 Agent 解决并重新验证。
- **验证**
  - [证据与判定](docs/roadmap.md#证据与判定)：对候选实际运行检查并保存原始材料，程序或独立只读 Agent 逐条判断，人基于证据接受。设计：[evidence-and-verify-v1.md](docs/evidence-and-verify-v1.md)
- **能力供给**
  - [Resources](docs/roadmap.md#resources)：Computer Use 与远程命令独占租用、排队与回收，可跨设备；浏览器按需启动。设计：[resources.md](docs/resources.md)
  - [Skills](docs/roadmap.md#skills)：Skill 库与不可变版本，Workspace 选用与固定，个人默认，草稿试用。设计：[skills.md](docs/skills.md)
  - [模型与账号](docs/roadmap.md#模型与账号)：设备原生登录与官方安装，模型服务（API 或网关）。设计：[models-and-accounts.md](docs/models-and-accounts.md)
  - [连接器](docs/roadmap.md#连接器)：Server 持有型（飞书、Cloudflare）与设备持有型（bytedcli、AWS CLI），按 Workspace 绑定。设计：[connectors.md](docs/connectors.md)
  - [渠道](docs/roadmap.md#渠道)：飞书 Bot 把群或单聊配对到 Workspace，话题对应会话，流式卡片与附件。设计：[channels.md](docs/channels.md)
- **信任**
  - [身份与共享](docs/roadmap.md#身份与共享)：所有接口要求登录，按 Viewer / Member / Maintainer / Owner 共享 Workspace，撤销立即生效。设计：[accounts-permissions-design.md](docs/accounts-permissions-design.md)

### Workspace

- **[Workspace](docs/roadmap.md#workspace)**：设备上的一个目录，可包含任意深度的多个 Git 仓库；Foundry 不改动它，没有 Git 的目录在第一次需要候选时经本人确认初始化。

### Personal Agent

- **[Personal Agent](docs/roadmap.md#personal-agent)**：测试中（2026-10-15 起本人在 dev 试用），路由准确率仍在提升；Web 首页与飞书单聊入口。设计：[personal-agent.md](docs/personal-agent.md)

## 快速开始

### 环境准备

- Node.js 22
- pnpm 11.7.0
- Go 1.24.0 或更高版本（以 [go.mod](apps/server/go.mod) 为准）
- Git；本地 Worker 支持 macOS 和 Linux，Linux 的 Issue 执行需要 bubblewrap 和可用的 user namespace。Issue 的澄清、独立判定与 Accept 集成在两个平台都可用；Linux 上受控 HTTP 目标暂不可用。Issue 在沙箱中只写自己的候选、读不到 Foundry 自身的凭据与状态；由你本人发起的 Issue 可以使用你本机的配置与凭据。Chat 在两个平台都可用，且不经沙箱。

### 安装与启动

```bash
git clone https://github.com/BD777/foundry.git
cd foundry
pnpm install
```

在两个终端中分别启动服务端和 Web 应用：

```bash
pnpm dev:server
```

```bash
pnpm dev:web
```

打开 [http://127.0.0.1:31983](http://127.0.0.1:31983/)。

### 连接本地 Worker

在网页里打开“设备 → 添加设备”，生成配对命令，在要干活的机器上运行（macOS 或 Linux，Node.js 20 或更高）。命令从 npm 安装 Worker、用一次性配对码配对，并设为登录时启动（Linux 用 systemd 用户服务；没有 systemd 的环境会打印前台启动命令）：

```bash
npx -y @bd777/foundry-worker@latest install --server http://127.0.0.1:31982 --token <配对码> --workspace /absolute/path/to/workspace
```

Worker 使用这台机器自己的 Claude Code 或 Codex，不另带一份。没装的话，在“设备 → 模型与账户”里点“安装”，Worker 会在这台设备上运行官方安装命令（Claude Code：`curl -fsSL https://claude.ai/install.sh | bash`；Codex：`curl -fsSL https://chatgpt.com/codex/install.sh | sh`），也可以自己运行；装好后用 `claude` 或 `codex login` 登录，再点“重新检查”。版本低于 Foundry 所需（Claude Code 2.1.201、Codex 0.142）时仍可使用，但页面会提示升级命令（Claude Code 用 `claude update`；Codex 按它的安装方式，例如重新运行官方安装脚本或 `npm install -g @openai/codex@latest`）。也可以在“模型服务”里配置 API 或网关。

Worker 以 root 运行时，Issue 照常执行（它在 Foundry 的沙箱里）；对话里 Claude Code 不允许以 root 身份跳过权限确认，请为对话选择其他权限模式，或用普通用户运行 Worker。

从源码运行 Worker（开发用）时，同样需要配对码：

```bash
pnpm --filter @bd777/foundry-worker foundry-worker -- setup --server http://127.0.0.1:31982 --workspace /absolute/path/to/workspace --token <配对码>
```

更多安装选项、认证配置、预览与排查说明见[开发指南](docs/development.md)。

## 项目结构

```text
apps/web/          React / Vite 界面
apps/server/       Go API、SQLite 状态投影与 Worker 通信
packages/worker/   本地 Agent 执行、文件、worktree 与预览
packages/protocol/ 组件间共享协议
docs/              使用指南、产品设计、架构与研究
cases/             产品回归场景与验证要求
```

服务端负责控制与状态投影，Worker 负责实际执行。数据存放、凭据处理和远程访问规则见[安全边界](docs/security.md)。

## 文档

| 文档                                       | 内容                                    |
| ------------------------------------------ | --------------------------------------- |
| [文档索引](docs/README.md)                 | 全部文档的分类入口                      |
| [开发指南](docs/development.md)            | 安装、运行、Worker 配置与验证           |
| [并行开发栈](docs/dev-stacks.md)           | 多套 Foundry 同时开发的隔离栈与体检工具 |
| [产品理念](docs/philosophy.md)             | 项目目标与工作闭环                      |
| [技术架构](docs/technical-selection.md)    | 组件职责与技术选型                      |
| [总纲](docs/workspace-sandbox-overview.md) | Workspace、Sandbox 与 Issue 的整体设计  |
| [Roadmap](docs/roadmap.md)                 | 按模块的现状、待办与完成标准            |

## 参与贡献

欢迎通过 [Issue](https://github.com/BD777/foundry/issues) 反馈问题、讨论需求，或提交 Pull Request。问题反馈请尽量附上复现步骤、运行环境和相关日志，并移除凭据等敏感信息。

开始修改前，请阅读 [AGENTS.md](AGENTS.md) 和[开发指南](docs/development.md)；当前工作上下文见 [CONTEXT.md](CONTEXT.md)。提交前运行项目回归检查：

```bash
pnpm regression:commit
```

涉及可观察行为的功能或修复，请同步维护[回归场景](cases/README.md)。修改项目介绍或启动方式时，请同步更新[英文 README](docs/README.en.md)。

## 许可证

本项目基于 [Apache License 2.0](LICENSE) 开源。
