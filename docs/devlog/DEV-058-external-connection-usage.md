# DEV-058 外部连接用量展示

状态：已关闭（不实施）。2026-10-28 用户决定：Limen 官方未提供用量接口前不做，也不做 Foundry 侧自行统计（“既不准又费力”）。调研与设计保留备查。实施来源为协调会话 `sess_1793063405185071529` 转达的用户需求（2026-10-28），负责会话 `sess_1793118331626834754`。无 Git 历史写入（提交由协调会话负责）。

| 环节                | 状态   | 说明                                                           |
| ------------------- | ------ | -------------------------------------------------------------- |
| 问题理解/调研       | 已完成 | [调研与设计](../research/DEV-058-external-connection-usage.md) |
| 代码                | 未开始 | 等待范围决策                                                   |
| dev Server/Web 部署 | 未开始 | —                                                              |
| Worker 更新         | 未开始 | Phase 2 需要 Worker 改动（`rate_limit_event`、usage 动词）     |
| Agent 自验          | 未开始 | —                                                              |
| 人工验收            | 未开始 | —                                                              |

## 问题

用户（2026-10-28）：“limen-like 的 provider，是否有办法获得 usage 的信息？如果有的话，也像 subscription 那样展示到我们的 Foundry 的看板上面去。”

## 调研结论（摘要）

- 订阅看板只覆盖本地订阅登录：`accountUsageTarget()` 要求 `local_login`，额度来自 SDK `get_usage` 控制请求或 Codex `account/rateLimits/read`。外部连接被排除。
- 外部连接每个回合的 token 和标价估算已经记录在 `metadata.turnUsage`，可按连接聚合（dev DB：`limen_default` 自 10-25 起 12 个会话、95 个回合）。
- 额度百分比 Foundry 单方面拿不到：`get_usage` 经 helper 代理不会被转发，且即便转发也是上游共享账号的额度；协议 v1 没有 usage 动词。
- 可行来源：被动记录 CLI 已发出的 `rate_limit_event`（网关是否透传待实测）；在协议中增加 helper 自答的 `usage` 请求（需 helper/网关维护方实现）。

## 时间线

- 2026-10-28：接手。只读调研代码、SDK 0.3.201 类型、dev DB 与本机连接 transcript、已安装 helper；未发起模型请求或凭据访问。写成调研与设计，发给协调会话等待决策。

## 提交

- 2026-10-28 夜间窗口经 PR #152 合并到 main（merge `29fe37c`），调研与 devlog 一个提交（含 DEV-056 的 README 条目）。
