# Session work 深度复核与修复（2026-10-18）

## 结论与范围

上一轮的 Server 修复不足以代表整条链路已正确。本轮沿定义 → 控制意图 → 设备执行 → 执行输入 → 终态回执 → UI/MCP 投影复核，并修复以下问题。不操作 OMH 业务、不重放目标业务 prompt、不强制重启活跃 execution-host。

| 根因                                                  | 影响                                                                    | 修复与约束                                                                                                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 周期定义与单轮结果混为一谈                            | 上轮 completed/failed/stopped 后周期任务被归档，批量停止可能漏掉        | 仍启用且未过期的周期定义持续进入活动清单、计数与控制目标；显示“本轮已完成/失败/停止”                                                                    |
| claim 被视为实际投递，run 更新覆盖身份                | Server 崩溃或重试时无法区分未投递与已投递，可能错认别的用户轮次         | 持久保存 run、generation、规范化 slot、UUIDv5 inputId；claim=unknown，实际投递后才 running；部分更新保留身份，终态不可逆                                |
| 仅按会话时间推断执行结束                              | 后来的用户输入可能被误认为计划执行的结果                                | 在队列启动下一轮前关联精确输入并保存终态；恢复查询已记录输入事件与执行 session；不确定则保留 unknown，不盲目重放                                        |
| confirmedRevision 被等同于停止证明                    | ACK 后仍 running 也可能得到 verified                                    | 停止回执同时要求相应实际终止状态；运行中/未知不冒充已停止；设备发现的新定义先以 ACK=0 登记，检查 revision 后才接收观察确认，拒收的未来 ACK 不能提前写入 |
| manualRunAt 在 claim 时提前清除                       | 停止状态的手动单次执行，下一次 tick 被当作非法运行取消                  | 单次授权保留至该 run 结束，精确匹配代次与 slot 后清除；后续自动调度保持原停止/暂停意图                                                                  |
| Worker 无条件信任 fire 成功返回                       | 重复响应中的 completed/failed 被复活为 running                          | 按实际 run 状态、endedAt 与 error 收敛；未知投递不得确认停止或产生重叠执行                                                                              |
| 未上报队列不持久，坏记录阻塞整批                      | 宿主重启遗失观察；一条拒收项使其他工作无法同步                          | pendingIds 持久化，失败 tick 也落盘；客户端错误隔离单项并保留重试/错误；所有项目批次处理后才单独确认 sweep，拆分重试不提前 ACK                          |
| 短命令/信号退出的监听与身份存在竞态                   | /bin/true 已退出却永久 unknown，信号退出不终结                          | spawn 后立即订阅自身 exit；记录信号退出码；组退出核验；身份不可证时不发送危险信号                                                                       |
| 到期判断早于当前执行事实 / 恢复调度依赖跨机器时间比较 | 计划到期时把仍在运行的执行虚报完成；Worker 时钟超前时错误回放错过的周期 | 到期只限制未来触发，保留当前 running/unknown 事实；使用控制 revision 判断恢复代次，丢弃错过的周期                                                       |
| 升级准备只暂停旧 timers                               | 新监督器在升级准备期间仍能派发新 run                                    | execution-host drain 同时禁止新监督器 tick，取消升级后恢复；上报实际 schedulerVersion                                                                   |
| 创建接口接受内部控制字段或同 key 不同定义             | 手动授权可被伪造；幂等重试返回错误任务定义                              | 拒绝 server-owned 字段；相同 key 的配置必须一致，否则 409                                                                                               |

边界保持集中：Store 管理持久身份、意图与回执；HTTP 组合现有会话投递与恢复；Worker supervisor 管理设备收敛，native runtime 控制由 adapter 注入；Protocol 提供共用活动清单规则；Web/MCP 共读同一事实源。主 store.Store 仍为 83 方法，模块审计无新增违反。

## 验证

