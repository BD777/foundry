# DEV-023 · Personal Agent 完整实施与验证

状态：**核心功能与联合源码已通过委托 Agent 验收；最终集成及运行时回执统一见 [PR138](https://github.com/BD777/foundry/pull/138)**。2026-10-21 用户授权推进完整方案并自行验证，采用推荐默认；不以 P0/P1 完成作为任务结束。设计依据：[修订方案](DEV-023-personal-agent.md) §1、§12、§14。唯一实施 owner：[DEV-023 session](https://dev.foundryapp.app/chats/sess_1792395078659563971)。

## 最终交付矩阵

每项分别记录实现、自动检查、真实链路及发布证据。当前已有能力只是基线，未接通的目标不能标已完成。`未开始` 不表示旧产品完全没有相关能力。

| ID  | 交付范围                        | 验证标准                                                                   | 实现   | 验证/证据                                                                                                                                |
| --- | ------------------------------- | -------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| I01 | 持久收件与离线入口              | Web/渠道相同消息只接收一次；模型/家设备离线仍可见待整理；冲突消息 ID 拒绝  | 已实现 | Web真实重复收件/冲突ID/设备离线恢复通过；飞书通道26项含绑定人、附件整组、回复归属，未向真实租户发测试消息                                |
| I02 | 稳定事项、版本与来源            | 多意图部分失败可恢复；更新 CAS；只记不派发/提醒；来源是可信输入            | 已实现 | 真实多意图只记录、稳定原事项接续、版本/CAS/来源与删除围栏回归通过；模糊清单只澄清未派发                                                  |
| I03 | 关联已有 session/Issue/service  | 一个事项关联多个工作；链接不授予控制权、不新建重复工作；恢复胶囊可用       | 已实现 | 原事项/Workspace/owner/native ID接续已实测；修复历史别名回收导致的原生恢复失败；Issue/service引用权限回归通过                            |
| I04 | 安全幂等派发                    | operation/outbox 与执行身份对账；重试/响应丢失只产生一次执行；未知不重派   | 已实现 | 真实单领域和跨域依赖派发通过；同输入幂等、未知回执/失败恢复/既有owner不重复创建回归通过                                                  |
| I05 | 路由、歧义和下一步              | 明确引用接续原 owner；歧义只问必要问题；路由决定落库；保留未知期限         | 已实现 | 真实模糊指代仅问旅行/摄影/音频哪份清单；未定时间保留；route解释、候选和澄清围栏回归通过                                                  |
| I06 | 完成证据与失败报告              | session 结束不自动等于事项完成；证据/阻塞可查；用户更正可恢复              | 已实现 | 真实文件、字节数/hash与完成状态已核；原生结束先review，助理核验后done；失败输入保留并显式接续成功                                        |
| M01 | 独立 Memory 位置                | 可选择设备及已有/新私有 Workspace；与前台设备解耦；共享/路径越界拒绝       | 已实现 | 远端主根与本机前台跨物理设备读写通过；本人独立位置UI已上线；共享主根真实拒绝并在恢复私有后可读                                           |
| M02 | 单 owner 知识与跨域 publication | 原始材料留源；最小授权引用；按主体、用途和目标检查；无自由双写             | 已实现 | domain逐版本发布、账号/成员范围重查通过；真实更正后旧授权失效、显式撤销、跨域只传必要hash/来源已验                                       |
| M03 | 受控文件读写、版本与索引        | 源设备 CAS 原子写入、operation/hash 回执；索引可重建；离线 pending         | 已实现 | 真实源CAS/409冲突、API及浏览器人工编辑review/adopt通过；索引重建/撤销围栏/1000容量与元数据分页回归通过                                   |
| M04 | 过期、纠正、撤销与遗忘          | 到期不用于当前行动；纠正回 owner；tombstone 传播；保留范围明确             | 已实现 | 真实更正、过期引用不可回忆、撤销、旧副本离线遗忘及重连清理通过；legacy转移与旧输入防复活由故障回归覆盖                                   |
| M05 | 显式位置迁移与维护权转移        | prepare/校验/epoch 切换/旧源停写；中断恢复不双主；不搬凭据                 | 已实现 | 跨物理设备freeze/copy/verify/epoch切换/retire完成；实际切换前取消保持epoch和原主根；中断竞态由故障回归覆盖                               |
| R01 | 四角色统一默认与覆盖            | runtime/profile/model/effort 合法组合；目标设备映射；缺能力不静默换账号    | 已实现 | 四角色Codex原生运行及设置选择已验；显式不可用账号拒绝且无静默fallback；缺Claude登录的环境未冒充在线验证                                  |
| R02 | 配置快照与数据流向              | 请求与实际参数分开；运行中版本固定；fallback 仅预设允许项                  | 已实现 | requested/observed快照、输入绑定、账号配置变化与actual-host能力回归通过；实际预算中止、精确输入停止已验                                  |
| J01 | 事件合并维护与持久恢复          | dirty 合并、稳定 job/游标、lease/fencing；无变化无模型调用；离线重连对账   | 已实现 | 真实memory/gov只读短作业完成；无变化去重、失败重试/预算已验；普通会话进度不再触发治理；修订回归及最终部署已完成                          |
| J02 | Workspace 初始化与存量治理      | 就绪检查、局部 patch、base revision；活跃依赖不被隐式改写                  | 已实现 | 真实非工程Workspace初始化、readonly建议与审阅后base-hash patch应用已验；活跃上下文围栏由确定性API/Worker回归覆盖                         |
| J03 | 有限跨域依赖                    | DAG/环检测、下游等待、材料授权传递；单个步骤失败可接续                     | 已实现 | 真实两Workspace依赖链完成：下游在上游核验后才派发，receipt等于上游SHA256；环检测和失败等待回归通过                                       |
| J04 | 取消、预算、停止范围与回收      | 暂停派发/停止明确工作/独立 service 分开；能力与 verified 回执可信          | 已实现 | 真实person_requested→nativeEndedAt/confirmedAt→目标PID退出；宿主/独立服务仍在；离线等待和迟到旧输入取消回归通过                          |
| U01 | 完整设置与事项/知识界面         | 简单默认+角色覆盖；位置、来源、运行状态透明；中英、键盘、亮暗、窄屏        | 已部署 | 设置/事项/知识界面已部署；真实亮暗窄屏/键盘/知识审阅采纳通过，axe0违规/4节点人工复核；停止回执文案已实际部署复核；证据跳转原工作区已实测 |
| V01 | 合成端到端与真实原生运行        | 覆盖正常、重试、断线、歧义、越权、跨设备知识/角色及恢复                    | 已验收 | 常用入口与跨设备合成验收已完成；最终完整format/verify通过，测试统计及限制见末节                                                          |
| D01 | dev 部署与 Worker 实际加载      | Server/Web 正确版本；Worker 包与实际 execution host 独立核验；保留活动工作 | 已部署 | Server/Web及日常actual host .1792555372已核；同ID保护服务恢复verified+健康/设备/Issue状态已核，最终Server/Web已更新，产物hash见末节      |
| D02 | 可审阅提交、CI 与最终成果验收   | 仅自身已验证文件；保护分支正常合入；完整成果入口和用户验收步骤             | PR交付 | [PR138](https://github.com/BD777/foundry/pull/138)承载正常保护分支交付；完整检查已通过，最新head CI/merge/main CI及同步回执在PR记录      |

## 实施顺序与边界

1. I01–I04 的数据库契约和事务、入口/工具/UI；先覆盖故障恢复。
2. R01–R02 的统一配置解析，接入协调与领域派发，明确来源/数据许可。
3. M01–M05 的知识源、受控文件协议、发布/撤销与迁移；只用合成数据。
4. J01–J04 的短作业维护、治理、依赖和控制，复用已合入持续工作能力。
5. U01 全路径体验与 V01 定向回归/真实 CLI/API/浏览器验证；D01 发布和实际加载，再 D02 完整准出。

相邻步骤可交错完善，但矩阵未全部满足前不宣称完整交付。多 memory 根、多主同步、任意远端计算平台、模型自动调优不属于本轮必要范围。任何缩减用户明确要求的决定必须记录原因，不能以阶段名称隐去。

## 并发与环境保护

- 起始 main 为 `3be3dfd`，包含 DEV-027 本地提交及 DEV-024/028 等未提交改动。保留所有其他 owner 内容。
- 已向 DEV-027 请求 PA prompt、MCP 公共对象、runtime/skills 与公共构建发布交接；收到明确交接前只推进独立模块/文档，不让新代码混入其固定发布产物。
- DEV-028 持有 `operate_resource` schema、Mac scope 相关 Server/协议/Worker/tests 及 resources 审计行。PA 新工具独立维护，不改该区域。
- 复用 [测试环境登记](test-environment.md) 的身份；秘密仓库外。无用户个人 TODO、简历或私人 Workspace 导入/迁移。
- 2026-10-21 01:00（UTC+8）起始磁盘：99G 分区，约 16G 可用、85% 使用。构建/打包/快照前后核对空间，遵循 AGENTS 的安全缓存边界；共用构建锁，不复制全量日常数据库或依赖。

## 流水与接续检查点

| 时间（UTC+8）    | 变化                                                                                                    | 下一步                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 2026-10-21 01:00 | 接受完整实施授权；读取最新 AGENTS、dirty 状态与现有清单/入口实现，登记全部交付矩阵；向 DEV-027/028 协调 | 先实现可靠收件与事项事务，等待共享文件/发布交接 |

起始检查没有活动持久工作；历史原生终端观察记录均已结束。后续如需受管接续，回执记在本节，不创建用户业务服务。

### 检查点 1 · 2026-10-21 01:38（UTC+8）

- 原 DEV-027 owner 恢复失败后，parent 指派继任 `sess_1792515861602906533`。继任已明确释放 PA prompt、MCP 新对象、Server 迁移/路由、协议和 Worker 新模块；其 PR #137 从独立 snapshot 验证，主树 index 不占用。DEV-028 资源范围仍独占。不要把其 dirty 加进 PA 发布。
- 已写 `pa_inbox`（独立收件、稳定原生 input ID、CAS/lease、回执对账）、Web 接收/等待状态、清单 revision/source key/计划与工作引用、事务内依赖环检查、删除后的身份围栏。用户输入来源排除其他 session 转发的文本。原始个人事项未复制到新测试。
- 已开始四角色偏好与不可变 `pa_run_snapshots`，角色解析/预览及协调收件接入；模型/effort 是请求值，实际值仍看原生回报。显式账号丢失不选另一个账号。**这些新增接入尚未完成编译回归，角色设置 UI 尚未接。**
- 已通过的阶段测试：flow 身份/依赖/来源；Inbox 并发重送与 DB 重开、租约恢复/CAS；HTTP `TestAssistantInbox*`（6.352s，模拟 daemon，非真实模型）；事项幂等/旧 revision/并发环与原清单测试（Store 7.473s）。后续新增删除围栏和角色快照后尚未重跑这些包，不能将旧结果覆盖新状态。
- Web typecheck 首轮只报 `assistant-home.tsx` 等待列表首项可能 undefined；已改为可选访问，尚未复跑。protocol 曾完成构建，但其后又新增 runtime DTO，下一次 Web/Worker 检查前须重新构建协议。
- 最新轻量检查：DTO contract 266 interfaces 通过；module audit 0 violations、core Store 仍 83 methods。SQLite 新存储走模块接口。共享 `audit-module-boundaries` 仅添加 sqlitestore → personalagent 依赖，DEV-028 resources 行保持。
- 重检查使用 `/tmp/foundry-check-changed.lock`。DEV-027 继任当前在独立树持锁串行 JS/vet；本 owner 没有遗留构建进程或占 index，暂不竞争重检查。磁盘约 15G 可用、86%，未清理任何用户数据/备份。

**接续优先顺序**：先读当前 dirty 和协调消息；在锁可用时重建 protocol 并对当前源码跑 Go PA/Store/HTTP 定向回归、Web typecheck，修真实失败；然后完成飞书持久收件（保持消息/话题及回复归属，附件不得静默丢弃）、收件处理/失败接续状态、领域派发 operation 及角色快照统一接入。接着按矩阵推进 Memory 文件协议与独立位置、跨域 publication、维护治理、角色 UI、预算/停止和完整实机验收，不停在收件阶段。

本次仍未部署、未发布 Worker、未提交。矩阵无项目被标为完整交付。后续 Git/CI 操作按会话中的授权边界执行，尤其保护其他 owner 的未准出源码和正在运行的服务。

一次性接续已登记为 `work_38ba357f95611e24cad1fdc428ab74d5`（当前会话 `continue_thread`）。设备观察回执为 revision 1 / confirmedRevision 1 / idle，nextFireAt 为 2026-10-21 01:41:36（UTC+8）；调度器实际报告版本 `0.5.7-dev.43.ga31ae80.local.1792510265`。此回执证明已登记并被设备观察，不是下一轮已经执行的证据。未创建重复接续或业务服务。检查点文档的 scoped check-changed 已通过，最新业务源码仍按上述待回归项继续验证。

### 实施流水 · 2026-10-21 02:40（UTC+8）

- DEV-027 继任已完成 PR #137 合入并同步，当前基线 `84aed611021fb7180829a58313d58d485b098009`；共享 index/build 已释放。本项仍未提交、未部署；DEV-028 未准出资源改动保持独立。
- Web/飞书收件均先持久保存。输入 root 与原始时区在显式重试中保持；附件必须全部可读取才派发；飞书原卡片/话题作为回复目标，结果通知可恢复。跨 session 传话不视为用户本人事实。失败输入可见并显式重试，未知送达不当作失败重派。
- 四角色统一默认与覆盖已有设置 UI，解析设备上实际可用账号、模型/effort 与显式允许 fallback，生成不可变配置快照。配置预览与运行快照 API 已有，UI运行观测/预算强制仍未完成。
- 领域派发 `pa_operations` 与 `dispatch_item` 已接入：事项意图版本独立于进度 revision；同一事项不能有两个未决派发；依赖未完成不执行；创建/接续会话输入时在同一 SQLite 事务重校验意图和 operation revision。稳定原生 input ID 用于响应丢失对账，原 owner 忙时等待，配置不同不暗换。执行结束进入 review，不将事项自动标 done。普通 create/send 的助理入口迁移、完整证据/UI尚待接。
- 原生 control 发现真实窄故障：Claude/Codex 已接收 steer 后若回执落盘失败，普通错误可能允许重送。改为 outcome unknown，保留去重；两条新增故障测试验证不会再次进入原生输入。
- Memory 文件层已开始：工作区内显式根、拒绝 symlink/hardlink/越界、Markdown正文+版本/hash/出处、原子 CAS、遗忘墓碑、单写锁及迁移 freeze/stage/retire 协议。仅新增受控文件 RPC，尚未连接用户位置设置、控制面 metadata/publication/迁移作业；不能声称跨设备记忆已实现。
- 已通过：`inbox-channel-regression.log` 的 PA/flow/Store/HTTP/Feishu 定向 Go、protocol构建、Web类型检查与20项测试；`operations-native-regression.log` 的Store/HTTP定向Go与12项Worker steer；`operations-api.log` 的账本/模拟daemon派发、丢回执、review与配置绑定测试。日志在仓库外 `/tmp/dev023-evidence/`。这些是自动/模拟验证，不替代真实CLI、浏览器、跨设备和部署验收。
- 文件层测试仍在运行，后续继续所有矩阵缺项。磁盘约15G/86%，未清理用户数据或备份；没有新业务服务或重复接续。

### 实施流水 · 2026-10-21 03:00（UTC+8）

- Memory 主根与领域根位置记录不保存知识正文；源文件正文使用 Worker 的 `knowledge_files_v1` 能力。一个人的主根唯一，旧根不能通过普通保存改设备/路径，明确迁移仍待实现。新建专用位置走已有 Workspace lifecycle，不初始化工程历史；源工作区必须私有且设备归本人，权限在延迟操作时重新检查。
- `knowledge_entries` 是版本/hash/出处/期限索引；`knowledge_mutations` 是临时 outbox。收到源文件回执后清除临时正文。遗忘先将索引置为 forgetting、使旧写失效并清除历史 outbox 的正文/标题/出处，再对源设备读后 CAS 写墓碑；迟到写回执不能恢复索引。旧会话、导出和备份的保留边界在 UI 明说。
- `knowledge_publications` 是指定事实版本的引用，无正文副本。目标工作区、执行账号指纹、成员及系统账号共享范围摘要、有效期均需匹配；纠正后的新版本不会自由双写或自动继承旧版本的外发授权。Issue session 继续使用 Issue 授权材料，不能利用工作区引用扩大范围。
- 设置页新增独立位置/现有或新建私有工作区、知识正文/纠正/遗忘、版本共享及撤销。保存配置和发布引用分别是显式用户动作。历史 `pa_memory` 尚保留原 owner，没有自动搬运；选择新主根后 `remember` 的新确认事实进入源文件队列，猜测需用户确认，历史记录的迁移和默认助理回忆授权仍需完成。
- 收件、领域派发、知识文件处理拆成独立的确定性恢复循环，均不做模型轮询，避免离线知识设备拖住前台收件。后台模型维护/预算/治理仍按矩阵未完成。
- 文件层、位置、临时正文清理/迟到回执、publication账号/成员边界的定向回归已通过。UI初轮发现中文翻译插入位置导致语法错误，已修；另一轮Go检查跨越源码新增过程而报未定义方法，不作为有效当前版本验收。现正对稳定源码重新跑protocol/Web类型/20项Web及Go定向回归，结果待记录。
- 磁盘仍约15G/86%，未生成新快照或部署包。现有一次性接续仍在执行，没有新增重复定时任务。

### 检查点 2 · 2026-10-21 03:07（UTC+8）

**当前可恢复状态**：全部本项源码仍为本地 main 的未提交改动，未部署。基线仍为 `84aed611021fb7180829a58313d58d485b098009`。DEV-028 资源源码/schema/协议和其报告、DEV-026 报告均非本项发布范围。共享 build/index 无占用；磁盘约15G/86%，无清理。

本轮最后稳定验证：

- `checkpoint2-regression.log`：protocol 构建、Web typecheck、21 项 Web 测试通过，新增独立 Memory 设备/离线保持位置用例。Go 的新负面测试抓到旧 `MemoryStatus(inferred)` 也是 active，不能据此认定来源已确认；已改为额外要求 stated 来源。
- `checkpoint2-go-final.log`：修正后的 HTTPAPI/Store `TestKnowledge*`、`TestAssistantOperation*`、`TestPersonalAgentOperation*` 全通过（8.800s / 4.645s）。验证新主根的 remember 不写第二份 `pa_memory` 正文、同输入重试仅一条 outbox、推断不进源文件；助理 raw create/send/handoff 不能绕过事项派发，普通 session 不受此约束。
- `knowledge-prompt-ledger.log`：Prompt 全包（含版本/hash/golden）通过；新版本 `2026-10-21.1`，测试 golden 已更新。后续如继续改 system.md，仍需更新此未发布版本的 hash/golden 并重跑全包。
- 上述检查不等于全仓/真实运行准出。尚未跑本项最终全量 check-changed/release verify，未做真实 CLI、浏览器、跨设备或部署验证。所有日志位于仓库外 `/tmp/dev023-evidence/`。最新 contract 为275个DTO/115个daemon消息，module audit为0 violations、core Store仍83方法。

关键实现入口：

- 派发：`store/personal_agent_operation.go`、`sqlitestore/personal_agent_operation.go`、`httpapi/personal_agent_operations.go`。意图 revision 与 UI revision 分开；事务接受原生输入时复核 operation/意图，并拒绝同 workspace 的另一个活动 writer。`replaceOwner` 仅在旧 owner 已停止后新建干净上下文并将旧引用降为 observing。无自动把session完成当事项done。
- 知识文件：`packages/worker/src/knowledge/files.ts` 与 `daemon/handlers/files.ts` 的 knowledge RPC；Go桥为 `httpapi/daemon_knowledge.go`。版本/hash/出处在Markdown源；源外编辑需review，不静默导入。当前freeze/staged/retire只是文件协议，**迁移编排尚未实现**。
- 控制面：`store/sqlitestore` 的 `knowledge_vault`、`knowledge_entries`、`knowledge_publications`。正文仅临时存在outbox；回执确认后擦除。forget先拒绝检索并清理/废止旧outbox，再对源读后CAS墓碑；迟到write回执不能复活。主根唯一；领域根可多，但每个领域同人一根。普通save不可改位置/epoch。
- API与模型工具：`personal_agent_knowledge*.go`、`personal_agent_publications.go`、`personal_agent_remember_source.go`。原始输入出处仍由personSaid的可信来源校验。`read_knowledge`只读明确publication，校验事实版本、target workspace/account fingerprint/audience/expiry。Issue仍用Issue授权材料。publication创建必须提交用户刚查看的sourceEpoch/revision/hash，防止确认过程中悄悄换正文。
- UI：`settings-knowledge.tsx`、`api/knowledge.ts`，已有/新建私有位置、领域来源、正文纠正/遗忘、版本发布/撤销、等待操作。旧MemorySection仍在下面保留历史owner，不自动迁移。新UI尚需浏览器视觉/交互验收，状态原因目前有原始代码需完善文案。其数据读取已防止切换来源时旧请求覆盖新选择。
- Worker native控制：`runner/codex-stream.ts`、`runner/claude-turn-controls.ts`、`session-steer.test.mjs`，已接受原生输入但回执保存失败改为outcome unknown，保留去重；12项通过。没有禁用原生委派或改DEV-028资源代码。

**下一轮优先继续，不以此检查点结束整个目标**：

1. 补齐 Memory 主根默认回忆的明确授权和配置变化边界。当前新主根已能保存，跨域只有逐条publication；助理未来对话还不能自动读取刚记下、未publication的事实。推荐提供用户明确开启的“主根内已确认知识 → 当前助理账号”授权，绑定具体profile/fingerprint及接收范围；改账号不得静默继承。领域事实继续用最小版本引用，不能因此变成全域自由共享。旧pa_memory未经确认的inferred也不能作为已确认事实输入行动。
2. 实现显式迁移状态机与维护权转移：旧根冻结、逐条验证/复制至staged新epoch、事务切换pointer/索引、激活新根、旧根retire。中断只允许一个主写者；不是改一行path。处理迁移期间forget的立即检索围栏，以及所有已知保留旧源/副本上的遗忘传播；不能让旧rollback副本永久保留而UI声称已全删。离线恢复/明确进度/失败路径必须可见。
3. 完成四角色执行生命周期/事件合并维护和存量治理。按数据workspace解析设备/账号，验证统一默认在多个设备上的映射，不让一个设备的账号选择暗中传到另一设备。内置旧digest/重试链路也要按角色配置或明确保留边界。维护模型只在真实变更时触发；readonly建议+受控CAS补丁，活跃session依赖的正文不得擅改。
4. 补全路由决策/事项恢复与完成证据UI、跨域依赖下游释放、预算/超时/取消请求及真实回执、停止前台/任务/维护/独立service的清楚边界。当前操作账本有部分基础，J01/J02/J04仍未完成。
5. 全部核心链路实现后，自行做合成真实CLI/API/浏览器（键盘/亮暗/窄屏）和跨设备验证。发布必须用排除DEV-028未准出源码的明确snapshot/manifest，核对actual loaded Worker host；最后完成保护分支正常合入、最新head CI跟进和完整验收入口。不要拿局部测试替代全矩阵准出。

继续遵守最新AGENTS、已获授权及会话中的Git操作边界；没有新产品决策需要再问。不要新建实施owner；仅在确需跨原生生命周期继续时登记一个去重接续。

第二检查点的一次性接续已登记：`work_0c4a645c1fe8359d4eac5f9f02db002a`，同一session的 `continue_thread`。设备已观察 revision 1 / confirmedRevision 1，状态 idle，nextFireAt 为 2026-10-21 03:11:00（UTC+8）。这是接续登记与观察回执，不是后续实施完成的证据；当前第一检查点的运行将随本轮正常结束，未调用控制工具取消当前执行。没有重复登记同一检查点或创建业务服务。

### 检查点 3 · 2026-10-21 04:30（UTC+8）

**仍为完整实施中，未部署、未提交。** 当前 main 基线与其他 owner 边界未变，DEV-028 仍不纳入本项发布。磁盘约14G/87%，没有清理数据。共享构建锁和 index 无遗留占用。

本轮新增闭环：

- 主根回忆：`KnowledgePublication.scope=memory_root` 仅用于私有主根及助理当前 profile；用户先预览解析账号，再显式允许。启用新账号会撤销旧 root-wide 授权，领域知识仍逐条版本引用。`read_knowledge` 可按标题列元数据，再读单条当前事实；过期/撤销/变化的源不会作为当前事实。source grant 本身不改变 OS 权限。
- 来源：新主根的 stated 事实引用实际匹配的原始用户事件，后来的通知不会冒充出处，也不会因通知重复而多写一份。旧 `pa_memory` 的 inferred/external 不再进入已确认事实上下文；选择主根后禁止旧 `/memory` 新增正文，旧记录仍标示原 owner，未自动搬运私人资料。
- 迁移：`knowledge_migrations` 持久记录 pending/freezing/copying/verifying/activating/retiring/complete。源根控制 revision 拦截迟到freeze/activate；目标只接受staged import，保留事实revision/hash/出处。校验后事务切换位置、epoch、索引与引用，激活目标后退役旧根。切换前可请求取消，先退役临时目标再恢复源；切换后只前滚恢复。正文不进入迁移manifest。
- 迁移期间forget：索引先置forgetting，切换事务不复活它；旧epoch迟到回执不能覆盖新索引；未完forget改到新epoch。`knowledge_replicas` 保留所有已知旧源/临时副本位置，`knowledge_replica_forgets` 对遗忘事实逐一取得墓碑回执，离线或权限不足保持waiting。原生文件协议允许在frozen/retired源执行受控forget，拒绝其他写入。
- 运行控制：`pa_run_controls` 绑定精确session/input；下发前记录可能发生副作用的发送尝试。未发送可本地取消；发送过但断线的执行只能保留stop_requested，不能假报已取消；迟到停止不能影响同会话后来的输入。全局暂停在接受输入的事务内复核，未派发事项被取消，恢复不会清除旧停止请求。独立服务不被此开关隐式停止。
- 预算：配置快照含inputId，`SessionInput.executionBudget` 由服务端注入。Codex/Claude的本机watchdog及自定义命令时限采用更紧的角色时限；不能执行此契约的旧actual host被`role_run_budgets_v1`门槛拒绝。Token预算依据原生主运行时已观测输入输出（含缓存），不是精确计费/全部子任务硬上限；UI明确报告延迟和在途请求可能超出。
- UI已有角色运行配置、观测用量、原始输入停止与回执；知识位置、主根回忆、领域来源、版本引用、迁移/取消、旧副本清理状态。尚未浏览器视觉/键盘总验，部分状态原因仍需完成自然语言文案。
- 原有摘要任务属于入口路由的后台辅助，现按coordinator配置快照/时限执行；其幂等键是内容版本＋该次到期批次，既防同批重复，也允许失败后合法重试。监督通知不再建议未经配置的跨账号切换或绕过派发账本。

稳定检查证据（仓库外 `/tmp/dev023-evidence/`）：

- `recall-regression.log`：回忆授权/旧推断过滤/账号约束Go定向通过，protocol/Web类型通过。
- `migration-regression.log`：HTTPAPI/Store通过（15.270s/5.385s），Worker知识文件5项通过，包括源版本保留、forget压过迟到复制、取消后的控制围栏。
- `run-control-regression.log`：Go相关包通过；Worker两个文件共18项通过，包含无Server连接时的本机Codex时限。
- 扩大生命周期回归先发现旧stop测试依赖“离线即已停”，以及摘要同内容合法重试被过强幂等键挡住；均已修。`lifecycle-final.log` Go通过（HTTPAPI47.122s/Store14.913s）。
- `checkpoint3-final.log`：当前扩大Go（HTTPAPI42.392s/Store16.670s）、protocol/Web类型及Web21项全部通过。
- `checkpoint3-worker.log`：当前Worker构建与19项测试通过（steer、knowledge-files、execution-host-capabilities），角色时限测试使用本机定时器，未调用真实模型。
- 最后又修正了“引用旧用户事实却指向当前通知”的出处问题：`checkpoint3-provenance.log` 新来源重放及相关派发/停止/摘要定向通过（HTTPAPI9.858s）。
- contract审计280个DTO/115个daemon消息通过，module审计0 violations、core Store83方法；diff whitespace检查通过。仍未进行本项最终全量check-changed/release verify。

继续实施优先项：

1. **J01/J02仍是主要缺口**：memory/governance虽可配置，但真正的事件合并短作业、readonly native分析、结构化治理建议、活跃Workspace保护、base-hash受控patch、初始化/存量规范治理尚未闭合。复用现有workspacedigest的ContentRev等事件线索，排除维护自身输出导致的循环；无变化不调用模型，失败重试有界。使用现有verification sandbox流程，不能只把一个普通session命名为“只读”。
2. **I03/I05/I06/U01**：事项已有稳定plan/refs/dependencies/evidence/operation，但PersonList仍主要显示旧清单；需要恢复/下一步/路由理由与歧义、已有owner/依赖/失败、完成证据的完整可见路径。原生完成只到review，不自动done；用户更正必须可恢复。真实模型的多意图/只记不做/接续/跨域验收仍未做。
3. **知识恢复细节**：手工编辑Markdown当前会拒绝未校验源，需要用户可审阅的显式adopt/reconcile路径，不能只能报external_edit。旧服务器事实应可显式迁移权威来源，确认后原正文不得自由双写。核对旧来源被遗忘后换intentKey重学的防护，并清理已确认属于本文件协议的崩溃临时写入残留；不得泛删用户文件。检查大于当前元数据读取界限时的可见性/分页或明确容量拒绝，避免静默截断导致丢事项。维护周期应淘汰过期的派生状态，保留必要出处/撤销围栏。
4. **权限与配置边界总验**：现有profileFingerprint是配置路由/端点标识，不是登录主体在线验证；不把缓存身份说成已登录可用。主根“私有”目前按Foundry成员/设备所有权重查，普通native进程仍有原OS账户文件权限，原方案§14也明确普通session不是最小权限。UI已说明受控recall接口不等于OS文件隔离。继续检查角色默认在不同设备上的解析、共享/撤权后的拒绝与恢复，避免未授权fallback。
5. **真实验证与发布仍未开始**：至少补真实native CLI、API/浏览器（亮暗/窄屏/键盘）、跨设备合成资料链路，验证stop/离线/权限不足/歧义/迁移中断与恢复。发布用明确source snapshot排除DEV-028混合dirty，记录产物hash并核对实际加载host；只更新自己已验证文件与README本行，最后正常保护分支PR/CI/合入及最终验收入口。不能以“自动测试通过”结束整个目标。

此检查点是长实施的持久接续，不是任务完成或新增用户业务计划。继续同一owner；无新产品决策需要重复向用户确认。

部署状态的只读核验：本轮实际execution host仍从安装目录 `0.5.7-dev.43.ga31ae80.local.1792510265` 运行，并非仓库 `packages/worker/dist`；另一个已安装的旧daemon仍在，未停止或更新它。公开dev首页仍引用静态资源 `/assets/index-BqytW1KS.js`，未加载Vite客户端。本项仓库构建没有被当作dev部署或actual-host升级证据。最终发布仍须核对新包与实际执行宿主两层。

第三检查点一次性接续：`work_a424f52081cf232efb3faf5fd50736fd`，同一session `continue_thread`，设备已观察 revision 1 / confirmedRevision 1，idle，nextFireAt 为 2026-10-21 04:56:00（UTC+8）。这是可靠接续回执，不是完整交付；没有重复timer或新实施owner。本轮业务测试已结束，未留构建锁/index占用。

### 检查点 4 · 2026-10-21 05:35（UTC+8）

仍在完整实施中，**没有部署、没有提交**。本轮补入 J01/J02 的真实运行链及 I03/I05/I06、M03/M04 的主要恢复路径；不能把这些代码与定向检查当作全矩阵准出。main 基线仍为 `84aed611021fb7180829a58313d58d485b098009`，DEV-028 边界不变。磁盘约13GiB/88%，未删任何数据或缓存。

- `pa_maintenance` 合并同角色/工作区/知识根的内容版本；一个用户同时一个维护作业，每24小时最多4次已接受运行。没有内容变化不调用模型；一次失败只允许用户显式重试两次。配置、权限、离线等待不消耗新的推理调用。memory按索引版本/epoch/到期变化触发，governance复用digest的ContentRev；其自身Foundry/native聊天投影从源活动中排除。发布建议前再复核版本，旧知识结果不会在遗忘/迁移后重现为当前建议。
- 两类维护使用实际 `source=verification` 沙箱、配置快照和本机时限；不是普通会话仅冠以只读名称。模型返回有界结构化建议，不能直接写知识、委派或创建后续事项。memory只提出带条目版本的核对建议；governance仅可提出AGENTS.md/README.md完整补丁，带原文件SHA256或missing。原生输入已换轮时旧维护不会消费或停止新轮。
- `pa_context_patches` 在同一事务中检查活动会话并取得工作区围栏；Create/Send以及Issue输入的中心写入路径都检查围栏。未获设备确认不超时释放。Worker用prepared/applied/conflict回执恢复崩溃，迟到重放不覆盖后续人工编辑；不跟随符号链接/硬链接，不接受任意路径。源文件与回执fsync，旧内容仅在源设备保留供追溯。此协议约束Foundry操作，独立服务及非托管OS进程仍保留原权限。
- 新建空领域Workspace写入目的、事实来源/执行状态边界和待补上下文，不假定软件工程。默认不初始化Git；MCP source.gitInit为明确可选。已有/克隆文件不被初始化模板覆盖。助理自己的非工程目录也不再默认Git初始化。
- 设置页新增维护状态、当前角色对话、有限重试、忽略及逐文件当前/建议内容审阅。事项页新增下一步/等待原因、项目、依赖、原owner/Issue/service引用、派发状态与完成依据；接续按钮再次持久收件并引用原事项/回执，不直接新建任务。路由理由/候选/澄清字段落库，澄清会改变意图版本并阻止派发。用户勾选完成记录为用户确认；既有执行的模型完成需先提供证据，session引用必须为可读的完成输入，URL禁止凭据及非HTTP(S)协议。
- 手工源编辑新增inspect/adopt：先展示原始文件的审阅正文和完整文件hash，用户确认后才以新出处/版本受控采纳。失配拒绝；遗忘也能处理损坏的元数据。`.pending-journal.json`仅登记本协议产生的暂存文件；取得写锁后只清理有journal证明的已放弃临时写入，不扫除未知用户文件或旧未登记文件。
- `knowledge_revoked_sources`保留按用户隔离的来源指纹：遗忘后模型不能换intentKey从同一条旧输入重学；不会删掉同一输入里其他已存在的事实，新消息的再次确认仍可保存。已知副本清理仍按原迁移队列。原生历史对话是历史记录，不冒充当前记忆，也不声称此接口能擦除任意OS文件/外部备份。
- 旧pa_memory转移需用户审阅content hash和updatedAt，事务冻结旧正文；文件回执提交后擦除旧正文/替代链，只留转移指针。途中forget（含forget all legacy）同时撤销待写副本，迟到write不能恢复索引。没有自动搬运真实私人资料。元数据索引可显式从owner文件重建；不复制正文、不与未完mutation竞争，不清除撤销围栏；已遗忘旧文件只会重新排队清理。
- 根容量明确为1000身份（包括墓碑），源与索引都拒绝越界而非静默截断。尚未引入多根/多主同步。后续扩容量可以增加分页，不能通过删除撤销身份释放配额。

本轮检查记录（仓库外 `/tmp/dev023-evidence/`）：

- `maintenance-first.log`、`maintenance-patch-go.log`：初轮去重/并发/CAS/文件围栏通过。
- 扩大维护测试抓到摘要接口不含Response而误报无效结果；改用正式session record读取后恢复。中途一次Backend不存在方法的编译错误已修，不作为有效测试证据。
- `maintenance-recovery-final-go.log`：HTTPAPI17.362s、Store8.219s通过；包含真实协议模拟的verification角色、稳定input回放与活跃Workspace写保护。
- `knowledge-recovery-ui-worker.log`：Worker11项通过（治理patch4、知识文件7），Web21项通过；后续新增minimumRevision/目录fsync仍待最终Worker重跑。
- `checkpoint4-go.log`：扩大Go及Prompt全包通过，未发布的2026-10-21.1 hash/golden已同步。旧事实转移的正常/遗忘竞态回归在此轮加入。
- `checkpoint4-complete-go.log`：最新扩大Store14.032s、HTTPAPI20.308s及Prompt通过，含索引重建/旧源防复活。
- `checkpoint4-web.log`：类型检查、22项Web测试通过，新增原owner/未知执行/依赖/接续保留事项身份用例；之后少量索引重建入口与文案仍需最终类型/浏览器检查。
- contract当前289 DTO/117 daemon消息，module0 violations/core Store83。未跑本项最终check-changed和release verify，未做真实模型/物理跨设备/浏览器总验；公共dev及实际host仍旧版。

接下来先稳定所有增量并做全范围定向检查，补必要失败分支；构建排除DEV-028的明确源码snapshot，完成真实CLI/API/浏览器/合成跨设备和发布。Worker的idle upgrade会等所有活动会话与持久工作自然空闲，不能为升级强停别人的执行；新Server用actual-host能力门槛拒绝不具备角色时限的旧host。只有包、daemon和actual execution host三层都核实后才算Worker完成升级。

### 检查点 5 · 2026-10-21 08:13（UTC+8）

本项仍未提交、未部署；扩大验证正在独立候选目录 `foundry-dev023-release` 运行。该目录基于 `84aed61`，仅同步本项文件，`operate_resource` 恢复基线对象，DEV-028 的资源/协议/测试和 DEV-026/028 文档均未加入。主工作树保留其他 owner 的改动。发布前以最终候选源哈希及产物哈希为准，不能用同步前 manifest 声称内容已经封存。

此前“精确 input 停止”只是协议起步，本轮扩大检查发现并修正了实际链路缺口：Worker 曾忽略目标 input，SDK cancel 返回也不等于原生执行已结束。现在取消目标包含 input ID，迟到取消不作用于新输入；只有原生精确结束或宿主持久 claim 已终结才确认停止。普通 Server canceled 投影不能作为停止证据。实际宿主必须宣告 `exact_input_cancel_v1`，旧宿主上的角色任务保持等待。配置快照与控制记录在接受输入的事务中绑定，删事件不消除已接受事实。全局停止事务同时阻止新的派发并标记所有已有控制，不按最近列表截断。确认范围是该原生 input，独立 service 不被这份回执冒充已停。

新增恢复边界：失败收件只有已证明未派发或已收到原生终态才可显式重试；未发送的领域 operation 可取消后按新配置发新步骤。原 owner 的任务记录去重、接续和结果观察保留原身份。Memory 初始位置在从未确认任何事实写入前可更正，已建立的来源仍必须迁移；外部编辑索引恢复需匹配最近应用回执，未知改动走显式 review/adopt。`read_knowledge` 可列本人来源元数据，不能借此读取未授权领域正文。原始输入出处仍由可信事件校验。

真实失败及修复证据（日志在仓库外 `/tmp/dev023-evidence/`）：

- 首轮全范围 `check-changed-full.log` 中格式、协议、Worker 定向测试、审计通过；Web 两条旧 direct-session mock 未适配持久收件，停止文案测试也沿用旧假成功文本，均已修。HTTPAPI 在全局停止中用无期限 context 等待设备 RPC，导致整包超时，现 reconcile 自带 8 秒上限，未知回执保持待确认。
- `exact-stop-regression-final.log`：HTTPAPI 33.907s、Store 17.892s、builtinskills 通过；`exact-stop-web-worker.log`：Worker 21 项、Web 33 项通过。这些是定向证据，不能覆盖后续所有改动。
- 首次候选打包后的 Worker 检查发现新增 MCP 工具缺少 CLI 命令映射，以及 custom-command 取消测试没有启用生产已有的进程监督器。补齐工具映射并使测试沿用生产监督后，`candidate-fix-regression.log` Worker 21 项（含实际 OS 子进程取消）及 HTTPAPI 25.662s 通过。失败轮次的唯一合成 counter 进程已精确清理，不涉及实际服务。
- 新候选 Worker 包为 `0.5.7-dev.49.g84aed61.local.1792541173`，Web/Server 已构建，`candidate-full-go.jsonl` 正在跑扩大包回归。另补不带 input ID 的旧结束通知不能充当精确停止证明的回归，待本轮结束后同步和验证。尚未做最终真实原生/API/浏览器/物理跨设备验收。

部署准备保留现有 Server 二进制与 Web 资产，并先做 SQLite 一致备份；不删除 WAL。此时磁盘约 12 GiB 可用、89%。Worker 短维护沿用 DEV022/024 已验证流程：两合成栈无实际执行且无其他 active claim 后，精确 stop 原记录并等待 verified/PID 消失；由标准 daemon idle upgrade 切换，随后原记录先 Server、后 Worker resume 并核验。running 和 suspended 都占 host busy，pause 不能替代 stop，也不修改 KillMode。维护回合本身需一次性受管接续释放；若升级未发生，先恢复服务，不无限等待。用户已授权这两项短维护，实际操作尚未开始。

### 检查点 6 · 2026-10-21 09:10（UTC+8）

**不是完整交付。** 本项仍未提交；main 基线与 DEV-028 排除边界不变。候选树独立构建与定向复核后已开始 dev 真实验收。此前说明中的“未部署”是当时状态，本节以后以这里的版本证据为准。

发布及故障处置：

- Server 当前进程 `1446045`，入口 `~/.foundry/server/releases/dev023-candidate/foundry-server`，SHA-256 `832269eb20c5c2c040ec8eac0d1c29853e724e97c4f456ffe003fbd22ce00487`，health startedAt `2026-10-21T00:45:40Z`。启动用了约42秒，初轮30秒等待先报失败；确认实际健康后只补完发布指针，没有第二次重启。原 binary 和一致 SQLite 备份保留，未删除 DB/WAL。
- 首次 Web 构建漏掉公开站点所需的同源 API 配置，真实浏览器发现无法取数；立即原子恢复旧 index，保留全部旧资产，再以 `VITE_API_BASE_URL` 空值重建并发布。当前公开页面已能读新 API；同源 index SHA-256 `c855264ccbe8509e44e4f78b146f8dc78129d5680d957dae8c067050fa7f1887`（后续视觉修订尚待替换）。完整证据在仓库外 `deployment.json`、`dev-deploy.log`、`web-same-origin-build.log`。公开 `/healthz` 被 nginx 静态路由接管，服务健康应读 loopback 31982 的 `/healthz`，不能把公开HTML当health。
- 已发布 Worker 包 `0.5.7-dev.49.g84aed61.local.1792543423`，排除 DEV-028。日常主宿主仍旧版，**尚未进行两项受保护服务的升级维护**。两个独立合成测试设备已用标准安装路径加载新包，非两个同机ID冒充跨物理设备：本机 test host `1448807`，远端 linux-dev test host `1510329`；实际 entry 均指向该版本。仅它们的合成目录和独立 state root 被操作，未改用户 Mac。
- 本机合成 Worker 原 source-checkout native终端精确 stop 回执 `wop_9b435edd2a831054c79c2d3470a4cb16` 为 verified，再装新包并以受跟踪 native终端运行。远端使用独立 `foundry-worker.dev023-acceptance` 标准系统服务；初次安装60秒超时，重试沿用已配对身份，10秒成功。安装失败没有被写成成功。测试结束仍需明确处理这些测试运行组件，不能把退出本会话当成它们已停止。

扩大检查发现并修复：

- Worker 的 Skill 下载准备与只读 sandbox 外层取消目标漏了 input ID；精确停止因此命不中下载。原全套测试在 `skill-package-fetch` 卡住，精确结束该自有测试进程后，其余测试继续收集。已补齐两个入口，下载取消用例加有限超时。新包的真实 HTTP/Worker验收用例13.6s通过，另43项停止/隔离/协议回归全部通过（`candidate-release-followthrough.log`）。
- 新增2种 daemon RPC 已有真实 handler，但覆盖清单仍按53种校验；补到55种。没有增加无回执的协议空壳。
- 首轮完整发布检查：Web **817/817**通过；Worker两组为80 pass/1 timeout/4 skip与800 pass/2 fail/8 skip，失败分别为冷Go编译超过测试90秒限额、旧消息清单和上述下载取消。不得描述这一整轮全绿；已定位三项随后定向复核通过。冷缓存的真实HTTP/Worker用例复跑正常，没有简单放宽它的90秒超时。
- Go其余包通过，HTTPAPI整包在默认600秒限额处停止于仍在推进的skill测试；之前15分钟限额运行实际648.7s完成。本次新增测试已使默认10分钟不够，发布命令改为明确20分钟。最终整包绿色回执仍未取得；需要合法执行所有测试副作用后完成，并继续跟CI。
- Go可重建缓存从约0.9GiB增至4.6GiB；确认无Go编译进程后清理，恢复约15GiB空闲。Server正常重启后WAL由SQLite自然回收，之后约19GiB可用；没有手动删除WAL/DB或回滚备份。

真实链路（e2e-alice，全部内容为合成材料）：

1. 原生 Codex CLI 在清除继承的会话/provider环境后，以 `gpt-6-astra/high` 返回指定标记；实际native推理通过，非直接provider API。另Claude Local报告missing_auth，不能据此声称该账号可用。
2. 本机助理 `ws_7ccbde37-c88b-4c82-91e6-90dc5edcd833` 接收同一消息两次只产生一个 input；同ID改正文409。模型把输入拆为两项 record-only 待办，未定时间保持“有空”，没有 operation、没有建项目。
3. 执行其中一项时，测试显式100k软预算在当前输入观测192518 tokens（含cache）后停止，并取得原生结束回执。不是历史session累计量；轮询/in-flight可超额，不能当账单硬上限。原事项/收件/已创建Workspace保留。显式调高测试预算后，retry保留原root，复用已创建Workspace，仅一个领域operation，实际产生 `reading-notes.md` 并完成原事项；另一项未改变、未初始化Git。该真实样本说明默认200k容易截断普通路由，已在源码把默认软上限改为500k，尚待本批部署；测试账号显式600k不改变其他人的设置。
4. Memory主根最初在远端设备 `dev_59529693-ae28-42b4-960b-0ef8c6deeaba` 的私有合成Workspace，本机助理设备为 `dev_1cc8297f-9d79-4428-aace-6640e5325abb`。受控写入和跨设备读取拿到revision/hash；显式主根账号授权已创建。纠正得到revision2。旧版本写入被围栏拒绝，但REST误报500，已补typed revision/idempotency错误→409与HTTP回归，当前新修订待部署复验。
5. 显式迁移 `kmove_e05cbd22188613041e3e5e203c25263b` 已complete，唯一根epoch1→2，落到本机合成Workspace `ws_677317c1-825f-43e8-829f-93f239b1890c`，数据版本保持。旧副本遗忘、断线恢复、domain逐版本发布和权限变化仍要完成实际验收，不能以迁移complete替代这些证据。
6. 浏览器已实际看到完成项/文件证据与未执行的另一个事项。截图发现辅助回报被当用户气泡、done项仍说待核验、每行路由详情过长；源码改为按可信sender metadata排除辅助输入、done时呈现已有结果、默认折叠详情。类型/27项定向Web及全UI审计通过，新视觉修订尚未发布复验。

当前正在 `live-fixes-candidate.log` 对新候选做Go定向回归、Server/Web构建及剩余审计；不得把旧817条覆盖后续界面修订。后续优先：完成这批修复部署和真实UI亮暗/窄屏/键盘；继续memory遗忘/迁移恢复/publication、已有owner接续/依赖/歧义/失败、四角色真实维护和精确停止；最后日常宿主安全短维护及最终PR/CI。所有矩阵仍需逐项补真实与最终发布证据，未整体准出。

### 首次使用就绪推进 · 2026-10-21 午间

用户要求优先让助理可安全开始使用，完整矩阵继续收尾。首用门槛收敛为：一致 Server/Web、具备角色预算和精确停止能力的实际日常宿主、合成账户记录及原 owner 接续验证。不能以候选包已安装代替实际宿主升级，也不以首用就绪代替整项完成。

- 用户原助理已存在且 active，默认执行设备亦已配置；没有重建或替用户选择 Memory 位置，没有迁移真实私人资料。设置现从本人全设备账号目录读取，避免侧栏当前 Workspace 的账号列表误限制角色选择。类型检查及30项 Web 定向回归通过；新知识元数据分页回归通过，过期/遗忘/旧epoch不进入当前页。角色回执与维护审阅移至 Activity。
- 已发布的前一候选 `.1792549870` 在本机与远端合成设备均实际加载。跨物理设备 Memory 更正、迁移后旧副本离线遗忘队列、重连清理均实测通过；旧版本更正返回409。主根账号授权已绑定当前原生账号配置指纹，变更需重新审阅；缓存身份仍不代表在线认证。
- 真实 readonly memory 作业完成；真实治理作业对合成 AGENTS 重复约定和缺少 README 提出带 base hash 的补丁，未自动改写文件。此前“治理未实施”已由实际作业证据替代，但完整治理 apply/活跃围栏浏览器验收仍待完成。
- 主机已标准更新 daemon 到 `.1792554854`（PID1554070），旧执行宿主 PID1147869 保留所有活动回合。尚未停止两项受保护合成服务，实际主宿主仍旧版。更新前后磁盘约20GiB/81%；没有手删DB/WAL，前次重启由SQLite自然回收WAL。
- 常用接续验收发现真实缺陷：Codex SQLite 的 rollout 路径经过已回收的生成配置目录，历史正文仍在原生数据根，按ID接续却报 `no rollout found`。初试原生 `thread/resume.path` 被当前 paginated thread 明确拒绝，未将这次尝试描述为成功。最终修复保留经来源记录校验的历史别名，同时清除临时配置/凭据；对既有受损地址，仅在明确错误后读取官方 `thread/read` 元数据，验证同一原生ID和受控数据根中的 session_meta，再恢复同一生成根下缺失的历史别名，仍按原ID调用原生 resume。不会新建替代线程或手改原生数据库。
- 原失败原生ID已通过真实 SDK/CLI `thread/resume` 恢复，未发送推理 turn；回归覆盖历史地址保留、清除临时凭据、ID失配和非指定错误拒绝重试。随后重新发起同一事项/owner 的合成执行，结果仍待核对。证据在仓库外 `first-use-resume-regression.log`、`native-resume-check.json`。官方接口结构由安装的 Codex0.163.0生成，未直接调用Provider。
- 首用候选构建曾因 knowledge UI 模块1002行违反已有架构审计失败；已拆出独立 pending-write 展示组件重新检查，没有忽略审计。完整HTTPAPI/发布CI仍未全绿，后续继续追踪；此前817项Web通过不能覆盖这些新改动。

首用入口预定 `https://dev.foundryapp.app/assistant`。本段记录时还不能宣布日常主宿主就绪；后续以明确停止/恢复回执、实际host entry和常用链路结果补记。

12:08 首用候选已一致发布：Worker `0.5.7-dev.49.g84aed61.local.1792555372`；Server PID1563405，SHA-256 `c2a322b467282d59ebf873a8c882fbc8247d2db749e8039b33e49e55ff2df46f`；Web index SHA-256 `76854b15f53575dd2b470b707b262df44947972497177117bc5add9ba4cabc71`。构建、contract、module及全部UI审计通过。合成本机实际host PID1563526已加载同版。真实浏览器发送“只查询”后，持久收件 resolved，原助理返回已完成文件的305字节证据及授权主根《合成语言约定》的当前版本，没有新增事项或执行。截图 `.foundry/attachments/dev023/first-use-query-memory.png`；账号目录与键盘选择、亮暗窄屏已核验，axe为0条违规，4个侧栏对比度节点需人工判断，未将 incomplete 写成通过。

治理补丁 `pactx_66ba2bafb9beadb0c8a0f981714d5414` 已 applied，实际AGENTS hash与设备回执一致，重复约定仅剩一条。原owner在04:04:05Z完成、补丁在04:04:15Z创建；因此这是安全完成后的CAS应用证据，不能作为运行中拒绝的实测证据。原事项已done，原owner/native ID均未变化，追加行恰好一次。

12:08:04–12:08:18 已授权主宿主短维护开始。两个合成栈无queued/running/blocked，主host只有维护自身claim；Worker stop `wop_8d857af9081c7f13c03235285b0d0acf`（rev12）与Server stop `wop_bae1147e9f2d4939d320ae0d43d0e06f`（rev6/ref2）均verified，原PID/PGID1150328/1149017全部消失。DB/helper及同work ID保留，Issues仍accepted。一次受管接续 `work_a426857e7da06d048d1cee510c59fb52` 在12:12恢复本线程，专为释放自身claim使标准idle升级；首步必须核actual host并按原ID Server→Worker恢复，若未升级也先恢复服务。此刻不宣称主宿主已经切换，也不宣称整项完成。

12:15 **首用已开放，完整矩阵继续**。实际主执行宿主 PID1566749 已加载 `.1792555372`，旧1147869退出；实际入口和host模块SHA与候选一致，设备心跳已包含 `role_run_budgets_v1` / `exact_input_cancel_v1`。本人既有PA无需重建，入口为 `https://dev.foundryapp.app/assistant`；独立Memory位置仍由本人在设置选择，未迁移真实资料。

维护恢复：Server原记录rev7，resume `wop_c5385eaa7216acd012e60fcd457765ef` verified，实际PID1568211，58105 health正常。Worker首次resume控制回执verified但实际进程exit1，不能冒充服务恢复：标准主机更新清掉了helper硬编码引用的旧`.1792399633`安装目录。保留的原版protocol/worker tgz已离线恢复到合成栈自有runtime目录，helper只更正相同版本的二进制位置，原文件、DB、环境参数、work ID保留，备份在仓库外。第二次resume `wop_f4bcf3d9a4e545abdc2f699712e6b930` verified（原work rev14），实际PID1569805、设备重新connected；原Issues `iss_107` / `iss_108`仍accepted。已排除以后日常runtime GC再次删除该栈固定版本的依赖。没有新建竞争服务或改写原数据库。

本轮原生接续/清理专项实际为14项通过，前述接续提示中的待核数量以此为准。完整发布检查、剩余失败路径和CI仍未全部完成；首用里程碑不关闭DEV023。

### 首用后验收 · 2026-10-21 12:15–12:40

补验覆盖真实两领域依赖、仅澄清不执行、人工源编辑、逐版本引用/撤销、成员范围变化、迁移取消及主动停止。`dependency-live.json` 记录两个领域operation与文件hash；下游只得到必要hash和来源引用。`permission-boundaries-live.json` 验证增添合成成员后旧授权不可用，Memory共享时拒绝、恢复私有后恢复读取。`migration-cancel-live.json` 验证切换前取消保持epoch2及原主根。全部材料为合成内容。

主动停止的 control `parctl_b370d938e9c29134503218fc115208b7` 对准 input `1d16bafa-70fe-5feb-a4ca-4ec7b3dd9014`，取得相同的nativeEndedAt/confirmedAt（04:25:31Z），实际前台等待PID1578828消失；宿主与两原独立服务继续运行。随后将e2e助理暂停，避免测试结束后继续自动维护。两自有合成设备的测试daemon和execution host均已明确停下（本机1563526、远端1653871退出，unit inactive/MainPID0）；原保护服务仍运行，未删除测试资料。远端compute租约 `lease_36c78a6acb804d771520` 已released。远端知识模块与最终候选SHA256均为 `c8459e160e5c91a2ddea87ed90f024a2e32e0e1f29f531adbe8acb71ef3ce5de`，没有把不同版本号误说成整个包一致。

本轮修复与限制：

- 手工源编辑正确拒绝读取，但REST曾错误返回500。已将正常冲突映射409、离线/需升级映射503；dev实际重验409并在真实浏览器review/adopt到revision3。Server当前hash `76ae79ee1e5cbcab4e9f21e4b9404cdaa35d15a42e0af97612e5f0f40c38548a`，后续末批发布会再次记录最终hash。
- 治理原先复用摘要ContentRev，普通会话/Issue进度也会触发模型审阅。改为用途+指令FilesRev，捕获和完成复核使用同一键；集成回归证明普通会话更新不新增job，真实指令变化才新增。尚待末批部署。
- Web与飞书的旧暂停标题仍说“全部已停止”，与停止回执语义冲突。现改为暂停新工作，明确已有执行看回执、独立服务另管；同步双语与通道测试，尚待末批部署。
- 扩大PA Go回归：HTTPAPI99.700s、Store24.921s通过；Feishu完整通道包通过。Worker扩大99项结果98pass/1可选原生目录用例skip；另一个创建Git提交的clone fixture明确留待最终验证，没有把它计入已通过。check-changed计划发现该fixture后已在执行前停止自身检查，停止回执 `wop_4ccbd50ba9cf06f3b18bd2c0a36bf4f4` verified；其余适用用例独立完成。最终完整check-changed/verify仍需执行，不掩盖此前HTTPAPI整包超时和最终CI尚未跑的事实。

没有向真实飞书租户发送测试消息；飞书收件/回复/附件归属证据来自真实业务handler配合受控Bot适配器和数据库的通道测试。缺少有效Claude登录的测试设备只验了不可用分支；不把缓存身份当成在线认证，不静默借用其他账号。

### 固定候选与最终接续 · 2026-10-21 13:21

P0–P3约定核心已接通并覆盖正常/离线/权限/歧义/失败恢复/跨域依赖等合成验收；不是以MVP替代完整范围。最终发布门槛仍未关闭：完整check-changed/verify、保护分支PR、最新head的全部必需CI以及实际合入/同步必须继续完成。

最终实际部署：

- Server PID1605156，health startedAt `2026-10-21T05:12:31Z`，二进制SHA-256 `c50515ebba2e0e991ccb56ebc6e7681f4c00bd678d71f8c101e142b6a4317063`。
- Web index SHA-256 `3eb6ca1b623e34dfecfa540d79592ff2bdf42b2fa75fd6e0ed2fc830ce5f238e`，同源API。完成证据按钮现在带原owner工作区，真实浏览器稳定落到原notes会话及其workspace参数；没有把侧栏当前项目当成证据归属。
- Worker仍为 `0.5.7-dev.49.g84aed61.local.1792555372`，actual host PID1566749。安装的270个dist文件与固定候选逐个一致，集合SHA-256 `94a2eaa962e2a96d508ae78dc3b595130addca2ecd8c2a0dc1f2918cb51d9130`。后续只有Server/Web修订，未为版本号变化重复中断宿主。
- 活跃知识授权查询不再被1000条旧撤销记录截断；1001条元数据回归验证尾部有效授权仍可发现，其他账号仍不可见。此查询仅返回权限元数据，不返回事实正文。
- 最后Web定向28项、先前相关7文件73项通过；Go治理/知识/飞书修订通过；正常停止与设备离线的真实页面已显示“暂停新工作”和独立停止回执范围。最终完整发布轮次仍待执行，未把局部绿色替代CI。

源码已固定在独立候选，排除DEV028资源改动；DEV029开始Connector事项后，禁止再从main整树发现/复制dirty文件进本候选。后续只按明确所有权做局部修复，保留其他owner的routes/protocol/i18n/MCP片段。公共build/index已释放，后续重检查继续共用既有构建锁。DEV029可基于此固定PA基线组合其已验证Server/Web改动，公共Worker发布不得回退已上线PA能力。

证据仓库外入口：`/tmp/dev023-evidence/release-source-manifest.json`（198个owned源文件及SHA）、`installed-worker-dist-equivalence.json`、`main-host-verified.json`、`main-maintenance-restored.json`、`dependency-live.json`、`exact-stop-live.json`、`memory-boundaries-live.json`、`permission-boundaries-live.json`、`migration-cancel-live.json`、`browser-adopt-live.json`、`manual-edit-http-fixed.json`、`evidence-browser-url.txt`。凭据始终在仓库外；没有迁移真实个人资料。磁盘约18GiB可用/82%，原保护服务运行，自有测试栈已停，无遗留compute lease或构建进程。

13:45 相邻事项已给出最终配对回执：DEV029组合候选保留本项198个owned源文件，再加DEV027已测rev8协调指引和其Connector范围。实际Server SHA-256 `ba1ebb122e4ada5ffeecb2455b8826ed6920bba309fb2b4ad7c71d81dbea4999`（PID1619369，startedAt05:32:14Z）；Web build `084e422accdfd615` / index SHA-256 `c54d3707050cd0af0c76007499d78db7d1f05a2ba30631e684e747754f77a93b`。其独立源码清单在 `foundry-dev029-release` 与对应manifest，Worker发布指针未变。后续PA验证/合入不得用PA-only资产回退该组合发布。

构建提前写public的根因也由当前Web发布owner定位并处理：旧PM2 `foundry-web-build` 的Vite命令实际带 `build --watch --outDir /var/www/foundryapp-dev`，PM2自身watch=false并不代表Vite未watch。该单一自动发布进程及其持久化条目已移除，其他live组件保持；78.56秒源mtime与隔离构建探测确认public inode/mtime/hash不变。此事解释先前构建期间的公开index变化，不能把早期显式复制回执当成持续排他的发布保证。现在仍以明确manifest发布及fresh版本核对为准。

DEV027 rev8的固定局部patch和base/after manifest已保存在 `.foundry/attachments/20261021/dev027-coordination/`，普通只读新会话的实际材料化与8情境验收通过。夜间正常整合需继承这份增量，不得将已发布指引覆盖回v7或复用同revision对应不同内容。后续联合源码交付按下方最新分工执行，取代此前各事项独立提交的安排。本项最终准出由同一owner的单一受管接续 `work_59b00474cd5aa2f5af166e85b9ef03f6` 继续，不另造实现owner、业务项目或重复计划。当前未提交、未宣称全部交付。

### 联合源码交付分工更新 · 2026-10-21

协调方已指定本项 owner 为 PA、DEV027 rev8 五文件增量、DEV029 已验 Connector 23 文件的唯一集成、共享 index 及公共构建发布 owner。以各自固定 manifest 和精确 delta 构造候选，允许拆成可审阅的多个提交，但只走一次协调的 PR / merge；排除 DEV028 未完成实机准出的改动并保留其工作树内容。

DEV027、DEV029 的既有受管接续用于本范围只读核对和证据交付，未经明确交接不另行操作共享 index、创建重叠提交或重复发布。集成时保留 DEV029 已发布的 Server/Web 配对资产与已停用的自动公网发布进程；不得用较旧 PA-only 候选覆盖。README 表格由本项统一机械排版，不改写其他事项状态。

本项负责跟踪联合 PR 最新 head 的两条必需 CI，以及实际合入后的 main CI，均到终态后记录合入与同步回执。已有单一接续 `work_59b00474cd5aa2f5af166e85b9ef03f6` 继续承担最终准出，不新增计划；完成后按真实工作状态处理，不移除正在执行的 run。本轮仅更新交接检查点，没有启动构建、重新发布或创建 Git 历史；完整交付仍未关闭。

联合发布待核项：DEV029 owner 在真实使用中报告，bytedcli 的基础 ByteCloud 登录状态不能证明 Meego 独立 GoAPI / Feishu Web session 已授权；现有状态展示未区分。该 owner 正按协调方指令诊断和准备最小修复，可能涉及 Connector 协议与 Worker 分能力状态。此处只记录已报告缺口，不将尚未核实的 CLI 行为当作定论。此前 23 文件 manifest 保留为已发布基线，不再代表 Connector 最终无缺陷准出；后续以明确 delta、是否需要 Worker 更新及相应验收证据交接给本项集成。原 PA / rev8 基线和 DEV028 排除边界保持，不并行修改同一 Connector 问题或发布旧候选。

Connector 热修发布的临时交接：本项将这一次已授权附加授权修复的公共构建、Server/Web/Worker 配套发布及目标 Mac 非中断升级验真交给现有 DEV029 owner；共享 index、Git 与联合 PR 集成责任不变。其以已封存的 PA + rev8 + Connector 组合候选叠加精确 delta，保留 PA 能力、排除 DEV028 未准出源码，继续使用构建锁及磁盘门。实际宿主尚未加载时仍须显示需升级，不以 installed 或 daemon 版本替代执行能力；不得强停活动 claim 或绕过标准 idle 更新。第三方扫码保留给用户。DEV029 完成或确认实际阻塞后，以源码与产物 hash、受影响验证、实际 daemon/host 能力及未验范围一次交回公共发布职责；当前尚未收到这次热修部署回执。

相邻 UI 修订边界：协调方新设 DEV030，负责 Services 卡片公共组件与间距修复及有界同类审计，不改 PA 业务或角色界面。其已告知 Services / Overview / Workspace 样式和文案的局部范围；当前临时公共发布仍由 DEV029 负责，DEV030 与其协调继承最新组合候选。最终 Git 集成仍由本项统筹，接收明确文件清单、base/after hash 和实际验证证据，不能从共享主树自动带入未验修改；发现 PA 卡片问题先按具体路径交接。DEV028 排除边界和已停用自动公网发布进程保持。

### Connector 热修交回与联合候选更新 · 2026-10-21

DEV029 已交回本轮公共发布职责；Services 的纯 Web 修订仍需继承最新组合基线。本项只读核验两层 manifest：`/tmp/dev029-evidence/capability-authorization/delta-manifest.json` 的 24 文件与 `repair-manifest.json` 的 3 文件，其候选 after hash 全部匹配，非文档源码 before hash 也匹配对应基线。最终源目录 `~/workspace/foundry-dev029-auth-repair`；文档后续检查点与已编译源码版本分开处理，不覆盖回旧快照。

据 DEV029 部署回执，Server SHA-256 为 `f9095d32df1c0dd3c55cb4d368533f702ca9f3fb3c164593743dd2fbc8533f32`（PID1659342），Web build `fed228382535f4f1` / index `905ee33980a3c48ea3dd4fd1234a9726364494a19a53934b852a688009771883`。Worker 为 `0.5.7-dev.49.g84aed61.local.1792566321`，包 hash 和 public pointer hash 见同目录 `repair-deployment.json`。能力增量改变 3 个 Worker dist 文件，随后解析失败修复只改变 `connectors/bytedcli.js`；此前“270 文件与 PA 候选全部一致”只描述旧版本，不适用于此新组合包。

DEV029 报告目标 Mac 的 daemon 已加载修复 adapter 并核对 hash，原业务 execution host 保留；不能据此宣布原生观察宿主也已升级。实际 Feishu Web session 授权仍待用户 Try again / 手机飞书扫码，没有代理授予第三方权限。修复针对已有 session 到 SSO 复用解析失败，限定一次官方 QR 回退并返回精确安全错误码。定向检查由 DEV029 提供，完整跨模块发布检查和联合 CI 仍由本项完成；此次本项核验的是清单一致性，未重复实机或浏览器验收。自动公网发布进程保持禁用。

### Services 与公共 Dialog 增量交回 · 2026-10-21

DEV030 已交回纯 Web 发布和共享构建职责。其固定源 `~/workspace/foundry-dev030-release` 基于 Connector capabilities 候选，不能整树覆盖更新的 Worker repair 候选；联合集成仅叠加 `/tmp/dev030-evidence/source-manifest.json` 中 `files` 的 12 项。本项逐一核对候选 after hash、原基线 before hash及最新 `foundry-dev029-auth-repair` 对应文件 before hash，均一致。

当前公开 Web build `f74abfdf92de463d`，index SHA-256 `77334b17827f8b03f617acc7a21c94be4f2f8bc7d42396ad5ad54df7184c3945`；本项直接读取 public index 再核对回执一致。DEV030 的 `deployment.json` / `public-assets.json` 记录主 JS/CSS、Server PID1659342 / SHA `f9095d32df1c0dd3c55cb4d368533f702ca9f3fb3c164593743dd2fbc8533f32` 与 Worker `.1792566321` 保持，自动发布 watch 未恢复。

该 owner 的固定候选 40/40 定向测试、typecheck、10 项 UI 审计、构建及实际浏览器矩阵已通过；包括 Services 三入口、主题/语言/窄屏/只读/恢复、嵌套 Dialog 鼠标取消与确认、Escape 只关子层、焦点返回及 Connector 合成授权弹窗。详情与未扩展范围见 `DEV-030-ui-components.md`，不将其定向结果冒充联合完整 CI。本项这次只独立核验源码清单与 public index，没有重复其浏览器测试。最终统一排版 README 表格，保留各 owner 状态；新增修订的联合检查、PR、合入后 main CI 仍未完成。

相邻 DEV031 额度显示工作已接到最新组合基线：以 `foundry-dev029-auth-repair` 为 Server/Worker 源，仅叠 DEV030 manifest 的 12 个 Web 文件；不得整树用较旧 Services 候选覆盖 Worker。DEV031 负责原生账号检查、额度新模块、profiles / device accounts 协议与 API、右侧栏的明确局部范围；本项不并发修改。`codex-auth.ts` 的只读额度查询选项须保留推理原默认行为，并验明不刷新登录或静默切换账号。其改动未经独立准出不进入联合候选，集成只接收明确 base/after manifest；继续排除 DEV028 未验源码。公共构建遵守既有锁与独立输出，实际部署另按当前发布状态交接。

DEV031 配套发布临时交接：当前无其他发布占用，将其已授权本轮 dev Server/Web/Worker 发布交给原 owner，候选为 `~/workspace/foundry-dev031-release`，清单 `/tmp/dev031-evidence/source-manifest.json`。该 owner 报告基线组合为最新 Connector repair + DEV030 精确 12 文件 + 本项 33 文件；须完成受影响检查、fresh 核线上基线后才显式发布。共享 index / Git / 联合 PR 仍归本项；活跃 execution host 不中断，daemon 与实际宿主能力分别验明，自动公网发布保持禁用。最终部署、额度能力证据与未验限制尚待其交回，本段不表示 DEV031 已准出或已纳入最终联合候选。

DEV031 共享审计文件证据更正：协调方转达，先前“main 与候选 hash 一致”的通知发于 guard 结果之前，实际 guard 已阻止该次写入。差异是 main 含 DEV028 尚未准出的 `macos-window-scope` 登记。随后 DEV031 仅将自身三个 quota 模块登记分别加入两处：main 保留 DEV028，候选排除 DEV028，两处模块审计均报告通过。最终 manifest 对 `scripts/audit-module-boundaries.mjs` 分别记录 `candidateBefore/After` 与 `workingTreeBefore/After`；联合集成须核对这两组 hash 并按精确增量处理，不从 main 整文件带入 DEV028，也不以候选整文件覆盖 main 丢失其未提交改动。此为证据更正，DEV031 最终配套发布和 runtime 回执仍待交付。

### DEV031 准出范围与最新联合基线 · 2026-10-21

DEV031 已交回公共发布职责，申请将已验范围纳入本项联合 CI / 保护分支合入。最终候选 `~/workspace/foundry-dev031-release` 继承 Connector auth-repair、DEV030 全部 12 项，再叠自身 35 路径；清单 `/tmp/dev031-evidence/source-manifest.json`。本项逐一核验 35 项候选 after hash 与当前工作树 hash，全部匹配；共享审计文件按其独立 `workingTreeAfter` 核对，保留 main 的 DEV028 行，候选仍排除该行。仅按固定清单组合，不盲拷 main 或以候选整文件覆盖共享工作树。

最新部署回执：Server PID1726268，加载 SHA-256 `732ccb0dca2e159dc0e4bb6ceafd16c4e337067bc26559ab989868935f250dea`；Web build `ca5b35a64b42ca5e` / index SHA-256 `75df261becfe3b4d84d605a911e14a0cf8fc49f9986566ab23494d3ed4ae7c6e`，本项 fresh 读取 public index 与回执一致。Worker 为 `0.5.7-dev.49.g84aed61.local.1792570873`，worker tgz SHA-256 `ba671d6f5983cc3d6db35ef68ee263141affc63a9aff3ca1a1371cdb674d612d`；完整包与 pointer hash 见该 evidence 目录 `deployment.json`。自动公网发布保持禁用。

按 owner 的 runtime 回执，Linux daemon1727248、Mac daemon49291 已加载新检查模块，活跃 execution host Linux1566749 / Mac42189 与 runtimeStamp 保留，不能把 daemon 更新写成全部宿主更新。Mac 当时可用空间9.67GiB，仅清理可再生 npm cache 后做61MiB有界更新，未删除用户资料、数据库或回滚产物；后续大写入仍需 fresh 磁盘门核对。

能力验收明确区分：真实 Codex0.163 原生无 prompt 读取获得7天额度窗口；Claude2.1.295 / SDK0.3.201 的实验接口在已测环境未给出窗口，显示 unavailable / native_read_failed，不声称已验证真实百分比。Claude 接口可能返回种子或缓存值且无原始采样时间，有窗口也须标记可能缓存，不能称在线验证。owner-only、所选 profile / generation 校验、身份变更清空、60秒缓存与并发去重等定向证据见 `DEV-031-subscription-usage.md`。

初轮失败项已由 owner 修复复验；最终候选 Worker / Web / HTTP 定向检查、构建、contract / module 和46步浏览器矩阵已报告通过（axe0）。本项此次只独立核对清单与 public index，不把这些证据描述成自己重复全部实测，亦不替代联合完整 CI。最终集成保留各 owner README 状态并机械格式化；联合最新 head 与合入后 main CI 终态、merge SHA 完成后须一次回传 DEV031 owner 补交付记录。

DEV031 后续纯 Web 紧凑化：用户验收要求保留完整额度信息，将 runtime / plan / account-quota 放到 Usage 标题右侧小字，refresh 靠右，reset / checked 紧凑换行。原 owner 继续负责其 usage 组件、共享窗口组件的公开 compact / footer 接口及 fixture；本项临时交回这一次纯 Web 发布。08:48:46Z fresh public index 仍为上述 `75df261b…`，以已封存 DEV031 候选叠精确增量，不覆盖旧候选，Server / Worker 不动，不重复真实额度探测。默认公共组件、窄屏长文本、键盘与未知/缓存状态须保留，最终 delta 和实际部署回执尚待交付；联合 Git / CI 责任不变。

DEV032 设备移除语义审计：用户报告已从 Devices 移除的设备仍出现在 Assistant Settings / Where it works，协调方指定独立 owner 处理生命周期及查询契约。已交接 PA home / role snapshot / Memory / routing 的源码入口和完整固定 manifest；本项当前不并发编辑这些源码。新 owner 将以精确设备 ID 与 tombstone 核实现场，集中处理候选与执行资格、失效绑定投影，保留历史证据，不按 label 删除、不静默迁移 Memory 或切账号。当前 DEV031 compact 纯 Web 增量另待固定回执；DEV032 只有明确清单与验证通过后才纳入联合候选，禁止盲同步主树、覆盖 PA 未提交实现或带入 DEV028 未验资源改动。联合 Git / CI 责任不变。

### DEV031 紧凑版交回及 DEV027 rev9 边界 · 2026-10-21

DEV031 紧凑版已交回发布职责。精确 6 路径 overlay 为 `/tmp/dev031-compact-evidence/source-manifest.json`，固定源 `~/workspace/foundry-dev031-compact`；本项核对 main / candidate 的 owned after hash 全部一致。fresh public index 为 `69d0c15d7ca08a94f9b73d54a3798084947ece583ecb4f7449d7092a4af4549e`，匹配其 Web `9fd6da9e0f5d89ba` 部署回执。owner 报告 Server / Worker 未变、未重启、自动发布仍停用。固定候选 typecheck / build、47 相关 Web 文件测试与10项 UI 审计、默认账号页6项测试及浏览器矩阵通过；详情见 DEV031 报告。主树曾遇 DEV032 写入中间态的类型错误，已交其修复且收到 typecheck 通过回执，但 DEV032 完整准出仍待完成，不能混入本次 overlay。

DEV027 收到追加报告协议任务，拟仅修改 `send_message.description`、双份 Foundry skill 协调段和 rev9 / checksum。已交接上述最新组合源；本项 fresh 核对五个候选文件均精确等于原 rev8 manifest。main 的四个 skill / revision 文件相同，只有 `mcp_tools.json` 不同，JSON 逐对象对照确认差异仅为 DEV028 `operate_resource`。因此 DEV027 独占原区段的局部增量，main 保留 DEV028、候选排除，分别记录 before / after；不整文件覆盖或从 main 全量构建。rev9 尚未验收，需交精确 patch / manifest 与验证证据后才纳入联合候选；联合 Git / CI 仍由本项负责。

### DEV027 rev9 仅 Server 发布 · 2026-10-21 17:20

原 owner 更正了此前过早的 PASS 通知：builtinskills 和格式检查当时仍在排队。本项先核基线构造隔离源，实际看到 builtinskills 整包0.037s与格式检查通过后才编译。五项 patch 的 candidate before / after 均匹配；整个 Server 源与031compact比较仅 MCP描述、双运行时revision、checksum回归、Server内置skill四个文件变化，另保留同字节Worker skill副本，不构建Worker。隔离候选 `~/workspace/foundry-dev027-rev9-release` 只包含Server与对应skill，不能当完整产品候选覆盖Web/Worker。全文件源清单 `/tmp/dev023-evidence/rev9/source-manifest.json`。

共享锁内 Server 编译通过；既有四项 HTTPAPI 回归实际全过：`TestFoundrySkillShowsWhatAgentsGet`、`TestSendMessageNamesTheSendingSession`、`TestMCPWaitIsCappedBelowTheClientLimit`、`TestMCPChildDefaultsAndWaitResult`，总4.298s。没有 Git 历史写入。等待期间曾误将锁持有者描述为另一检查，核进程工作目录后确认是本次Go编译并及时更正；未绕锁并行重建。

仅 Server 原子替换并正常重启后，实际 PID1769807，loaded SHA-256 `786f15603b775295fe2f6ef641727e3f3d658d42e0148d79fa10c332cab6c7e3`，health startedAt `2026-10-21T09:19:56Z`。Web index `69d0c15d7ca08a94f9b73d54a3798084947ece583ecb4f7449d7092a4af4549e` 与 Worker release pointer `9215ebfc83c704f4b34aae053adf7610276d499ddfff9caa669877a9cd63cbb9` 前后保持，没有重启执行宿主。回滚二进制保留，前后哈希与健康回执见同目录 `deployment.json`；构建前16GiB、后15GiB可用/85%，未清理用户数据。

已把 loaded 回执交给 DEV027 做独立 live / new-turn 验证，结果尚待其交付；同时通知 DEV032 后发 Server 必须继承rev9，不能回退到031旧Server。当前公共构建与发布已释放，DEV032与DEV033仍须按各自最终精确增量准出；联合完整检查、Git / PR / CI / 合入后main验证仍未完成。

rev9 独立验证边界补记：DEV027 已报告 live 工具描述、双 runtime 包 hash 与 loaded binary 一致，但原只读 probe `sess_1792560833744595155` 的续接输入 `01a15dc4-e9fb-7146-b4a8-2041e3e247b0` 仍尝试旧 rev8 受管路径，在该执行中返回文件不存在，模型明确拒绝凭旧记忆作答，此项不通过。本项 read_context summary 独立确认失败；随后仅 stat 旧路径，host 文件系统中实际仍存在，故不能写成被 GC 删除。续接 catalog 与本轮 verification sandbox 可见根不一致是待核假设，尚未定位准备层原因；不扩大沙箱权限、不伪装该用例已过。DEV027 改用 fresh 只读 probe 验证 rev9，新会话结果不能覆盖既有续接传播缺口。最终联合验证仍需单独评估此准备层问题，或明确保留未测/未修限制。

DEV032 / DEV033 组合发布顺序：两 owner 已协调不交错覆盖 Web。DEV032 完成末轮 PA 候选排除等定向测试并封最终清单后，仅发布继承 rev9 的 Server，给健康和 loaded hash；须保持与短暂仍在线的031compact Web兼容。DEV033 待自身当前编译完成，精确叠 `/tmp/dev032-evidence/web-source-manifest.json` 的12项无交叉 Web 增量，再做最终构建与设备/PA smoke；收到032 Server健康回执后，由其一次组合Web发布。本项已明确交接这两个短发布职责，不启动竞争部署，Worker保持不动。最终Server与组合Web清单、版本和验收回执均待交付，暂不将未封存的末轮改动计为联合准出。

DEV027 rev9 最终证据已交回并冻结五文件。持久交付入口 `.foundry/attachments/20261021/dev027-reporting/delivery.json` 包含精确 patch / 四组 before-after hash、live描述、两 runtime 包hash、fresh与resume分别记录的probe结果；本项再次核五路径的隔离候选与工作树 after hash均匹配。fresh只读 `sess_1792574784262192281` 实际读取rev9文件hash `177209f2b4e7b0e53fac2279b1b4da8592fb2f960b4b7ff7414a7a1b85662144`，12情境通过，行为仅读取与最终答复。旧probe续接失败仍保留为独立缺口，不被fresh结果覆盖，也没有量化A/B节省结论。

联合源码必须继承rev9（或后续明确已验更高版本），不可因旧PA / 029快照回退rev8。owner的源码、报告、契约与定向回归通过，但共享README机械排版仍使其check-changed总体失败；本项最终统一格式化，不能将该总体检查写成已通过。DEV027既有接续仅作只读复核，不再独立提交或重复发布。

### DEV032 Server 回执与组合 Web 观察 · 2026-10-21 18:07

DEV032 已只发布 Server，PID1806348，health startedAt `2026-10-21T10:07:02Z`，loaded SHA-256 `fb96a556f670c5696469b18ec029275c90f8603a8940d0ff1b19a180b0d337b8`；本项直接读取 `/proc/1806348/exe` 哈希与其 `deployment-server.json` 一致。rev9五项已继承，Worker pointer未变，原两个保护服务仍 running/enabled，自动发布保持禁用。正常启动修复仅撤销两份 PA 设置中指向已移除设备的旧授权，其余JSON字段由 owner 核对保持；备份保留，无手工SQL改状态。

全HTTP首错为新增候选逻辑将已配对但未上报inventory的有效设备误判不存在，已改为历史身份加tombstone判定，并在修复后补验默认推荐、初始化、设置保存及home迁移四条调用面。最终分批范围证据 `/tmp/dev032-evidence/httpapi-coverage-final.json` 为525个顶层用例：513通过、6环境跳过、6涉及Git历史的夹具待联合检查，未覆盖与未解决失败均为0；这不是525项全部通过，也不是单次完整包全绿。末轮边界check-changed由 owner 报告通过。

其Server发布回执时Web尚为031compact；本项随后fresh读取public index已是组合候选 `786f6a72da0caac5f8644f86f9cdd1f8104c56213609656471f4756d078bd649`，表明033显式发布已推进。仍等待033最终版本/产物与浏览器回执及032最终线上验收、精确delta交回，不仅凭index变化宣称整项准出；不得回退旧Web或旧Server。

### DEV032 封存、DEV031 对齐修复与 DEV029 后续热修边界

DEV032 最终交付为 `/tmp/dev032-evidence/handoff-manifest.json`（SHA-256 `e77d5d4da5f886f38f44ba9d6ed48fd5e61a330e4a4e47601c2ce18a898a843d`）、同目录 `verified-delta.patch` 和 `handoff/`，只含43路径精确增量，并非整树候选。本项核43项封存 after hash全部一致。编译候选 `foundry-dev032-release` 保持不变；最终报告与README032单行单独交接，不能整表覆盖。实际 tombstone 与同名有效设备已由 owner 精确核对；正常移除/SSE/刷新/历史/401/410/Memory只读等验收和清理已完成，保护服务保持运行。最终HTTP覆盖仍是513通过、6环境跳过、6Git夹具待验，不改写为全绿。

DEV031 标题对齐已发布，Web `751e32929d69edee` / index `29fff88b59503ebb5855a13dca128a9f8de6706e551015f1a35b0d1fc7cee7c8`，本项fresh index核对一致；Server032与Worker未变。精确4路径 `/tmp/dev031-align-evidence/source-manifest.json`、候选 `foundry-dev031-align` 的 after hash本项全部核对一致，仅可发布Web，继承033 own20项及032 Web13项。生产CSS中通用h3 margin-bottom13px覆盖本地margin0是实测根因；局部title class修复并用仅生产CSS复验5情境46命令，中心对齐、原紧凑高度及相邻Files样式保持，定向检查通过。最终联合清单应继承该overlay，不能回退031compact旧标题。

DEV029 正处理用户追加的授权超时热修，拟快速operation回执加后台有界阶段、同operation恢复，尚未准出。本项将下一次配套发布临时交其原owner，并明确最新组合须核032 Server、033 Web精确增量与031align overlay；`foundry-dev032-release` 的旧整树不能假定包含033/align，更不能从main盲抓。其最终协议/Server/Worker/Web delta、检查及loaded回执待交付，Git/index与联合CI仍由本项负责。当前已验快照保持，未验热修不提前并入。

### DEV029 异步授权最终交回 · 2026-10-21

DEV029 已完成配套热修发布并交回公共构建/发布职责。最新完整组合候选 `~/workspace/foundry-dev029-async`，精确14项 delta `/tmp/dev029-evidence/linux-dev-timeout/source-manifest.json`；继承032 Server、033 Web、031align、rev9，未列源由其2193项基线快照核验，DEV028排除。本项逐项核14个候选after hash全部一致，后续联合构造须叠在032之后，不能用032冻结的 `connectors.go` 覆盖异步授权修复。报告有构建后部署回执补记；README029独立行按其交付文件处理。

本项fresh读取实际加载二进制与公网产物，确认Server PID1840661 / loaded SHA-256 `3b6403643063afff677888c6b2c568aebfa09add25ca312bd12807363b2f142a`，Web index `6e080e94b02e93d9f162dcdd9803967a5db1d8e51ad5f136dbf6754c0b48cb8d`（owner回执build `9a3d8d1e2d827097`），Worker release pointer `264c61395b300b0ad4445b9e8027e17d547d6ac6f5a8e0dd8adae59202523720`，均与交付一致。Server health startedAt `2026-10-21T10:42:57Z`；Worker版本 `.1792579126` / worker tgz SHA `7d56e95ad6044c264ccefd8e7aed62c40eaf6ea427c0c972721f97f9bf0d1a36`。owner核273个dist仅 `connectors/device-held.js` 改变；linux-dev daemon与自然升级host已实际加载并上报能力，Mac本轮未动，未强停活跃host。

owner的check-changed、Go race定向、候选Worker/skill19、Web8、contract/module/10项UI审计与受控浏览器慢准备→PNG→断线同operation恢复→核验完成已通过。顶层pnpm audit包装器因依赖链接试图reconcile而中止，改用相同node审计脚本通过；不能将包装器本身写成通过。真实第三方grant仍待本人点击/扫码，当前只读base ready、Meego unknown/bootstrap_available，不冒称真实授权已完成。完整证据在该目录及 `.foundry/attachments/20261021/dev029-linux-dev-timeout/`。

当前公开最新组合以上述版本为准，不得被旧候选覆盖；自动publisher仍禁用。既有单一联合接续继续完整检查、剩余Git夹具、最新head CI、保护合入及合入后main CI；DEV029的既有接续仅做范围只读核对，不重复PR或发布。整体DEV023源码交付仍未关闭。

DEV033 用户追加布局合同：Workspace回顶部、展开与折叠均保留实际作用域分隔线、收紧选择器并区分折叠图标。原owner继续只改侧栏范围，本项交其本次纯Web发布职责，基线为最新 `foundry-dev029-async` 与该异步授权manifest；不得回退031align、032或既有授权修复。需相关检查和生产CSS浏览器验证通过、fresh版本门与公共Web锁后显式发布，Server/Worker不动。最后稳定的精确delta与部署回执待交付，尚未纳入联合候选；不新增计划或独立PR。

DEV034 service / tunnel 调研已交接最新排除028基线及非秘密部署入口，预计独立新增模块并局部接线 routes/server/daemon/workspace-services，先核当前已验源；未准出增量不自动纳入联合候选。Nginx只确认 `dev.foundryapp.app` 既有API反代和静态发布，尚未确认独立preview域或wildcard DNS/TLS可用，不能预设已有能力。本项未创建预览域、改Nginx或扩展公开入口。

交接期间fresh public index已为 `079dcabb9d7411acc10ddf0bc3299e9acf5a5c0d45426f0f7a81581b63c837ba`；`/tmp/dev033-top-evidence/deployment.json` 对应Web `3b98a29002d2840d`，Server/Worker保持029异步版本。新Web精确overlay在同目录 `source-manifest.json`，候选 `foundry-dev033-top` 基于029-async，仅可发布Web；已告DEV034须保留。DEV033最终收尾回执仍待交付，不将fresh index观察替代其完整准出。

DEV032 用户追加设备提示 UI：原owner将顶部共享系统账号提示移至对应设备卡片popover，保持事实/来源/确认，只改Web。本项将其下一次纯Web发布排在DEV033工具组最终交回之后，先独立实现，最终在最新冻结Web上叠精确增量；Server/Worker和lifecycle不动，DEV034/028未准出仍排除。fresh磁盘11GiB/90%，继续复用依赖和严格保护活动缓存/DB。当前public index观察到 `15a60b859b2fc0f55a6e8d3c97516603c69050822991a5c6b27c108d0c0ecf7d`，不同于当时033-tools部署文件的 `30e536b5…`，已向033核最终收尾版本，未据旧回执批准覆盖；后续必须以实际owner的最终固定manifest和fresh gate交接。

### DEV033 最终交回与 DEV022 timers 后继发布 · 2026-10-21 21:48

版本差异现已定位：DEV033 交出Web窗口后，DEV022于 `2026-10-21T13:43:18Z` 发布组合Web `a3e6df1daecced03` / index `15a60b859b2fc0f55a6e8d3c97516603c69050822991a5c6b27c108d0c0ecf7d`。本项fresh public核一致，并独立核033最终12路径（11代码+报告）和022新增14路径的候选after hash全部匹配。033自己的历史8577 / `30e536…` 部署回执准确，保留其历史含义，不改写成022版本。

033最终清单 `/tmp/dev033-tools-evidence/source-manifest.json` 与 `delivery.md`，固定源 `foundry-dev033-tools`，37测试/typecheck/build/10UI审计、14生产CSS场景及线上66步由owner报告通过，端口关闭，owner已完全释放。最新完整后继候选 `~/workspace/foundry-dev022-timers`，清单 `/tmp/dev022-timers-20261021/source-manifest.json`，部署回执同目录 `deployment.json`；Server PID1840661 / `3b640364…`、Worker pointer `264c6139…` 保持。DEV022仍在最后线上验收，本项已请求其最终稳定后一次交付，不另操作共享index或创建竞争PR。

DEV032设备提示popover应接在022验收释放之后，在该最新固定组合上叠精确增量，已通知owner；不得从033旧候选覆盖timers更新。联合准出仍按最终稳定清单与证据逐层纳入，未验034/028不混入；既有单一接续安排不变。

DEV022 timers最终交付已稳定且窗口正式交给032：上述14路径固定清单另有 `delta-manifest.json` / `delta.patch`，文档通过 `documentation.patch` 与 `readme-row.json` 单行交接，不复制整树dirty。owner最终验收为48测试文件、10UI审计、修复后的类型检查与固定构建、23项定向及14生产CSS浏览器场景通过，亮暗axe各20通过/0问题；公开认证页面实载并用仅客户端GET替换的119记录fixture核验7行及分立历史计数，没有写真实任务，路由替换与预览已清理。该范围仅Web展示与请求边界，未重跑原生执行器，Server/Worker不变且原记录保留。DEV022已声明不再修改该delta、不另操作index/PR，最终联合CI与保护合入由本项完成；其完整证据和验收步骤见 `DEV-022-native-work.md`。

### 联合最终检查启动与原生续接修复 · 2026-10-21 夜间

以各 owner 固定 manifest 构造 `foundry-joint-release` 隔离 Git 候选，选入342个明确文件（含报告与按owner合成的README行），业务源逐一匹配最终已验组合；排除DEV028和未准出的DEV034。最新032-share的11项提示UI及022 timers增量均纳入，主树仍保留其他owner改动。首轮 `pnpm format` 已通过。pnpm最初试图因复用目录布局自动重装依赖，被非交互保护拒绝；本轮关闭自动重装并保留锁文件，未改共享依赖。

首轮变更检查Web609项全过；Worker分组发现三个外层沙箱用例失败，末组357通过/2跳过不能代表全包成功。保留完整日志后复现为隔离候选的依赖链接指向候选外，子进程无法加载 `smol-toml`；不是通过放宽沙箱来修复，正在用已有离线缓存修正独立依赖布局。远端加速尝试已取得compute租约、同步基线，但设备在传输及随后只读检查时70秒未回答，未运行远端验证；租约 `lease_cf1106c6dd16155aa52d` 已明确released，不把该尝试计为通过。

对rev9只读续接暴露的缺口做了真实原生最小复现：Codex0.163同一线程在config更新及显式resume developerInstructions后仍使用旧指令，而通过原生 `thread/inject_items` 添加当前可信developer指令后读取新标记成功。依据[官方App Server协议说明](https://learn.chatgpt.com/docs/app-server)与已安装0.163生成schema（2026-10-21核对），只修改现有恢复路径：恢复同一native ID后、开始user turn前刷新Foundry当前device/skill配置；刷新失败则不执行新turn，不改沙箱权限、账号或线程身份。

新增“同owner恢复先刷新目录”“刷新拒绝不开始执行”两个回归实际通过。真实候选wrapper续接 `01a15ece-6813-7d11-8dea-7207e8855f12` 后以read-only执行一次cat读到合成当前目录文件，native ID保持。首次独立探针因缺少本地Codex多调用二进制的sandbox别名未能读文件，补齐探针的既有二进制PATH别名后才通过，没有降级sandbox。证据 `/tmp/dev023-evidence/joint/instruction-resume-probe.json`、`instruction-wrapper-probe.json`。这是原生准备修复的新增证据，未将此前旧probe失败删除；新Worker包发布和实际宿主加载仍待最终步骤完成。

当前先建立可审阅草稿PR，使干净CI与本机剩余检查互相补充；未通过完整检查与最新head必需CI前不合入。Connector owner已对联合树做只读范围核验，31路径合并中30项精确hash一致，唯一routes差异为已验032生命周期围栏，Connector路由定义一致；证据 `/tmp/dev029-evidence/night-integration/connector-provenance.json`。

联合PR已建立：[PR138](https://github.com/BD777/foundry/pull/138)，初始提交 `82287fd` 精确342文件，主树index未动。首轮check-changed的Go整包658.3秒、SQLite91项、Web609项、格式/类型/所有审计通过，整体因三个沙箱依赖外链用例失败；完整日志已保留，不将末组357通过/2跳过冒称全绿。远端传输失败后已明确释放compute租约，本机离线依赖修复在共享锁队列中；DEV034精确停止其另一排队检查并让出后继短窗口，当前HTTP检查自然完成，不中断服务或父runtime。

首轮两个CI均失败于Node22的角色截止时间测试：假原生生产者没有真实进程/套接字句柄，仅等待Promise，框架在未ref的截止计时器触发前结束事件循环，随后两例被连带取消。仅给假生产者增加有界存活句柄，仍断言生产取消与关闭发生，不改预算实现或放宽断言。15项相关回归通过，修订提交 `b31024e` 已推送；最新push/PR两次CI `39619710679` / `39619719906` 正在运行，尚未合入。

### 最终联合源码准出记录 · 2026-10-21

用户于2026-10-21明确委托本项完成全部核心、验证、dev发布及正常保护分支合入；这里记录的是Agent准出，不称用户本人逐项测试。最终本机 `pnpm format` 与完整 `pnpm verify` 实际exit0：协议47通过、Web855通过、Worker900通过及12项平台/环境跳过；Go全部包通过（HTTPAPI631.348秒、SQLite250.127秒），类型/生产构建/10项UI审计/contract/module/安装体积/用例校验/vet通过。模块审计0项违规、Store83方法；Worker安装体积3MB，预算150MB。用例目录38项结构有效，但仍有人工/计划覆盖警告，不冒充全部场景自动化。

首轮check-changed的三个沙箱失败已通过独立复现定位为候选外依赖链接；候选内使用既有离线缓存硬链接563包、0下载后，三个原失败用例和同组回归通过，最终受影响7文件check-changed全PASS（Worker13测试文件）。未放宽沙箱，也未删断言。远端加速尝试没有运行验证、租约已released；不拿这次失败尝试计成绩。首轮CI的Node22假生产者事件循环问题也已修复，`b31024e`的push / pull_request两次完整CI分别 `39619710679` / `39619719906` 均success。

独立原生证据确认当前可信指令可在相同Codex native ID恢复后刷新、read-only读取新目录；旧probe失败与探针首次缺辅助程序的失败均保留。运行时新包采用一次协调宿主维护：DEV034冻结包版本 `.1792596448` 的原生helper编译SHA `919be13a8135cfba200491a6dffd0f8e0d3ed08b16384cb950aba19c6a2ac931` 已独立核验与本候选一致；额外tunnel模块在未配独立预览域时不产生访问URL、代理流或业务进程。此处只记录包核验，实际加载、两原服务恢复及旧probe复验须以PR最终回执为准，不能用“已安装”替代。

本次Git范围包含PA与已验DEV022/027rev9/029–033增量，排除DEV028和未准出的DEV034源码。另仅在旧 `docs/personal-agent.md` 加版本指引，保留历史设计，防止Server-only memory等旧描述被误读为现行契约。最终文档收尾不会改业务实现；最新head两条CI、实际merge SHA、main CI、保留其他owner dirty的同步核验及发布/维护结果统一追加到 [PR138](https://github.com/BD777/foundry/pull/138)，该处为交付终态的实时记录。

可用入口：`https://dev.foundryapp.app/assistant`。本人已有助理可直接记录、查询、派发和接续；独立Memory位置由本人在设置选择，本轮未迁移真实私人资料。合成验收使用已登记e2e身份；真实第三方grant仍需本人点击/扫码，Claude无有效登录/无额度窗口的环境明确显示不可用，飞书通道没有向真实租户发送测试消息。原两个受保护合成服务保留同work ID与数据，本项自建测试栈已停；此后维护如升级未发生也须先恢复原服务。
