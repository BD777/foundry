# Foundry Documentation

Start with the project overview in [简体中文](../README.md) or [English](README.en.md).
Some design documents are written in Chinese; each page keeps one language.

Pages fall into three kinds:

- **Module documents** own one module each: its design, its implementation
  boundary (what is built, what is missing, what was verified live and when)
  and its next steps. The boundary section is the authority on what is built.
- **Reference** pages describe cross-cutting structure and operations of the
  code on main.
- **Archive and research** keep background reasoning; they are not
  descriptions of current behaviour.

## Start here

| Question                                  | Read                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| What is Foundry trying to be?             | [Workspace and Sandbox overview](workspace-sandbox-overview.md)                     |
| What works today, and what comes next?    | [Roadmap](../README.md#roadmap), then the module document's implementation boundary |
| How do I run and develop Foundry?         | [Development](development.md)                                                       |
| How do I deploy it with Docker?           | [Deployment](../deploy/README.md)                                                   |
| How are credentials and access protected? | [Security](security.md)                                                             |
| Where should an agent working here start? | [AGENTS.md](../AGENTS.md) and [CONTEXT.md](../CONTEXT.md)                           |

## Modules

Ordered top-down as in the [module diagram](assets/architecture.svg)
(source: [architecture.mmd](assets/architecture.mmd)). Upper layers depend on
lower ones.

| Layer             | Module                   | Owning document                                                    | Related                                                                                                                                                                                                                                                                                            |
| ----------------- | ------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entries           | Channels                 | [channels.md](channels.md)                                         |                                                                                                                                                                                                                                                                                                    |
| Workflows         | Chats                    | [chat-experience.md](chat-experience.md)                           | [chat list](chat-list-design.md), [transcript pipeline](chat-transcript-design.md), [turn navigator](chat-turn-navigator-design.md), [session model](session-model.md)                                                                                                                             |
| Workflows         | Issues                   | [issue-workflow.md](issue-workflow.md)                             | [conversation and status](issue-conversation-design.md), [Evidence & Verify v1](evidence-and-verify-v1.md) and its generated [field reference](evidence-and-verify-v1-fields.md), [multi-repository execution](issue-workspace-execution.md), [release gate](foundry-conversation-release-gate.md) |
| Agent surface     | Foundry MCP / CLI        | [session-orchestration-design.md](session-orchestration-design.md) |                                                                                                                                                                                                                                                                                                    |
| Execution kernel  | Session Runtime, Sandbox | [execution-kernel.md](execution-kernel.md)                         | [module architecture §5](architecture-modules.md)                                                                                                                                                                                                                                                  |
| Capability supply | Resources                | [resources.md](resources.md)                                       |                                                                                                                                                                                                                                                                                                    |
| Capability supply | Skills                   | [skills.md](skills.md)                                             |                                                                                                                                                                                                                                                                                                    |
| Capability supply | Models and accounts      | [models-and-accounts.md](models-and-accounts.md)                   |                                                                                                                                                                                                                                                                                                    |
| Capability supply | Connectors               | [connectors.md](connectors.md)                                     |                                                                                                                                                                                                                                                                                                    |
| Foundation        | Devices and workspaces   | [devices-and-workspaces.md](devices-and-workspaces.md)             | [daemon lifecycle](daemon-lifecycle.md), [parallel dev stacks](dev-stacks.md), [Docker deployment](../deploy/README.md)                                                                                                                                                                            |
| Foundation        | Identity and sharing     | [accounts-permissions-design.md](accounts-permissions-design.md)   | [security](security.md#accounts)                                                                                                                                                                                                                                                                   |

The Personal Agent layer has not started; it is described in the
[Roadmap](../README.md#roadmap).

## Product and concepts

- [Workspace and Sandbox overview](workspace-sandbox-overview.md): the framework document — core concepts, glossary, Issue lifecycle, deployment architecture and module outlines.
- [Philosophy](philosophy.md): the working loop between people, agents and the project.

## Cross-cutting reference

- [Module architecture](architecture-modules.md): layer rules, code-module boundaries, the map from product modules to code modules, and the history of the milestone phase.
- [Technical architecture](technical-selection.md): components, responsibilities and technology choices.
- [Storage strategy](storage-strategy.md): what lives on the server, the worker and in the workspace.
- [Security](security.md): accounts, authorization, credentials, model catalogs and remote exposure.
- [Development](development.md) and [live regression](live-regression.md): running, verifying and end-to-end cases.
- [Web architecture](../apps/web/src/ARCHITECTURE.md): frontend module boundaries, kept beside the code.
- [Regression cases](../cases/README.md): behaviour catalogue and evidence requirements.

## Research

- [Git submodules and worktrees](research/git-submodule-worktree.md), [workspace candidate filesystem](research/workspace-candidate-filesystem.md) and [managed agents landscape](research/managed-agents-landscape.md).

## Archive

- [Workspace AI product plan · 2026-09-08](archive/workspace-ai-product-plan-2026-09-08.md): the original full planning discussion, superseded by the overview and module docs.
- [Project concept · 2026-07-03](archive/product-concept.md): the first product concept.

## Where documentation belongs

- The root [README](../README.md) is the project homepage and the only maintained Roadmap, organized by module; keep its [English counterpart](README.en.md) in step.
- Each module has one owning document. When code changes a module's behaviour, update that document's design and implementation boundary in the same change; do not keep a separate status page, development log or dated evidence folders in `docs/`. Acceptance evidence goes in the pull request; delivered changes are in Git history.
- A new module gets a row in the Roadmap, the module diagram (`assets/architecture.mmd`, re-rendered to `architecture.svg` with Mermaid 11+) and the table above.
