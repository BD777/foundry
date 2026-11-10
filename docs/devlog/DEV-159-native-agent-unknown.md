# DEV-159 · 原生子 agent 状态显示为未知

## 问题

原生 Claude 子 agent 没有可观察的实时状态时，Server 投影与 Web 将部分状态误判为 `unknown`，让运行中的结果看起来失去状态，或让已经结束的结果保留错误标记。

## 调查与修复

- Server 将原生工作项的观察状态与持续状态合并时区分“没有新观察”和“观察结果为 unknown”，避免未知值覆盖已有状态。
- 持久化层保留已确认状态的合并语义，并补回归测试覆盖未知观察与终态。
- Web 的状态归一化只在确实没有可用状态时显示未知；Worker 的 Claude 原生工作映射同步避免把缺失字段当成显式未知。

## 部署与版本证据

该修复属于 dev 已部署改动，已纳入 2026-11-10 提交窗口的部署状态快照 D。

## 检查

- `go build ./...`
- `go vet ./...`
- Web TypeScript typecheck
- Worker TypeScript build
- 新增/相关测试：`session-work.test.mjs`、`native-agent-work.test.mjs`

## 限制

本次为提交窗口本地演练，不推送、不创建 PR。真实原生 agent 的运行时状态仍取决于具体 Claude 版本是否提供可观察事件。

## 验收步骤

1. 打开包含原生子 agent 的会话侧栏。
2. 子 agent 无新观察时，应保留最近一次已确认状态，而不是变成未知。
3. 子 agent 结束并上报结果后，状态应稳定显示终态。
