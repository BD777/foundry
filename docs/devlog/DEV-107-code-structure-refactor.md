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

- 第三、四轮合并后（未提交，基于 `37677a57`）：完整 `pnpm verify` 通过（29 个 Go 包、Worker/Web/Protocol 测试、全部审计、`go vet`；修正两个回归用例与一处文档中仍指向旧 CSS 路径的引用）。scratch 栈（本人库在线副本、集成关闭）：Server 196 ms 就绪；启动时彻底删除 4 台历史已移除设备（其中一台带 162 个会话、2819 条事件）；新 Worker 配对后真实 Codex 两轮（"NOTED"、记住 "KIWI-9"），会话自己经 MCP `create_session` 建子会话（`source=agent`，回复 "CHILD-OK"），REST 创建 Issue（等待契约确认）；聊天、Issue（亮/暗）、设备、工作区页面渲染正常，日志无错误。真实浏览器：无工作区时访问 `/workspace` 各分区，修复前出现 4 个 `/api/workspaces//…` 被重定向成的 404，修复后为 0；设备页"从 Foundry 移除"在有运行中轮次时先得到 409 提示，"停止轮次并移除"后设备从列表消失，Worker 收到 `device_removed` 后驻留且无子进程，Server 当即删除该设备的会话、Issue、证据、Agent、Skill、资源等全部数据（亮/暗两种主题，含悬停态）。验证结束后栈与临时 Workspace 已删除。

## 部署

已部署（2026-11-02）。顺序：新 Worker 先上，Server 后上（PR #169 起 Server 不再兼容旧 Worker）。

1. 09:4x 发布 Worker 包 `0.5.7-dev.206.g37677a57`（`main` `37677a57`；原 `release.json` 存为 `release.before-dev107.json`）。此前本人第一次点更新时我尚未发布新包，设备装上的仍是 `dev.182`，补发后本人再次更新。
2. 10:1x 7 台在线设备 Worker 均为 `dev.206`（macbook、byte-dev、byte-dev-sg、CanWendeMac-mini、sg-chaos、cottoncpp、limen-canada）。
3. 数据库在线备份 `~/.foundry/server/backups/foundry-20261102-pre-dev107.db`（1.33 GB，`quick_check` ok）；Server 二进制回滚副本 `foundry-server.pre-dev107`。
4. Server 交接部署：新进程接管，旧进程 635 ms 退出，`/healthz` 200；7 台设备 3 s 内全部重连，新握手下分块回复（`reply_chunk`）与资源上报正常，日志无错误。
5. Web `d7a68afb4cb5fc68`（原 `c12e7f5aa210a44d`，存于 `releases/dev107/previous-20261102T021322Z`）；部署脚本校验入口与同源 API 通过；e2e-alice 真实浏览器登录聊天、设备、Issue 页正常。

回滚：二进制换回 `foundry-server.pre-dev107` 并 SIGHUP；Web 用 `previous-…` 两个文件还原；数据库无需回退（新版本没有改动已有表结构，旧版本的一次性迁移记录仍在库中）。

第三至五轮与 DEV-108 一起部署（2026-11-02，`main` `0e24f165`，PR #174；由 DEV-108 会话执行，记录据其回报）：

1. 数据库在线备份 `~/.foundry/server/backups/foundry-20261102-pre-dev107r3-dev108.db`（1,369,866,240 B，`quick_check` ok）。
2. Worker 包 `0.5.7-dev.210.g0e24f165`（原 `release.json` 存为 `release.before-dev108.json`）；本人点更新后 7 台在线设备均为该版本。执行宿主：5 台已换新；byte-dev、sg-chaos 当时有聊天回合在跑，旧宿主排空后自行切换（均非 Issue 执行或证据）。
3. Server 交接 00:34（UTC+8）：二进制 sha256 `e86d71dd…`（回滚副本 `foundry-server.pre-dev108`），旧进程 978 ms 退出，`/healthz` 200；启动即彻底删除 4 台历史已移除设备（含旧 VM-4-8-debian），7 台设备 4 s 内重连，此后日志无错误。偏差：交接先于确认全部执行宿主换新（见上）。
4. Web `c46db7f04bacf74b`（原 `d7a68afb4cb5fc68`，存于 `releases/dev108/previous-20261102T163644Z`）；e2e-alice 真实浏览器聊天、设备、Issue、工作区、Skill、资源页正常。
5. 部署后线上核验（00:4x，e2e-alice 真实浏览器）：设备页逐台移除 DEV048、DEV053、DEV076 三台离线合成设备，均无失败请求；其工作区返回 404，Server 日志逐台记录级联删除（DEV048 含 76 个会话、1,919 条事件、63 条聊天归档）。e2e-alice 只余 DEV023 合成设备（承载其助理工作区）。