- 已运行要求的文件范围 check-changed：Protocol 构建/47 项测试、Web 类型检查/268 项回归、Worker 构建/46 项相关回归、存储与 UI 审计通过。首轮模块审计发现跨层引用，已改为 Store 身份 helper 与 composition 注入版本，模块/contract 再查通过。
- 最新 Worker 相关沙箱回归：31 项通过，无跳过；原生兼容实验另行启用，通过。包括真实进程组、10 次短命令、信号退出、手动 run、重启重试、错误隔离、drain 与时钟偏差。
- 真实已安装 Claude CLI 经 SDK 驱动本地确定性协议夹具：恢复磁盘 cron 被禁用，连续 compact 后仍恢复持久工作上下文。未调用 provider 推理接口或使用真实 provider 凭据。
- Go 最新定向 HTTP/SQL 回归通过（包括未来 ACK 拒收、手动单轮授权保留与退休）；其中真实 Node WorkSupervisor 连接 Go HTTP handler，经设备派发给空闲 session、结束并收敛回执的联动测试通过（合成 Agent 回应，无真实模型调用）。
- 最新 Web session-work 14 项通过，类型检查通过。真实浏览器 1440×1000 浅色与 390×844 深色、键盘展开、周期 run 完成后的控制、一键停止与 pending、空面板隐藏均核验。窄屏 scrollWidth=390。
- 全量 HTTP/Store 第一次重跑：561 项通过，2 跳过，仅观察者顺序测试失败；原因是新增 run 终态观察者必须在 chat queue 之前，而测试仍断言旧名单。已同步断言并定向通过；最终全量 HTTP/Store 重跑 562 项通过、2 跳过，无失败；之后补充的未来 ACK 防回归与最新全部 TestSessionWork 定向复测亦通过。

截图：`.foundry/attachments/session-work-deep-audit-desktop.png`、`session-work-deep-audit-narrow-dark.png`、`session-work-deep-audit-empty.png`。隔离浏览器、Server 与代理已停止，隔离 DB 恢复，quick_check=ok。

## 部署与实际清单

Server 已部署，仅重启 foundry-server，healthz startedAt=2026-10-17T16:56:05Z；Web build=77e4c0c4a6040a09，公网入口 JS 与部署目录逐字节相同。

Worker 新包已发布：0.5.7-dev.32.g65295eb.local.1792256215。固定地址与 latest 地址均下载验证 SHA-256：protocol=a585609ddaaaecfee2462cf9b29c0700f6cf6038ed5daf4dcf66f574f8db1215；worker=f4f2b522e9a3cf2b5ddb0d9d79d4246c63317ec2358ef745c914a58efdace48a。用户可在 Devices 更新；发布包不等于设备宿主已加载。发布前 SQLite online backup quick_check=ok，回滚备份 `~/.foundry/server-backups/deep-work-audit-20261018-004921/`。

实际 MCP 部署后复查：

| session                       | 清单事实                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| sess_1791532977920187026      | 38 条历史记录：31 completed、7 stopped；无未确认项，停止屏障保留                                              |
| sess_1792166086646208492      | 32 条历史记录：17 completed、13 stopped、2 failed；无运行/未知/未确认项                                       |
| sess_1792201997907970502      | 1 个失败子任务历史 + 1 个 enabled schedule，ack=0，scheduler=not_observed；未冒称恢复业务唤醒                 |
| 当前 sess_1792197549245061512 | Server/MCP 独立工作清单为空；旧加载宿主仍可在本地 prompt 注入误分类进程，必须加载新版 Worker 才能消除本地误报 |

## 尚需真实设备升级的边界

linux-dev 之前只读核实的 execution-host 仍为 dev.28，根本没有 session-work 模块；新 daemon 没有强行终止它以保护活跃业务。此类设备必须在 Devices 更新 Worker，并让执行宿主在空闲时完成切换。当前会话旧宿主的本地误报亦不可能靠 Server 热更新改掉。没有强制更新设备、杀活跃 Agent 或建立第二条调度执行通道；生产业务唤醒仍需新版宿主的真实确认。

对不可读身份、PID 重用、未知外部 cron 当前执行等，仍保留未确认而拒绝误杀或假停止；任意脱离会话归属、删除标记或运行在未升级远端的进程不能保证自动发现。系统不承诺在这些缺乏证据的情形下“全部已停止”。

## 用户更新后现场复查（2026-10-18 01:33，北京时间）

- dev-server：/proc 核验实际 execution-host PID=3432223，entry 位于 `0.5.7-dev.32.g65295eb.local.1792256215`。MCP 新鲜心跳上报同一 schedulerVersion，processes=managed_native_and_attributed；当前会话 items=[]，没有未完成控制。此前本地 prompt 的 79 条误报已消失，后续核查命令也未重新变成独立 work。
- linux-dev：通过只读 compute lease 核实 runtime/current 已指向同一新版，daemon PID=2544213；但实际 execution-host 仍是 PID=1564333、dev.28，session-work 模块不存在。存在 3 条 active 执行 claim，且均能找到对应真实 Codex/Claude 进程，Server 也显示 running：`sess_1792201997907970502`、`sess_1792207060483989184`、`sess_1792253384576548718`。因此旧宿主并非仅有陈旧记录，不能安全强制替换。
- linux-dev 的总控周期任务仍 ack=0、scheduler=not_observed；另一个审计会话刚登记的周期任务也尚未接管。未触发任何业务 prompt、未停止或干预上述 Agent。无需重复安装新版包；需等该设备当前执行轮次结束、宿主满足空闲切换条件后重新确认调度器心跳和任务 ACK。
- 原事故会话 38 条历史终态保持不变，停止屏障仍在；其 stop_all 的整机发现扫描回执仍 pending，因为该设备没有新协调器确认 sweep，不能把历史项目均已终止说成整机扫描已验证。另一个历史会话 32 条仍全为终态、无未确认项目。
- compute lease 已释放。此轮只核查状态，没有修改调度控制意图或强制更新宿主。

