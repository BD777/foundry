# DEV-107 代码框架重构：收拢封装、删除遗留、修复分叉

[Devlog](README.md)

## 问题

本人要求完整 review 代码框架与目录组织（2026-10-31）。结论：整体框架（单 Server + SQLite、每设备一个 Worker 与 execution host、单 SSE、Agent 经 MCP 回调）合理；问题在中观层——领域逻辑集中在 `httpapi`、同一原语多份实现、Go/TS 各写一份的规则已分叉、遗留兼容代码堆积。本人决定（2026-11-01）：框架不动，按阶段重构；不兼容旧 Worker、旧 Server、旧数据；跨语言规则只保留一个真相源；契约 IDL 采用 OpenAPI 3（Protobuf 备选），存储压缩单列。

## 调研

- 全景图与附录：[docs/refactor/code-map.md](../refactor/code-map.md)（按概念 × 层，重复实现、跨语言分叉、契约现状）。
- 分步计划：[docs/refactor/plan.md](../refactor/plan.md)；遗留清单：[docs/refactor/legacy-inventory.md](../refactor/legacy-inventory.md)。
- IDL 调研：Go 侧 JSON Schema 生成器不支持判别联合；OpenAPI 3 + `oapi-codegen` / `openapi-typescript` / `oasdiff` 能原样描述现有 JSON；Protobuf 的 JSON 映射（int64 为字符串、省略默认值）与 SQLite 中 1.3 GB JSON 及约 195 处 `json_extract` 冲突。实测 `agent_session_events` 86% 字节为字符串值，zstd+字典约压到 25%。

## 实现

阶段 0（已核实缺陷，各有回归测试，并确认未修复时测试失败）：

1. REST 创建验证者会话不检查设备沙箱能力：检查移入唯一创建入口 `createAndDispatchWith`。
2. 子会话列表未裁掉导入上下文（JSON 路径写成顶层）：精简会话投影收成两个常量。
3. 证据契约校验 TS 缺 `project_command`、确定性标准需检查器、确认人 id 三条规则：对齐 Go，`isHumanActor` 进 protocol，删除 Worker 中被校验器覆盖的重复检查，新增共享 fixture。
4. 证据生成器 `--check` 失败且未接入：生成产物加入 `.prettierignore`，接入 `pnpm verify` 与 `check-changed.sh`。
5. Go 用量累加与 Worker 不一致：费用仅在各段都有时才合计，只读写缓存的请求也计用量。
6. 托管根目录判断使用 Server 本机路径语义：改用设备路径规则。

阶段 2（Server 后台任务）：13 个后台循环由 `backgroundJobs()` 一处登记、`StartBackground` 一处启动；关闭时先停任务并等待返回，再关 store；ticker 循环收成 `everyFromNow` / `everyAfter`；删除 5 把从不争用的 `TryLock` 互斥锁。

阶段 1 第一批（遗留删除，见清单中 ✅ 项）：全部一次性迁移与启动转换删除，约 60 处补列并入建表语句（新库列与索引逐项一致）；删除旧 Issue 状态归一化、旧契约导入（三端）、0.5.2 前的过程标签、旧资源上报转换、旧 cookie 与库路径、Web 中"旧 Server"分支与 localStorage 分组迁移、`updatedLabel`、`threadId`（Server 侧）、Worker `runner.ts` 转出文件；`store.Store` 方法 83 → 77。

规模：265 个文件；手写生产代码约 +610 / −2550，测试约 +540 / −1530。

## 验证

- 阶段 0：`scripts/check-changed.sh` 12 项全过；Server `httpapi` / `sqlitestore` / `store` 完整测试通过。
- 阶段 2：Server 全部 26 个包测试通过（`httpapi` 706 s）。
- 阶段 1 第一批：`check-changed.sh`（全部改动文件）与 Server 全量 `go test ./...`；空库建表结构前后对比一致；本人库的表结构（含单行表）在临时副本上可启动。
- 阶段 1 第二批：完整 `pnpm verify` 与 `prettier --check .` 通过；Worker 证据端到端（真实 Server HTTP + Worker）通过。
- scratch 栈（`main` 的 `7abc2999` 构建，本人库完整在线副本，集成关闭）：Server 112 ms 就绪、启动日志无错误；新 Worker 用 Worker 指纹配对（共享系统账号确认）并按新握手注册 Workspace；真实 Codex 会话两轮回复正确（"DEV107 OK"、"SECOND TURN OK"），用量与标题生成正常，聊天页渲染正常；Claude 会话因本机未登录 Claude 失败（环境原因）。验证结束后栈与临时 Workspace 已删除。