回滚（第三至五轮）：二进制换回 `foundry-server.pre-dev108` 并 SIGHUP，同时还原上面的备份（新 Server 已删除 `runs` 等表和已移除设备的数据，只换二进制会留下空表）；Worker 回滚用 `release.before-dev108.json`。

复盘后的修复与 P1（2026-11-03，均先部署、22:00 后再提交；部署从统一集成树 `foundry-int` 构建，部署锁 `/tmp/fdy-deploy.lock`）：

1. 15:27（由 DEV-108 会话交接）Server `1d4bdcf3`：PR #177（关闭等待 hub 发起的工作）、#179（会话事件去冗余与压缩）、#180（P0：恢复分类、外部账号资格一处判定、设备路径、工具结果去行为指导），含 DEV-109；Worker `0.5.7-dev.225.g1d4bdcf3`。17:4x 收尾压缩后停机 54 s 执行 `foundry-server db vacuum`：库 1.42 GB → 756 MB。
2. 18:09 Server sha `71d33308…`、Worker `…local.1793698057`（Agent 经 compute 租约自行更新 7 台；macbook 的 Worker 在 `~/.foundry-stacks/dev`）、Web `78104b64`：#181（会话事件词表一份定义，修 Codex 回合结束标签漂移，删用量回填）、遗留第四轮、Issue 执行成为普通会话（DEV-112）、UI 统一改版（DEV-110）。启动删除 `skills` 表时旧进程退出前报 28 次 "no such table"，之后无。
3. 18:42 / 19:36 DEV-111（连接器扩展）在其上部署；19:17 我从未含 DEV-111 的树交接 Server，覆盖其 Server 约 3 分钟，19:21 恢复。此后统一用 `foundry-int` 与部署锁。
4. 21:06 Server `15d4163a`、Worker `…local.1793710909`、Web `de726783`：P1-A（`internal/textcut`、`internal/keylock`、`google/uuid`，剩余 goroutine 纳入关闭，维护与摘要会话走 `CreateAndDispatch`，session-work 测试根因）与 P1-B（会话来源/活跃状态一份定义并由 audit-contract 锁定；侧栏状态只在 Server 推导，压缩复用同一推导；证据业务规则只在 Server，Web 经 `contracts/validate` 预检）。每批都先过完整 `pnpm verify`、scratch 栈真实 Codex 端到端与真实浏览器检查。

回滚：`dev023-candidate/foundry-server.pre-<批次>` 与 `worker-packages/release.before-<批次>.json`；备份 `foundry-20261103-pre-dev107r5.db`、`…-pre-dev107p1b.db`。

## 限制与遗留

- 高负载下仍有偶发测试失败：`TestWorkspaceDigestTriggers`（单跑与 `-race -cpu=1` 20 次均过）、`TestSetupPrimesEveryProjectAFewAtATime`（未复现）。
- Codex 用 shell 写的文件不进"文件"面板（只统计 Agent 记录为文件写入的编辑），为既有行为。
- P2 未开始：Daemon WS 消息与 REST DTO 迁 OpenAPI、`httpapi` 按领域拆、阶段 8 文档重写。

