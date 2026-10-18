# 会话工作管理：实现与验收记录

日期：2026-10-17。对应分析与目标设计：`session-work-management-design.md`。

本次改动位于当前工作树，未提交。初始验收使用独立数据库、隔离的 Foundry 状态根和测试会话；没有执行 OMH 业务操作，没有接管或修改现有宿主 cron。10 月 17 日 10:24 已按用户授权部署 dev Server / Web，Worker 未更新，部署证据见文末。

## 事故结论

`sess_1791532977920187026` 的旧 timer `9b17c9d2` 没有被删除。10 月 17 日凌晨删除的是另一个 timer `30c32941`；08:36 的“全部停止”回复之后，旧 timer 于 08:37 实际再次执行。页面显示一个 scheduled task 有实际依据。此前的业务任务、原生 timer、crontab 和后台进程分别管理，模型回复也不构成停止凭据。

## 已实现的链路

| 范围                | 实现                                                                                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 统一事实源          | 独立 `WorkStore`，保存任务定义、期望状态、设备观察、revision / generation、操作回执与调度执行记录；旧快照不能覆盖控制意图                                                                                        |
| 来源                | Foundry 定时提示与托管命令、Claude timer / background task / subagent、Foundry 子会话、宿主 crontab / systemd timer / launchd 定时来源、Linux 上能由会话环境与进程身份确定归属的 detached 进程                   |
| 控制                | 单项暂停 / 恢复 / 停止 / 归档、定时任务立即运行、暂停全部定时、停止全部；仅展示来源支持的操作；后台托管进程按进程组执行 SIGSTOP / SIGCONT / TERM / KILL 并核验                                                   |
| 停止屏障            | 批量停止先持久化屏障，阻止迟到任务及后代会话自动启动；空清单也要等设备完成发现，并用操作序号确认（不靠两端时钟判断）；迟到的旧定时来源也继承此前的批量暂停；单项显式恢复仍可执行；无归属来源不被批量操作偷偷接管 |
| 统一调度            | execution-host 独立协调器，不依赖浏览器或活跃对话；新 worker 不再启动旧 timer 执行循环；断线也不把调度交还给另一执行器；Claude 原生 cron 禁用并引导到 Foundry 创建工具                                           |
| 原生持久 timer 迁移 | 校验 native session、创建者进程、源文件格式与锁，备份后只移除准确来源；存在活跃创建者、未知格式或竞争写入时保留来源并显示未确认                                                                                  |
| UI                  | 右侧按定时任务 / 后台执行 / 子 Agent 分类，另列待归属来源；显示下一次时间、实际状态、待确认控制、错误、最近回执和结束记录；保留已有原生输出查看入口；离线提示不再遮住工作入口                                    |
| MCP / CLI           | `list_session_work`、`get_session_work`、`control_session_work`、`create_scheduled_work`；`read_context(scope=work)` 与会话摘要；CLI `foundry work list/show/control/schedule`；详情可读执行历史                 |
| compact 恢复        | 同源、有限长度的持久工作简报；Claude 的 prompt / tool 边界与 PostCompact 合成消息；Codex 的每轮提示以及 native compact 通知后的 `turn/steer`；不依赖模型自己记忆旧 cron                                          |
| 边界审计            | `session-work` 领域模块仅依赖 Transport / Platform；native runtime 的停止能力经 composition 回调注入；Server 归一化包只依赖 store，未扩充主 `store.Store`                                                        |

实际 HTTP 入口使用既有 session 命名空间：`/api/agent-sessions/{id}/work`、`/work/operations`、`/api/daemon/session-work` 和 `/api/daemon/sessions/{id}/work-fire`。MCP、页面和设备同步共用领域存储与控制逻辑。

## 浏览器与真实进程验收

测试工作区：`ws_93cf0709-299c-4881-8908-2e170febc525`；测试会话：`sess_work_acceptance`。它是合成完成会话，不冒充模型生成的回答。调度配置设在未来，避免验收期间实际调用模型；后台 ticker 是真实 Node 进程。