## 部署

未部署，等本人执行。PR #169 起 Server 不再兼容旧 Worker（不再声明功能、删除 `/timer-fires`、配对只认 Worker 指纹），所以必须先更新 Worker、再部署 Server；新 Worker 与当前 Server 可以配合（当前 Server 支持全部功能）。Worker 不会自动更新，需设备所有者在 Web 上操作。

1. 发布 Worker 包（不影响运行中的设备）：`pnpm pack:worker-release --out ~/.foundry/server/worker-packages`（先备份当前 `release.json`）。
2. 本人在 Web 的 Devices 页逐台点 Update（在线设备：macbook、byte-dev、byte-dev-sg、CanWendeMac-mini、sg-chaos、cottoncpp、limen-canada）；运行器在回合结束后切换。
3. 全部设备显示新版本后，按 [Deploying the dev Server](../development.md) 部署 Server（保留 `foundry-server.pre-dev107` 回滚副本，`pm2 sendSignal SIGHUP`，查 `/healthz`），再用 `scripts/deploy-web-dev.sh` 部署 Web。
4. 之后可做阶段 1 第三批：删除对当前 Worker 恒有能力的检查（清单 A1、D1）。

回滚：二进制换回 `foundry-server.pre-dev107` 并 SIGHUP；数据库无需回退：新版本没有改动已有表结构，旧版本的一次性迁移记录（`applied_migrations`）仍在库中，回滚后不会重跑。

## 限制与遗留

- 待核实：A9、A13、B17、B19、C5、C7（见清单）。
- Server 严格解码 JSON，删除字段会让仍发送该字段的旧 Worker 收到 400；与滚动升级"容忍未知字段"的原则冲突，随阶段 6 统一。
- 本人库保留三张不再使用的记账表（`applied_migrations`、`session_state_key_revision`、`skill_version_migrations`），无害。

## 验收步骤

1. 部署后打开 Web，聊天列表、对话、Issue、设备页正常显示，无报错。预期：与部署前一致。
2. 在一台已连接设备上发起普通聊天并完成一轮。预期：正常回复，用量显示正常。
3. 经 MCP 或 REST 在缺少沙箱能力的设备上创建验证者会话。预期：409，提示更新 Worker 或安装 bubblewrap。
4. 重启 Server。预期：启动日志无迁移报错，后台任务（提醒、inbox、知识库队列等）照常运行。

## 时间线

- 2026-11-01（UTC+8 11-01 至 11-02）：review、全景图、计划；阶段 0、阶段 2、阶段 1 第一批实现并自验。
- 2026-11-02 03:19：PR #168（阶段 0、阶段 2、阶段 1 第一批）CI `verify` 两次通过后合入 `main`（`7f53b3f2`）；本地 `pnpm format` 与完整 `pnpm verify` 已先通过。
- 2026-11-02 04:48：PR #169（阶段 1 第二批）CI 通过后合入 `main`（`2ffec9b2`）。scratch 栈端到端验证通过（见"验证"）；发现 `scratch-stack.sh` 停止 Worker 时不停执行宿主，开发机上已累积 13 个，PR #170 修复。
- 2026-11-02：阶段 1 第二批内容：删除旧版 `issues.ts`（`syncReviews`、`foundry-worker sync`、按"设备删除"放行的路由规则）、旧 Accept 协议分支、配对机器指纹回退、0.5.4 前设备标签、Skill 包旧 CRC（库中 359 个版本均为标准 CRC）、按字符串识别账号暂停、旧会话定时器执行器（`/timer-fires`、`session_timers` 消息）；复查后保留 `pa_memory` 迁移（无知识库时的在用路径）与无 profile agent 分支（测试夹具仍依赖）。
