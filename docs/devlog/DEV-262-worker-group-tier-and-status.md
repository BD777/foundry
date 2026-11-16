# DEV-262 执行组编辑器：成员「主力 / 备用」与每成员状态行

状态：已部署 dev（train15/16/17-20261117）；Agent 代验收（2026-11-17，范围见验收记录）；已合入 main（PR #272）。

本项是 [DEV-261](DEV-261-executor-load-balance.md) 的 Web 半边；服务端接口（`WorkerGroupMember.tier`、只读 `WorkerGroup.domains`）由 DEV-261 提供，本项只改 `apps/web`。

## 改动

- 每个成员可设「主力」（tier 1）或「备用」（tier 2）；无 tier 视为主力。保存走既有 `worker_groups` 保存路径。
- 组内简介与档位提示两种语言重写：账号限流期间会话转到备用成员，账号恢复后回到主力；配额/权重提示不变。
- 每个成员下面一行状态，数据来自 `WorkerGroup.domains`：
  - 限流中（CircleAlert，警示色）：约 N 分钟后恢复（向上取整到分钟；无未来冷却时不留分钟数）；
  - 正常（CircleCheck，成功色）：N/M 个会话；
  - 试探中（虚线圆，muted）、恢复中（RefreshCw，muted）；
  - 另示「1 小时内转备用 N 次」。
  - 图标与文字本身区分状态，颜色只是附加；浅色/深色都清晰。
- `apps/web/src/features/profiles/worker-group-domain.ts`：`memberTier`、`domainForMember`（域 = 账号 + runtime）、`domainStatus`（状态文案键与占位值）的纯函数；`test/worker-group-domain.test.mjs` 断言域匹配、各状态、冷却取整与两种语言的状态文案齐全。
- i18n：`workerGroups.domain.*`（en/zh-CN）。

## 验证

- CanWendeMac-mini（lease 已释放）：Web typecheck、`audit:ui`、prettier 通过；42 个定向 Web 测试通过（一次远程任务因 "local daemon disconnected" 重试后通过）。
- 浅色/深色 1280 宽截图各一张（同一组 mock GET 数据）：`/tmp/dev262-editor-light-1280.png`、`/tmp/dev262-editor-dark-1280.png`（不入库）。
- 部署后（train17-20261117，Web `b99dde4b9481c928`）`/healthz` 200；无迁移。

## 验收步骤

1. 「模型服务 → 执行组」打开组 `deepseek-flash-1017`：每个成员有「主力 / 备用」设置，haiku 显示为「备用」。
2. 成员状态行按账号域显示：正常（N/M 个会话）、限流中（约 N 分钟后恢复）、试探中、恢复中；并显示 1 小时内转备用次数。
3. 修改档位并保存，刷新后仍是保存的值。

## 限制

- 状态是服务端内存熔断器的视图，重启后只重放运行中/阻塞会话最近 30 分钟的事件（见 DEV-261 的限制）。
