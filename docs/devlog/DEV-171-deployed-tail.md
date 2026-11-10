# DEV-171 · 其余已部署改动（收尾）

## 问题

逐项拆分后仍有一组小型、已部署的收尾改动没有独立条目：全局侧栏没有完全复用共享导航样式，step usage 的相等判断漏掉请求速度字段，表格 Dialog 的单一宽度约束缺少回归断言，工作区检查规则也停留在旧描述。

## 调查与修复

- AppShell 的导航标题与条目改用共享 `navHeadingClass` / `navItemClass`，保留窄导航 rail 的特殊布局。
- step usage 比较补齐 `requestMs` 与 `decodeEligible`，请求速度变化会触发正确重渲染。
- 表格 Dialog 测试明确断言只保留一个视口宽度类 `w-[92vw]`。
- `AGENTS.md` 的检查规则更新为按改动选择覆盖测试与类型检查，批次检查在部署前执行一次。

## 部署与版本证据

这些改动均属于 dev 已部署内容，最后一个本地演练分支的产品文件应与提交窗口部署快照 D 完全一致。

## 检查

- Web TypeScript typecheck
- `chat-markdown.test.mjs`
- `sidebar-scope.test.mjs`
- 最终与 D 做全树差异检查

## 限制

本项只收纳逐项拆分后的剩余已部署内容；未部署的 W-2、chevron、ASC-2、adaptive concurrency、bash3 与 S1 修正不进入提交窗口。

## 验收步骤

1. 侧栏标题和条目与 Assistant 设置导航使用同一套样式，窄导航布局不回归。
2. 同一回合的请求耗时或 strict decode 资格变化时，步骤用量应刷新。
3. 表格弹窗只有一个宽度类，窄屏与桌面均不横向溢出。
