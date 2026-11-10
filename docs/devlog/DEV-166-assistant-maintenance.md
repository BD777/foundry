# DEV-166 · Assistant 维护脱敏与项目索引只注首轮

## 问题

Assistant 维护提示可能把不应进入模型上下文的敏感维护细节带进去；长对话每轮重复注入完整项目索引，也增加了上下文占用和无关注意力。

## 调查与修复

- 维护流程在进入 Assistant 指令与模型上下文前统一脱敏，日志和失败信息不暴露密钥或原始维护载荷。
- 项目索引只在 Assistant 会话首轮提供；后续回合仍可通过工具按需读取，不重复整份注入。
- 更新 system 指令与 golden fixtures，并补维护脱敏和 wiring 回归测试。

## 部署与版本证据

该改动属于 dev 已部署状态，已纳入 2026-11-10 部署状态快照 D。

## 检查

- Server `go build ./...`
- Server `go vet ./...`
- `go test ./internal/personalagent/... ./internal/httpapi -run '<assistant wiring tests>'`

## 限制

本次为提交窗口本地演练，不推送、不创建 PR。已存在会话的下一轮会在新进程/提示重建后采用首轮规则。

## 验收步骤

1. 查看 Assistant 维护日志与模型上下文，不应出现测试密钥、原始载荷或未脱敏错误。
2. 新建 Assistant 对话首轮应包含项目索引。
3. 同一对话后续轮次不应整份重复索引；需要时仍可由工具读取当前项目文件。