## 审计会话补充事实后的复核

收到 sess_1792253384576548718 的只读反馈后，再次查询两个任务详情及 linux-dev claims。总控任务当前实际 revision=3（反馈中的 revision=2 已过时），ack=0；独立审计任务 revision=1 / ack=0；二者 runs=[]，仍无真实 fire 证据。调度服务接管与实际唤醒成功必须分开报告，后者至少需要运行历史与对应投递/执行证据，不能只看非 unknown 或 ACK。

active claim 按 sessionId/inputId 归属一轮执行。dev.28 对应源码在 session_completed 入本地可靠 outbox 时，或 dispatch 的 finally 中，将该 claim 改为 completed；snapshot 仅返回 active claims。它不是根据 Server 的 session.status 字段、也不是根据 native 进程存在而直接判定。

现场同一审计会话的 ff6bf57f... 与 63512843... 输入已 completed；短暂只有另外两条 active claim，随后审计会话出现新输入 8aff2e48... 的 active claim。其 Claude PID=2541922 保持不变。这证明该审计会话能在轮次间释放 claim，常驻 native 进程本身不等于持有执行轮次。之前“找到 native 进程”只证明进程存活，不应单独作为轮次仍在执行的证明。

没有证据表明存在“审计会话不被唤醒就无法释放其 claim”的逻辑死循环；仍存在全机同时空闲窗口迟迟不出现的升级活性问题。剩余其他 active claims 不能仅凭无新消息或进程休眠就擅自清除。旧宿主尚未切换，不能宣布业务唤醒已恢复。本次没有清 claim、停止 Agent、重启宿主或触发业务任务，compute lease 已释放。

额外只读发现：旧宿主 identity 中的 dev.28 entry 路径已不在磁盘，但原 PID 仍运行；本次使用 git 中 a7caf96 对应源码核对其 claim 语义，未将当前安装包源码冒充原进程实装文件。此事实也提示后续升级验收需要涵盖活跃旧宿主安装目录的保留策略。

## 用户授权立即替换执行宿主（2026-10-18 01:51，北京时间）

用户明确要求“你直接升级，别等了。如果升级能修复的话”，已说明替换可能中断当前轮次。升级前远端保留 identity/claims/controls 快照于 `~/.foundry/execution-host-backups/forced-upgrade-20261018-015039/`。通过新版包导出的 service adapter，精确校验并停止 systemd user unit `foundry-execution-50f1341014a404c1.service`，随后以已安装新版 entry 启动同一受管服务，没有建立 detached/旁路执行宿主。

旧 PID=1564333 已消失；新 PID=2576590，entry 为 `0.5.7-dev.32.g65295eb.local.1792256215`，启动身份 `5fa5cf51-3c6a-4c0f-883b-f09f6159013f:340023559`。设备生成 session-work inventory，pending=0，新鲜心跳上报正确 schedulerVersion。总控 schedule ack=3/3、idle、下次=2026-10-17T17:55:00Z；独立审计 schedule ack=1/1、idle、下次=2026-10-17T18:17:00Z。

中断影响已实查：总控 `sess_1792201997907970502` 与正确性审计 `sess_1792207060483989184` 的原两轮变为 failed，错误为 Codex app-server exited before completing the request。独立审计会话当时已完成，没有被中断。未自动重放这两条输入。准备等待总控下一次自然触发，核验实际 run / 输入投递再报告唤醒恢复；此时 ACK 只证明协调器已接管。

新版扫描另外发现两个既有 crontab 与一个 systemd timer，均为 observed、未归属，仅提供 adopt；没有接管或停止它们。compute lease 已释放。

01:55 自然触发已发生：`wrun_830c723312c00303ea65db8063593345`，generation=3、scheduledAt=17:55:00Z、startedAt=17:55:01.110477543Z；inputId=`78cb70f8-f55b-5d1c-a0da-184cba2aef0c`，executionSessionId 为原总控会话。实际 User message、Started Codex、contextCompaction 事件均已落地；因此并非仅 ACK 或计划时间。此轮于 17:55:11Z 失败，原因为 native Codex 对 `ws://192.0.2.10:8787/v1/responses` 请求得到 404。调度链路已能唤醒，模型网关执行链路尚未通过。

