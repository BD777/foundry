# Evidence & Verify v1

[Roadmap](../README.md#roadmap) · [Issue 工作流](issue-workflow.md#evidence-and-verify) · [完整字段表](evidence-and-verify-v1-fields.md)

Evidence & Verify v1 的业务契约与支持范围。设计背景来自已归档的 [0908 Plan](archive/workspace-ai-product-plan-2026-09-08.md) 第 7–9、11–12、20 节及六态 Issue 生命周期；两者冲突时以本文的 v1 取舍为准。

## 状态：核心链路已实现，不等于整个路线图完成

已实现共享模型与 Go 生成、精确契约确认、claim/启动双重门槛（包括 mock）、封存候选、持久材料、命令/项目自带命令/受控本地 HTTP/候选文件导出/人工上传、独立 Agent SDK 初判、逐条件结果与覆判、不可变审阅包，以及绑定审阅包的人工批准和既有逐仓集成 journal。也已接入只读 Agent 澄清（在所选 Workspace 原目录只读探索）、候选 Worktree 内独立验证（含项目命令的程序判定与 JSON Schema 下发）、显式基线对齐与复验、断线结果恢复、媒体安全预览和状态 SSE。

尚未完成的项目列在 [§9](#9-尚需收口的实施项)：通用服务/外部依赖绑定、Codex 真实图文判定、复杂媒体，以及 Linux 上的 Agent 阶段会话与集成都不能标为完成。功能准出以[对话式准出标准](foundry-conversation-release-gate.md)为准。

## 1. 对象边界与字段来源

```text
IssueContract（人确认 revision + digest）
  → CandidateSnapshot + VerificationInput（Worker 封存）
  → Evidence → Material（实际材料，不含 pass/fail）
  → Verification → Result（程序/独立 Agent 初判）
  → HumanAssessment（可选，只能覆判 Agent）
  → ReviewSnapshot（不可变审阅包）
  → AcceptanceDecision（人批准）
  → WorkspaceAcceptance journal（逐仓集成）
  → 全部仓库成功才 Accepted
```

[完整字段清单](evidence-and-verify-v1-fields.md) 是从共享 TypeScript 声明生成的全部字段表，包含所有嵌套类型和枚举，不另维护一份可能漂移的 DTO。源码权威入口：

- `packages/protocol/src/evidence.ts`：业务模型。
- `packages/protocol/src/evidence-validation.ts`：严格 wire 校验及语义规则。
- `packages/protocol/src/evidence-schema.json`：生成的跨语言结构定义。
- `apps/server/internal/store/evidence_models_generated.go`：生成的 Go 模型。
- `packages/protocol/src/evidence-rpc.ts`：内部 Worker 任务协议。
- `packages/protocol/test/evidence-fixtures.json`：Go/TypeScript 共用有效/无效样本。

| 对象                | 职责                                                    | 权威字段生产者                                              |
| ------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| IssueContract       | 目标、范围、约束、有序 Criterion、确认                  | Server 分配版本和摘要；人确认；调用方只提交 ContractContent |
| AcceptanceCriterion | 自然语言完成条件、rubric、参考 Media、证据要求、checker | 契约编辑入口，随确认版本冻结                                |
| Material            | 原始字节、MIME、摘要、保管 Worker、可用性               | Worker 读取实际字节后封存；Server 索引                      |
| CandidateSnapshot   | 仓库集合、基线、候选树、文件清单                        | Worker Git/文件观察，不信任 Agent 报告                      |
| VerificationInput   | 候选之外的环境、工具、依赖、被测目标                    | Worker；未固定的输入必须 unknown                            |
| Evidence            | 材料、采集过程、条件/要求多对多关联                     | 可信采集器；人工上传必须单独声明候选关联                    |
| Verification        | 一条条件的一次请求、固定输入、执行状态                  | Server 分配 sequence；Worker 完成；结果不覆盖               |
| VerificationResult  | pass/fail/inconclusive、发现、引用、局限                | 程序/Agent；Server 检查引用和准出门槛                       |
| HumanAssessment     | 针对准确 Agent 结果的用户判断与理由                     | 用户明确提交；不改写原 Result                               |
| ReviewSnapshot      | 选定判断、有效结论、新鲜度、blockers                    | Server；实时观察变化生成新包和新摘要                        |
| AcceptanceDecision  | 用户明确批准哪个审阅包                                  | Server 从登录会话确定 actor                                 |
| AuditEvent          | 不可由 Agent 改写的关键历史                             | Server/可信 Worker                                          |

公共约束：

- camelCase JSON；UTC RFC3339 时间；opaque ID；`schemaVersion=1` 与业务 `revision` 分开。
- `Digest` 使用 `sha256:` 前缀。确认内容、原始字节和结果不原地覆盖；可用性和运行状态为独立投影。
- 数组必须存在时用 `[]`；拒绝 `null`、未知字段、无效 selector、跨 Issue/Workspace 引用。
- 参考图是 target/example/counterexample/context，不得仅凭同一 Material 满足实际结果材料要求。
- 主体来自认证或可信执行上下文：登录账号记为 `user` actor，未启用账号时回退为单一 `local_owner`；请求正文不能指定 actor。
- 公共 Material 不含本机存储绝对路径、凭据或永久 URL；浏览器只能提交 Material ID。

## 2. 契约与生命周期

保留 `pending / in_progress / blocked / verifying / accepted / abandoned`。

新 Issue 只保存原始目标草案：不生成 inferredTask、不填三条通用条件、不声称使用过 skill。空目标或 `hi` 可以保存但不能确认，更不能 claim。Agent 通过主聊天与用户共同明确可观察条件，用户核对自然语言确认卡；系统提交准确的 `revision + contentDigest`。

澄清入口复用 Issue 的 Harness/profile/model，在用户选中 Workspace 的**原目录**里进行独立只读阶段会话，据此追问必要歧义，而非念固定问卷。沙箱把 Workspace 路径授予只读、工作目录设为该路径，写入仍只限会话私有 home（`stageSandboxExecutable` 的 `readRoots`/`workdir`；Verify 阶段还会附加候选 Worktree 所需的 Git 目录只读根）；Claude 侧只开放 Read/Grep/Glob 与项目指令文件，不提供 Bash 等写/执行类工具。对话保存在原 Issue，输出要么是下一问，要么是严格 `ContractContent`。提议形成 `origin=agent_proposal` 的新草案，相同内容不重复修订；不创建实现候选、不继承实现会话、不自行确认。参考图片以实际字节传入；复杂参考材料（PDF/音视频等）解析仍不支持。七步表单、JSON 编辑和右侧第二聊天已退出主界面；技术结构仅按需展开。

明确确认结束澄清阶段。执行交接只以准确已确认契约及确认后的执行反馈为准，澄清期“不要实施”和状态问句不作为新的执行指令。状态问答持久化但不确认、不派发。新建任务可自动开始只读澄清，访问历史草案不自动调用模型。

每次编辑追加草案，修改已有内容须有 changeReason。已确认内容、checker bundle、fixtures 或参考 Media 变化须重新确认。修订待确认时 `amendment_pending` 暂停新 claim/判定/Accept；在途工具允许收束。撤回草案继续旧契约；新版确认不自动复用旧判断。

判定模式只有：

- deterministic：固定程序和确认过的 checker。Checker 配置只有 `command`（固定检查 bundle）、`project_command`（项目自带命令）、`http`（受控本地服务）三种。缺 checker 允许实现，不允许有效通过。
- agent：独立只读阶段会话初判；会话跑在本次实现的候选 Worktree 内（不是实现会话的延续，也不是脱离项目的文字评审），实际查看候选文件、可运行只读检查命令，最多 30 轮。pass 可进入最终 Accept，无需逐条重复点击。fail/inconclusive 可被有理由、有固定证据引用的人类覆判。

确定性失败不能人工覆判。新判定不继承旧判定上的 HumanAssessment。普通聊天反馈不等于修改或确认契约。

## 3. 候选与输入

Worker 在执行锁内封存候选。正式候选取自已封存的 Git 状态：tracked 与非 ignored、应交付的 untracked 进入候选提交，逐仓记录 tree、baseline 和文件摘要；二进制、symlink、gitlink 有独立清单项。

验证从 Git blob 物化到独立目录，校验清单摘要。禁止指向 canonical 源代码的外部 symlink。Evidence/报告/预览放在候选外，不改变产品指纹。环境计数 revision 仅定位，不能代替 contentDigest。

当前实现对存在 ignored 输入的仓库保守标 `bindingStatus=unknown`；尚无完整的配置/数据/锁文件/凭据版本注册入口，不能静默将它们视为不相关。check_before_accept 依赖尚未支持实时复核时拒绝接受。

HTTP 首个实际适配器是 macOS 受控本地 Node HTTP listener：

- 封存 API 可传 `httpTargets: [{name, entrypointRelativePath}]`，name 必须被已确认 HTTP checker 引用。
- entrypoint 必须来自候选，ES module 默认导出 Node 请求处理函数；Worker 物化快照并创建监听器。
- 端口由 OS 分配，实例 ID 由 Worker 生成，目标记录绑定候选/启动定义/Node 版本。
- 只支持 GET/HEAD，无外部网络和宿主写权限；不自动授权生产写操作或通用 HTTP 写请求。
- 不接受用户填写任意端口的“可信服务”。Worker 重启或服务退出后不得静默重启并沿用旧输入；重新封存/验证。
- 响应重定向不跟随；网络错误是技术失败，HTTP 业务断言失败是 completed + fail。

## 4. 材料、采集与独立初判

存储位置：

```text
<executionRoot>/<workspaceId>/evidence-store/
  materials/
  evidence/
  candidate-snapshots/
  verification-inputs/
  verifier-output/
  outbox/
```

目录 0700、文件 0600，拒绝符号链接存储根，临时写入/fsync/原子发布，原文件摘要验证后可见。Server SQLite 保存安全元数据和业务记录。worktree 或 SDK scratch 清理不删除证据。材料读取检查归属、路径、摘要，包括空文件；离线/损坏/缺失不抹去历史，但阻止新 Accept。

上传缓存按 Issue 记录活动租约；下次上传时清理超过24小时且尚未开始封存的缓存。已进入封存但结果未知的缓存保留用于恢复，不盲删。成功封存并保存 receipt 后立即移除临时上传副本；相同幂等重试直接比较正式 Material 的字节，不重建临时副本。没有后台定时器，因此24小时是最早回收时间，不是精确删除时刻。

命令 checker bundle v1 格式：

```json
{ "files": { "check.cjs": "/* fixed UTF-8 checker code */" } }
```

Server/Worker 都将完整配置、bundle 字节摘要、fixture 摘要和 timeout 纳入 checker 身份。entrypoint 从 bundle 运行；候选和 checker/fixtures 只读；结果输出目录独立可写；fixtures 位于 `FOUNDRY_CHECK_FIXTURES/<materialId>`，产物目录为 `FOUNDRY_EVIDENCE_OUTPUT`。进程退出与 assertion verdict 分开。stdout 必须为 `{"assertions":[{"id":"…","expected":true,"observed":true,"verdict":"pass"}]}`，零/重复/不足断言、格式错误、超时、信号退出不得通过。

首批采集：

- command：真实参数、stdout/stderr、退出码、超时和完整性。
- project_command：Foundry 在封存候选的只读副本上直接运行项目自带命令（例如 `node --test …`），无 checker bundle、无断言格式要求；stdout/stderr 本身即证据，预期退出码（可为多个）决定判定，超时/信号退出判技术失败。命令在断网沙箱内运行，需要联网安装依赖的命令会确定性失败，不放开网络。
- HTTP：请求参数、状态、响应头和响应体，状态/头/JSON Pointer 的固定比较。
- candidate_export：按封存 snapshot 的仓库及相对路径导出实际 Git blob。
- candidate_changes：系统逐仓比较冻结 baseline 与 candidate，保存 Git 变更清单；用于变更范围证明，不信任实现总结。
- human_upload：先生成 Material，再显式关联条件、验证输入和人的声明；仅 agent 条件可接受这种关联。

Agent 初判只接收确认的条件/rubric/参考 Media/选定 Evidence/输入身份，不喂实现会话的“我完成了”；提示明确要求在候选 Worktree 中实际查看文件，observed 必须写清文件路径或所用命令。图片实际以媒体字节输入；未支持 PDF/视频等材料时明确失败，不把文件名当内容。判定是全新独立阶段会话（`persistSession: false`、独立私有 home），不是实现会话的续接。Claude 使用 Agent SDK：仅预批准 Read/Grep/Glob，判定阶段额外允许只读 Bash 运行检查命令，写/编辑/Task/Web 类工具一律拒绝，空 MCP/skills/plugins、不继承 settings（判定会话不加载项目指令；项目指令只在澄清阶段读取）。Codex 使用独立私有配置与 `sandboxMode: read-only`、`approvalPolicy: never`、断网，禁用 Shell（无 Worktree 的纯材料判定）、Apps、浏览器、Computer、插件、hooks、子 Agent 等能力。额外 macOS sandbox-exec 包装只放行 SDK runtime/系统只读根/独立 home/候选只读根，候选与原始证据不可写、宿主管理凭据不可读；Linux 由 bubblewrap 提供同样的只读阶段隔离（独立 home 可写，Workspace/候选只读，未挂载的路径不可见也不可写），但共享宿主网络、挡不住控制面端口；其他平台直接报 `agent_verifier_isolation_unavailable`，不回退到无隔离执行。隔离统一由 Sandbox 模块提供（见[模块化架构 §5.1](architecture-modules.md#51-sandbox)）。

判定请求向 provider 下发与解析端一致的 JSON Schema：Claude 走 Agent SDK 的 `outputFormat: { type: "json_schema", schema }`，Codex 走 `outputSchema`，Schema 由共享协议模型生成（`VerificationResult` 去掉服务端补填字段）；provider 不支持 schema 时仍按文本回答。解析侧另留有界形状容错：提取代码围栏/末个对象、单引号对象字面量重引、句子包成单元素数组、非字符串 observed 序列化、缺失的 evidenceId 按材料归属修正、删除 null selector；只对齐形状，不改 verdict、措辞与引用归属。

最多一次纯格式修复（修复轮不再挂载 Worktree、不带图片，只重写格式）；verdict、finding 身份/数量、观察事实或引用不一致即判失败。仍不能校验则技术失败。请求模型和实际报告模型分别记录，未报告的不猜测。执行 session source 为 `verification`。

报告是 Result 的可读投影，不是判断存在的替代。系统验证引用属于本次固定材料；Agent pass 必须有带引用的 passing findings。缺少材料、input unknown 或不可用等仍由准出计算拦截。

日志和 HTTP 的基线脱敏在保存/提供模型前执行。若断言输出必须脱敏，命令结果不能通过；HTTP 返回 inconclusive。当前规则是保守基线，不承诺自动发现所有业务秘密。

## 5. 准出、人工接受与恢复

每条条件按 Server sequence 选择当前候选/契约下最新请求；queued/running/failed/canceled 都不回退旧 pass。材料数量按独立摘要去重，只是完整性门槛，不代表语义正确。

必选条件同时要求：确认契约、完整绑定输入、所需材料可读、有效 pass、fresh、无未解决技术失败。可选条件错误展示但不应代替必选门槛。不存在 forceAccept。

Accept 提交 `reviewSnapshotId + reviewDigest`。Server 重新核对人、状态、当前判定集合；Worker 在锁内重新检查真实候选、材料、canonical baseline 和逐仓 journal。

- 基线没变且 target tree 等于验证树：继续既有 prepare/apply journal。
- 基线前移：拒绝旧批准。用户在 Evidence & Verify 点击对齐后，Worker 只在隔离候选中 merge 新 baseline，封存带 `parentSnapshotId` 的新快照，页面重跑已确认的确定性条件。Agent 条件必须补齐新输入的 Evidence 并重新判断；全部通过后仍须新的人工 Accept。冲突留在候选中，不自动裁定冲突。
- 部分应用：保留逐仓 expected/target/applied，重试只能对应同一 decision；未知外部修改不得覆盖。
- 全部应用后才设置 Accepted。丢失响应后的已完成 Accept 重放返回原结果，不启动新集成。
- 已批准记录保留；当前内容/判定改变使旧批准不再适用。
- Accepted 页面读取当时集成的不可变审阅包，不因候选临时目录清理改写历史；不提供再次 Accept 的活动按钮。

Server 在发送判定任务前事务性复核当前契约/候选。确定性采集的 Evidence ID 在请求时预留，不能混入历史 pass。新判定排队后契约改变会取消该请求；在途结果可保留历史，不覆盖新选择。

同一 Issue 的多个判定在 Server 排队逐条执行，避免竞争 Worker 的候选锁；不同 Issue 可独立执行。等待判断时的 review 保持不可接受、不抢采集锁；判断齐备后的 review 和最终 Accept 仍重新核对真实候选。

Worker outbox 在执行前保存 intent、结束后保存完整 receipt。Server 在 Workspace 连接/重连后按持久判定 ID 查询结果：已结束则登记原始结果、仍执行则等待、状态未知则明确技术失败。恢复不重放 command 或 HTTP 请求。测试通过丢弃终态 WS 响应再重连验证“同一材料、同一结果、零重复采集”。多仓故障注入验证 A 成功/B 失败时保持未完成，保留外部文件，重新创建执行存储实例后只恢复原 decision/journal。

## 6. API 与 UI

业务端点均在 `/api/issues/{id}`：

| 路径                                    | 方法     | 作用                           |
| --------------------------------------- | -------- | ------------------------------ |
| `/contracts`                            | GET/POST | 历史/新草案                    |
| `/contracts/import-legacy`              | POST     | 显式导入旧文字为未确认草案     |
| `/clarify`                              | POST     | 独立只读 Agent 下一问/契约提议 |
| `/conversation/status`                  | POST     | 持久化只读状态问答，不派发执行 |
| `/contracts/{revision}/confirm`         | POST     | 精确摘要确认                   |
| `/contracts/{revision}/discard`         | POST     | 有理由撤回                     |
| `/materials`                            | GET/POST | 材料元数据/流式上传            |
| `/materials/{materialId}/content`       | GET      | 安全下载；非任意路径读取       |
| `/candidate-snapshots`                  | GET/POST | 历史/封存候选与输入            |
| `/verification-inputs`                  | GET      | 输入身份                       |
| `/evidence`                             | GET/POST | 证据列表/人工登记              |
| `/evidence/export`                      | POST     | 导出候选文件                   |
| `/verify`                               | POST     | 当前契约/候选/条件请求         |
| `/verifications`、`/verifications/{id}` | GET      | 判定与结构化 Result            |
| `/human-assessments`                    | GET/POST | 人工判断历史/追加              |
| `/review`                               | GET      | 当前不可变 ReviewSnapshot      |
| `/accept`                               | POST     | 人明确接受审阅包               |

Evidence 写操作及 `POST /api/issues` 要求 `Idempotency-Key`；同键异内容冲突。契约/澄清/判定绑定精确修订或输入，Accept 同时校验 review ID/digest、actor 和 rationale。不能声称仓库内所有历史 mutation 都已升级为统一预期版本语义。

`POST /candidate-snapshots` 支持 `alignFromSnapshotId`，只允许对当前候选显式对齐，不能悄悄复用旧判断或批准。普通候选封存仍使用同一路由。

列表响应 `{items,page,pageSize,total}` 默认20最大100。材料上传走 HTTP 流，内部每块256KiB，单文件100MiB；图片送模型最大25MiB。HTML/SVG 默认附件下载，nosniff，不在主站运行。没有新的 Run/Asset/验证任务导航；复用 Issue Criteria、Evidence & Verify、Changes、Environment。

主聊天提供 Agent 澄清、参考上传、同源确认卡与状态问答；沿用既有登录与权限入口，不要求额外口令。右侧“目标与约定”用目标/标准/范围/参考卡片，“验收结果”按整体结论→逐条实际观察与引用→采集计划→最终接受组织；“改动”和“执行环境”按需深入。阶段提示位于 tabs 上方，不抢切用户当前 tab。文件按实际候选清单推荐，选择调整与内部 ID/JSON 收进展开区。PNG/JPEG/GIF 预览上限25MiB，文本/JSON 上限2MiB，浏览器再次验证真实字节摘要；文本经 React 转义，参考与实际材料分开展示。图像区域高亮、视频/PDF 等丰富预览尚未实现。功能准出见[对话式准出标准](foundry-conversation-release-gate.md)。Issues 的 Web 入口目前暂时隐藏，上述 UI 在重新开放时按该标准验收。

专用 `evidence_updated` SSE 只传 Issue/entity ID、版本和状态，页面去抖后重取小实体，断线重连刷新。文件内容不塞进 SSE/WS 大消息。列表和内部材料 inventory 分页读取，不再因20条默认页长漏掉材料。

## 7. 人工控制与兼容

人工决定走普通的登录会话与 Workspace 角色（见[账号与权限](security.md#accounts)，路由规则在 `apps/server/internal/httpapi/routes.go`）：查看需要 Viewer；编辑草案、澄清、封存候选、上传与导出材料需要 Member；确认/撤回契约、发起判定与人工覆判由 Issue 创建者或 Maintainer 及以上执行；Accept 需要 Maintainer 及以上。actor 由服务端从登录账号确定，请求正文不能指定。Agent 澄清结果只写 `agent_proposal` 草案，用户确认准确版本后才生效，Accept 绑定准确 review。没有额外人工口令或设备信任系统；这不声称能区分真人点击与该账号下的自动化操作。

执行子进程剥离 Foundry 控制/配对环境变量，禁止读取用户配置、私有状态、`.env`、Server `.data`，禁止访问默认以及本次配置的控制端口。用户任意安装的本机软件与 OS 管理员不在威胁边界内。

旧 acceptanceCriteria/checks/report 只是历史材料，不成为新 Evidence 或通过判断。未完成旧 Issue 可显式点击导入：非占位条件保存在 `origin=legacy_import` 的目标草案中，criteria 仍为空，须定义 rubric 与 EvidenceRequirement 后确认。精确匹配的三条占位条件不导入；原 Issue 字段保留。旧终态禁止导入，不重判。

未完成旧任务下一次执行/Accept 需要新契约确认。旧 revision-only Accept 明确报协议升级错误，无兼容后门。`verify-issue-loop.mjs` 和 `verify-concurrent-workspace.mjs` 两个旧脚本已在任何副作用前明确报 retired；新验收使用 `evidence-api-e2e.test.mjs` 和 `evidence-integration.test.mjs`，不让旧自动派发流程无限等待。

## 8. 验证

可复现验证：

```sh
node scripts/generate-evidence-models.mjs --check
pnpm verify
pnpm --filter @foundry/worker build
node --test packages/worker/test/evidence*.test.mjs
node --test apps/web/test/evidence*.test.mjs
node --test --test-concurrency=1 apps/web/test/*.test.mjs
cd apps/server && go test ./... && go test -race ./internal/sqlitestore ./internal/httpapi
```

真实模型测试为显式 opt-in，不在普通测试中消耗 provider 用量：

```sh
FOUNDRY_VERIFY_E2E_LIVE=1 node --test packages/worker/test/evidence-api-e2e.test.mjs
```

自动测试覆盖：类型检查、Go全量/race、共享字段和摘要一致性、真实命令成功/失败/零断言/格式错误/超时、HTTP 合法/非法请求/重定向/错误实例/服务丢失、图像实际字节输入、binary/untracked/基线变化、材料损坏和归属、覆判与最新请求选择、人工批准不等于集成、Accept 幂等及控制端口隔离。真实 Server/Worker API 测试覆盖终态响应丢失后恢复、基线前移对齐复验与新 Accept；多仓 Worker 测试覆盖部分应用与持久 journal 恢复。

| 实施阶段     | 当前覆盖                                                                                                                                               | 不应误认为已完成                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| 0 模型契约   | 全部共享业务类型、Go DTO/schema/字段表、有效无效fixture、跨语言摘要检查                                                                                | 类型定义不等于每种载体和执行环境都已支持         |
| 1 确认边界   | 删除硬编码、人工编辑确认、claim/Worker双重校验、legacy显式导入                                                                                         | 旧任务不会被自动确认或重跑                       |
| 2 输入与材料 | Git快照、独立物化、持久材料、命令/项目自带命令/受控HTTP/上传/导出、outbox恢复与缓存回收                                                                | 通用外部输入/依赖闭包尚缺                        |
| 3 判定与审阅 | 固定检查器（含项目自带命令的程序判定）、候选 Worktree 内独立 SDK 初判、判定侧 JSON Schema 下发与有界形状容错、真实图文输入、覆判、最新请求/新鲜度/准出 | Codex 真实 provider 图文判定未验证；复杂媒体尚缺 |
| 4 Accept集成 | 精确审阅包、锁内核对、基线对齐复验、新Accept、逐仓journal恢复                                                                                          | 受控 HTTP 目标仍仅 macOS；Linux 沙箱挡不住控制面 |
| 5 创建澄清   | Issue内逐问Agent会话、所选 Workspace 只读探索（目录/代码/项目指令）、严格契约提议、明确人工确认                                                        | PDF/音视频等复杂参考材料解析尚缺                 |

## 9. 尚需收口的实施项

以下都是明确缺口，不属于“已通过”：

1. Codex 真实 provider 图文初判尚未完成验证（曾受账号用量限制阻止，未伪造通过）。Claude Agent 判定已有真实闭环记录，图片输入有真实 SDK smoke，但不声称完成所有媒体演示。
2. 通用 HTTP/service/build identity、外部配置/数据/依赖/凭据版本注册与 Accept 前复核；目前支持受控本地 Node GET/HEAD 与纯文件/项目命令，`check_before_accept` 依赖未注册时拒绝接受。
3. 自动恢复目前覆盖 collect/assess；上传/对齐/澄清有持久幂等结果，但不具备所有中途副作用的通用恢复协议。未知执行状态继续拒绝盲目重放。
4. 图像区域高亮/标注、PDF/视频/音频预览、主动删除材料的影响提示。rationale media 只能作解释性 context，不作为新 Evidence。
5. 所有历史 mutation 的统一预期版本检查，以及原始输入/配置关联的更完整交互。通用依赖安装与输入闭包尚未实现；ignored 文件存在时保守 unknown。
6. 复杂参考材料解析（PDF/视频/音频等）尚未支持；澄清阶段的受控仓库只读探索已实现（所选 Workspace 原目录、只读工具与项目指令，不写入、不执行命令）。
7. Linux 平台：执行期隔离使用 bubblewrap（见[多仓执行方案 §12](issue-workspace-execution.md#12-第一版实现与操作边界)），需要可用的 user namespace；Agent 阶段沙箱（澄清与判定）与 Accept/集成自 2026-09-25 起在 Linux 开通；受控本地 HTTP 目标仍仅在 macOS 开通；Linux 沙箱挡不住控制面端口（见[模块化架构 §5.1](architecture-modules.md#51-sandbox)）；未验证平台保持拒绝。

只有这些缺口收口并完成首个 provider 的全链路演示后，才应把 README 的 Evidence / Verify 能力勾为完成。
