# DEV-161 · 模型速度 S1-S4

## 问题

回合用量只显示 token 和总耗时，无法区分模型生成、首 token、工具等待与请求等待；Codex 的部分速度只能从事件时序估算，界面也没有明确标出估算值。

## 调查与修复

- 契约新增 `modelMs`、`ttftMs`、`timingEstimated` 与请求级用量字段，Server 生成类型同步更新。
- Claude 使用原生请求和流事件时间；Codex 从请求、工具项和首输出事件重建模型窗口，并标记估算。
- Web 将回合汇总拆成可读的速度指标，同时保留缺失值与估算值的区别，不把不可计算的数据显示成 0。
- 中英文文案、格式化和 step/turn 用量测试同步补齐。

## 部署与版本证据

该组改动属于 dev 已部署改动，已纳入 2026-11-10 部署状态快照 D。两份来源 worktree 在 UI、Worker、契约重叠处按上述职责合并，生成文件在本地重新生成。

## 检查

- `node scripts/generate-contracts.mjs`
- Server `go build ./...` 与 `go vet ./...`
- Web TypeScript typecheck
- Worker TypeScript typecheck
- `step-usage.test.mjs`、`turn-usage.test.mjs`、`codex-timing.test.mjs`、`request-usage-stream.test.mjs`

## 限制

本次为提交窗口本地演练，不推送、不创建 PR。Codex 没有原生逐请求速度时必须显示估算标记，不能当作精确采样。

## 验收步骤

1. 打开一个包含 Claude 或 Codex 请求的回合，展开步骤用量。
2. Claude 应显示原生模型耗时与首 token 时间。
3. Codex 显示速度时应带近似/估算含义；缺少数据的步骤不显示伪造的 0。
4. 总耗时与模型耗时应分开，工具等待不应被算成模型生成时间。
