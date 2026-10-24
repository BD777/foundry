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

| Question                                  | Read                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| What is Foundry trying to be?             | [Workspace and Sandbox overview](workspace-sandbox-overview.md)           |
| What works today, and what comes next?    | [Roadmap](roadmap.md), then the module document's implementation boundary |
| How do I run and develop Foundry?         | [Development](development.md)                                             |
| How do I deploy it with Docker?           | [Deployment](../deploy/README.md)                                         |
| How are credentials and access protected? | [Security](security.md)                                                   |
| Where should an agent working here start? | [AGENTS.md](../AGENTS.md) and [CONTEXT.md](../CONTEXT.md)                 |

## Modules

Ordered top-down as in the [module diagram](assets/architecture.svg)
(source: [architecture.mmd](assets/architecture.mmd)). Upper layers depend on
lower ones. Each module's status and next steps are in the matching section of
the [Roadmap](roadmap.md).

| Layer             | Module                                            | Owning document                                                    | Related                                                                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entries           | Channels                                          | [channels.md](channels.md)                                         |                                                                                                                                                                                                                                                                                                    |
| Personal Agent    | Personal Agent                                    | [personal-agent.md](personal-agent.md)                             | [channels](channels.md), [session orchestration](session-orchestration-design.md), [devices and workspaces](devices-and-workspaces.md)                                                                                                                                                             |
| Workflows         | Chats                                             | [chat-experience.md](chat-experience.md)                           | [chat list](chat-list-design.md), [transcript pipeline](chat-transcript-design.md), [turn navigator](chat-turn-navigator-design.md), [session model](session-model.md)                                                                                                                             |
| Workflows         | Issues                                            | [issue-workflow.md](issue-workflow.md)                             | [conversation and status](issue-conversation-design.md), [Evidence & Verify v1](evidence-and-verify-v1.md) and its generated [field reference](evidence-and-verify-v1-fields.md), [multi-repository execution](issue-workspace-execution.md), [release gate](foundry-conversation-release-gate.md) |
| Workflow platform | Candidates, integration queue, evidence (planned) | [workflow-platform.md](workflow-platform.md)                       | [Issue workflow](issue-workflow.md), [module architecture](architecture-modules.md)                                                                                                                                                                                                                |
| Agent surface     | Foundry MCP / CLI                                 | [session-orchestration-design.md](session-orchestration-design.md) |                                                                                                                                                                                                                                                                                                    |
| Execution kernel  | Session Runtime, Sandbox                          | [execution-kernel.md](execution-kernel.md)                         | [module architecture §5](architecture-modules.md)                                                                                                                                                                                                                                                  |
| Capability supply | Resources                                         | [resources.md](resources.md)                                       |                                                                                                                                                                                                                                                                                                    |
| Capability supply | Skills                                            | [skills.md](skills.md)                                             |                                                                                                                                                                                                                                                                                                    |
| Capability supply | Models and accounts                               | [models-and-accounts.md](models-and-accounts.md)                   |                                                                                                                                                                                                                                                                                                    |
| Capability supply | Connectors                                        | [connectors.md](connectors.md)                                     |                                                                                                                                                                                                                                                                                                    |
| Foundation        | Devices and workspaces                            | [devices-and-workspaces.md](devices-and-workspaces.md)             | [daemon lifecycle](daemon-lifecycle.md), [parallel dev stacks](dev-stacks.md), [Docker deployment](../deploy/README.md)                                                                                                                                                                            |
| Foundation        | Identity and sharing                              | [accounts-permissions-design.md](accounts-permissions-design.md)   | [security](security.md#accounts)                                                                                                                                                                                                                                                                   |

## Product and concepts

- [Workspace and Sandbox overview](workspace-sandbox-overview.md): the framework document — core concepts, glossary, Issue lifecycle, deployment architecture and module outlines.
- [Philosophy](philosophy.md): the working loop between people, agents and the project.

## Cross-cutting reference

- [Roadmap](roadmap.md): the only roadmap and to-do list, by module, with completion criteria and dependencies.
- [Workflow platform](workflow-platform.md): proposal to make Issues one built-in workflow over shared candidate, integration-queue and evidence capabilities; not implemented.
- [Module architecture](architecture-modules.md): layer rules, code-module boundaries, the map from product modules to code modules, and the history of the milestone phase.
- [Technical architecture](technical-selection.md): components, responsibilities and technology choices.
- [Storage strategy](storage-strategy.md): what lives on the server, the worker and in the workspace.
- [Session isolation and Workspace Skill drafts](session-isolation-design.md): proposed configuration boundaries, draft trials, shared launch preparation, migration and acceptance; not an implementation-status claim.
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

- **Roadmap and pending work** live only in [roadmap.md](roadmap.md), one row per item with a stable ID. Other pages link to the row instead of keeping their own checklist. The root [README](../README.md) shows the module diagram and a one-line summary per module; keep its [English counterpart](README.en.md) in step.
- **Module documents** own design and the implementation boundary (what is built, what is missing, what was verified live and when). When code changes a module's behaviour, update that document in the same change.
- **The devlog** ([devlog/](devlog/README.md)) records started items as `DEV-NNN`: investigation, fix, deployment and version evidence, checks, acceptance and limitations, as required by [AGENTS.md](../AGENTS.md). It is the execution record, not a second roadmap; a roadmap row links to its `DEV-NNN` entry.
- Pull requests carry acceptance evidence for the change; delivered changes are in Git history.
- A new module gets a section in the Roadmap, a box in the module diagram (`assets/architecture.mmd`, re-rendered to `architecture.svg` with Mermaid 11+) and a row in the table above.