- 页面暂停 ticker 后，真实 PID `3049818` 的操作系统状态为 `T`，回执为 verified；恢复后同一 PID 继续运行，未创建第二份进程。
- 重建协调器与重启测试 Server 后，暂停状态、进程身份和任务归属保留。停止协调器后提交操作，服务端显示 pending；恢复协调器后按同一 revision 收敛为 verified。
- 浏览器网络中断注入后，按钮操作明确显示 “Work control failed / Failed to fetch”，正常清单轮询不会把控制错误悄悄清掉；解除中断后可重试。
- “停止全部工作”后两个托管项目均达到 desired=stopped、actual=stopped、confirmedRevision=revision；真实 ticker PID 消失。一个既有宿主 cron 仍显示待归属，回执明确有一个来源尚未处理，没有冒充“全部已验证”。
- 在停止屏障仍存在时，从结束记录点击“重新运行”，ticker 创建新 PID `3070764`；再次点击停止后，该 PID 消失，操作回执 verified。
- 故障注入保留原 confirmedRevision，但把实际观察改为 unknown：页面显示“待设备确认”及错误，不显示“已停止”；恢复协调器后错误清除、实际状态恢复为 stopped。
- 停止后新增 `QA late task after stop`，服务器直接保存为 stopped，设备也确认 stopped，没有重新启动。
- 现有 crontab 内容在批量操作前后的 SHA-256 均为 `e1cbb8824934c0c42fb79c2fe7efc7233c448412ae71540bffe19206a5522641`。
- 实际 MCP `get_session_work` 返回同一个任务及其执行历史结构；持久简报包含停止屏障，无须读取此前对话。
- 检查 1440×1000 桌面和 390×844 窄屏、深浅主题、中英文；窄屏 `scrollWidth=innerWidth=390`，工作按钮没有超出视口。键盘 Enter 可展开任务详情。

截图：

- `.foundry/attachments/session-work-desktop-light.png`
- `.foundry/attachments/session-work-desktop-dark.png`
- `.foundry/attachments/session-work-narrow-light.png`
- `.foundry/attachments/session-work-narrow-dark.png`
- `.foundry/attachments/session-work-control-error.png`
- `.foundry/attachments/session-work-offline-pending.png`
- `.foundry/attachments/session-work-unknown-not-stopped.png`

## 自动验证

- `go test ./internal/httpapi -run '^TestSessionWork' -count=1`：旧 timer 导入、旧触发接口停止屏障、MCP、单次派发、重复触发、停止代次拒绝、非法 cron 拒绝，以及停止后显式恢复的 `new_session` 执行不被误取消。
- SQL 存储回归：停止后旧快照和迟到项目不复活、后代会话继承屏障、批量操作跳过无归属来源、幂等键与 revision、观察时间精度、手动执行不取消暂停；空清单等设备 sweep 确认、旧 sweep 不确认新操作、迟到旧 timer 继承批量暂停。
- Worker 沙箱测试：原生文件精确迁移 / 拒绝覆盖、crontab 保留其他条目 / 拒绝歧义、真实进程组暂停恢复与停止（含忽略 TERM 的后代）、时区 / DST、离线持久恢复、Codex compact 通知的协议路径。
- 原生兼容实验单独启用：`RUN_NATIVE_WORK_COMPAT=1 node scripts/run-worker-tests.mjs -- test/native-work-compat.test.mjs`。安装的真实 Claude CLI 在基线配置下触发磁盘 cron；禁用原生调度后不触发；连续三次 `/compact` 后均重新收到持久简报。实验使用本地确定性协议夹具，没有真实模型或 provider 请求。
- `scripts/check-changed.sh --files …` 已按本次文件范围执行；最终各项结果在下方补记。

## 已知覆盖边界

这些边界会影响页面能否显示“已验证”，不应由模型口头抹平：

