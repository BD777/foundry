# DEV-022 · 原生持续工作统一抽象与 Ongoing work UI

状态：2026-10-21 本轮 timer-only 侧栏修复已部署并完成 Agent 自验，公开 Web `a3e6df1daecced03`。Timers 与 Agents 独立，命令历史不再混入；完整库存/聊天记录及 Workspace Services 保留。Server/Worker 本轮未改，源码精确增量交唯一 PA 联合 Git/CI owner；不宣称用户亲测本轮。此前委托准出与历史证据保留。

负责人：[Astra / xhigh 实施 session](https://dev.foundryapp.app/chats/sess_1792392033435484621)，创建回执已确认模型与推理强度。

## 问题与目标

现有面板把任务类型、来源、归属层级和控制能力混在一起：Foundry 子 session 与原生 subagent 同名展示，后代服务被汇总到祖先会话，操作按钮占用窄面板，Claude 与 Codex 原生覆盖不对等。目标是由 native-agent 层统一封装 Claude/Codex，上层业务和 Web 只消费一致的任务模型与真实能力。

## 用户要求

| 范围               | 要求                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 原生定时任务       | 保留 Claude 原生机制，以观察和真实能力适配为主；调研 Codex 原生对应能力并等价接入。原生不支持 stop/pause/resume 就不提供对应操作，不伪造能力。   |
| Foundry 定时创建   | 核实是否仍有必要、是否造成多入口混淆；现有能力足够则移除重复创建入口。先形成证据和结论，不预设必须保留或必须删除。                               |
| 原生后台执行       | Claude/Codex 同一抽象、同等展示；实际支持的控制才提供。                                                                                          |
| Foundry 后台创建   | 与定时能力一样评估必要性，删除被充分覆盖的冗余能力；保护已有任务和运行中的验收服务。                                                             |
| OS 脱离进程        | 保留有价值的发现能力，但必须证明 session 归属和进程身份；不误关联普通前台命令、运行时或其他用户工作。                                            |
| 原生 subagent      | Claude/Codex 都要接入展示；默认观察，不凭空提供生命周期按钮。即使底层存在 stop，也先澄清其粒度与安全语义，不能用停止父会话冒充停止子任务。       |
| Foundry 子 session | 保留创建能力；当前会话只列直接创建的一度子 session，点击跳转。子 session 状态可选，不把孙辈及其服务摊平进当前面板。                              |
| 三类 UI            | 定时任务、后台执行、Agent 工作分开处理；明确原生 subagent 与 Foundry 子 session 的区别。                                                         |
| 操作与状态         | 有效操作放在三个点的 popover 菜单，不再铺开 Stop/Pause/Resume。状态用有颜色的 dot 节省宽度；补充可聚焦说明、tooltip/无障碍文本，不仅靠颜色表达。 |

统一抽象不等于假设两种 runtime 功能完全相同。必须区分“不支持”“未知”“当前不可控制”，并记录原生版本、能力来源、生命周期、任务身份、归属和控制回执。定时定义和单次运行保持区分。批量操作及停止范围随一度展示一起复核，不能隐藏后代却悄悄继续批量停止它们。

## 调研与交付

1. 对照已安装 Claude/Codex CLI、SDK/app-server 协议和官方资料，形成定时/后台/subagent 的发现、观察、控制能力矩阵；区别 CLI、桌面应用与云端能力。现有缺失接入不代表原生不支持。
2. 给出 Foundry 自建计划/后台命令的保留或裁减结论。若无法覆盖跨进程持久唤醒等必要场景，明确差异和最小补充方式；需要产品取舍时请用户拍板。
3. 实现统一 native-agent 边界、两侧适配及上层/UI；迁移兼容已有记录与活跃任务，不造成重复执行或遗失控制。
4. 运行相关回归、真实原生能力验证和浏览器验收，部署 dev Server/Web；Worker 安全更新或告知用户处理。记录实际加载版本，不把发布包等同于设备生效。
5. 在本文件补齐实际方案、变更、测试/部署证据及用户验收步骤，总表更新到待人工验收；用户验收后才能关闭。

## 并发协作

DEV-006/007 由 [Astra session](https://dev.foundryapp.app/chats/sess_1792389911761860653) 同时在本地 main 推进，DEV-008 writer 清理也已整合。两项均须保留。

- 开始写之前交换当前编辑文件与发布计划。独立文件各自推进；共享 runtime/runner、协议、MCP schema 和 UI 公共组件逐文件协调所有权，基于最新内容做局部修改。
- 不 reset/clean、不覆盖整个目录、不回退另一事项的实现；冲突由 owner 结合双方意图解决并重测。
- 共享构建产物、公共 dev 部署、Worker 发布清单串行协调；各自测试数据/端口/日志隔离，不停止另一 session 的验收服务。
- 当前主工作区约束以 AGENTS.md 为准。私人操作约定仅通过会话交接，不写入项目文档。

## 六环节状态

| 理解/调研                                           | 代码                                           | dev Server/Web                               | Worker                                              | Agent 自验                                                    | 人工验收                           |
| --------------------------------------------------- | ---------------------------------------------- | -------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------- |
| 已完成；原生优先，持久唤醒/Workspace 服务为必要补充 | 本地 main 已实现，未提交；保留 DEV-006/007/008 | Server 健康；Web 9a51b00f6cdda112 已实测加载 | 包、daemon 与实际 host 均为1792399633；两服务已恢复 | 相关回归、真实 CLI、新host精确控制、Workspace引用及浏览器通过 | 视觉反馈已修订，待人工复看；未关闭 |

## 流水

| 日期       | 变化与证据                                                                                                               | 下一步                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| 2026-10-19 | 用户明确要求统一 native-agent 抽象、原生能力对等接入、三类 UI、一度子 session、菜单操作与状态 dot；授权独立 session 实施 | 创建 Astra/xhigh owner，先调研和协调共享文件，再持续实现交付 |

2026-10-19 协作确认：DEV-006/007 当前独占 execution-host/client.ts、execution-host/server.ts、workspace-ops.ts、daemon/control-connection.ts 及 execution-host-capabilities.test.mjs；其下一次 Worker 打包、发布和 daemon 更新完成前，本项不并行发布。两项 owner 直接交接共享文件和发布窗口。

## 已验证的能力与实施取舍（2026-10-19 调研中）

已安装 CLI：Codex `0.163.0`、Claude Code `2.1.295`；仓库 Claude Agent SDK `0.3.201`。能力必须按实际运行版本及连接确认，不能从产品名推断。

| 原生能力       | Claude CLI / SDK                                                                                                                                    | Codex CLI / app-server                                                                                                                         | 接入原则                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 会话内计划     | `CronCreate/CronList/CronDelete`、`ScheduleWakeup`；SDK Stop hook 的 `session_crons` 与 PostToolUse 可观察；未发现对应的 SDK 直接删除/暂停/恢复接口 | 已测 0.163.0 experimental 完整请求 schema 和隔离 app-server 请求枚举均无计划 API；不能据此否定桌面或云端调度                                   | Claude 恢复原生创建和观察；无直接可验证控制的计划不显示菜单，不通过模型代执行或停止父会话伪造操作 |
| 后台终端       | `task_started/task_updated/task_notification`，SDK `stopTask(taskId)`；须以终态事件确认结果                                                         | `thread/backgroundTerminals/list`、`thread/backgroundTerminals/terminate`（threadId + processId）；还有独立 `command/exec/*`，两类身份不可混用 | 原生优先；仅精确归属和已确认可用的控制可开放；旧版本/失联显示未知或不可控制                       |
| 原生 subagent  | 生命周期事件及已有 tracker                                                                                                                          | `collabAgentToolCall.agentsStates`、`subAgentActivity`，`thread/list.parentThreadId` 等                                                        | 两侧统一投影，只读；不以父 runtime 停止代替子任务控制                                             |
| 跨进程持久唤醒 | 会话计划要求原生进程运行；恢复有版本及过期边界；桌面/云端另有调度器                                                                                 | 官方桌面/Web 定时能力不等于 headless CLI API                                                                                                   | 保留一个边界明确的 Foundry 持久计划补充入口；不与会话内原生计划并列推荐为等价选项                 |

证据：本机执行 `codex app-server generate-json-schema --experimental`，输出 `/tmp/dev022-evidence/codex-schema/`；无凭据、无模型推理的隔离 app-server 探针 `/tmp/dev022-evidence/codex-control-probe.json` 验证 initialize 返回 0.163.0、thread/start、后台终端 list，以及 terminate 请求被正确解析。当前仅证明接口存在，尚不等于真实单任务终止验收完成。`schedule/list` 被 native 以 unknown variant 拒绝，其完整请求枚举无计划方法。

官方资料：[Codex app-server](https://learn.chatgpt.com/docs/app-server)、[Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[桌面/Web 定时任务](https://learn.chatgpt.com/docs/automations?surface=app)、[Claude 会话计划与桌面/云端对照](https://code.claude.com/docs/en/scheduled-tasks)。接口细节以已安装版本生成的 schema 和 SDK 声明为准。

现有实现问题已定位：`claude-launch.ts` 禁用 cron，`claude-runtime-start.ts` 拒绝原生计划工具，supervisor 自动迁移磁盘计划；后台/agent 默认统一提供 stop；Server 工作范围递归展开后代。实施将取消新的自动迁移，保留已经迁移的历史执行权，避免双触发；原生计划与单次运行分开。普通后台命令创建入口拟收敛至原生，已有 Foundry 受管服务保留观察及控制，真实替代能力验证后再落实裁减。

协作进展：DEV-006/007 owner 已于 2026-10-19 发出源码冻结/打包完成回执（包 `0.5.7-dev.39.gc2e46c6.local.1792392272`），本项取得约定文件编辑权；公共构建及部署权仍待其明确移交。保留对方 4 个源码及 2 个测试文件所有权。当前尚未部署本项。

### 持久服务决定与共享引用

用户确认保留持续运行的本地服务，并要求多个关联会话均可找到同一服务入口。Schedule 是定时触发，持久服务属于后台执行的细分。已测 Codex native 后台终端可精确控制，但 Foundry 当前每回合关闭 native app-server 并验证进程组退出；不能为了服务存活回退 DEV-008 退出确认或 DEV-006 凭据释放。因此 `create_scheduled_work` 保留持久唤醒与持久服务两个明确用途，普通回合内后台命令继续使用原生工具。

共享服务采用同一 work ID、创建 session 和实际执行；关联 session 是显式引用，`control_session_work` 的 `link` / `unlink` 携带 `relatedSessionId`，不改变 generation、不重新启动进程。两侧 session 都需现有控制权限；显示仅限可读取的创建者和关联会话。共享服务排除在会话级批量停止之外；单项暂停/停止影响所有引用，Web 展示范围并在菜单动作后明确确认。解绑只移除入口，不停止服务。

真实 Codex 验证已完成：隔离 app-server 使用原生 `gpt-6-astra / xhigh` 启动两个独立 `sleep 90` 终端；适配器终止一个目标后重新列举，目标消失且兄弟终端仍运行。完整结果 `/tmp/dev022-evidence/native-codex-control.json`，探针最终关闭其自己的 runtime 并释放私有输入。未操作业务服务。初轮 Worker 42 项通过，包括 DEV-008 writer 锁、延迟退出、遗留子进程与同线程重试。后端范围测试正在按一度语义更新；浏览器、共享引用回归和部署尚未完成。

### Workspace 归属与持续管理

用户进一步确认服务应归属 Workspace。实现将持久服务按不可变 `workspaceId` 列入工作区清单，创建 session 只保留审计/旧执行身份；无关联使用 session、创建者已完成时仍可从工作区查询与控制。工作区概览与 Workspaces 行提供“服务”入口，会话里的持久服务也直接打开同一管理面板。跨设备访问仍控制原设备上的同一进程，不表示迁移；关联限制在同一 Workspace，不能跨工作区任意共享。

工作区 GET 服务清单和单项控制复用 WorkStore 与既有工作回执；没有另建服务执行器。关联变更使用独立 `referenceRevision`，不会增加执行 generation 或触发重复启动；全局控制须携带最新关联版本，避免陈旧页面误判影响范围。退出或交接会话不停止服务，`unlink` 不停止服务，`stop_all` 不包含共享服务。

历史兼容补充：新观察到的 Claude 原生计划永不进入 Foundry 执行器；已退休原生来源的旧迁移定义保留原执行权。仍存在 native 定义的旧未完成迁移会显式报不可自动迁移，保留源文件。带旧迁移记录的 runtime 继续隔离 native cron 恢复，避免原生 transcript 恢复导致双触发。新 server 不把原生只读计划下发给不声明 `X-Foundry-Native-Work: 1` 的旧 reconciler，避免旧宿主误接管。

### 已取得的浏览器证据（仍在最终检查）

使用独立测试数据库、真实 HTTP 路由与编译 Web 页面验证，不修改日常数据。已验证：三类分组；两个 native subagent 均只读且无空菜单；状态 dot 有可聚焦名称；键盘打开菜单、Escape 返回原按钮；共享服务停止前显示全部关联会话影响；直接子 session 点击跳转且父面板不列孙辈；正常宽度与 900px 页面没有水平溢出（侧栏约 290/318px）。

共享引用交互：consumer session 通过菜单解绑后，入口消失；工作区服务入口仍可找到同一 work ID，`generation=1`、`desiredState=enabled`、观察状态 running、关联版本变为 2。证据 `/tmp/dev022-evidence/browser-service-preservation.json`。此处为受控的 UI/API 合成状态；真实进程停止隔离由前述 Claude/Codex CLI 和 WorkProcesses OS 回归分别验证。

截图：`.foundry/attachments/dev022-work-light.png`、`dev022-work-dark.png`、`dev022-work-narrow.png`、`dev022-workspace-service-unlinked.png`。检查发现并修正了工作区对话框重复说明、会话切换短暂显示旧清单、测试 mock 未区分服务 API、协议 DTO 内联类型导致字段审计误读，以及旧回执查询时持有 SQLite rows 的等待问题。最终回归和部署尚未完成，不以初轮通过项代替交付完成。

## 2026-10-19 16:55 · 实现、最终验证与部署回执

本节覆盖前述阶段记录中的“实现中/尚未发布”。实现与所有不依赖宿主切换的检查已完成；未创建 Git commit。DEV-006/007 owner 已交接公共构建/发布权，并独立核对本次最终包、实际 daemon 和三个受保护工作。

### 最终取舍与实现边界

- 原生任务统一经过 `packages/worker/src/agent-runtime/work/`，协议 `NativeWorkInfo` 包含 runtime/version、native session/task 身份、发现来源、观察状态和每项控制能力；控制结果保持 verified/pending/unknown 区别。未测版本、发现接口失败和 runtime 失联不会被推断为已完成，也不会开放未经验证的按钮。Codex CLI 0.163.0 的 stop 必须再次枚举精确 thread/item/process 归属并等到目标消失；两种 native subagent 都只读。
- Claude 原生计划不再一律禁用或新建即迁移。原生定义与 `lastRun` 分离：计划快照、空清单、重复/乱序事件及同步中的结束事件不能覆盖当前运行或复活终态。缺少 `session_crons` 的旧事件不是“确认没有计划”。旧迁移保留原执行权和条件禁用，不自动迁回。Server 不将原生计划交给旧 reconciler 执行，原生计划不能领取 Foundry run。
- 保留 `create_scheduled_work` 这一个持久工作入口，明确用于跨 native 进程生命周期的唤醒、或用户已批准的 Workspace 持久服务；普通会话内计划/后台命令用原生工具。没有再增加一套平行创建 API。MCP schema、Worker CLI 参数和两份内置 Foundry skill 同步说明边界，旧创建记录和控制回执继续兼容。
- 服务归属不可变 Workspace；创建 session 是审计来源。`relatedSessionIds` 是明确关联，`referenceRevision` 防止过期影响范围；关联/解绑只更新引用，不增加执行 generation。Workspace 清单与控制不依赖仍有活跃或关联 session，同 workspace 成员权限与 Issue 范围单独校验。归档后的重复控制可找回原幂等回执；跨 workspace 关联拒绝。
- 当前会话仅列其自己的工作与直接 Foundry 子 session，原生 subagent 另作标识，显式关联服务可以出现。全后代的隐式扁平展示和批量控制已移除；共享服务不随会话批量停止，单项全局操作先显示影响范围，解绑不停止。OS 发现仍只接收可验证归属/进程身份的来源，不能凭普通命令名称推断为任务。
- Web 使用共享菜单/Tooltip/Dialog 的公开 API；三类分组、状态 dot、无动作不显示菜单、直接子 session 跳转、长标题详情、未知/终态及错误/重试均可访问。Workspace 概览和 Workspaces 行均提供服务入口。会话切换按 session ID/请求代次隔离，避免旧父会话清单短暂出现在子会话中。

主要代码边界：`packages/protocol/src/session-work.ts`；Worker `agent-runtime/work/`、`session-work/`、`agent-timers.ts` 及 Claude/Codex runner；Server `internal/{store,sqlitestore,httpapi}/session_work.go`、`httpapi/workspace_services.go`、`sessionwork/projection.go`；Web `lib/session-work-state.ts`、会话工作面板及 `components/workspace/workspace-services.tsx`。`docs/architecture-modules.md` 和模块审计同步新边界。保留 DEV-008 全进程组退出确认后才释放 runtime/凭据的逻辑，以及 DEV-006/007 已有隔离与实际宿主能力门；本次共同包包括其最终空模型字符串规范化修复，撤回的模型目录初始化方案没有混入。

### 自验记录

使用真实安装 CLI、独立 HOME/端口/测试数据库及账号；未停止或替换业务工作。测试失败后按具体原因修复重跑，以下是最终证据，不把初轮失败写成整轮成功。

| 层级            | 最终证据与结果                                                                                                                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原生版本/协议   | Claude Code 2.1.295、SDK 0.3.201、Codex CLI 0.163.0；实验 schema 与无推理探针保存在 `/tmp/dev022-evidence/codex-schema/`、`codex-control-probe.json`。计划缺失结论仅限这一 CLI/app-server 版本。                                                     |
| Codex 真实控制  | 原生 app-server + gpt-6-astra/xhigh 启动两个 `sleep 90` 后，终止一个精确目标、再次列举确认兄弟仍存活；探针自己的 runtime 最终关闭。`native-codex-control.json`、`native-codex-control-final.log`。                                                   |
| Claude 真实 CLI | 真实 SDK/CLI 配合隔离的确定性本地模型协议 fixture：单个后台任务 stop 收到终态、兄弟任务仍运行；历史 cron 恢复禁用与压缩后工作上下文兼容。`native-cli-final.log`：2 pass、0 fail。该 fixture 不等于真实 provider 推理。                               |
| Worker          | 最终相关测试 `native-patch-tests-final.log`：64 pass、0 fail，包含新观察器、原生计划定义/运行竞争、发现失败、进程/凭据退出和 DEV-006/007 空 model 回归；`native-run-final-check.log` 的 build、14 个测试文件及模块审计通过。                         |
| Protocol/Web    | `native-run-check.log` 中 protocol build/test、Web typecheck、46 个 Web 测试文件与全部 UI/contract/module 审计通过；当轮 Worker 两项失败由下一轮 `native-run-final-check.log` 修正并通过。此前菜单/权限/路由补齐后的 `final-check.log` 全通过。      |
| Go API/Store    | `changed-check3.log` 的完整 httpapi/sessionwork/store 检查及范围测试通过；新增 Workspace 无关联/创建者完成仍控制、跨工作区拒绝、归档重试见 `workspace-service-final2.log`；native `lastRun` HTTP 往返与拒绝第二执行器见 `native-run-api-final.log`。 |
| 隔离真实浏览器  | 三类、直接子会话导航、无 native subagent 菜单、共享影响确认/解绑、Workspace 持续管理、深浅主题和窄面板通过；服务区域 axe 16 pass、0 violations。最终 `TestSessionWorkBrowserFixture` 正常结束 PASS（428s），测试服务与两个浏览器均关闭。             |
| 日常浏览器      | 复用已登记 e2e-alice，实际 dev Web 构建 `759792eaa18e9b46`，`index-CoAsz9Nz.js`；Workspace 服务 GET 200、空清单与说明正确、390px 页面无水平溢出，没有创建日常对象。                                                                                  |

新增最终截图：`.foundry/attachments/dev022-native-run-light.png`、`dev022-native-run-dark.png`、`dev022-native-run-narrow.png`、`dev022-daily-final-services.png`。原生计划详情显示独立“Latest native run”；有心跳的受管计划菜单确认为 Pause/Stop/Run now；318px 工作面板的 clientWidth/scrollWidth 均为 318，状态 dot 有 role、tabIndex 和可读名称。共享解绑证据 `browser-service-preservation.json` 中同一服务仍 enabled/running、generation 仍为 1。

### 部署与实际加载

| 对象                      | 实际回执                                                                                                                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dev 数据保护              | `~/.foundry/server-backups/dev022-snapshot-20261019T074541Z/` SQLite 一致快照，quick_check=ok，密钥副本权限 600；回执 `deploy-backup.json`。旧发布包与 manifest 保留。                                                            |
| Server                    | PM2 `foundry-server` 安全重启；本机 `/healthz` status=ok、startedAt=`2026-10-19T08:52:16Z`（北京时间 16:52:16）；API 公开下载与账号请求正常。重启期间短暂 502 已恢复。                                                            |
| Web                       | 静态 watch 构建实际发布并由真实浏览器加载 `759792eaa18e9b46` / `index-CoAsz9Nz.js`；浏览器 meta 与 `/version.json` 相同。                                                                                                         |
| Worker/Protocol 发布      | 最终 `0.5.7-dev.39.gc2e46c6.local.1792399633`，在 `1792396585` manifest 基础上 CAS 发布；457 个包输入打包前后 SHA 一致。发布文件名与 latest 两类共四次公网 SHA 核验通过，回执 `/tmp/dev022-evidence/patch-release-receipt.json`。 |
| 包 SHA256                 | protocol `b8ba268b1bb12dbae75aa46a123a5092ec50b008e0310a9ec45876e76d91466d`；worker `e78d1a1178d68bc950d2255fd9186e664eda9c80e86ac609c092eced0ddec349`。                                                                          |
| dev-server daemon         | 安全 update exit 0；PID 298186，Server 设备记录 connected/version=`1792399633`，安装 current 指向该版。                                                                                                                           |
| dev-server execution host | **仍为 PID 161331 / `1792369800`**。实际宿主尚未加载新适配，不能把 daemon 更新当 native 生效；旧宿主的 draft capability 保持未宣告。当前 UI 动作依实际记录能力，未因新版 Web 就开启新 native 控制。                               |

DEV-006/007 owner 独立复核最终公开包 SHA、空 model 修复、await close 边界、实际 daemon/host 与三个工作一致；之前还在公开 `1792396585` 包做过真实独立 verifier smoke 和凭据释放验证。其独立记录见 `DEV-006-007-isolation-drafts.md`，本项不代替该 owner 的完整验收。

### 实际宿主升级阻塞与最小维护方案

这不是简单等待会话自然空闲的问题：持久服务会让现有宿主永久 busy。`execution-host/server.ts` 的 `prepare_upgrade` 只在 `!busy()` 时允许切换，busy 包含 `sessionWorkBusy()`；running 和 suspended 进程都算忙。`execution-host/service.ts` 的 Linux 单元使用 `KillMode=control-group`，当前两个合成服务与 host 位于同一 cgroup。只读检查没有找到已实现的服务移交、进程接管租约或多代 host 共存控制路径，不能安全绕过 busy，也不修改 KillMode 或把进程脱管。

16:54 实际受保护工作：

| 工作                                                | 状态                                                    | 保护边界                                                                          |
| --------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `work_2de671aff5f6b54978a980c3d9b18601` 合成 Server | running、rev1/gen1、PID182803                           | 58105 合成栈的数据/API；不得 scratch-stack down 或删除 DB。                       |
| `work_e079566a13f5dbbd745d90199ccd6a54` 合成 Worker | running、rev7/gen4、PID277892                           | owner 已用同记录安全恢复到已安装 6585 helper，数据/定义不变；不得换成重复新服务。 |
| `work_5a71ddbc9f817ab5ea9e02547ec5ab44` 接续计划    | enabled/idle、rev1/gen1、nextFireAt=2026-10-19 22:00+08 | 原计划和执行权保留，不重建、不取消；当前由旧 host 正常观察。                      |

两服务 cgroup 为 `/user.slice/user-1003.slice/user@1003.service/app.slice/foundry-execution-3c15d9486a45731c.service`，见 `/tmp/dev022-evidence/final-runtime-state.json`。16:54 host claim 只有本 DEV-022 session active；后续发送协作回执会唤醒相关 owner，维护前必须重查，不能把快照当实时授权。

以下是**尚未执行、需明确授权**的最小方案：

1. 等本项及任何再次唤醒的旧 host 会话完成，确认两个合成 Workspace 没有 queued/running Issue 工作；保留现有 DB、helper 和 work 定义。
2. 仅对上述两个服务逐个发 stop，并核验 verified 与实际退出。不能用 pause 代替（暂停仍占 busy），不能 stop_all。这是两个合成服务的短暂中断，不涉及停止原接续计划。
3. 在无 active claims/持久进程后，让 daemon 走已有标准 idle upgrade；不强杀 host/cgroup。核实新 host PID 和真正包路径为 9633，然后在同一两个 work 记录上 resume，复用既有 helper/数据，核验实际端口与设备连接恢复。
4. 核对原计划 ID、enabled/idle、revision 和 nextFireAt；由新 reconciler 读取同一记录，不复制任务。维护窗口避开其到点时刻；如服务停止未 verified 或会话重新 active，停止切换流程并恢复服务，不强制继续。

维护需要当前旧 host 会话结束后由受管流程或操作者继续核验；本次不创建脱管脚本/host cron。用户尚未授权中断这两个受保护服务，因此本项只完成到安全发布，日常新版 native 加载与加载后的综合验收仍待此步骤。该缺口单独记录，不扩展为未经评估的 host 架构改造。

### 人工验收步骤

1. 刷新 dev Web，在会话详情查看 Schedules、Background execution、Agents 三组；行内只有状态 dot，有操作才有三个点菜单，键盘可到达，展开可看完整长标题、原生版本和控制原因。深浅主题和窄侧栏都不溢出。
2. 查看父会话的直接 Foundry 子会话，点击跳转；孙会话及其服务不隐式出现在父工作面板。原生 subagent 与 Foundry 子会话标签不同，原生 subagent 没有生命周期按钮。
3. 从 Workspaces 行或 Overview 打开服务；同一 Workspace 服务在创建会话结束、无使用会话时仍可找到。对专用验收服务显式关联第二会话，两处显示同一 work ID；解绑只消除引用；全局停止/暂停先说明影响，共享服务不被 session stop_all 误停。勿用两个受保护业务验收服务试停。
4. 完成上述授权维护并核实 host 9633 后，再用专用会话创建原生任务：Claude 原生计划保持原生执行且显示独立最近运行；Codex 0.163 后台终端可精确 stop、兄弟不受影响；两个 runtime 原生 subagent 只读。未知版本/失联不显示假成功或不支持的按钮。
5. 验收原计划/服务记录未重建、无重复执行，DEV-006/007 服务与原接续计划仍在；确认后由用户标记本项验收范围。当前人工验收未确认，本项不关闭。

## 2026-10-19 19:52 · 已授权短维护，受管交接中

用户已明确批准立即执行相关运行栈升级与验证；本 owner 为唯一维护执行者。已核实两合成 Workspace 无 queued/running/blocked 执行会话，原 `iss_107` 为 draft/revision 4，`iss_108` 保持 accepted/revision 2。一致数据库及 helper/配置备份位于 `~/.foundry/server-backups/dev022-maintenance-20261019T115009Z/`，quick_check=ok，秘密副本权限 600。

精确停止顺序为合成 Worker 后 Server：Worker `wop_df304d80c0a748d9c7c4028c2e0d56b7` verified、revision 8；Server `wop_c0132efd7283193529eae8cac6167c5c` verified、revision 2。两个原 PID 均实际消失，58105 端口关闭，未调用 stop_all。回执 `/tmp/dev022-evidence/maintenance-stops.json`。同一 Worker 的仓库外 helper 已从公开 6585 路径更新为已安装 9633，未改变 work ID、数据或原计划。

为释放维护回合自身 active claim，登记一次性 Foundry `continue_thread`：`work_8f3b978734f845995d622c294160b9b4`，19:53:20 接续。本回合结束后由已有 daemon idle upgrade 尝试切换；接续首先验证实际 host，再以原记录先恢复 Server、后恢复 Worker。如未切换也先恢复服务再诊断，禁止强切或无限等待自身空闲。原 22:00 接续计划仍 enabled/idle、revision 1，不被维护计划替代。恢复和加载后验收尚在进行，不能把本段停止回执写成整个维护完成。

## 2026-10-19 19:57 · 宿主维护与加载后复验完成

一次性接续准时执行；日常宿主已通过原有 idle upgrade 切换到 PID **374938**，`identity.json` 与 `/proc` 实际入口均指向公开 `1792399633`。daemon PID 298186 同版且 connected；设备现在宣告 `workspace_draft_skills_v1`。没有强杀旧 cgroup、绕过 busy 或把服务脱管。

Server 原记录恢复回执 `wop_fb3cf62cf1a144b3795a6021640cc6ee` verified，revision 3/generation 2/PID375677，58105 `/healthz` 正常、startedAt=19:53:56。随后 Worker 原记录恢复回执 `wop_f3409dc0c05f486a76367b51ec6e739f` verified，revision 9/generation 5/PID375855；实际运行公开 9633，合成设备 `dev_98e07e47-ede7-4b3c-90f0-e96117c689ac` connected 且支持草稿能力。没有新建重复服务。停止到进程恢复约 Server 2 分 47 秒、Worker 3 分 29 秒。

原 `iss_107` 保持 blocked/draft/revision 4，`iss_108` 保持 accepted/integrated/revision 2，candidate `snap_d57e9412-a2f0-48ea-8062-ee08d7d9ec6d` 和 review `review_93017779-03e8-48bb-803b-81707a1f8260` 未变。原 22:00 计划的 ID、revision 1/generation 1、nextFireAt 与 enabled/idle 状态均未变，coverage.schedulerVersion 已是 9633。恢复回执与数据证据：`/tmp/dev022-evidence/maintenance-restored.json`、`maintenance-issues-after.json`。

在**日常新宿主的本回合**启动两个原生 `sleep 120` 终端，均由 app-server 0.163.0 原生枚举并同步至真实 Foundry 工作清单；仅显示 stop 能力。对 task98599 的控制 `wop_fd79f5636317fbf62044667471485786` verified，目标 stopped，task64363 同时仍 running；随后对兄弟测试任务清理 `wop_8bcb808162bb51c06df6ef8218c1681d` 也 verified。证据 `/tmp/dev022-evidence/post-host-native-evidence.json`。这补齐了此前“包已安装但日常 native 未加载”的缺口。

Workspace 真实清单返回两个既存服务。对 Server 原记录临时显式关联本会话后，入口出现在本会话；解绑后入口消失，Workspace 清单仍在，进程 PID375677、执行 revision 3/generation 2 均未变化。link/unlink 两回执 verified；关联版本正常变为 referenceRevision 2，已告知原 owner 后续控制须使用最新版本。没有对两服务再发停止/暂停。

DEV-006/007 owner 已接回合成栈，独立确认新宿主并完成当前回合 refresh、fresh include/exclude、普通新会话发现草稿及公开 9633 独立 verifier 的实际读取冒烟；其记录见 `DEV-006-007-isolation-drafts.md`。它的其余候选场景由原计划继续承担，本项没有新增重复接续。

临时维护任务已 pause（revision 2），只禁用未来派发，本轮仍继续 UI 精修。回合结束后由 parent 移除这一条临时记录并核验终态，不能在其执行本回合时用 stop/remove 取消自身。原 22:00 计划不属于清理范围。

## 2026-10-19 · 用户视觉反馈与精修

用户实际查看后指出逐行横线难看、padding 不统一、右侧状态点和箭头占用标题空间。这次视觉验收**未通过**，此前功能/axe 通过不作为视觉接受。原反馈截图为 `.foundry/attachments/20261019/att_dm8sngy26t0t_0_image.png`、`att_dm8snox2xhd6_0_image.png`。

按用户意见去掉列表行内横线和子会话箭头；子会话使用真实链接，保留普通点击的应用内跳转、键盘 Enter、复制/新标签页语义。状态并入左侧 Clock/Terminal/Bot 类型图标的位置：保留空心类型轮廓，颜色和小型静态状态标记区分运行、等待、完成、失败、暂停、未知，附带可聚焦 tooltip 和类型/状态无障碍文本；不填满机器人、不添加持续动画。右侧只放确有操作的菜单。来源说明缩为 Foundry session、Codex/Claude native 或 Workspace service；完整标题可读取。Ended 使用无胶囊背景的轻量展开行，历史条目不增加缩进。批量菜单与标题同行，影响范围在选择该动作后的确认框展示，减少常驻说明占位。

最终 Web 实际发布并由日常浏览器加载 `9a51b00f6cdda112` / `index-B2ANXj5s.js`，页面 meta 与 `/version.json` 一致；本轮只有 Web 和测试/文档变化，不另发 Worker 包，不重启已恢复的服务。共享 `WorkStatusIcon` 也用于 Workspace 服务清单，未通过私有 DOM 或 JS 改写 CSS。

最终验证覆盖正常 1280×900、900px 页面及 390×844 窄屏；318px 工作面板的 clientWidth/scrollWidth 均为 318。逐行 border 为 0，Ended 背景透明，进行中/历史条目采用同一缩进；子会话链接内没有箭头，右侧没有独立状态点。键盘焦点能读出“Child session · Running”等类型+状态，菜单 Escape 返回触发器；Ended 空格展开/收起，子会话 Enter 跳到正确 URL，批量停止先显示真实范围且取消不改状态。长中英文标题、无菜单原生 subagent、暂停/失败/未知/完成状态均逐项查看。所有新状态标记均无 CSS 动画。

本轮类型检查、10 项 UI 审计通过。初轮 46 个 Web 测试文件发现旧的纯状态文本断言，精修批量菜单后又发现依赖常驻说明文字的断言；两者改为真实无障碍语义/菜单可用性后，最终相关 17 项测试和 `scripts/check-changed.sh` 通过，见 `visual-last-check.log`。中途一个补跑聚合命令返回 143，未记为通过；类型/审计证据在 `visual-small-check.log`，最终单项回归单独复跑。真实浏览器 fixture 的 Go 测试日志 PASS（725.742s），外层 native shell 曾返回 143，实际 fixture 子进程已通过 done marker 正常结束，无遗留服务；不混淆外层回执与测试结果。

深浅主题的最终 axe 检查各为 20 pass、0 violations、0 incomplete，见 `visual-final-light-a11y.json`、`visual-final-dark-a11y.json`。主题切换过渡中的一次采样曾读取新背景/旧文字色，等实际主题颜色稳定后重新检查；未用临时 CSS 覆盖来修补结果。最终两个浏览器和独立测试 HTTP fixture 均已关闭，日常账号没有新增对象。

供人工复看的截图：

- `.foundry/attachments/dev022-refined-panel-light.png`、`dev022-refined-panel-dark.png`：侧栏工作区域。
- `.foundry/attachments/dev022-refined-final-light-overview.png`、`dev022-refined-final-dark-overview.png`：正常尺寸整页。
- `.foundry/attachments/dev022-refined-final-mobile.png`：390px 页面；`dev022-refined-collapsed.png` 记录收起状态。

请按新截图及实际 dev 页面复看图标、行距和 Ended。此前用户指出视觉未通过的记录保留，当前是修订后待复验，不能由 Agent 代为关闭事项。

## 2026-10-20 显式委托准出记录

用户于 01:07 明确委托“你验证OK了的，你都先确认归档吧”。本轮按已验证范围由 Agent 准出，未追加用户本人测试的声明；历史未通过/待验条目是对应时点记录，不抹除。最终边界、浏览器/版本/合入证据见 [DEV-025](DEV-025-release-closure.md)。

only-ended 修订的公开 build `5c363c9b29f8b22e` 已在真实独立 HTTP/UI fixture 完成零项/6 条已结束/8 活跃+3 历史、键盘、中英、双主题与 390px 窄屏检查。上下 16px、gap 8px；axe 亮/暗各 20 pass、0 violation。截图及交互 fixture 外层 143 的准确边界见 DEV-025，不将该外层测试回执写成 PASS。两个既有合成服务继续运行并保留数据，临时计划已有精确 remove verified；未调用 stop_all。

## 2026-10-21 · 侧栏只展示定时任务与独立 Agent

用户实际反馈右侧 `Work → Ended (119)` 被 cat、ssh、test、git 等普通调用历史填满，明确要求“这里预期只放 timer 类的东西，工具调用历史不用放在这里”。反馈图：`.foundry/attachments/20261021/att_dmaiyanmwdkb/att_dmaix6sk0j39_0_image.png`。本轮修正的是侧栏范围，不删除原生记录，也不改变原任务/服务的生命周期；历史三类统一模型仍保留在 MCP 库存，持久服务仍从 Workspace Services 管理。

根因：`SessionWorkSection` 只过滤 removed/非独立工作，将 schedule、process、agent 合并到一个 Ended 折叠；原生 app-server 正常记录的命令执行因此进入侧栏。没有证据需要改源分类，故不修改 Server、Worker、协议或数据库。

实现边界：

- 仅 `kind=schedule` 进入 Timers（定时任务），Foundry 和原生 timer 一致；Agent 独立成区，原生 subagent 与直接 Foundry 子会话仍可辨识、查看和跳转。两个历史折叠、空态和输入框计数分别按其种类计算，命令及服务不参与。
- 移除侧栏的 conversation-wide `stop_all`。`useSessionWork` 只接受有明确目标、当前可见且具备相应能力的单项控制；拒绝 bulk、process、native-agent 生命周期控制。重试保留原幂等键/版本，同时检查目标仍属于侧栏范围，不能借失败重试控制隐藏服务。
- 控制回执只有完整目标集都属于当前区时才呈现，隐藏/混合目标的旧 bulk 回执不冒充 timer 回执。真实 timer 的 pending、unknown、offline、屏障说明及单项控制保持；原生缺能力时不造按钮。
- 无 work list 或读取失败时，旧 `BackgroundSection` 不再回退渲染；真实旧 timer 与 subagent 回退仍可见。普通后台进程不参与侧栏入口计数，聊天文档的后台活动标识和原始记录保留。
- `lib/session-work-state.ts`、Workspace Services 的生命周期与完整后端库存未改。没有用工具名/标题正则猜测类型，也未停止或删除既存计划/服务。

本轮 14 个代码/测试路径位于右栏组件、状态、controller、chat 中英翻译和对应测试；没有改 DEV-033 左栏。DEV-034 的 service/tunnel 实现由其 owner 独立处理，未混入本次候选。固定候选 `~/workspace/foundry-dev022-timers` 继承 `~/workspace/foundry-dev033-tools`，保留其 029 async + 032 + 031 align + 033 tool-group 基线；2,183 个其他基线文件逐一核对未变。精确 source manifest / before-after / patch 位于 `/tmp/dev022-timers-20261021/`，供唯一联合 Git/CI owner 集成，不整树打包 dirty。

自验证据：

| 范围                       | 结果                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/check-changed.sh` | 48 个相关 Web 测试文件和 10 项 UI 审计通过；初轮发现可选索引及 fixture 缺字段两处类型错误，修正后独立 typecheck 通过；最终定向 check-changed 通过。                                                     |
| 固定组合候选               | typecheck、生产构建通过；23 项定向回归全通过，含 bulk/隐藏控制拒绝、原幂等键重试、119 条范围投影、无 list 的旧 fallback 与历史折叠。                                                                    |
| 119 条混合库存             | 111 条命令 + 4 个 timer + 3 个 agent + 1 个服务完整保留；侧栏仅 7 行，当前计数为 2 timers/2 agents，已结束计数分别为 2/1。过程不变更隐藏服务。                                                          |
| 真实浏览器                 | 生产 CSS 的 14 个场景通过：中英、深浅、1280/390px、仅命令、仅历史、仅 Agent、fallback、读取失败、离线；最长标题无横向溢出。两个历史折叠互不影响，键盘 Space/tooltip/菜单与 Foundry 子会话链接验证通过。 |
| 控制请求                   | 浏览器模拟单项暂停后保持 pending，失败重试使用完全相同的 ID/revision/idempotencyKey；请求只指向 timer，没有 bulk/隐藏 process 写入，服务仍 running。所有测试 API 均为隔离 fixture，不执行真实任务。     |
| 可访问性                   | 最终亮/暗各 20 pass、0 violation、0 incomplete。                                                                                                                                                        |

固定 fixture 单独打包的 CSS 起初与应用入口不同，最终改为引用实际待发布 CSS，并核对 SHA-256 `bcd7eac38c26fac9af6dd3d9af7cdd27a734e5b267a969ccd1470827e6bb48a2` 完全相同后重跑矩阵。测试专用入口未纳入生产发布。详见 `check-changed.log`、`typecheck-final.log`、`final-check.log`、`candidate-tests.log`、`production-css.json`、`browser-matrix.json`、`retry-browser.json`、`a11y-{light,dark}.json`。

截图：`.foundry/attachments/dev022-timers-20261021/final-panel-light.png`、`final-panel-dark.png` 及同目录中英/主题/窄屏整页。此前准出保留为历史；本次追加的 timer-only 约束以此节为准。最终发布和回执在下文登记，不以候选构建成功冒充公网已生效。

### 2026-10-21 21:43 · 最终发布与线上回执

DEV-033 明确移交窗口后，从公开 `8577a1b9c462b8ca` / index SHA `30e536b579628bf81b10f05b3c140b70a5c96e40d754c38f1e84bb7ee365ffcf` 做 CAS 发布，保留旧 assets 和该版 index/version 回滚文件。最终 Web **`a3e6df1daecced03`**，index SHA-256 **`15a60b859b2fc0f55a6e8d3c97516603c69050822991a5c6b27c108d0c0ecf7d`**；公开 HTTP、磁盘、认证浏览器 meta 与 `version.json` 一致，实际脚本为 `index-ONTVRq5D.js`。

Server PID **1840661**、已加载二进制 SHA **`3b6403643063afff677888c6b2c568aebfa09add25ca312bd12807363b2f142a`**、health startedAt=`2026-10-21T10:42:57Z` 保持不变且 healthy。Worker release pointer SHA **`264c61395b300b0ad4445b9e8027e17d547d6ac6f5a8e0dd8adae59202523720`** 未改；本轮没有重启 Server 或更新 Worker。发布前后磁盘分别约 10.14/10.13 GiB 可用，仅清理已核实无进程引用的本 owner 旧测试浏览器 profile，未删数据库/WAL/业务文件或回滚包。

复用登记的 e2e-alice，在真实 dev 页面读取既有合成会话；只在浏览器中替换该会话的一条 **GET work 响应**为 119 条混合 fixture，不创建会话、不写服务端数据。已部署的实际页面显示 Timers/Agents 两区、7 个正确条目、历史分别 2/1，原聊天内容保持可读，未出现 `/work/operations` 写请求。随后解除读取拦截并正常读取真实库存，再关闭浏览器。截图 `live-119.png` 与 `live-{version,119,unrouted}.json` 区分公开构建核验和受控数据注入，不冒称这些合成 timer 在真实运行。

回执与固定文件：`/tmp/dev022-timers-20261021/deployment.json`、`source-manifest.json`（14 代码/测试路径）、`delta-manifest.json`、`delta.patch`、`readme-row.json`。DEV-029 async、032、031 align 和 033 tools 基线完整保留，未混入 DEV-034 未验增量。预览与浏览器关闭后释放纯 Web 发布窗口给 DEV-032；后续版本必须从本固定候选叠加，避免旧快照重新带回命令历史。源码交 PA 单一联合 CI/受保护合入，无竞争 PR 或独立 Git 操作。

用户可直接刷新原会话验收：定时区仅显示真实 timer，展开“已结束的定时任务”不会出现普通命令；Agent 及直接 Foundry 子会话在独立区，历史计数互不影响；没有会暗中作用于隐藏工作项的全会话批量按钮。原工具历史仍在聊天记录，持久服务仍在 Workspace Services。本轮按已有委托完成上述已验证范围，不记录为用户本人测试。
