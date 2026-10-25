<h1 align="center">
  <img src="../apps/web/public/foundry-icon.png" alt="" width="48" height="48" align="absmiddle" />
  Foundry
</h1>

<p align="center"><strong>A workspace as the single source of truth, where agents work concurrently and verified, human-accepted contributions advance both the project and its working capabilities.</strong></p>

<p align="center"><a href="../README.md">简体中文</a> | English</p>

<p align="center"><a href="#quick-start">Quick start</a> · <a href="#documentation">Documentation</a> · <a href="#roadmap">Roadmap</a> · <a href="https://github.com/BD777/foundry/issues">Report an issue</a></p>

Foundry is an AI work platform built around workspace evolution: it runs the native Claude Code / Codex on your own devices, lets agents work concurrently in one project, and returns accepted results to the workspace as the starting point for the next task.

## What Foundry is

**Every project needs a workspace.** Writing code, a novel, research or documentation, an agent starts from the project's current state. The workspace is the project's single source of truth and the agent's context: it holds results (code, text, data) and methods (skills, tools and rules). Every accepted change moves the workspace forward, so the next task starts from better context. Foundry exists to let several agents drive that evolution safely and continuously.

<p align="center">
  <img src="assets/architecture.svg" alt="Foundry architecture (labels in Chinese): entries, Personal Agent and workflows built on foundations, all evolving one workspace" width="900" />
</p>

- **Foundations are the core of Foundry.** Execution (native agent sessions, multiple devices, Foundry MCP / CLI), isolation and integration (Git worktree candidates, Sandbox, integration queue and conflict resolution), verification (evidence, independent judgment, human acceptance), capability supply (resources, skills, models, connectors, channels) and trust (identity, roles, credential boundaries).
- **Workflows combine foundations.** **Chats** are the most direct path: the agent edits the workspace directly and the person handles isolation and review; it is also the most used. **Issues** add isolation, evidence, human acceptance and integration on top, as a trusted delivery flow. Later, people will be able to build their own workflows from the same foundations (plugins, still being designed).
- **Personal Agent sits above workflows.** You say what you want; it decides which workspace it belongs in, creates one if needed, and dispatches and supervises sessions there.
- **Entries**: the web app, external agents (through the `foundry` CLI / MCP) and IM channels (the Feishu bot).

Isolation, integration and evidence are implemented inside Issues today and are being extracted into standalone foundations so other workflows can use them ([design](workflow-platform.md), Chinese).

## Roadmap

What each layer's modules do now. Each module's to-dos, dependencies and completion criteria live only in **[roadmap.md](roadmap.md)** (Chinese); module names link to their section. Design documents are in Chinese.

### Workflows

