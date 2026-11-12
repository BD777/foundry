# DEV-195 AGENTS.md 重组与「不可构建的切片用独立 worktree」规则

## 状态

只改文档，不需要部署。随 2026-11-12 晚提交窗口合入 main（[PR #264](https://github.com/BD777/foundry/pull/264)）。

## 问题

- 根 `AGENTS.md` 有 12.8 KB，其中大半是 Web UI 规则和「代码、检查在哪」的清单，每个会话都要读完，与当前任务无关的部分也占上下文。
- 仓库根目录和 `apps/web` 用 `CLAUDE.md` → `AGENTS.md` 软链接让 Claude Code 读到规则；Claude Code 现已原生读取 `AGENTS.md`，这两个链接属于多余的兼容层。
- 2026-11-12 共享 dev 检出里，另一个切片部署 Server 时把 DEV-191 未完成的迁移一并带上了 dev，当时该迁移的负责人还没有备份数据库；另外两个切片也因它的编译错误被卡住。

## 调查

- Claude Code 原生读取 `AGENTS.md` 的版本与各设备覆盖由 [sess_1794491478431629113](https://dev.foundryapp.app/chats/sess_1794491478431629113) 核实：官方 CHANGELOG 2.1.277 加入 AGENTS.md 支持（项目里没有 CLAUDE.md 时读取 AGENTS.md），官方 Memory 文档写明需要 v2.1.277 或更高版本；各设备上的 Claude profile 版本均为 2.1.311，`instructionFiles` 没有被覆盖。
- 仓库代码不依赖仓库自己的 `CLAUDE.md` 文件：Worker 和 workspacedigest 只是把它列为可选的规则文件名。

## 修复

- 根 `AGENTS.md` 从 12.8 KB 减到 5.6 KB，只留跨任务都用得上的约束：
  - UI 规则移到 `apps/web/AGENTS.md`，只在动 Web 时加载；
  - 代码与检查的位置移到 `docs/where-things-live.md`。
- 删除根目录的 `CLAUDE.md` 软链接；`apps/web/CLAUDE.md` 在 main 上从未被跟踪，也不再保留。
- `docs/research/native-agent-conformance.md` 按 Claude Code 原生读取 AGENTS.md 的现状改写规则文件一节；`apps/web/scripts/audit-v3-layout-contract.mjs` 的一行注释改为指向 `apps/web/AGENTS.md`。
- `docs/agent-orchestration.md` 新增一条规则：会让代码树暂时无法构建的切片（跨包重构、schema 迁移）在独立 worktree 里进行，能构建、测试通过后再合回 dev。

## 部署与版本证据

纯文档，无部署。

## 检查

`prettier --check .` 通过；规则由编排者逐条核对过，确认搬移后没有丢失。

## 限制

低于 2.1.277 的 Claude Code（经 LLM gateway 时为 2.1.281）读不到这些规则；目前所有设备都是 2.1.311。

## 验收

在仓库根目录开一个新的 Claude Code 会话，问它根 `AGENTS.md` 的某条规则，它应能答出；改 `apps/web` 下的文件时，它应能引用 `apps/web/AGENTS.md` 里的 UI 规则。
