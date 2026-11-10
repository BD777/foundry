# DEV-173 · 开发工具与测试稳定性

## 问题

macOS 自带 Bash 3.2 无法运行依赖 `mapfile` 的 `check-changed.sh`；远程检查固定 30 分钟，长测试无法按设备调整。Radix Dialog 测试偶发在 happy-dom 恢复后派发迟到事件，usage 历史表也需要在设备/工作区清理测试中登记为保留数据。

## 调查与修复

- `check-changed.sh` 去掉 Bash 4 专属 `mapfile`，并用空数组安全展开兼容 Bash 3.2；远程检查可直接使用 macOS 自带 bash。
- `remote-check.sh` 选择 Homebrew bash 优先、系统 bash 兜底，并允许 `REMOTE_CHECK_TIMEOUT` 覆盖检查 job 上限。
- Radix 测试 cleanup 已因 PR #249 的全量 Web 测试阻塞提前合入：先关闭 Dialog、卸载组件，再 flush 零延迟 timer。
- usage 历史保留登记已因 PR #252 的 Go 测试阻塞提前合入：设备、工作区和会话删除不抹除 usage fact。

## 部署与版本证据

该组改动于 2026-11-10 14:44Z 后部署到 dev，已纳入本轮追加提交。Radix 与 usage 保留两部分已在前面阻塞的 PR 中合并，本 PR 不重复修改。

## 检查

- `bash -n scripts/check-changed.sh scripts/remote-check.sh`
- `scripts/check-changed.sh --list`
- Web Radix cleanup 与 Worker connector 测试已在对应 PR 通过
- 契约与 usage history 保留测试已在 PR #252 通过

## 限制

本地 Linux 使用较新的 Bash，无法完整模拟 macOS 3.2；通过语法、无 `mapfile` 扫描和分支逻辑测试覆盖兼容性。

## 验收步骤

1. 在 macOS 自带 `/bin/bash` 上运行 `scripts/check-changed.sh --files <files>`，应正常生成计划而不是报 Bash 版本错误。
2. 设置 `REMOTE_CHECK_TIMEOUT=3600` 后运行 `scripts/remote-check.sh`，远端检查 job 应使用一小时上限。
3. 全量 Web 测试连续运行，Radix Dialog cleanup 不应留下跨测试窗口的定时事件。
4. 删除设备或工作区后，usage 历史行仍保留且不在 owner/migration 审计中报错。