1. 设备必须运行新 worker 才能协调新任务；旧设备不会因为 Server 新增表就自动具备控制能力。此次未滚动升级已有设备，也未停止事故会话的现存任务。
2. 工具调用前后的宿主清单差异只能证明发现时间，不能证明创建者，因此不会自动把新出现的宿主任务变成托管任务；只有用户显式关联才接管。任意外部 cron 的历史执行无法仅凭禁用一行 crontab 证明已经结束；停止会禁用后续触发，但对既有外部执行保留未确认错误。新任务应使用 Foundry 调度 / 进程托管入口。
3. detached 发现仅覆盖 Linux 上 UID、会话环境与 PID 启动身份能够核验的来源。去掉会话环境、权限不可读、远端未升级设备的进程不能保证发现；没有将这些情况报告为空清单或全部已停止。
4. systemd / launchd 适配器已实现状态核验，但未在真实 macOS 或新建真实 systemd timer 上做完整生命周期验收；本机真实浏览器与 OS 操作验证覆盖 Foundry 托管进程。launchd 不提供“只暂停未来、不影响当前执行”的按钮。
5. 本次没有调用真实模型服务；原生 Claude 兼容性通过真实 CLI + 本地协议夹具验证，Codex compact 路径通过 native 协议夹具验证。拒绝 context steer 时会保留可见失败，下一轮仍重新注入简报。
6. 新托管命令的输出保存在设备私有日志中；现有 Claude 任务继续使用原有输出详情入口。通用 Web 日志流、全量执行历史分页、保留策略和更细的运行级父子关系仍属于目标设计中的后续扩展。

## 最终检查结果

| 检查                          | 结果                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Protocol 构建及测试           | 通过，47 项测试                                                                                                             |
| Web 类型检查、生产构建        | 通过；构建使用空 `VITE_API_BASE_URL`，验收页面只连接隔离测试 Server                                                         |
| Web 相关回归                  | 83 个测试文件、497 项通过；后续补充的 3 项任务 UI 定向测试通过                                                              |
| Worker 相关回归               | 21 个测试文件，136 项通过，1 项默认跳过的原生兼容实验已单独启用验证                                                         |
| 原生 CLI / CLI / 任务兼容实验 | 最后单独启用的一轮共 29 项通过、无跳过；包含真实 Claude CLI 的 cron 禁用和三次 compact                                      |
| Server 整包                   | 保存完整 JSON 输出的一轮：HTTP API 469 项通过、2 项按现有条件跳过、2 项工具目录元数据失败；sessionwork 2 项、store 9 项通过 |
| Server 失败修复复测           | 为四个新 MCP 工具补齐 limits、缩短 summary；上述两项失败与会话工作测试一起定向复测通过。没有把修复前的整包失败写成整包全绿  |
| 存储新增回归                  | 停止屏障、后代、无归属来源、幂等、时间精度、最新错误不被旧确认遮蔽均通过                                                    |
| UI / contract / module 审计   | 全部通过；无新增审计债务；主 store.Store 保持 83 个方法                                                                     |
| 浏览器 / OS                   | 深浅色、窄屏、中英文、键盘、错误、离线 pending、真实进程暂停 / 恢复 / 重新运行 / 停止均有实测记录                           |

最后补充的 Worker 定向回归包含宿主任务不按时间巧合自动接管，以及空会话 roster 恢复与 sweep 操作序号确认。跨语言契约审计已纳入新领域的 8 个接口，共检查 246 个接口。实际隔离实例中，操作序号 10 提交时设备确认仍为 9；一轮协调后升为 10，三个托管项目全部达到对应 revision，未归属来源仍明确报告。

`check-changed.sh` 首轮总体结果为失败，原因是上面的两项新增 MCP 元数据缺失；保留失败事实，修复后运行相关测试及审计。最后的定向测试覆盖后续观察状态和显示文案修正。测试 ticker 已停止；原有宿主 crontab 未改动。

## 2026-10-17 10:24 Server / Web 部署

