# 重构分步计划（工作底稿）

依据：[代码组织全景图](code-map.md)。原则：框架不动，收拢封装、去掉重复实现、补齐公共原语；先合并逻辑、后搬目录；文档最后基于新代码重写。

每一步都能单独合入：行为不变（除非明确是修缺陷），相关测试全绿，`scripts/check-changed.sh` 通过。每个阶段开工前，先对该阶段要动的区域做测试与防御逻辑的抽样审计，只审将要改的代码。

## 阶段 0：已核实的缺陷（已合入，PR #168）

| #   | 内容                                                                                                    | 状态   |
| --- | ------------------------------------------------------------------------------------------------------- | ------ |
| 1   | 验证者设备检查移入 `createAndDispatchWith`，REST 与 MCP 共用                                            | 已改   |
| 2   | 精简会话 SQL 投影收成两个常量，修正子会话列表的 JSON 路径                                               | 已改   |
| 3   | 证据契约校验 TS 对齐 Go；`isHumanActor` 进 protocol；删除 Worker 中被校验器覆盖的重复检查；共享 fixture | 已改   |
| 4   | 证据生成器产物加入 `.prettierignore`，`--check` 接入 `verify` 与 `check-changed.sh`                     | 已改   |
| 5   | Go 用量累加对齐 Worker（费用全知才知，缓存 token 也算用量）                                             | 已改   |
| 6   | 托管根目录判断改用设备路径规则                                                                          | 已改   |
| 7   | `security.md` 的 `access_token` 例外                                                                    | 随文档 |

## 阶段 1：删除遗留路径（第一、二批已合入，PR #168、#169；第三批待部署后）

只有本人设备在用，旧逻辑直接从代码删除，不留兼容分支。Server 端接口如果当前 Worker 仍在调用，先让 Worker 停止调用，再在同一次交付里删 Server 端；部署时 Server 与 Worker 一起更新。

- Server：`Run` 镜像（`runs` / `run_events` / Issue 中的 run 副本）、`POST /api/daemon/register`、旧资源清单 `DeviceResource`、旧定时器端点 `/timer-fires`、仅测试使用的 store 方法、按"旧版 Worker"分支的兼容代码。
- Worker：`issues.ts`（旧合入、旧预览、`syncReviews`）、`session-timers.ts`、`runner.ts` 转出文件、`discoverResources` 旧路径。
- Web：`features/runs`、`app/fixtures.ts` 移出生产包、为旧 Server 保留的状态归一化。

## 阶段 2：Server 后台任务（循环层已合入，PR #168）

- 已完成：13 个后台循环由 `backgroundJobs()` 一处登记、`StartBackground` 一处启动；关闭时先停所有任务、等它们返回，再关 store；ticker 循环收成 `everyFromNow` / `everyAfter`；删除 5 把从不争用的 `TryLock` 互斥锁。
- 不做：把各队列合成一张通用表。各表的 Claim/重试语义不同，合表要迁移数据，收益不抵风险。
- 可选 store 接口改为编译期依赖：已合入（PR #172）。

## 阶段 3：Server 会话服务出 `httpapi`（设计见 [phase3-session-service.md](phase3-session-service.md)；会话令牌可达路由由路由表推导已合入，PR #172）

新包承载创建/派发/发送/取消/inbox/队列与会话事件观察者总线；`personal_agent_maintenance`、`workspace_digests` 改走同一入口；`agentRouteAllowed` 由路由表推导。完成后以同样模式迁出个人助理流程与 Issue 服务（REST 与飞书共用）。

## 阶段 4：Worker 执行路径与启动入口

一个"接收—调度—结算"核心，execution host 与进程内回退只是外壳；调度 key 一份；测试覆盖 host 路径。runner 与 `session/` 判定者合并为一套 harness。

## 阶段 5：公共原语

- Go：一个 `internal` 公共包（rune 截断、id、出站 HTTP client、退避）；设备 RPC 包装与错误码映射一处。
- Worker：`platform/`（路径包含、原子写、JSONL 请求/响应、单飞、按 key 串行、配置读取、脱敏规则、状态目录布局）。

## 阶段 6：跨语言契约（原则已确认，IDL 待定）

原则：每条规则只有一个真相源。

1. 状态与判定只由一端（通常是 Server）计算，经协议下发结果；其他端不再推导（会话活跃、用量合计、转录事件类别、Skill 依赖闭包等）。
2. 手写的业务规则只保留在真相源一端；其他端需要时请求它（例如 Web 的预检改为调用 Server 的 dry-run 校验），不再各写一份。
3. 声明式的定义（消息结构、字段约束、枚举、能力字符串、错误码、标签词表）用一份 IDL 描述，两端代码由它生成；IDL 选型见对话中的比较，待定。

## 阶段 7：目录搬迁

逻辑收拢后再按模块搬：Worker 顶层平铺文件进模块目录；Web `features/chat` 分子目录；`httpapi` 剩余部分按领域拆子包。审计规则同步改为"模块文件必须在模块目录内"。

## 阶段 8：文档

基于新代码重写 `docs/architecture-modules.md` 等，移走带日期的实施记录。