- 待核实：A9、A13、B17、B19、C5、C7（见清单）。
- Server 严格解码 JSON，删除字段会让仍发送该字段的旧 Worker 收到 400；与滚动升级"容忍未知字段"的原则冲突，随阶段 6 统一。
- 本人库保留三张不再使用的记账表（`applied_migrations`、`session_state_key_revision`、`skill_version_migrations`），无害。
- `scripts/live-session-regression.mjs` 已修复（自带 REST 客户端）；用 Codex 跑时 `orchestration` 需要设备至少 2 个回合名额（7 GB 机器的硬件默认是 1），`steer-child` 受 Codex 父会话较慢影响（消息到达时子会话已结束），不是代码问题。
- 空工作区占位（`api/foundry-data.ts` 的 `emptyWorkspace`）的名称和路径为硬编码英文，未走 i18n；它同时供文档标题与侧栏使用，单独处理。
- 两个测试在高负载下偶发失败（`TestChatQueueCoversSessionsAnotherSessionStarted` 超时，HEAD 同样；`TestDaemonReplacedConnectionIsToldWhy` 仅清理临时目录失败）：测试服务器在 hub 的后台工作停下前关闭了库，下一轮修。
- Issue 状态问句的识别沿用 Web 原有的窄正则（如 "What's the status?"，带 "of this issue" 不匹配）。

## 验收步骤

1. 部署后打开 Web，聊天列表、对话、Issue、设备页正常显示，无报错。预期：与部署前一致。
2. 在一台已连接设备上发起普通聊天并完成一轮。预期：正常回复，用量显示正常。
3. 经 MCP 或 REST 在缺少沙箱能力的设备上创建验证者会话。预期：409，提示更新 Worker 或安装 bubblewrap。
4. 重启 Server。预期：启动日志无迁移报错，后台任务（提醒、inbox、知识库队列等）照常运行。
5. 第三、四轮部署后：设备页对一台测试设备点"⋯ → 从 Foundry 移除…"。预期：对话框列出将删除的内容；若有运行中的轮次，先提示并把按钮改为"停止轮次并移除"；确认后设备从列表消失，其工作区、聊天、会话、Issue 不再出现；该机器上的 Worker 提示已被移除且不再重连，本地文件与登录保留。
6. 第三、四轮部署后：切换到"未选择工作区"，再点侧栏"概览"。预期：直接进入工作区列表，浏览器控制台没有 404。
7. 第三、四轮部署后：浏览聊天、Issue、设备、工作区、Skill 页，亮/暗两种主题。预期：样式与部署前一致；工作区目录树的选中项有底色。

## 时间线

