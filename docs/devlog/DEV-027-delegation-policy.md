# DEV-027 · Foundry 子会话与原生子代理的选择边界

状态：默认报告协议 revision 9 已上线并随 PR #138 合入；fresh 与原 native thread 续接均已验证，最终 main CI 通过。旧失败记录保留；Claude 实际模型行为未测。

## 授权与范围

2026-10-20，[统筹会话](https://dev.foundryapp.app/chats/sess_1792388089518795992)转达用户批准：“FunFair MCP的sub session与原生的sub agent的区分，就按你建议的来做。你可以开一个session去做这个事情。”上下文已说明 FunFair 指 Foundry。实施 owner 为 [DEV-027](https://dev.foundryapp.app/chats/sess_1792509632577894053)。用户既有 Agent 自验准出授权仅用于实际验证范围，不代表人工验收。

起点为 main `a31ae8037e35e3f75c71c3322a881fdbfd966b7b`。先核对并发会话；保留 DEV-023 研究报告、README 其他行和 DEV-026 的已有修改。研究依据为 [DEV-023 §14.10](DEV-023-personal-agent.md#1410-delegation-选择边界与评估设计2026-10-20-补充)，并核对 §14 的运行配置、角色和生命周期。本项只改委派选择面，未扩展 Personal Agent 产品功能或改 UI。

## 实现

| 入口                                   | 原问题                                                        | 本次变化                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| MCP `create_session`                   | 只介绍创建任务及运行成本，没有与原生分工的边界                | 描述及摘要前置小任务自己做、临时本域优先允许的原生、跨域或独立追踪用 Foundry；用户明确选择优先                                    |
| MCP `send_message` / `handoff_session` | 复用与重新开会话的选择容易被忽略                              | 已有 owner 用 send；历史误导才 handoff；不按阶段不断新建                                                                          |
| 两份内置 Foundry Skill                 | “part of your task is better done in other sessions” 触发宽泛 | 收窄触发，补三分规则、原生能力差异、隔离约束、文件归属、精简结果与避免重复嵌套                                                    |
| Claude / Codex 原生注入                | 没有共用的业务选择规则                                        | `delegation-instructions.ts` 同一文本进入 Claude appended system prompt 和 Codex developer instructions；不是权限授予或路由执行器 |
| Personal Agent Step 4                  | “Everything else goes to a helper” 过宽                       | 自己做/允许的本域原生/独立或跨域 Foundry，仍保留目标项目文件操作的角色边界；prompt 版本 `2026-10-20.1`                            |
| 持续工作上下文与 Skill                 | “Native subagents are read-only” 易被理解为不能写文件         | 明确 Foundry 的原生子代理记录是观察记录，不代表原生子代理文件权限                                                                 |

保留每个 Foundry session 的设备槽位、模型使用、用户聊天入口成本；同 Workspace 非 Issue 会话共用目录，未宣称自动 worktree 隔离。没有宣称 native 无独立上下文、不能恢复或一定更省。只换模型先看原生配置支持；只有远端确定性命令时优先已有 compute 租约。

工具总数、输入 schema、annotations、limits 均保持原样。CLI 仍由原命令表调用相同 MCP 端点，没有另设委派入口。两份 Skill 产品源码同步，未改当前会话的只读 managed 安装目录。

草稿/excludedNames 对 Codex 的 `features.multi_agent=false`、对 Claude 的 `disallowedTools=[Agent,Task]` 保持不变；角色工具控制保持不变。锁定 Skill trial 子会话仍由既有 `prepareSessionSkillSelection` 继承锁定输入，拒绝跨 Workspace/Issue、改变选择或引入历史。受限情况下小任务自己完成，不能因追求并行绕到 Foundry。

## 验证记录

- 首批 Worker 定向检查 36/36：原生注入一致性、无 catalog/普通/draft/excludedNames/空排除锁五类配置、Skill 两目录逐字节同步、CLI/schema 合约、角色工具与受管来源隔离。
- Personal Agent prompt golden 与版本 hash 检查通过。
- HTTPAPI MCP/FoundrySkill/Assistant/PersonalAgent 定向检查通过，83.502 秒。
- 前后工具面比较：37 个工具，除 description/summary 外对象全部相等。原始差异及回执：`/tmp/dev027-evidence/tool-surface.json`。

原生行为冒烟与隔离实际分发证据见下文；日常部署待与 DEV-024 协调。没有 A/B 对照数据，不声称 token 节省、性能改善或某 runtime 更优。完整对照评估仍是 DEV-023 的后续方案。

### 原生运行时冒烟

复用已登记的 `isolation-dev006-007` / `scratch-admin` 测试栈，新建合成 Workspace `ws_ae30e2a7-e19e-4cda-8554-082dfad1a784`（`/tmp/dev027-smoke`）。独立 DB、端口 58105、`FOUNDRY_INTEGRATIONS=off`；没有业务数据操作、用户消息外发或持久计划。模型推理均通过已有原生 CLI/SDK。

固定 Worker 包为 `0.5.7-dev.43.ga31ae80.local.1792510265`。隔离 execution host 实际入口为 `/tmp/dev027-evidence/runtime/node_modules/@bd777/foundry-worker/dist/execution-host/main.js`，不是仅观察安装版本。源 Skill、服务端分发后 materialized Skill SHA-256 同为 `96c5ff059fb7bb5dd90ad78389be2aa864f72e5ef2ce4d89a37bf983b9511242`；真实 Codex 事件记录了读取该受管副本。MCP `tools/list` 返回了新 create/send/handoff 描述。

| 场景                                | 可观察结果                                                                                                                                                                                       | 证据/边界                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11 个情境的选择问答                 | 小任务 self；临时本域 native；草稿受限小任务 self；独立长期/跨域 Foundry；已有 owner 复用；显式 native/Foundry 各遵从；远端命令 compute；只换受支持模型 native；不能保持隔离的必要 child blocked | `sess_1792510432195165353` 首轮。属于策略理解探针，未实际操作跨设备/Provider或等待一周，不是自由选择 A/B                                                   |
| 真实小文件计数                      | 读 `tiny.txt`，2 个非空行，无额外委派                                                                                                                                                            | 同一首轮；该轮明确要求自己完成，不把结果归因为优化效果                                                                                                     |
| 显式原生临时分工                    | 一个 native child `/root/tiny_first_line` 返回 `alpha`；无 Foundry child                                                                                                                         | `subAgentActivity` 原生事件确认子模型 `gpt-6-astra`、effort `high`，thread `01a159f3-e7bc-7ad2-87a5-6f4b4497302d`                                          |
| 显式独立 Foundry 会话               | 一个 child `sess_1792510798314012095` 返回 `beta`                                                                                                                                                | 父子均 Codex Local / `gpt-6-astra/high`；没有再嵌套                                                                                                        |
| 继续同一事项                        | 复用上述 child，回答包含 `alpha`                                                                                                                                                                 | 后续输入仍为同一 conversation；测试 Workspace 最终只有这一个 Foundry child，没有按阶段再创建                                                               |
| fresh history + exact draft include | `sess_1792510897458713236` 自行计数，2 行，未派生 child                                                                                                                                          | draft 由 refresh 返回的 id/digest 锁定。报告 `list_agents` 可调用，但生成 native child 被 Skill 策略禁止且未尝试；不将只读观察工具的存在误报为可创建子代理 |
| Claude 原生请求                     | 未通过：`OAuth session expired and could not be refreshed`                                                                                                                                       | `sess_1792510508244496149`，请求 `opus/high`。未取得实际模型回报，未切换账号或扩大授权；Claude 行为结果保留未验证                                          |

两项环境失败保留：Claude 模型目录先提示登录待续期，真实请求随后确认刷新失败；首次 Foundry child 创建因测试 Worker 继承当前会话的隔离 `CODEX_HOME` 而被 `missing_auth` 拒绝。仅停止无活动任务的隔离 Worker/host，清除启动环境里来自当前会话的 Provider/Codex 覆盖，恢复该设备原生登录来源后重试成功。没有写入伪造健康状态或复制 token 绕过检查。早先已成功的 native 事件与后续成功的 Foundry 事件分别保留。

运行记录在 `/tmp/dev027-evidence/`：`codex-probe-result.json`、`native-events.json`、`sessions-final.json`、`restricted-probe-final.json`、`claude-probe-final.json`、`served-tool-descriptions.json`、`loaded-skill.json`、`loaded-runtime.json`。这些是测试环境本机证据，未对外公开完整原生转录或私有推理。原生子代理在宿主重启后的 transcript 查询不可用，模型/effort/启动结果以此前保留的事件为准。

### 完整范围检查与发布产物

`check-changed.sh --files ...` 对本项 14 个文件执行：格式、gofmt、Protocol build/tests、Web 类型检查、Worker build 与 11 个相关测试文件、PA prompt Go 测试、contract audit 全部通过。首次 module audit 因新 `delegation-instructions` 未登记模块归属失败；补入既有 harness 模块后单独复验通过，0 tracked violations。未改审计 baseline 或放宽规则。日志：`check-changed.log`、`module-audit-final.log`。

| 固定产物         | SHA-256                                                            |
| ---------------- | ------------------------------------------------------------------ |
| Server binary    | `a1f93b0aeb5b65f739e679c7815091beec1d793674363223d8e0c95812860f83` |
| Protocol tarball | `fbee582c948ba4b06843fc3be1b48636b608a15d1b7b52d1c7b0deb1e57c64ff` |
| Worker tarball   | `9ac2007fdc57637631514df07180ba6c45fbcadee2ee8468c67ee0cee1b0c9ef` |

产物固定后才向 DEV-028 释放其他 Worker/Protocol 文件及 `operate_resource` 单一 schema 对象的写权。DEV-027 后续发布只使用固定产物，不混入其未验证改动。日常 Server/daemon 部署暂缓：DEV-024 正在保留并取证现有读连接 `not found` 现场，需与其协调一次安全部署。当前不能把隔离宿主生效写成所有日常活跃会话已切换。

2026-10-20 统筹会话确认可在已测 Codex 范围继续准出，保留 Claude 凭据限制。隔离测试结束后已确认 host snapshot 的 busy=false、claims/background/ownTurns 均为空，再停止本轮测试 Worker/host 和端口 58105 Server；三个测试 Workspace 的 service 列表均为空，原 DB 和材料保留。回执为 `scratch-host-final.json`、`scratch-cleanup.json`。没有遗留本轮 schedule 或模型作业。

### 源码与包发布

- 独立源码提交 `a2fba5038e47772bfaf9f2a6b1b4579be25cecce`（15 个文件）。共享 schema 仅 create/send/handoff，模块审计仅新增 delegation 文件归属；提交后 index 为空，其他专项 dirty 保留。README 自己一行单独留在工作树，未整表暂存。
- 固定 Worker release 已原子发布为 `0.5.7-dev.43.ga31ae80.local.1792510265`。公开 `/api/worker/release` 回报同版；Protocol/Worker 的版本化和 latest 四个下载均与上表 SHA-256 相同。回执：`published-release.json`、`public-package-checks.json`。
- 此步只发布包文件，没有重启日常 Server/daemon 或强切活跃 execution host。Server 将由 DEV-024 从上述固定 commit 加其 SQLite 最小修复构建共同部署，明确排除 DEV-028 的未验证修改；日常运行时实际加载仍待独立核验。

### 上线前版本契约补项

最后核对发现内置 Skill 定义仍为 revision 5；源代码明确要求目录内容变化时递增。虽然早期隔离测试已因 checksum 改变取得新内容，不能让同一版本号对应不同包。补提交 `3be3dfd9a05cba1a52c17f4b0b9f666e9c8152ca` 将 Claude/Codex 同升 revision 6，并以完整 Skill ZIP checksum `4d8b1ae40dd7c7531e860e513a1d53cf535ffb0052815e10d5772f992366858f` 增加版本身份 guard。针对两文件的 check-changed、builtinskills 整包测试通过，日志 `revision-check.log`。

该补项只改变 Server 的版本身份及测试，Skill 内容和已发布 Worker 包不变。DEV-024 已在实际投产前收到新 SHA，改从新基线重建共同 Server；上表早期隔离 Server binary 不会作为最终生产产物。生产版本与最终二进制 hash 以共同部署回执为准。

## 2026-10-21 日常实际生效与源码交付收尾

原 owner 的原生 thread `01a159e6-68bf-7683-b724-adbe23083bcc` 恢复时报 `no rollout found`，统筹已确认其会话 failed；本轮由[唯一继任](https://dev.foundryapp.app/chats/sess_1792515861602906533)接续收尾，没有重置 thread、删除历史或重复派发原开发。2026-10-21 统筹转达用户授权：已验证范围自行准出、归档并通过保护分支流程交付。授权不包括将 Claude 凭据失败写成验证成功。

01:08 继任执行 fresh 只读核验：

- 日常 Server PID `1136698` 的实际 `/proc/.../exe` SHA-256 为 `a048c90a16473da4815bf9b944bb4706074b3849e77005624dbfe9211898c4b3`；`go version -m` 为 SQLite `1.40.1`，health startedAt `2026-10-20T16:04:11Z`。与 DEV024 的固定部署回执一致。
- 日常 MCP `tools/list` 的 create/send/handoff 描述逐字匹配 `3be3dfd` 固定快照；内置 Skill API 同时返回 Claude/Codex revision `6`，manifest SHA-256 `96c5ff059fb7bb5dd90ad78389be2aa864f72e5ef2ce4d89a37bf983b9511242`。本继任会话实际 materialized Skill 也为相同内容。
- sg-chaos daemon PID `1146265`、execution host PID `1147869` 均为 `1792510265`；实际 host entry、systemd MainPID 相符，两服务 `NRestarts=0`。因此本设备已完成实际加载，不再是“仅安装”。byte-dev 本轮没有升级到 DEV027，不扩大已测设备范围。
- 原合成 Server/Worker PID `1149017/1150328` 仍存在，58105 health 正常；合成 Worker 保留 `1792399633` 测试基线。DEV024 已记录原 work ID 的两次 resume verified；本轮不停止服务、不清 DB，也不把测试基线描述成日常新版。

固定源码以 `3be3dfd` 为基线，仅叠加 DEV024 的 go.mod、go.sum、取消读回归测试，以及 AGENTS 磁盘规则和 024/027 收尾记录；另补 CI 的显式 Server 编译准备阶段（见下段）。独立 worktree `/tmp/foundry-dev027-closure` 使用离线共享存储安装依赖，不复制数据库；所有构建输出均在隔离目录。DEV028 未验 Mac 改动和 DEV023 新实施代码均排除。主树 PA prompt、MCP 新对象、Server 路由/迁移与新模块已交回 DEV023；DEV028 的 operate_resource 和 Mac scope 继续由其 owner 独占。

本轮 7 文件 `check-changed` 全部通过（32 秒），包括 SQLite 取消读回归；重新构建的四个关键 Worker JS 文件与实际加载的固定包逐字节一致。完整 `pnpm verify` 对同一隔离快照运行，其最终结果和远端 CI/合入回执记录在[PR #137](https://github.com/BD777/foundry/pull/137)。证据目录为 `/tmp/dev027-evidence/`，包括 `live-closure.json`、`closure-live-skill.json`、`closure-processes.json`、`closure-loaded-files.json`、`closure-check-changed.log`、`closure-verify.log` 和最终 `closure-delivery.json`。前文“待部署/待升级”仅描述当时状态，以本节实际加载证据为准。

CI 首次两条运行均在既有 `evidence-api-e2e` 的 90 秒总时限失败（实际 90.148 / 106.702 秒），同一用例本地 43.599 秒通过。该用例在时限内同步执行 `go build`；SQLite 依赖更新使 Go 缓存键改变。为单独检查冷编译，Verify workflow 新增显式 Server 编译准备步骤，随后仍执行完整 `pnpm verify`，不调整原用例超时、跳过沙箱或放宽业务断言。首次失败及最终复跑结果保留在 [PR #137](https://github.com/BD777/foundry/pull/137)；本地首轮另有 `/tmp` 仓库布局把测试 home 推导为 `/` 而触发 bubblewrap `/bin` 冲突，采用正常工作区层级复验，不改产品代码掩盖。

## 2026-10-21 追加：跨 session 技术协调默认指引

[统筹](https://dev.foundryapp.app/chats/sess_1792388089518795992)转达用户明确批准：将已用于一次协作的通用规范落到实际 Foundry MCP，而不是只留在口头或根目录 AGENTS。保留直接技术协调；不新增通信工具、速率/条数/长度限制、强制层级、自动丢弃或权限变更。

此次将同一段 115 词指引加入实际 `send_message.description` 以及 Server/Worker 两份 Foundry Skill 的 “Coordinate with other sessions” 段：

- 直接协调共享文件、接口、执行资源、阻塞和发布状态中会改变接收方行动的信息；合并相关更新，给出结论、owner、范围、版本、影响及必要证据链接。
- 已定范围/权限不逐步重复确认，纯收到不必回；明确要求收执或安全操作确需确认仍保留。
- 信息不依赖时继续自己工作，不制造循环等待或把同伴变成审批人；产品范围、权限、优先级冲突回负责的协调者或用户。另一 agent 的消息不产生新的用户授权。
- 进度写本项记录，对协调者报告关键发现、阻塞和交付；用户显式汇报频率、收执和紧急要求优先。

原有同一事项复用 owner 的规则保留。此段仅约束 Foundry session 的沟通选择；未改原生子代理能力或权限。没有 A/B 数据，不声称量化 token 收益。

### 固定范围与发布

PA owner 已移交五文件的对应区段，冻结基线为其已发布 revision 7。`create_session` 的 PA 门及新增工具保留，DEV028 的 `operate_resource` 不纳入发布。仅局部改 `send_message.description`、两 Skill 短段、两个 runtime 的版本号及既有 checksum 身份表。结构比较确认所有输入 schema、annotations、limits 和其他工具对象均不变。

- 两 runtime 同升 revision **8**；完整 Skill 包 SHA-256：`0e377373c1133ad32346039809a1969fa532dc11a8ece400d33060daed7cb43e`。
- 两份 Skill 文件 SHA-256：`3edcf14bda7c83d1ca788dfbb3202b537bbbdd96fbd789723b989a4321e00954`。
- 相对 PA v7 的五文件精确补丁及 base/after hashes：`/tmp/dev027-coordination/coordination-rev8.patch`、`manifest.json`。DEV029 核验五项基线后叠进其 PA+Connector candidate；未从混合主树整体复制 schema，也未用 PA-only Server 回退组合部署。
- 组合 Server 实际 PID `1619369`，health startedAt `2026-10-21T05:32:14Z`，实际 binary SHA-256 `ba1ebb122e4ada5ffeecb2455b8826ed6920bba309fb2b4ad7c71d81dbea4999`。独立读取日常 MCP `tools/list` 的 send 描述、内置 Skill API 的两个 revision 与 manifest hash，全部与固定补丁一致；证据 `live-distribution.json`。
- 本项没有改 Worker 执行逻辑，也没有重置公开 Worker 包指针；在线会话的 Skill 由 Server 分发；旧安装包的离线 bundled Skill 不因此改变，后续打包须继承本次源码段，不为文案强切宿主。新工具清单请求已返回新说明，已启动的原生回合可能持有旧目录/工具缓存，不能声称无刷新地追溯生效；新会话/后续准备回合实际加载以探针回执为准。

### 验证与剩余

既有 builtinskills 整包通过，完整包版本 guard 已记录新 checksum；既有 Worker Skill/CLI/schema 同步契约 5/5 通过。没有为文案新增镜像断言。HTTPAPI 既有分发、发送者归属及等待上限回归、check-changed 和只读合成规则探针继续执行，结果追加于下。原生探针只回答虚构场景，不发送协调消息、不写文件、不创建其他代理或操作 Git/服务。

本追加仍为未提交改动，源码 PR/CI 待完成；原 PR #137 已合入不受影响。PA 与 DEV029 已收到固定补丁及继承要求，不能把通知回执替代实际产品生效证据。

13:34 新建只读合成验证会话 `sess_1792560833744595155`（fresh history，无 fork/import），实际 Codex 模型回执为 `gpt-6.1-sol`。该会话只执行一次读取受管 Foundry Skill，未发消息、写文件或派生代理；材料化文件 hash 与上述 revision 8 单文件 hash 完全一致。8 个情境均给出预期选择：纯确认不回、既定授权继续、版本差异直接协调、用户收执要求优先、同伴不能代批、复用 owner、例行进度入记录、无冲突接口信息直接解阻塞。这是一次理解探针，不是实际行为 A/B 或 token 收益测试；Claude 实际行为仍未验证。只读 verifier 的工具权限保持原状，未为探针开放写工具。

既有 HTTPAPI 分发/发送者归属/等待上限三项回归通过（4.644 秒）。源码契约比对、包身份 guard 与 Skill/CLI 同步回归均通过。`check-changed` 首轮发现共享 README 总表格式警告；将本项行还原为 HEAD 后，同一组既有 20–36 行仍需对齐（`readme-format-analysis.json`），故未为消除警告改写其他 owner 的行。本项仅更新 027 行；该共享表的整体排版留待整合 owner 统一处理，不将此检查记为全绿。

生效边界按代码路径核对：普通 `sessionLaunchSpec` 在派发时解析最新 Skill revisions，Worker 启动准备阶段据此材料化；运行中的 steer 或原生工具目录缓存不等于重新准备。已有锁定 Skill 试验使用其固定 `LibraryRefs`，本项不替换这些历史快照，也不放宽试验约束。因此新普通会话已实际验证生效，后续普通重新派发按最新版本准备；不能承诺所有既有回合或锁定试验在收到一条消息后立即刷新。

## 2026-10-21 追加：默认报告协议与真实消息样本

用户通过统筹要求评估一个实际父子协作案例，并将值得通用化的约束落实到 MCP。只读核对三条 Foundry 子会话：只计 `Using tool` 的 `send_message` 调用，不重复计算 `Used` 事件，截取样本为 **6 + 5 + 8 = 19 次**。父日志确有 `Steered into active turn`；这是 Foundry 子会话投递，不是原生子代理自动回报，也未发现足以称为无限 ACK 循环的证据。本报告只保留去身份化类别，不保存业务正文、环境标识或私密产物。

| 样本类别 | 调用数 | 判断                                                                                                                                   |
| -------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 资源准备 | 6      | 包含开始、若干准备阶段、本地已解决问题及最终交付；许多阶段不改变父会话下一步行动，可合并。若确实释放父会话等待的依赖，则仍应及时报告。 |
| 页面验收 | 5      | 含父会话明确要求的后续实现汇报，不能一律判为多余。                                                                                     |
| 证据整理 | 8      | 接口契约和实际输出超过上游约定容量属于有用的即时决策信息；其余例行阶段可以归并。                                                       |

结论：投递进入执行上下文符合平台实现，但原 “key findings, blockers and delivery” 太泛，容易把每个小进展都解释为关键发现。没有对照数据，不能把19条全算浪费，也不能量化性能或 token 改善。

### 最小修改

替换原协调段，未层层追加规则。实际 `send_message.description` 与两份 Skill 使用同一段197词规则（原115词）；不新增 Worker 原生注入副本、通信工具、硬性条数/长度/速率限制、强制 parent 中转、自动 drop 或权限变化。保留直接协调、继续独立工作、既定授权不反复确认及同伴消息不能授予新用户权限。

新默认协议：

1. 发送前回答“接收方现在要因此改变什么？”默认在产物稳定后一次集中交付；中途仅报告需要决定/操作、契约变化、等待依赖释放、影响结果/安全/期限的意外或明确约定的检查点。
2. 否则开始、安装、本地修复和增量测试进展记自身记录；消息只给结论、影响/需要的动作及证据指针，继续工作时明确已稳定部分，避免将半成品当最终交付。
3. 明确消息会 steer 运行中的会话或启动空闲回合，不作心跳、纯致谢或重复最终摘要；保留重要错误纠正、显式/安全必要收执及用户沟通偏好。
4. 接收方合并关键变化，不逐条 ACK 或逐条转述，也不为“收到”唤醒已无工作的同伴。
5. 发起方可在既有自然语言 brief 指定产物、中途报告及真正阻塞条件，不增加 API 参数或强制层级。

### 最终结果回报机制核对

- 普通异步 Foundry 子会话没有通用的最终答复自动转发到父原生回合的路径。`onSessionCompleted` 持久化/广播状态，再触发具体 observers；UI 完成事件不等于父 Agent 收到完整答复。
- `wait_session` / `wait=true` 通过 `waitMCPStatuses` → `mcpSessionResult` 返回终态的 `response`，不是自动唤醒所有父会话。既有回归 `TestMCPChildDefaultsAndWaitResult` 明确验证此能力。
- PA 有单独的 tracked-task 跟进：`assistantTaskOf` 匹配跟踪记录，`noticeAssistantTask` 在 PA active 等条件下合并通知；`assistantTaskLine` 包含答复摘要和会话链接，非所有父子会话的无条件全文转发。
- 因此规则明确保留：普通异步完成须一次最终交付；若确有活动等待或已确认的自动报告路径将交付同一结果，则不另发重复消息。不得仅因存在 `parentSessionId`、UI 完成标志或原生子代理自动回报就推断 Foundry 普通子会话也自动转发。

机制依据：`apps/server/internal/httpapi/daemon_session_inbound.go`、`events_sessions.go`、`server.go`、`mcp_sessions.go`、`personal_agent_supervision.go`。没有修改这些 handler 或通知机制。

### 固定基线与验证

当前组合基线为 `foundry-dev031-compact`，继承029 auth repair、030及031两层已验 manifest，排除未准出028/032。五文件逐项匹配 rev8 after hashes 后生成 `/tmp/dev027-reporting/reporting-rev9.patch`；`manifest.json` 分别记录 candidate 与工作树 before/after。主树与 candidate 的 schema 仅既有028 `operate_resource` 不同，本项没有将它带入 candidate。

两 runtime 升 revision **9**，包 checksum `a7b7aa0c4b78df946c2c33834b7e7789443b65b89b5490b57b2852b04575ba19`；两 Skill 单文件 hash `177209f2b4e7b0e53fac2279b1b4da8592fb2f960b4b7ff7414a7a1b85662144`。版本身份表保留已发布 rev8，不复用同一版本发布不同内容。JSON整体比较确认除send描述外的所有对象/schema/limits/annotations不变，双份Skill字节一致；builtinskills全包及源码格式检查已通过。

PA 是唯一联合集成/公共发布 owner，收到精确delta后在隔离组合源上验证和只重编Server；本项不直接发布、不覆盖Web/Worker、不重启用户host，也不新开PR或timer。线上分发、去身份化规则理解探针及剩余检查结果完成后追加。既有一次性接续仅作本范围只读复核/证据交付入口，源码PR/CI继续归PA，不将通知owner当作产品生效。

### revision 9 实际发布与验收回执

PA 在基于031compact的隔离Server后继应用五文件delta；四项既有HTTPAPI回归实际通过（4.298秒）：分发内容、消息发送者归属、等待上限和等待取得最终结果。实际Server PID `1769807`，startedAt `2026-10-21T09:19:56Z`，loaded SHA-256 `786f15603b775295fe2f6ef641727e3f3d658d42e0148d79fa10c332cab6c7e3`。独立读取日常 `tools/list` 与两runtime内置Skill API，描述、revision9及manifest hash匹配；实际下载两份revision9包，均5579字节，SHA与上述包checksum一致。

Web仍为 `9fd6da9e0f5d89ba`，Worker仍 `1792570873`，其public配对指针未改变，也未重启用户execution host。发布源 `/home/windeng/workspace/foundry-dev027-rev9-release` 只含Server及相关Skill，不能当作完整Web/Worker源码候选；联合Git整合应使用完整031compact基线加本delta及各已验manifest，不能从混合main整树打包。

- **fresh理解探针通过**：`sess_1792574784262192281` 配置Astra/high，usage回报 `gpt-6-astra`，只读当前受管Skill一次；材料化hash为 `177209f2…5662144`。12个去身份化情境均符合预期，包含必要即时消息/可合并阶段/显式汇报例外/半成品稳定性/无自动转发时最终交付/已确认等待时不重复/错误纠正/同伴不能授权。没有向真实业务session发送消息，没有量化收益或A/B结论。
- **原验证会话续接未通过**：`sess_1792560833744595155` 的本次input `01a15dc4-e9fb-7146-b4a8-2041e3e247b0` 仍读取旧revision8目录，在verification执行中返回ENOENT，模型拒绝沿用旧记忆。父owner和本owner都仅stat确认旧路径在宿主仍exists/isFile，不能据此声称被GC删除。旧catalog与本轮sandbox可见根不同步是待验证假设；未绕过sandbox、手改原生history或修改权限来掩盖。PA已单独记录准备层缺口，fresh通过不覆盖该失败。
- **生效边界更正**：前节代码核对证明Server派发解析latest refs，但本次实测表明这不足以证明既有Codex续接上下文一定拿到新catalog。当前确认新普通会话生效；不将“只发一条消息/进入新turn即可使所有旧会话刷新”列为已验。运行中缓存、锁定Skill试验及旧离线Worker bundle也不追溯重写；Claude实际模型行为未测。

既有Skill/CLI/schema契约5/5、builtinskills、gofmt、contract audit与本项源码/报告格式通过；`check-changed`总体仍因共享README格式警告为FAIL，由PA联合整合时统一机械对齐，不改其他事项状态。本项只改总表027行。源码仍未提交，完整release CI及合并回执归PA唯一集成owner；本owner现有一次性计划仅作只读复核，不新增timer/重叠PR/发布。

完整回执与精确delta已持久化在 `.foundry/attachments/20261021/dev027-reporting/`，含 `delivery.json`、`manifest.json`、`reporting-rev9.patch`、`served-package-hashes.json`、`probe-receipt.json`、fresh结果和保留的续接失败结果。真实样本仅存聚合数/去身份化判断，未保存业务正文。

## 2026-10-22 最终合入与原线程续接复验

rev9随 [PR #138](https://github.com/BD777/foundry/pull/138) 合入 `c1338f7b18ae736c2ce048beeadf8dd87ada4aa1`。最新head `b72aa69` 两条Verify及合入后main [39632103251](https://github.com/BD777/foundry/actions/runs/39632103251) 通过；文档索引修正后的最终main `69f2084ab17611c395420505c679b7c0d3ebc635` 与本地同步，[39634194951](https://github.com/BD777/foundry/actions/runs/39634194951) 亦成功。此前“待提交/待CI”描述对应当时状态，以本节为准。

原续接缺口已由PA修复并实际部署：恢复同一原生thread后、执行新turn前，通过原生 `thread/inject_items` 刷新Foundry当前可信developer配置；刷新失败则不执行，不扩大sandbox或改变账号/线程身份。实际host PID `2062401` 加载 `.1792596448`。原probe `sess_1792560833744595155` 保持native `01a15cf3-c368-7860-b29a-ee27a1a19d34`，新input `01a15f37-900a-7a86-b41e-38e4b1ae51d1` 的提示未提供新路径；执行确实从当前受管 `69e135…` 目录读取Skill，返回完整SHA-256 `177209f2b4e7b0e53fac2279b1b4da8592fb2f960b4b7ff7414a7a1b85662144` 和对应协调规则。新结果关闭本例续接传播缺口，原失败及host路径存在的证据不删除，不改写为当时成功，也不扩大为所有provider已实测。

独立只读核验与原始复验答复归档于 `.foundry/attachments/20261021/dev027-reporting/final-closure.json`、`resume-probe-fixed.md`。本项已完成的一次性计划取得精确remove verified回执，未停止共享服务、未重复发布或创建PR。联合交付最终回执见 [PA合入记录](https://github.com/BD777/foundry/pull/138#issuecomment-6321097469)。