用户明确授权更新 Server / Web；没有更新设备 Worker、发布新 Worker 包或重启 execution-host。

- 部署前使用 SQLite online backup 备份 `/home/windeng/.foundry/server/foundry.db`，`quick_check=ok`；旧 Server 二进制和 Web 产物一并保存在 `/home/windeng/.foundry/server-backups/session-work-20261017-102359/`。
- Go 构建通过；会话工作接口和两项 MCP 元数据回归重新运行通过。Vite 在独立 staging 目录完成生产构建，16 个文件与现有 Web 构建监听器输出逐一核对，内容完全一致，无须再清空站点目录。
- PM2 `foundry-server` 重启后 `/healthz` 返回 `status=ok`，`startedAt=2026-10-17T02:24:53Z`；五张 `session_work*` 表已建立。
- `https://dev.foundryapp.app/version.json` 返回 build `14cc3af4d0d4c1e4`；公网 HTML 引用的入口资源均与 staging 产物 SHA-256 一致。
- 当前会话通过实际 Foundry MCP `read_context(scope=summary)` 返回新增 `work`、`barrier`、`coverage` 信息。设备尚未升级，覆盖状态明确为 `not_observed`，没有声称已完成宿主任务发现。
- 部署前后 PM2 Worker PID 均未变化；本机 execution-host PID `2866802` 及进程启动身份未变化。Server 重启后本机会话设备 `sg-chaos` 与其他当前在线设备重新连接。
- 部署明细保存于上述备份目录的 `deployment.json`。独立新 MCP 工具的目录在已启动会话中仍可能保留旧声明，重新建立会话或刷新 MCP 连接后才会获取新目录。

## 2026-10-17 10:27 Worker 包发布

按用户后续指示发布设备可点击更新的构建 `0.5.7-dev.32.g65295eb.local.1792203973`，没有向任何设备发更新请求。

- 在独立源码副本运行现有打包脚本，避免 prepack 清理正在被设备源码 Worker 使用的 `dist/`。Protocol / Worker 均完成构建，包内版本及依赖一致，确认包含任务协调器、compact 通知和升级忙碌判断。
- 使用该副本的编译产物运行任务管理、服务环境、Codex 协议及旧执行迁移定向回归，共 32 项通过，无跳过。
- 旧清单与包已备份至上述备份目录的 `worker-release-before/`；先放置新 tarball，再原子切换 `release.json`。Server 无须再次重启。
- 公网 `/api/worker/release` 返回新版本；Protocol / Worker 两个版本 URL 及两个 latest URL 的下载 SHA-256 均与本地包一致。
- PM2 Worker PID 和本机 execution-host 进程身份保持不变。支持自更新且在线的设备可在 Devices 点击更新；新版执行服务仍要等旧服务空闲后才会生效。
- 发布回执保存在 `/home/windeng/.foundry/server/worker-packages/publication-0.5.7-dev.32.g65295eb.local.1792203973.json`。

## 2026-10-17 面板空状态与操作语义修正

用户指出空任务面板及两个无对象的批量按钮造成困惑。本轮只调整 Web，不更新 Worker 或重启执行服务。

- 空清单、仅归档项目、空清单加已验证旧回执均不渲染任务区；读取失败或仍待确认的操作保留必要提示，不把未知状态当作空清单。
- 移除面板中范围不清的全局操作栏，操作按钮跟随具体任务，并标明可访问的目标名称。停止/结束的定时任务也进入折叠历史；历史之外的暂停任务仍可恢复。
- 归档只对核验结束的任务开放。待设备确认时不开放恢复、立即运行或提前归档；仍可对尚未停止的任务提交停止意图。
- 原始 cron、时区、发现范围和任务标识放进展开详情；默认显示任务名称、状态和按页面语言格式化的下一次时间。
- 输入框入口和面板共用生命周期判断，已暂停任务不再漏计。批量停止屏障提示改为“阻止自动派发”，避免显式恢复后仍声称全部任务已停止。
- 区分清单读取失败与控制失败；前者刷新清单，后者重试原操作。响应丢失后重试保留原始请求及幂等键，即使轮询已更新 revision，也不会制造第二次操作。