- **[Chats](roadmap.md#chats)**: talk directly in the selected workspace; attachments, server-side queue, steering, recovery, outputs and diffs, background tasks, groups and search. Design: [chat-experience.md](chat-experience.md)
- **[Issues](roadmap.md#issues)**: criteria → work in a candidate → evidence and independent judgment → human acceptance → integration; real loops passed with Claude and Codex on macOS and Linux; new features paused until real-use feedback. Design: [issue-workflow.md](issue-workflow.md)
- **[Custom workflows](roadmap.md#自定义工作流)**: planned, not implemented. Design: [workflow-platform.md](workflow-platform.md)

### Foundations

- **Execution**
  - [Native agent sessions](roadmap.md#原生-agent-会话): one session is one native session on a device; event stream, steering, cancel and recovery; follows official stable releases. Design: [execution-kernel.md](execution-kernel.md)
  - [Devices and daemon](roadmap.md#设备与-daemon): the daemon connects out, pairing and automatic updates, several devices and workspaces, cross-device sessions, [Docker deployment](../deploy/README.md). Design: [devices-and-workspaces.md](devices-and-workspaces.md)
  - [Foundry MCP / CLI](roadmap.md#foundry-mcp--cli): the only interface agents use to call Foundry: dispatch, observe, steer and hand off sessions, lease resources, use connectors. Design: [session-orchestration-design.md](session-orchestration-design.md)
- **Isolation and integration**
  - [Candidates and Sandbox](roadmap.md#候选与-sandbox): one Git worktree candidate per task; the Sandbox implements one interface on macOS and Linux, allows writes only to the candidate, and fails closed elsewhere.
  - [Integration queue and conflicts](roadmap.md#合入队列与冲突解决): accepted candidates are integrated one at a time; when the workspace has moved on, the candidate is aligned first and the agent resolves conflicts and re-verifies.
- **Verification**
  - [Evidence and judgment](roadmap.md#证据与判定): real checks on the candidate with raw materials kept; programs or an independent read-only agent judge each criterion; a person accepts based on the evidence. Design: [evidence-and-verify-v1.md](evidence-and-verify-v1.md)
- **Capability supply**
  - [Resources](roadmap.md#resources): Computer Use and remote commands leased exclusively, queued and reclaimed, also across devices; browsers on demand. Design: [resources.md](resources.md)
  - [Skills](roadmap.md#skills): skill library with immutable versions, per-workspace selection and pinning, personal defaults, draft trials. Design: [skills.md](skills.md)
  - [Models and accounts](roadmap.md#模型与账号): the device's native logins and official installs, model services (API or gateway). Design: [models-and-accounts.md](models-and-accounts.md)
  - [Connectors](roadmap.md#连接器): server-held (Feishu, Cloudflare) and device-held (bytedcli, AWS CLI), bound per workspace. Design: [connectors.md](connectors.md)
  - [Channels](roadmap.md#渠道): the Feishu bot pairs groups or direct chats to a workspace, threads map to sessions, streaming cards and attachments. Design: [channels.md](channels.md)
- **Trust**
  - [Identity and sharing](roadmap.md#身份与共享): sign-in required everywhere; workspaces shared as Viewer / Member / Maintainer / Owner, with immediate revocation. Design: [accounts-permissions-design.md](accounts-permissions-design.md)

### Workspace

- **[Workspace](roadmap.md#workspace)**: a folder on a device that may contain Git repositories at any depth; Foundry leaves it unchanged, and a folder without Git is initialized only after the person confirms, the first time a candidate is needed.

### Personal Agent

- **[Personal Agent](roadmap.md#personal-agent)**: under testing (tried on dev by the owner since 2026-10-15), routing accuracy still improving; web home and Feishu direct-chat entry. Design: [personal-agent.md](personal-agent.md)

## Quick start

### Prerequisites

- Node.js 22
- pnpm 11.7.0
- Go 1.24.0 or later, as declared in [go.mod](../apps/server/go.mod)
- Git; local workers support macOS and Linux. Issue execution on Linux requires bubblewrap and a working user namespace. Issue clarification, independent-agent verification and Accept integration work on both; on Linux, controlled HTTP targets are not available yet. In the sandbox an Issue writes only its own candidate and cannot read Foundry's own credentials and state; an Issue you started yourself can use your local configuration and credentials. Chat works on both and is not sandboxed.

### Install and run

```bash
git clone https://github.com/BD777/foundry.git
cd foundry
pnpm install
```

Start the server and web app in separate terminals:

```bash
pnpm dev:server
```

```bash
pnpm dev:web
```

Open [http://127.0.0.1:31983](http://127.0.0.1:31983/).

### Connect a local worker

In the web app open Devices → Add device, create a pairing command and run it on the machine that should do the work (macOS or Linux, Node.js 20 or later). It installs the worker from npm, pairs it with a one-time token and starts it at login (a systemd user service on Linux; without systemd it prints the command to run it in the foreground):

```bash
npx -y @bd777/foundry-worker@latest install --server http://127.0.0.1:31982 --token <pairing token> --workspace /absolute/path/to/workspace
```

The worker uses that machine's own Claude Code or Codex; it does not bring a copy of either. If one is missing, choose Install under Devices → Models & accounts and the worker runs the official installer on that device (Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`; Codex: `curl -fsSL https://chatgpt.com/codex/install.sh | sh`), or run it yourself. Then sign in with `claude` or `codex login` and choose Re-check. A version older than Foundry needs (Claude Code 2.1.201, Codex 0.142) still works, and the page shows the update command (`claude update` for Claude Code; for Codex, whatever installed it, such as the official script again or `npm install -g @openai/codex@latest`). API endpoints and gateways can be configured under Model providers instead.

A worker running as root still runs Issues (they run inside Foundry's sandbox). In chats, Claude Code refuses to skip permission prompts as root: choose another permission mode for chats, or run the worker as a regular user.

A worker run from the source checkout (for development) needs the pairing token too:

```bash
pnpm --filter @bd777/foundry-worker foundry-worker -- setup --server http://127.0.0.1:31982 --workspace /absolute/path/to/workspace --token <pairing token>
```

See the [development guide](development.md) for installation options, authentication, previews and troubleshooting.

## Project structure

```text
apps/web/          React / Vite interface
apps/server/       Go API, SQLite projections and worker communication
packages/worker/   Local agent execution, files, worktrees and previews
packages/protocol/ Shared component protocols
docs/              Guides, product design, architecture and research
cases/             Product regression scenarios and verification requirements
```

The server handles coordination and state projections; workers perform execution. See the [security boundary](security.md) for data placement, credential handling and remote access rules.

## Documentation

| Document                                         | Contents                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| [Documentation index](README.md)                 | All documentation, organized by topic                                           |
| [Development guide](development.md)              | Installation, startup, worker configuration and verification                    |
| [Parallel dev stacks](dev-stacks.md)             | Isolated stacks for running multiple Foundry copies, with doctor/repair tooling |
| [Product philosophy](philosophy.md)              | Project goals and the work loop                                                 |
| [Technical architecture](technical-selection.md) | Component responsibilities and technology choices                               |
| [Overview](workspace-sandbox-overview.md)        | Overall design of Workspace, Sandbox and Issues (Chinese)                       |
| [Roadmap](roadmap.md)                            | Status, next steps and completion criteria by module (Chinese)                  |

## Contributing

Use [Issues](https://github.com/BD777/foundry/issues) to report bugs or discuss requests, or submit a Pull Request. Include reproduction steps, your environment and relevant logs when reporting a problem, and remove credentials or other sensitive information.

Before making changes, read [AGENTS.md](../AGENTS.md) and the [development guide](development.md). Current working context is in [CONTEXT.md](../CONTEXT.md). Run the regression gate before submitting changes:

```bash
pnpm regression:commit
```

Update the [regression catalogue](../cases/README.md) for features or fixes that change observable behavior. Keep this README and the [Chinese README](../README.md) in sync when updating the project introduction or startup instructions.

## License

Foundry is licensed under the [Apache License 2.0](../LICENSE).
