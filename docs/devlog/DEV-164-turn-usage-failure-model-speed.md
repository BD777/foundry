# DEV-164 · 失败回合用量、实际模型与 Codex 逐请求用量

## 问题

失败回合此前可能不记录 token，用户看到的模型名称也可能来自请求配置而不是实际响应；Codex 的用量与速度需要按每个模型请求结算，不能把整回合时间当成一个请求。

## 调查与修复

- Worker 在失败、取消和正常终态都保存已观察到的用量，并记录实际模型；缺失值保持缺失。
- Codex app-server 流按请求归并 usage 与首输出时间，回合结束后汇总模型请求数、token、成本和约 tok/s。
- Web 在失败回合也显示已有的用量与模型，并把逐请求数据归到正确步骤；不把估算速度显示为精确值。
- 契约、生成类型、中英文文案和 Worker/Web 回归测试同步更新。

## 部署与版本证据

该改动属于 dev 已部署状态，已纳入 2026-11-10 部署状态快照 D。与第 3 项重叠的累计 hunk 以 `usage-worker` 合并，翻译文件采用 D 中与表格预览共存的版本。

## 检查

- 契约重新生成
- Server `go build ./...` 与 `go vet ./...`
- Web TypeScript typecheck
- Worker TypeScript typecheck/build
- `step-usage.test.mjs`、`turn-usage.test.mjs`、`codex-app-server.test.mjs`、`request-usage-stream.test.mjs`

## 限制

本次为提交窗口本地演练，不推送、不创建 PR。Codex 没有报告原生 tokens 时仍是缺失，不补零。

## 验收步骤

1. 运行一个正常结束和一个失败的模型回合，展开用量。
2. 失败回合应保留失败前已收到的 token 与实际模型。
3. Codex 多请求回合应分请求显示，并能由其生成时间计算近似输出速度。
4. 模型或 tokens 未上报时，界面显示不可用而不是 0。
