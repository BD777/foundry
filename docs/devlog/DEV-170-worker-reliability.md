# DEV-170 · Worker 可靠性

## 问题

长时间运行的 Worker 会在 MCP 断连后失去工具、反复拉取 Codex 模型清单，并可能在 session-work 的定时/状态读写上停住；Codex 回答中的本地文件引用也只是纯文本，不能直接打开。

## 调查与修复

- MCP forwarder 增加活动检测、自动重连和 supervisor；调用超时与关闭路径有明确结果，旧工具会话不会泄漏。
- Codex 模型清单按设备缓存，刷新失败保留上一份可用目录；启动、resume 与显式刷新共享同一缓存。
- session-work supervisor 的定时读写改为不阻塞主循环，修复 IO 失败后的恢复、暂停和重新入队。
- Codex 流中的工作区文件引用转成已验证的应用内链接；外部或不存在路径仍保留文本。

## 部署与版本证据

该组改动属于 dev 已部署状态，已纳入 2026-11-10 部署状态快照 D。第 12 项与 D 的 worker 差异在本地逐文件核对后只剩 Codex citation 四个文件，并从 D 补齐。

## 检查

- Worker TypeScript typecheck/build
- `server-mcp-forwarder-timeout.test.mjs`
- `foundry-tools-supervisor.test.mjs`
- `codex-model-catalog.test.mjs`
- `session-work.test.mjs`
- `session-work-sync.test.mjs`
- `codex-citations.test.mjs`

## 限制

本次为提交窗口本地演练，不推送、不创建 PR。MCP 仍遵循服务端工具清单与既有超时；文件链接只对本会话可见的工作区文件生效。

## 验收步骤

1. 断开并恢复 MCP 连接，下一次工具调用应自动重连，不能要求重开会话。
2. 模型清单刷新失败时仍显示上次目录，并标出失败原因。
3. 让 session-work 的定时/状态 IO 失败一次，supervisor 应继续处理其他会话并可恢复。
4. Codex 回答引用已存在工作区文件时可在应用内打开；未知或越界路径不生成链接。