真实 Chromium 验收使用先前的隔离 QA 数据库及合成任务，设备保持离线，没有启动任务协调器、模型请求或真实业务任务。对 Web 生产组件执行了实际按钮和 HTTP 操作：暂停/键盘恢复只改变目标任务，其他项目 revision 保持不变；延迟控制请求时按钮禁用且只显示一次进度提示；响应丢失后等待轮询，再点“重试上次操作”，两次请求内容完全一致，目标 revision 保持 3、无关任务保持 2，错误清除。结束历史可用键盘展开；未确认/unknown 项目保留提示且没有归档按钮。检查中英文、深浅主题、1440×1000 和 390×844；窄屏 scrollWidth=innerWidth=390，任务操作均在视口内。

新增状态回归覆盖空清单、归档、旧回执、未完成操作、停止/完成定时、暂停任务、待确认控制、入口计数以及读取/重试按钮语义。对应截图：

- `.foundry/attachments/session-work-ux-empty.png`
- `.foundry/attachments/session-work-ux-active-light.png`
- `.foundry/attachments/session-work-ux-active-dark.png`
- `.foundry/attachments/session-work-ux-narrow-dark.png`
- `.foundry/attachments/session-work-ux-paused-narrow-light.png`
- `.foundry/attachments/session-work-ux-ended-narrow.png`

Web 仍按现有 PM2 构建监听流程发布；最终资源校验与检查结果保存在本机私有临时目录的 `session-work-ux-check.log` 和 `session-work-ux-deployment.json`。

## 2026-10-17 真实会话历史任务误报与批量停止

用户再次要求核验并关闭 `sess_1791532977920187026` 的全部任务。读取实际 MCP 清单与设备进程，发现共有 38 条记录：1 条 Claude 原生定时任务 `9b17c9d2`（`28,58 * * * *`），28 条历史子 Agent、9 条历史后台命令。后两类 37 条均有明确结束记录，原来是 31 条 completed、6 条 stopped，绝非 38 个在跑的任务。

根因是历史导入默认 revision=1，却把明确结束记录的 confirmedRevision 留在 0；后续读取只保留旧行，不会修复确认状态。页面因而把历史结束项当作待确认控制，展示任务数量和 Stop。前轮用已确认的合成结束记录验收，漏掉了这种真实旧数据形态。

本轮修复：

- 有明确结束时间的原生一次性任务，在导入时直接确认该历史事实；同时修复尚未获得设备观察的旧导入行，保留已经提交的停止意图及原始 completed/failed/stopped 结果。新 generation、错误状态、已经获得设备确认的观察、没有结束证据的项目及 schedule 均不能借旧历史被确认。
- 子任务完成事件使用事件本身的观察时间，不再使用导入时的当前时间。旧 running 快照不能复活已确认的历史结果。
- 批量操作跳过已确认结束的历史项目；批量暂停也跳过已停用或已暂停的调度，避免制造新的待确认任务或改变历史结果。
- 有至少两个实际可停止的受管任务时，展示带数量的“停止全部任务”，说明只控制本对话的定时任务、后台执行和子 Agent，并阻止自动派发。空清单、单项、历史或只读状态不显示。该操作不再顺带取消主对话；主对话有独立的停止入口。
- 已登记任务全部结束但旧设备尚未完成发现时，明确显示“已登记的任务均已结束，设备仍需核验是否存在未登记来源”，不把范围扫描回执混同于正在运行的任务。

实际停止与边界：