核查 profile `codex_provider_llm_gateway` 的人设偏好为 auto，持有 2026-10-16T08:39:44Z 的 websocket 自动学习缓存。为恢复同一 endpoint 的 HTTP 执行，在用户本次恢复授权范围内进行了显式运维修正：仅把该自动学习缓存改为 https 并记录真实失败 run 的证据；保留 auto、模型、provider、base URL 与凭据，不调用 provider API 探测，不冒充原生 CLI 自动学习事件。以原 learned_at 条件更新避免覆盖并发修改，旧行备份于 `~/.foundry/server-backups/forced-upgrade-transport-20261018-015630/prior-transport.json`。准备验证下一次自然执行结果，尚未将缓存调整写成 HTTP 已成功的证明。

原事故会话的 stop_all 操作已在新版宿主完成 sweep 后成为 verified；38 条记录保持终态、无未确认项目，停止屏障保留。旧单项操作因已被后续 revision 取代仍为 unknown，并非当前仍在运行。

## 恢复执行时发现的原生写锁清理缺陷及修复

后续实际执行报 `thread ... already has an active writer`。远端只读核查发现首次失败后原 Codex app-server 仍存活，并由当前宿主登记，但没有对应 active claim。不是仅凭 PID 判断执行活跃：这里反向证明了失败轮次确有进程清理遗漏。

根因：`runCodexStreamedTurn` 手动调用 events.next()，在外部 handleCodexEvent 处理 turn.failed 抛错时，没有对 generator 调用 return()；原生适配器已设置 terminal=true，abort 因而也不会再关闭生产者。适配器 generator 的 finally 不执行，client.close()/runtime lease 释放被跳过，下一轮持有相同 native thread 时碰到 active writer。

修复 `packages/worker/src/runner/codex-stream.ts`：所有退出路径都在 finally 中关闭迭代器，保留原失败原因，清理异常不覆盖原结果。`packages/worker/test/session-steer.test.mjs` 补测失败轮次释放 writer，以及 producer 清理本身抛错时仍保留原执行错误。要求的文件范围 check-changed：prettier、Worker 构建、7 个相关测试文件全部 PASS；另行 Codex/steer 定向 17 项通过。

先精确核验原失败总控 claim 已不活跃、PID 启动身份和会话归属，再清理其遗留组 2582267，TERM 后整组消失；未修改 active claims。发布 Worker `0.5.7-dev.32.g65295eb.local.1792260170`，公网 tarball 哈希匹配：protocol=3d403d23b158648f0bc41c61c55ca9e69d97d35fd8b2775e84553d89cd455229、worker=1bbdef6a8e76a7d542bee46dbe687340ce91f1918a754c9c23305ce10c230994。

linux-dev 经官方 startSelfUpdate 流程安装成功，然后按用户直接升级的授权替换执行宿主；新 PID=2603205，entry 位于该修复版本，实际文件包含失败流清理。替换前快照 `~/.foundry/execution-host-backups/writer-fix-20261018-020548/`。第二次替换时 active 输入属于总控、独立审计及其另一个审计会话 sess_1792260092013439595，均属于本次强制升级的中断范围，未隐瞒为无副作用更新。

网关侧另有审计会话提供的证据表明当前 ASGI 环境只支持 HTTP。为避免自动传输缓存过期后又重试 WebSocket，将该单一 Foundry profile 的 codex_transport 从 auto 固定为 https（该配置名也覆盖 http:// URL 的 HTTP 传输），旧偏好备份在同一 transport 备份目录 prior-profile-transport.json。没有更换 provider、模型、地址或凭据，没有安装网关软件、重启网关或直接请求 provider 推理接口。

02:05 时隙在会话忙碌保护解除后于 18:05:53Z 自然投递，run=`wrun_40765ffb4acf18add97dcc678387412b`，input=`dd6f2f50-317c-5e23-93f0-c161664b4998`。该轮已有实际输入、Started Codex 与 contextCompaction 事件，且由修复后的宿主承载。尚待补记压缩后推理进度，不能把 running 单独称为业务闭环已完成。compute lease 已释放。

最终验收补记：18:07:15Z，上述 02:05 自然触发轮次的 contextCompaction 出现 Processed step，随后产生 3 条 Model request usage 事件；18:07:48Z run 仍为 running、ack=3/3，由新版 PID=2603205 执行。已有规范化时隙、durable run、精确输入、原生启动、实际模型压缩完成与用量证据，验证了升级后自然唤醒和 HTTP 执行链路；不将其表述为 OMH 业务已经完成。此前两次真实失败 run 保留在历史中，没有删除失败或把 ACK 当成功。当前 linux-dev 最终已加载版本为 `0.5.7-dev.32.g65295eb.local.1792260170`。
