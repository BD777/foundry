# Foundry 定时唤醒未接管调查

目标会话：`sess_1792201997907970502`（byte-dev / ccm-omh-integration）。只核查 Foundry 调度，不操作 OMH 业务任务，也未重放业务调度 prompt。

## 已核实的事实

- 2026-10-17 13:08:14（北京时间）通过 `create_scheduled_work` 创建 `work_6a17e06ae2eb3d0291e9456b4a80f228`，cron=`*/5 * * * *`、Asia/Shanghai、continue_thread。
- 13:15:48 请求手动 run；截至本次调查，revision=2、confirmedRevision=0、actual=unknown，手动操作仍 pending，无调度执行记录。13:15 的 nextFireAt 是待执行意图，不是已触发证明。
- 设备在线，daemon 报告 `0.5.7-dev.32.g65295eb.local.1792203973`。实际通过 Foundry compute lease 只读核验：execution-host PID=1564333，entry=`/data00/home/dengcanwen/.foundry/runtime/0.5.7-dev.28.ga7caf96/node_modules/@bd777/foundry-worker/dist/execution-host/main.js`，启动身份=`5fa5cf51-3c6a-4c0f-883b-f09f6159013f:322842622`；该宿主无 session-work/supervisor.js，本地 session-work/inventory.json 不存在。
- 新 daemon 检测到 execution-host 时不会再启动第二个协调器。旧宿主保持运行以保护活跃 Agent，但其版本没有新版调度器。因此本任务只有 Server 登记，没有设备执行者。设备在线或 daemon 新版本均不能证明执行宿主已支持调度。

## 修复及边界

在 Server 读投影与创建结果中增加实际调度器就绪诊断。依据 WorkSupervisor 的已上报 observedAt 判断 observed / not_observed / stale（90 秒，最多允许 5 秒时钟超前），通过 MCP coverage 与任务错误显示。未接管时明确需要更新设备 Worker 并等待执行服务空闲切换；心跳过期时不再承诺后续唤醒。

这些诊断只作用于响应：不改设备的实际状态、confirmedRevision、控制意图和历史记录，不把任务登记当执行确认；新设备重新上报后自动清除。暂停、停止、已结束任务不因此被重新标错。没有运行临时 cron、第二个旁路协调器或 detached Agent。

已部署 Server，healthz startedAt=`2026-10-17T15:56:02Z`。部署前 SQLite online backup quick_check=ok，备份目录 `/home/windeng/.foundry/server-backups/scheduler-wake-20261017-235551/`。生产实际 MCP 已返回 scheduler=not_observed 及诊断，原任务 revision=2 / ack=0、原手动操作 pending 保持真实状态。

旧宿主的实际切换仍未发生。按用户既有约定，Worker 更新由用户在 Devices 发起；活跃业务会话不被强制中断。恢复自动唤醒仍需新版宿主加载后得到真实设备确认，不能将本次诊断修复称为已验证业务唤醒成功。

## 验证

`check-changed.sh --files apps/server/internal/httpapi/session_work.go apps/server/internal/httpapi/session_work_test.go`：gofmt、7 项 HTTP API 定向检查、contract / modules 审计全部通过。补充集成断言后再次运行全部 TestSessionWork，通过。覆盖缺失/新鲜/过期/异常未来心跳，创建结果明确未接管、真实设备记录不被诊断污染，以及心跳恢复自动清除诊断。隔离 dispatch 回归仍验证实际入队、稳定 input identity、重复触发去重和停止 generation 拒绝。

补充 UI 验证：诊断通过 scheduler / schedulerError 匹配后用中文、英文文案展示，不隐藏真正的运行错误；新增 UI 定向 13 项通过。第二次文件范围检查的 46 个 Web 测试文件和全部 10 个 UI 审计通过；该轮 tsc 首次失败，原因是新增 coverage 字段缺少 Protocol 类型声明。补齐两个可选字段、重建 Protocol 后，Web typecheck 单独复测通过；Protocol 47 项及跨语言 contract 审计通过。没有把首次检查写成全绿。

真实浏览器检查桌面 1440×1000、深色窄屏 390×844；任务展示“任务已登记，设备调度服务尚未接管”，原任务实际确认状态不变，scrollWidth=390。截图 `.foundry/attachments/scheduler-not-ready-desktop.png`、`.foundry/attachments/scheduler-not-ready-narrow-dark.png`。测试浏览器、隔离 Server 与代理已关闭，隔离 DB 恢复且 quick_check=ok；compute lease 已释放。公网 Web build=`277d99507b6a2e87`，version.json 与入口 JS/CSS 哈希和部署目录一致。Worker 未自动升级，业务宿主未重启，生产任务未被触发或暂停。

## 后续：七条历史任务被计为进行中

`session=sess_1792166086646208492`，同属 byte-dev / llm-gateway。查询得到 32 条 Claude 历史任务：17 completed、13 stopped、2 failed，无 running / suspended / unknown。其中七条 revision=1 / confirmedRevision=0（六 completed、一 stopped），均有明确 endedAt；这些不是七个活跃任务。

之前的历史确认回填依赖最新 native 状态事件再次出现同一任务 ID，而旧快照已不包含这些 ID，导致七条留存记录未被修复。现在 WorkStore 读取清单时也使用留存结束证据进行幂等回填；事务重新核对当前代次与观察，保持未知来源、新执行代次、无结束时间和错误状态的保护，不重写任务实际终态或启停意图。对已核验终止的原生单次身份再请求 stop/remove，也保留结束事实，不重新制造 pending。

文件范围检查首轮发现已有单项 stop 回归不满足新回填顺序，修复上述幂等停止后重跑存储及 HTTP API 定向回归。此类旧数据修复只需更新 Server；新进程分类和自动调度仍需设备 Worker / execution-host 加载已发布的新版。未更新或强制重启 byte-dev，未向这些历史任务发送停止信号。

修复已部署，Server healthz startedAt=`2026-10-17T16:06:40Z`。生产实际 MCP 再查：32 条均保留原终态（17 completed / 13 stopped / 2 failed），未确认记录=0，running / suspended / unknown=0。存储及 HTTP API 定向复测均通过，gofmt 和 diff 检查无异常。部署前 online backup quick_check=ok，备份位于 `/home/windeng/.foundry/server-backups/native-history-20261018-000555/`。