- 经 Foundry MCP 提交 `stop_all`，持久化停止屏障；操作 ID `wop_9fb4fcf746f470e5aa989ee2120fe38c`。
- 使用设备 compute lease 核验原生 session ID、会话环境、PID 与启动身份后，只终止该会话残留的 Claude 进程 PID `539104`；其工作区没有包含目标 timer 的原生持久文件。复查设备 `/proc`，归属于该 Foundry session 的进程为 0。
- 根据这次设备实查和已有明确结束证据，经设备接口回写目标 38 条观察：31 条 completed、7 条 stopped，全部 confirmedRevision=revision，没有 running / suspended / unknown。没有把所有历史任务伪写成此次停止。
- 设备上两条无归属证据的宿主 crontab 没有修改；前后 SHA-256 均为 `daefc49f13578cc3c924d247d2820e1502599df74a3e3475d32f7fef8cfe4a75`。没有操作 OMH 业务队列或其他会话。
- byte-dev 仍驻留 `0.5.7-dev.28.ga7caf96` 的 execution-host（PID `1564333`）。没有强制升级或重启它。完整设备范围发现未确认，批量回执继续保留 pending；这与上述 38 条已登记任务的终态确认是两件事，未伪造全设备 sweep。

验收增加旧确认版本 0 的历史导入/修复、错误与新执行不能借旧事件确认、批量控制不改变历史或复活已停调度、批量停止不取消主对话，以及批量按钮的实际对象与展示条件。真实浏览器在隔离 QA 中用键盘触发批量停止，HTTP 只发出一次 stop_all，两项任务均设置 stopped 并建立屏障；模拟单项终态确认后任务进入历史，范围未确认说明仍保留。

Server 构建与定向回归通过后已重启，`startedAt=2026-10-17T05:15:34Z`；部署前数据库在线备份和 quick_check=ok，旧二进制及 Web 产物保存在 `/home/windeng/.foundry/server-backups/session-work-history-20261017-131505/`。Web 使用现有构建监听发布。本轮没有发布或推送设备 Worker 更新。

私有验收材料：`/tmp/fdy-5Ae6fa/session-work-incident-evidence.json`、`session-work-history-check.log` 和 `session-work-history-deployment.json`。截图：`.foundry/attachments/session-work-bulk-active.png`、`.foundry/attachments/session-work-bulk-ended.png`。

## 2026-10-17 前台工具误报为后台任务

当前会话 `sess_1792197549245061512` 提示的 11 → 18 个 work items 是实现缺陷。Linux 扫描器错误地把 `PGID == PID` 当成独立后台工作的证据，收录了 Codex 工具命令、测试、构建和 `codex-code-mode-host`。这些命令结束后又被记成 unknown / ack=0；服务端已有 running / ack=1，拒绝这份过期观察，形成永不消失的假任务。

修复边界：

- 进程分类与生命周期核验集中在 Worker 的 detached-processes 适配器。独立进程组不代表独立后台工作；仍有存活父进程的工具执行、原生执行树和内部 helper 不纳入后台任务。当前 Linux 自动发现只接管 PID 1 收养、同 UID、会话归属与启动身份均可验证的孤儿进程；显式 Foundry 托管命令保持原有控制路径。
- 外部进程观察增加 background / foreground / runtime 分类。Protocol、MCP、Web 使用相同的独立工作判断；旧 Worker 未分类观察保留为诊断数据并降低覆盖可信度，不作为可停止任务。Server 单项和批量控制都保护未分类、前台及 runtime 来源，Worker 发信号前再次验证启动身份与角色。
- 精确 PID + boot ID + start ticks 消失、僵尸或被复用，证明原进程已经结束；权限和读取失败仍为 unknown。退出结果确认当前 revision，旧快照不能把已核验退出的身份改回运行或未知。归档保留退出证明，不重新制造待停止记录。

现场处理：通过 Foundry compute lease 在本设备运行新版只读适配器，核验本会话误记录；没有发送进程信号。2026-10-17T15:38Z 时累计 22 条，其中 21 条原身份已退出，写入真实设备观察后通过 MCP 逐条归档，21 项回执均 verified。仍活着的 `work_7b4223ee297d27e2a172424b0e0f1053` 被核验为 Codex runtime 并保留运行，未停止、未归档。随后实际 `list_session_work` 返回 items=[]，barrier=false。

