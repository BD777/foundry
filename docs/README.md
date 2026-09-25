# Foundry Documentation

Start with the project overview in [简体中文](../README.md) or [English](README.en.md).
Some design documents are written in Chinese; each page keeps one language.

Pages fall into three kinds:

- **Reference** describes code on main.
- **Design** describes intended behaviour; parts may not be built yet. Each
  design page says what is implemented, and [current status](current-status.md)
  is the authority on that.
- **Archive and research** keep background reasoning; they are not
  descriptions of current behaviour.

## Start here

| Question                                  | Read                                                            |
| ----------------------------------------- | --------------------------------------------------------------- |
| What is Foundry trying to be?             | [Workspace and Sandbox overview](workspace-sandbox-overview.md) |
| What works today, and what is missing?    | [Current status](current-status.md)                             |
| What work is planned?                     | [Roadmap](../README.md#roadmap)                                 |
| How do I run and develop Foundry?         | [Development](development.md)                                   |
| How do I deploy it with Docker?           | [Deployment](../deploy/README.md)                               |
| How are credentials and access protected? | [Security](security.md)                                         |
| Where should an agent working here start? | [AGENTS.md](../AGENTS.md) and [CONTEXT.md](../CONTEXT.md)       |

## Product and concepts

- [Workspace and Sandbox overview](workspace-sandbox-overview.md): the framework document — core concepts, glossary, Issue lifecycle, deployment architecture and module outlines.
- [Philosophy](philosophy.md): the working loop between people, agents and the project.

## Architecture and operations (reference)

- [Module architecture](architecture-modules.md): layers, module boundaries and the milestone split (design; M1 interface draft).
- [Technical architecture](technical-selection.md): components, responsibilities and technology choices.
- [Storage strategy](storage-strategy.md): what lives on the server, the worker and in the workspace.
- [Daemon lifecycle](daemon-lifecycle.md): symbol-level map of the device daemon.
- [Security](security.md): accounts, authorization, credentials, model catalogs and remote exposure.
- [Development](development.md), [parallel dev stacks](dev-stacks.md) and [Docker deployment](../deploy/README.md).
- [Web architecture](../apps/web/src/ARCHITECTURE.md): frontend module boundaries, kept beside the code.
- [Regression cases](../cases/README.md): behaviour catalogue and evidence requirements.

## Issue loop (design)

- [Issue workflow](issue-workflow.md): goals, candidate execution, evidence and verification, acceptance and integration.
- [Issue conversation and status](issue-conversation-design.md): the six states and the shared conversation UI.
- [Evidence & Verify v1](evidence-and-verify-v1.md): the implemented contract for criteria, materials, verification and acceptance; its [field reference](evidence-and-verify-v1-fields.md) is generated from the TypeScript declarations — do not edit it by hand.
- [Multi-repository execution](issue-workspace-execution.md): candidate environments, worktrees, integration and recovery.
- [Release gate](foundry-conversation-release-gate.md): the acceptance standard for conversation-driven Issue work.
- [Tools and shared resources](tool-use-and-resources.md): Tool Use and resource scheduling, mostly future design.

## Chats and platform (design)

- [Chat experience](chat-experience.md), [chat list](chat-list-design.md), [transcript pipeline](chat-transcript-design.md) and [turn navigator](chat-turn-navigator-design.md).
- [Session orchestration](session-orchestration-design.md): agents creating and steering sessions through the `foundry` CLI and MCP.
- [Accounts and permissions](accounts-permissions-design.md): ownership and workspace sharing; phases 1–2 are built.
- [Platform extensions](platform-extensions.md): IM, accounts, cloud workspace and workflow plugins.

## Research

- [Git submodules and worktrees](research/git-submodule-worktree.md), [workspace candidate filesystem](research/workspace-candidate-filesystem.md) and [managed agents landscape](research/managed-agents-landscape.md).

## Archive

- [Workspace AI product plan · 2026-09-08](archive/workspace-ai-product-plan-2026-09-08.md): the original full planning discussion, superseded by the overview and topic docs.
- [Project concept · 2026-07-03](archive/product-concept.md): the first product concept.

## Where documentation belongs

- The root [README](../README.md) is the project homepage and the only maintained Roadmap; keep its [English counterpart](README.en.md) in step.
- [Current status](current-status.md) records the implementation boundary, the Roadmap records future work, and Git history records delivered changes. Do not keep a separate development log or dated evidence folders in `docs/`; put acceptance evidence in the pull request.
- Update the owning design page when behaviour changes, and add new pages to this index.
