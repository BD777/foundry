# DEV-162 · macOS verifier agent-updates 修复

## 问题

macOS 验证会话在读取或写入 agent-runtime 更新记录失败时，会让原生 CLI 状态读取和验证启动一起失败；缺少 `sandbox-exec` 时的错误也偏离既有“后端不可用”分类。

## 调查与修复

- 原生 CLI 的普通探测不再依赖 daemon 的更新记录；daemon 面向状态额外叠加更新信息，读取失败会记录脱敏日志并继续。
- 更新控制器的读写 bookkeeping 失败不再中断实际的运行时检查与更新。
- macOS Seatbelt policy 生成与执行分离，缺少后端时明确返回 `backend_missing`。
- 补齐 agent update、native CLI、运行时缺失、sandbox 和 verifier 测试。

## 部署与版本证据

该修复属于 dev 已部署改动，已纳入 2026-11-10 部署状态快照 D。

## 检查

- Worker TypeScript typecheck/build
- `agent-runtime-update.test.mjs`
- `native-cli.test.mjs`
- `runtime-install-missing.test.mjs`
- `sandbox.test.mjs`
- `verification-session.test.mjs`

## 限制

本地 Linux 环境不能替代真实 macOS `sandbox-exec` 行为；本次演练只验证代码路径和测试。

## 验收步骤

1. 在缺少或损坏更新 bookkeeping 的 macOS 设备上读取原生 CLI 状态，会话仍应能启动。
2. 缺少 `sandbox-exec` 时，启动应返回清晰的 unavailable 状态，而不是通用崩溃。
3. 更新记录恢复后，daemon 状态应重新显示更新目标与检查时间。