发布：数据库 online backup quick_check=ok，旧二进制、Web 与 Worker 包保存在 `/home/windeng/.foundry/server-backups/process-work-20261017-233739/`。仅重启 Server，healthz startedAt=`2026-10-17T15:37:47Z`。新 Worker 包 `0.5.7-dev.32.g65295eb.local.1792251443` 已发布；protocol 与 worker 的版本固定链接、latest 链接均下载验证 SHA-256 一致。没有更新设备、没有重启 execution-host：其 PID 仍为 3142183，运行旧包，当前活跃会话的旧本地简报仍可能列出 helper 或新增工具观察。用户在 Devices 更新后，execution-host 按现有空闲切换逻辑加载新版；不能声称仅靠 Server 更新已替换扫描器或 compact 提示。

定向验证已通过：Worker 18 项（含真实前台进程绝不被发现/发信号、进程组与原生祖先分类、PID 复用/权限失败、Supervisor 退出收敛）、Web 12 项，以及 Go 会话工作 API / 存储回归。完整文件范围检查、浏览器验收与公网 Web 最终校验结果另记下方。

补充验收结果：

- `check-changed.sh --files …`：Protocol 构建/测试、Web tsc、Worker 构建/沙箱回归、Go HTTP API / sqlitestore / store、UI / contract / modules 审计均通过。Web 扩大回归 266 项首轮 263 通过、3 失败；失败均为旧事故日期已超过七天的有效期，测试意外使用当天时钟。将这份历史重放固定到事故当时后，相关 23 项全部通过；没有放宽生产过期逻辑。新增覆盖文案后的 Web tsc 与全部 UI 审计另行通过。
- 真实浏览器隔离 DB 放入 runtime、foreground、未分类和 background 四种观察，只出现 1 条后台任务和 1 项计数；键盘 Enter 展开详情。新增第二条 background 后，按钮准确显示停止全部任务（2）；实际点击只改变这两个目标，前三种观察的 desiredState 不变。无设备协调器时显示待设备确认，不冒充已经停止。
- 移除两个背景测试任务后，余下三种非任务观察不产生任务区域、计数或停止/暂停按钮。深色窄屏 390×844 的 scrollWidth=390；浅色桌面 1440×1000 已目视检查。测试浏览器关闭，测试 Server / proxy 均停止，隔离 DB 已恢复且 quick_check=ok。
- 截图：`.foundry/attachments/process-work-only-background-light.png`、`.foundry/attachments/process-work-only-background-narrow-dark.png`、`.foundry/attachments/process-work-bulk-pending-narrow-dark.png`、`.foundry/attachments/process-work-empty-narrow-dark.png`。恢复代理前短暂出现的 Failed to fetch 有明确错误和刷新入口；截图最终覆盖为恢复后的正常空态。
- 另补保护：旧版本曾发给 runtime 的 stop/remove，不能因为新版确认了 runtime 分类就得到 verified；只有实际退出证据才算完成。存储定向测试再次通过，最终 Server startedAt=`2026-10-17T15:44:31Z`。公网 Web build=`d24c78a7f68b73ad`，version.json 与 HTML 入口 JS/CSS 均与部署产物一致。
- 原始事故 session `sess_1791532977920187026` 再次经 MCP 检查：38 条记录无待结束项目，barrier=true。该旧设备仍未上报新扫描覆盖（not_observed），没有把会话记录结束等同于整机所有来源均已核验。

最终清理又核验了旧扫描器在验证期间误收录的 16 条已退出工具身份，经 MCP 归档均无错误；唯一仍活跃的误分类条目还是原 Codex runtime，保留运行。compute lease 已释放。最终 execution-host PID 3142183 与启动身份不变；后续新增工具仍可能被旧 host 误观察，彻底停止此类本地提示必须加载新 Worker，未通过清空数据伪装扫描器已升级。