- 2026-11-01（UTC+8 11-01 至 11-02）：review、全景图、计划；阶段 0、阶段 2、阶段 1 第一批实现并自验。
- 2026-11-02 03:19：PR #168（阶段 0、阶段 2、阶段 1 第一批）CI `verify` 两次通过后合入 `main`（`7f53b3f2`）；本地 `pnpm format` 与完整 `pnpm verify` 已先通过。
- 2026-11-02 04:48：PR #169（阶段 1 第二批）CI 通过后合入 `main`（`2ffec9b2`）。scratch 栈端到端验证通过（见"验证"）；发现 `scratch-stack.sh` 停止 Worker 时不停执行宿主，开发机上已累积 13 个，PR #170 修复。
- 2026-11-02 05:05：PR #170（scratch-stack 停止执行宿主）合入；05:4x PR #171（devlog）合入。
- 2026-11-02 05:52：PR #172 合入（`35113bf5`）：Server 的 24 项存储能力改为编译期依赖，删除 62 处运行时断言、16 个访问器及其全部降级分支（501"storage unavailable"、静默跳过工作屏障等）；会话令牌可达的 25 条路由改由路由表标记（`agent(...)`），删除手写路径匹配 `agentRouteAllowed`，测试锁定集合。`httpapi` 全量测试与 CI 通过。
- 2026-11-02：到此暂停。原因：部署需本人先在 Web 上更新各设备 Worker；阶段 3 余下步骤（REST/MCP 创建合并、观察者总线、抽包）与阶段 4（Worker 执行路径合一）都改动核心会话路径，应在前几批部署并人工验收后再做。阶段 3 第 1 步经复查不做（后台会话启动与交互式启动的差异是有意的），见 [阶段 3 设计](../refactor/phase3-session-service.md)。
- 2026-11-02 10:1x–：第三轮（未提交，等 22:00 后提交合入）。Server：删除当前 Worker 恒有能力的检查（约 30 项，保留 `verification_sessions` 与执行宿主相关 6 项）；REST 与 MCP 创建会话共用 `resolveNewSession`，修复两处分叉（助理令牌经 REST 绕过 `dispatch_item`；Viewer 经 MCP 得到误导的"未找到"）；REST 发消息同样拒绝助理令牌；会话事件观察者改为类型化注册并锁定顺序。Worker：执行宿主与进程内路径共用 `execution-core.ts`（修复进程内路径上 Issue 子会话与执行会话可能同时写候选工作树的问题），宿主控制协议类型化（`execution-host/protocol.ts`），`session-policy.ts` / `session/policy.ts` 改名；证据判定者的 Claude 启动经评估不并入 runner（一次性、不持久、无运行时挂钩，强行合并会扭曲 runner）。Web：`features/chat` 94 个文件按职责分入子目录，外部连接设置与目录浏览移出聊天，Agent 运行时组件移出 `components/ui`，路由 schema 移到 `lib/routes.ts`（删除 `lib→app` 例外），HTTP 调用全部回到 `api/`，删除"请更新 Worker"类提示；Protocol 删除连接器的 `*Supported` 字段与 `old_worker`。
- 2026-11-02：阶段 1 第二批内容：删除旧版 `issues.ts`（`syncReviews`、`foundry-worker sync`、按"设备删除"放行的路由规则）、旧 Accept 协议分支、配对机器指纹回退、0.5.4 前设备标签、Skill 包旧 CRC（库中 359 个版本均为标准 CRC）、按字符串识别账号暂停、旧会话定时器执行器（`/timer-fires`、`session_timers` 消息）；复查后保留 `pa_memory` 迁移（无知识库时的在用路径）与无 profile agent 分支（测试夹具仍依赖）。
- 2026-11-02 11:xx–13:xx：第四轮（未提交，与第三轮一起等 22:00 后分批提交合入）。Server：会话服务（创建、派发、发送、取消、inbox、事件、恢复）移入 `internal/sessions`，个人助理移入 `internal/personalagent/{run,knowledge,assistant,flow,prompt}`，均经端口接口（`httpapi/session_ports.go`、`personal_agent_ports.go`）；`httpapi` 生产代码 46,268 → 38,309 行，`*Server` 方法 869 → 715。设备移除改为彻底删除并级联（`removed_device_credentials` 记录已退役凭据，旧凭据得到 410；离线且留有工作的设备也可移除；启动时清理历史已移除设备）；Worker 在被移除后同时停止进程内的会话、定时工作与证据服务。Worker：顶层只留 `cli.ts`、`daemon-connection.ts`、`foundry-cli.ts`，其余按模块进目录（审计改为按目录）。Web：CSS 按组件/功能拆成就近样式表，`src/styles/` 只留 tokens、base 与 6 个模式表，`audit-v3-layout-contract.mjs` 增加未定义 `--fdy-*` 检查。契约：证据模型改以 `contracts/evidence.openapi.yaml` 为唯一来源，生成 TS 类型与 JSON Schema，Ajv / Go jsonschema 校验，`oasdiff` 检查破坏性变更。验证中另修：工作区页在没有工作区（含首屏加载中）时不再挂载各分区，消除 `/api/workspaces//…` 被重定向成"workspace not found"的 404；工作区树选中项恢复选中底色、输入框与描述恢复原意的 token（拆分前引用的 3 个 token 从未定义）；移除对话框改用 `Button` 的 `danger` 变体，删除重复样式（拆分后悬停时变灰）；`scratch-stack.sh worker <name> pair` 把其余参数传给 `setup`。
- 2026-11-02 22:00–23:15：第五轮（Issue 服务、Run 镜像删除、审计清理）与第三、四轮合并后完整 `pnpm verify`、scratch 栈真实 Codex 回归与 Issue 全流程、真实浏览器自验通过；验证中修复 Issue 消息路由未带变更原因即被拒（409 `human_clarification_required`）与 DEV-108 遗留的三处测试/协议问题。PR #174 合入 `main`（`0e24f165`，含 DEV-108 独立提交）；CI `pull_request` 一次通过，`push` 一次因上述清理问题失败、重跑通过。
- 2026-11-03 00:34：第三至五轮与 DEV-108 部署（见"部署"）；00:4x 线上移除三台合成设备核验级联删除。
- 2026-11-03：复盘（`docs/refactor/retrospective*.md`）后完成 P0 与 P1 并全部部署（见"部署"）；按本人定义"完成 = 已验证并部署"，提交留到 22:00 后。
