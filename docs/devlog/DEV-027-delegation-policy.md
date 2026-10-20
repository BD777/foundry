# DEV-027 · Foundry 子会话与原生子代理的选择边界

状态：实现、Codex 自验及日常实际加载均通过，已与 DEV-024 共同上线；已验证范围按委托准出，源码与 CI 回执见本轮 release PR；Claude 行为验证受原生登录限制。目标是减少等价委派入口的歧义，保留两种机制及其真实权限；本项不实现新的路由器或多 Agent 平台。

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

固定源码以 `3be3dfd` 为基线，仅叠加 DEV024 的 go.mod、go.sum、取消读回归测试，以及 AGENTS 磁盘规则和 024/027 收尾记录。独立 worktree `/tmp/foundry-dev027-closure` 使用离线共享存储安装依赖，不复制数据库；所有构建输出均在隔离目录。DEV028 未验 Mac 改动和 DEV023 新实施代码均排除。主树 PA prompt、MCP 新对象、Server 路由/迁移与新模块已交回 DEV023；DEV028 的 operate_resource 和 Mac scope 继续由其 owner 独占。

本轮 7 文件 `check-changed` 全部通过（32 秒），包括 SQLite 取消读回归；重新构建的四个关键 Worker JS 文件与实际加载的固定包逐字节一致。完整 `pnpm verify` 对同一隔离快照运行，其最终结果和远端 CI/合入回执记录在本轮 release PR。证据目录为 `/tmp/dev027-evidence/`，包括 `live-closure.json`、`closure-live-skill.json`、`closure-processes.json`、`closure-loaded-files.json`、`closure-check-changed.log`、`closure-verify.log` 和最终 `closure-delivery.json`。前文“待部署/待升级”仅描述当时状态，以本节实际加载证据为准。
