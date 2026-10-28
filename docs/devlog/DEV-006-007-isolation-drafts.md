# DEV-006/007 · Session 隔离与 Workspace Skill 草稿

状态：2026-10-20 按用户显式委托，由 Agent 对已验证交付准出归档。草稿完整试验、新宿主回归、无文件差异及新增 result.txt 两类 Issue 均已完成实际集成；具体证据和历史失败如下保留。源码统一合入与最终回执见 [DEV-025](DEV-025-release-closure.md)，不表述为用户本人点击验收。

## 问题与实现来源

DEV-006 的执行配置、凭据与 Skill 快照生命周期，是 DEV-007 草稿发现、固定摘要及对照试验的共同基础，因此由同一 owner 收尾。前序实现位于 `feat/session-isolation`（`f832e75`、PR #135）及其后续未提交改动。设计与历史专项证据见 [隔离设计](../session-isolation-design.md)、[基础实施](../session-isolation-implementation-20261019.md)和[草稿实施](../session-isolation-drafts-20261019.md)。历史合成栈已被清理，其中的 Session/Issue ID 只保留为历史观察，不能作为本轮可查询验收记录。

## 2026-10-19 接续整合

- 在本地 main `c2e46c6` 上，以该提交为共同基线，逐文件三方整合隔离工作树的 115 个文件；保留 main 的 DEV-008 writer 清理和并行文档整理。没有 reset、clean 或覆盖整棵树。
- 原 main 文件备份与整合清单在仓库外 `/tmp/fdy-iirZAF/foundry-isolation-integration-yq5j81e3/`。
- 两处手工冲突：`native-inspection.ts` 的原生元数据操作清理，`runner/codex-app-server.ts` 的 turn 清理。均等待 DEV-008 的进程组关闭确认，再释放运行时和临时输入；保留取消监听移除、启动失败与关闭失败合并报告，避免过早释放 writer。
- 整合后的格式、协议构建/测试、Web 类型检查与相关测试、Worker 构建/回归、SQLite 及审计已通过。HTTP API 长检查中断后按日志补跑，覆盖 484 个顶层用例（482 通过、2 条件跳过、0 失败）；Store 29 项通过。后续宿主能力补丁的 14 个 Worker 测试文件另行通过。
- 本轮重新建立独立合成栈 `isolation-dev006-007`，禁用 integrations，旧合成对象不复用。

## 部署与实际加载

日常 Server 最新健康启动时间为 `2026-10-19T08:52:16Z`，Web 当前 build 为 `9a51b00f6cdda112` / `index-B2ANXj5s.js`（DEV-022 owner 完成新版 UI 自验，本 owner 复核公开 version.json 和入口）。最终共同包与 dev-server 实际 daemon 为 `0.5.7-dev.39.gc2e46c6.local.1792399633`（PID 298186），保留 Verify 缺省模型修复和退出/凭据清理边界；版本化、latest 与本地包哈希均经本 owner 独立核对。

经用户授权的短维护已完成，实际 execution host 现为 PID 374938，入口明确位于公开 `1792399633` 的安装目录；daemon PID 298186。两个合成服务在原记录上停止、恢复，数据保留。旧宿主不宣告草稿能力的保护此前已验证；新宿主的当前回合刷新、固定快照包含/排除及普通新会话发现也已通过真实回归，见文末维护后证据。

## 本轮 Agent 自验

本轮真实 Codex 试验覆盖 with/without/previous、固定摘要、v2 过期提示、普通新会话发现、开关、当前回合 `refresh_workspace_skills`；真实浏览器覆盖失败保留与重试、无效草稿、桌面/390px 和亮/暗主题。原 Issue 完成 `hi`→读取真实项目→上传参考→自然语言草案→同源 Details→修订→“继续”不确认，再明确确认、真实执行、修订取证方案并重新确认、独立 Verify、显式 Accept 与集成。

独立无文件差异 Issue `iss_108` 与原新增文件 Issue `iss_107` 均为 accepted / integrated，分场景记录，没有用无改动结果替代新增文件集成。原场景最后确认 revision 7，三项检查通过；缺证据、无引用判断、旧契约输入、跨 Issue 输入、候选变化及过期 review 均被拒绝。README 与 v2 Skill 摘要保持不变。

## 人工验收

待用户执行。可按以下入口复核，用户明确通过后才关闭 DEV-006/007：

1. 打开日常 [主 Workspace 草稿页](https://dev.foundryapp.app/workspace/skills?workspace=ws_8d046eba-109d-4017-b22f-6311250f90a7)，应看到项目草稿来源、内容版本、刷新与试用入口；现有草稿未发布。
2. 对照新宿主的 [包含草稿](https://dev.foundryapp.app/chats/sess_1792411283760544901)、[排除草稿](https://dev.foundryapp.app/chats/sess_1792411283845164312) 与 [普通新会话](https://dev.foundryapp.app/chats/sess_1792411317652947819)：包含及普通会话读到固定管理副本，排除会话为 ABSENT。三者独立原生历史，提示没有携带方法正文。
3. 在能访问 dev-server 本机的浏览器打开 [新增文件合成 Issue](http://127.0.0.1:58105/issues/iss_107?workspace=ws_9a7f5fdc-72da-4599-a24a-782e59e1171e)，账号为登记的 `scratch-admin`，凭据保留仓库外。应显示 Accepted and integrated、最终第 7 版和 3/3 条件通过。展开实际证据，应能查看 `result.txt` 原文以及系统生成、绑定同一候选的改动清单；两个独立判断分别引用这些材料。
4. 如需核对实际交付，合成源目录 `/tmp/foundry-dev006007-acceptance` 中 `result.txt` 恰好是 `ISOLATION_ACCEPTANCE_OK` 加一个 LF，共 24 字节；Git 干净，相对固定 v2 基线只新增此文件。该目录与 Foundry 源码工作区分离。

合成 Server/Worker 保留供复验，DB 未清理。合成页面使用本轮隔离草稿 UI build `0f06bcf26c97eab0`，Worker 使用公开 `1792399633`；日常站点后续 DEV-022 UI build 与合成页面分别记账，不冒充同一产物。

## 2026-10-19 Astra 复核与本轮证据

接续 owner：[sess_1792389911761860653](https://dev.foundryapp.app/chats/sess_1792389911761860653)，使用 gpt-6-astra / xhigh。独立复查了两处手工合并及 `agent-processes.ts`、`agent-runtime/codex-client.ts`、`execution-host/service.ts` 的自动整合：Codex 等待原生进程与受管进程组全部退出，成功后才释放运行时；取消、启动异常、关闭异常及隔离输入清理边界均保留。没有另开源码 owner。

前任结束后，尚未完成的检查、备份和构建进程已退出，不能沿用“正在运行”作为结果。本轮保留已完成检查，补跑未完成项。第二次长检查在 Server 阶段收到终止信号，原因未确认；Worker 与 SQLite 的完整输出保留，HTTP API / Store 改为独立 JSON 进度日志继续检查。

- 备份：`~/.foundry/server-backups/dev006-007-snapshot-20261019T060752Z/`，固定只读事务快照，623,484,928 字节，`quick_check=ok`，`VERIFIED` 回执与密钥副本齐备。之前两份中断副本不可用于回滚。
- Web 自动生产构建已完成，日常站点和本地 `version.json` 一致：`0f06bcf26c97eab0`；主入口 `index-BLxMdMhq.js`。合成栈复用这份完整产物，未把配置存在当成实际部署。
- Worker 68 个测试文件，两组共 478 项：468 通过、0 失败、10 项条件跳过。包含真实 writer 锁、遗留子进程、取消与立即重试。SQLite 相关 3 项通过。输出：`/tmp/fdy-DbdbFd/tmp.30slwHdz9Z/3.log`、`4.log`。
- 10 项 UI 审计通过，没有新增债务；V3 layout 的 3 项既有债务保留。跨语言契约与模块审计通过（254 类型、113 daemon 消息、25 浏览器事件、33 请求映射、0 模块违规）。
- HTTP API 分段补跑覆盖完整，Store 包通过：`/tmp/foundry-dev006007-server-test-summary.json`；中断的整包过程没有标成通过。

### 新合成环境

独立栈 `isolation-dev006-007`：`http://127.0.0.1:58105`，账号 `scratch-admin`，integrations 关闭，服务端外部代理阻断。DB 来自上述已验证备份，原库与无关业务对象未改动。Server 和 Worker 使用 Foundry 受管进程，状态和停止回执可查询；保留 DB，不运行删除实例的 down 操作。

- Workspace：`ws_9a7f5fdc-72da-4599-a24a-782e59e1171e`，目录 `/tmp/foundry-dev006007-acceptance`。
- Device：`dev_98e07e47-ede7-4b3c-90f0-e96117c689ac`。
- Issue：`iss_107`（仅属于这个新栈与 Workspace，不能与已删除旧栈的同号 Issue 混淆）。
- 所有合成页面操作由授权自动化完成，不声称用户本人点击；模型请求均经过原生 Codex CLI。

### 草稿真实试验

以下均为新建原生线程，使用 Codex 的 gpt-6.1-sol，未复用历史推理结果：

| 场景                   | Session                    | 观察                                                                                       |
| ---------------------- | -------------------------- | ------------------------------------------------------------------------------------------ |
| 页面试用 v1            | `sess_1792390418503942485` | 读取受管副本，返回 `DRAFT_ACCEPTANCE_V1_7429`                                              |
| 改为 v2 后试用上一版   | `sess_1792390526275595697` | 仍返回 v1，固定摘要生效                                                                    |
| 页面不使用此 Skill     | `sess_1792390584712852636` | 返回 `BASELINE_NONE`                                                                       |
| v2 页面失败后重试      | `sess_1792390668586363076` | 模拟网络失败时保留输入与选择；恢复网络后返回 `DRAFT_ACCEPTANCE_V2_8563`                    |
| 关闭开关后的普通新会话 | `sess_1792390934889424918` | 返回 `BASELINE_NONE`，刷新 API 同时拒绝 409                                                |
| 恢复开关后的普通新会话 | `sess_1792391060684534337` | 自动发现并返回 v2                                                                          |
| 当前回合创建并刷新     | `sess_1792391087262297782` | 调用 `refresh_workspace_skills`，读取返回的不可变副本并返回 `CURRENT_TURN_REFRESH_OK_3917` |

当前回合快照摘要 `8dc134c72f8a5920fe530085894b0b246564d91527f107556a2d284753dd251f`，已读取的受管根位于合成栈 `state/skill-sets/e9e0ccd6a3ebfd5e9d3457d61ae9942a679524d445695c4383635749293deb64/`。试验完成后只移除该临时 fixture；既有 README 与 fixture-method 草稿保留。

真实页面确认了修改后的过期提示、忙碌/禁用状态、开关持久化、输入保留与重试。390px 暗色页面和试用弹窗可操作，键盘可选择账号，无横向溢出。浏览器的 `uncheck` 命令曾连续发出 false/true 两个请求；改为单次真实点击后只发送一次并正确关闭，未将工具行为误报为产品缺陷。

截图目录：`.foundry/attachments/dev006007/`，包括 `trial-v1-light.png`、`draft-v2-stale-light.png`、`trial-failure-retains-input.png`、`drafts-dark-390.png`、`trial-dark-390.png`。

### Issue G1–G3 的当前证据

- `hi` 触发澄清 Session `sess_1792390707971030339`；实际执行目录检查并读取 README，然后询问具体目标，没有产生实施候选。
- 从主输入区上传 `foundry-dev006007-reference.txt`；材料 `mat_db596ec5-7dbf-45fd-8c05-6b7abc612ee5` 以 context 进入契约，未当作结果证据。
- 真实 Agent 提出自然语言草案，聊天确认卡与 Details 均展示相同版本。通过主聊天将检查表达式改为明确的字节 10，并将独立判断的输入材料明确为封存候选 `result.txt`，避免以尚未生成的判断日志作为先决材料。
- 当前草案 revision 4，仍未确认。完整字节检查已在独立临时 fixture 中验证：正确 LF 通过，字面反斜杠 n 和双换行失败；现有文件的基线摘要检查通过。
- 截图 `issue-hi-readonly.png`、`issue-draft-v4-light.png`。候选执行、Verify、准确 review 的显式 Accept 与集成成功仍未完成，不标记待人工验收。

### 部署及升级期间的补充修复

日常 Server 已从主树重启，`/healthz` 报告启动时间 `2026-10-19T06:35:10Z`，实际 PID 201194。启动期间读取约 8GB 数据后恢复监听；没有强制终止数据库初始化。重启前唯一活动会话为本 owner，重启后仍为 running，设备重新在线。PM2 配置备份在上述备份目录的 `pm2-before-deploy.json`。

HTTP API 的长运行两次收到外部终止信号，未将中断整包标记通过。最终按逐项日志补跑未完成部分：484 个顶层用例覆盖完整，482 通过、2 个条件跳过、0 失败；Store 29 项通过。`TestSkillBundleLifecycle` 单独通过（4.765 秒）；结果摘要在 `/tmp/foundry-dev006007-server-test-summary.json`，没有以历史检查替代新检查。

日常浏览器使用既有 e2e-alice 账号，仅查看其旧测试 Workspace；实际加载 `index-BLxMdMhq.js`，meta build 与公开 version.json 均为 `0f06bcf26c97eab0`，草稿区正常呈现，离线旧设备显示连接/升级提示。截图 `daily-deployed-drafts.png`。

首次发布 `0.5.7-dev.39.gc2e46c6.local.1792390538`，保留旧包并比较旧 manifest 后原子切换；四个公网下载（版本化与 latest，两种包）的 SHA-256 均通过。dev-server daemon 更新成功，旧 execution host PID 161331 继续服务活跃会话，未强制停止。

升级时进一步发现：daemon 的静态能力宣告可能领先于仍忙碌的旧宿主，旧宿主会忽略新增草稿输入。已修正为从已连接宿主的能力快照决定宣告，未连接或旧宿主不宣告草稿；空闲切换后通过已有注册通道更新能力。下述最终包已包含补丁。

新的 DEV-022 owner 与本 owner 已逐文件协调；本轮能力补丁独占 execution-host/client、server、workspace-ops、daemon/control-connection 及相关测试。DEV-022 不同期发布；两个合成服务及其数据保留，不作为新功能裁减对象。

### 最终发布回执与仍未完成项

- 宿主能力补丁：4 个源码文件、1 个新 IPC 回归和现有真实宿主断言。检查 `/tmp/foundry-dev006007-host-capability-check.log` 全部通过：Worker 构建、14 个相关测试文件、格式与模块审计。旧忙碌宿主、升级后的能力、断线后不使用过期快照均有回归；真实宿主进程报告新能力。
- 最终包 `0.5.7-dev.39.gc2e46c6.local.1792392272`。打包前后 475 个文件的 SHA-256 相同；清单在 `~/.foundry/staging/dev006007-host-capability-20261019/checked-source-sha256.json`。DEV-022 在打包完成后才获准编辑公共主树，未混入本包。
- protocol SHA-256：`423bde73c619d55f411ba4ce6ff8a108a3c53f2c89f55959b0a5b6445cbc5c80`；worker SHA-256：`5f809807ed7b565aea146ae4be9f3d5d10d09b0f71fe92f912424610767780ea`。版本化与 latest 四地址均匹配。
- 发布与前一版包备份：`~/.foundry/server-backups/dev006007-worker-0.5.7-dev.39.gc2e46c6.local.1792392272/`。dev-server daemon 更新退出 0，实际 PID 211652，Server 设备记录为 connected / 1792392272；旧 host PID 161331 未变化，设备正确不宣告草稿能力。
- 本轮发布结束后，公共构建/manifest/daemon 发布权已明确交给 DEV-022 owner `sess_1792392033435484621`。后续验收若需改共享文件或再次发布，先逐项协调，不覆盖其他 dirty 工作。
- 合成服务 `work_2de671aff5f6b54978a980c3d9b18601`、`work_e079566a13f5dbbd745d90199ccd6a54` 保留运行和数据。后续受管接续 `work_5a71ddbc9f817ab5ea9e02547ec5ab44` 已登记，本 owner 继续负责完整 Issue 验收；旧已停止计划未恢复。
- 当前契约 revision 4 / `sha256:2d4d4ae9a28335be0b095ce67b0c0563c006a310fdb9eb969b4f66819dcb29f0`，未确认、无候选。“继续”后版本仍为 4、状态仍为 draft。`README.md` 和原 Skill 文件摘要前后相同。验收结果页显示尚未进入验收，未提供 Accept；390px 主聊天输入可达，页面宽度等于视口宽度。
- 本轮未提交、推送或合并源码。该发布时点的完整链路尚未完成；后续无文件差异场景的真实闭环见下节。原新增文件场景、实际宿主安全加载及后续人工验收仍待完成，不能将已部署或 Session 结束视为交付完成。

## 分步骤核查与继续验证

此前将整个候选验收链路一并延后，范围过大。开发/验证与 Git 提交是不同动作；本轮继续所有不创建 commit 的正常产品路径，不改产品语义、不删除历史。

| 步骤         | 正常产品实现                                                                                                       | 是否创建新的 Git commit                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 准备候选     | `issue-environments.ts` 的 `prepareIssueEnvironment` / `prepareRepositoryUnlocked` 从已提交 baseline 建立 worktree | 不创建 commit；会创建 worktree/分支等 Git 元数据                                              |
| Agent 执行   | `issue-executor.ts` 在候选中执行；正常任务不让 Agent 提交                                                          | 执行本身不提交，仍取决于任务是否产生文件差异                                                  |
| 执行自动收尾 | `issue-execution.ts` 调用 `snapshotEnvironment`，再调用 `execution-git.ts` 的 `gitCommit`                          | staged 差异或 MERGE_HEAD 存在时提交；无差异时复用 HEAD                                        |
| 封存取证输入 | `evidence-rpc.ts` 的 `sealVerificationInput` → `evidence-snapshots.ts` 的 `sealCandidate`                          | 常规封存只读已存在、干净的候选 commit；带 alignment 的路径另会刷新并快照                      |
| Verify       | 在封存候选副本运行程序检查与独立 Agent                                                                             | 不创建 Git commit                                                                             |
| Accept       | `workspace-acceptance.ts` 先准备 merge，再条件调用 `gitCommit`，验证后应用到 source                                | 分叉 merge / 引用差异可能创建 commit；正常 fast-forward 或 up-to-date 路径不必创建新的 commit |

原 `iss_107` 要新增 `result.txt`，因此其自动收尾会创建候选 commit；不能把这一环节的结果当成仅有文件写入。提交位于 `/tmp/foundry-dev006007-acceptance` 的共享 Git 仓库，候选是其 worktree，不是 Foundry 源码仓库。候选准备从已提交 baseline 读取，而该合成 source 的 v2 Skill 仍为 dirty；既有草案保留 v2 的要求与 baseline v1 不一致，且 Accept 会拒绝 dirty source。应通过正常源文件提交/草案修订处理，不丢弃现有文件或弱化检查。

立即增加独立的无文件差异场景：Workspace `ws_d3f03f56-3125-4a8f-82f1-4e2c8618de09`，路径 `/tmp/foundry-dev006007-nochange`，Issue `iss_108`。目标仅核验已有 README，禁止改动项目文件；从已有 baseline clone，没有创建新 commit。初始所有引用可达 commit 集合仅 `c42350f7e8d80686f484f73cb0d55face00eaf63`。该场景用于真实候选、Verify 和 up-to-date Accept 的独立证据，不冒充原新增文件场景已集成。

原 Issue 的新增负向 API 验证：使用已被替代的 revision 3 和错误 digest 的 revision 4 分别确认，均返回 409 `contract_revision_conflict`；检查后仍为 draft，没有执行 run。当前宿主仍保留原活动进程，未强制切换；公共发布继续由 DEV-022 owner 协调。

### 无文件差异场景已完成真实集成

`iss_108` 使用 Codex Local，经真实页面审阅并确认 revision 2 / `sha256:8af94df1f99f9e87c0c3d5623f3cdc47fe9eb0ebe6df4c70dcf72bae356555da`。实施 Session `sess_1792394242868714372` 实际读取候选 README、执行字节检查，没有项目文件改动；自动 snapshot 复用了既有 HEAD。随后在真实页面准备封存材料、采集与检查。

- 候选：`snap_d57e9412-a2f0-48ea-8062-ee08d7d9ec6d`；输入：`input_11715683-0011-494d-9cbd-f58c0a11d9c9`。
- 程序检查 `verify_118d3322-affe-4771-ac45-895563ed6e52`：SHA-256 比对通过，退出码 0。
- 独立判断 `verify_2a6ea71d-c35b-479e-b491-acd64ad5c810`：原生 Codex 线程 `01a15319-1b61-76f1-9e0c-4619861bab33`，pass。已校验原始材料摘要；真实活动日志包含 `nl -ba README.md`、读取 `../changes/summary.md` 以及检查完整 diff 为 0 字节。结果引用 README 第 2 行及导出材料 `mat_a2cde6d9-7bd7-4d84-b523-87d4ac3408c0`，并非只读实施总结。
- 缺少判断/证据时，页面 Accept 禁用，带准确当时 review 的 API 接受请求仍返回 409。
- 在独立判断完成后，仅临时修改自己合成候选的 README；新 review 显示 `candidate_changed`，旧 review 接受请求返回 409。恢复精确原始字节后，先前 review ID 仍被拒绝；没有改写证据、历史判断或候选 commit。
- 最终在页面明确接受新 review `review_93017779-03e8-48bb-803b-81707a1f8260` / `sha256:f6af1e2f99971f13084236da0d7f7b5f15f4c5a13d4bf6be9473b97a13a21534`。
- 服务端 `status=accepted`，2/2 必须条件通过；工作区环境和接受 journal 均为 `integrated`。接受记录 `acc_050f9ce8-41da-4f1c-8b46-fa3dc4af57f7`，决策 `decision_0837ae3d-93e4-4680-a2e6-da4d9a52c42f`，集成快照 `snap_7fb5dd80-5c61-45c0-92a9-2d246f70eeea`。
- journal 的 expected 与 target 均为 `c42350f7e8d80686f484f73cb0d55face00eaf63`，仓库状态 clean。逐阶段 `git rev-list --all` 不变；最终 `git cat-file --batch-all-objects` 也仅发现这一条 commit 对象，未新增任何 commit。
- 截图：`nochange-missing-evidence.png`、`nochange-stale-review-rejected.png`、`nochange-ready-after-independent-verify.png`、`nochange-accepted-integrated.png`、`nochange-actual-evidence-preview.png`，均在 `.foundry/attachments/dev006007/`。

原 `iss_107` 仍为未确认 draft、没有 run，原 README 和 v2 Skill 字节未动。两个场景分别记账；无改动 Accept 成功不代表新增 `result.txt` 已完成集成。

### Verify 缺省模型问题及最小修复

无改动场景的真实 Verify 首先暴露了新问题：Issue 选择 Provider default 时，独立判断把空字符串 `model: ""` 传给 Codex 原生协议，报 `No models are available`。确定性检查正常，失败记录保留，Accept 被阻断。

最初的模型目录假设未通过真实重试，已撤回。原生 CLI 控制对照进一步确认：全新 HOME、没有目录缓存且省略 model 时，`thread/start` 正常；传空字符串时稳定报错。最终只在 `packages/worker/src/session/codex.ts` 将空白/空字符串规范化为 `undefined`，由原生 CLI 继续选择默认模型；没有硬编码模型、引入宿主配置或改变 Git 语义。新增 `packages/worker/test/codex-verifier-default-model.test.mjs` 用真实子进程协议夹具拒绝空串，覆盖同一输入。临时改过的 catalog helper 和其旧测试已恢复原样，无额外 diff。

修复先在此前已发布 1792392272 的仓库外副本上独立转译验证，未触碰公共 dist 或日常发布。私有测试版本为 `1792392272-verifiercheck`；同一受管合成 Worker 经两次 stop/resume 加载诊断改动，每次停止及恢复均取得当时 revision 的 verified 回执，最终 revision 5 / running，DB、Server、Workspace、Issue 和历史结果均保留。最终回归通过，真实 Verify 第 4 条记录 pass，前两条失败判断保留，不改历史结论。

最终两个源码/测试文件已交 DEV-022 owner 纳入共同冻结、类型检查、综合回归及发布；公共发布权仍由其串行持有。这一阶段的成功来自私有合成运行时；后续正式发布及安装包实测见下节，不以私有结果冒充公开包结果。完整日志和数据摘要在 `/tmp/foundry-dev006007-nochange-evidence.json`、`/tmp/foundry-dev006007-nochange-verifier-proof.txt`、`/tmp/foundry-dev006007-private-verifier-final-test.log`。

- DEV-022 owner 已确认，最终空模型回归也在公共 Worker 构建后的定向测试中通过（`/tmp/dev022-evidence/worker-final-targeted.log`）；综合 Server 检查及共同发布仍由该 owner 串行收尾。
- 完成态页面刷新后仍显示 Accepted and integrated；亮色桌面、暗色 390px 及证据预览已检查。窄屏页面宽度等于视口 390px。补充截图 `nochange-accepted-evidence-dark-390.png`、`nochange-accepted-light-reloaded.png`。

## 共同发布后的独立核验

2026-10-19，DEV-022 owner 串行发布 `0.5.7-dev.39.gc2e46c6.local.1792396585`。本 owner 未并行修改发布 manifest、公共 build 或日常进程，独立完成以下核验：

- protocol 的版本化与 latest 下载均为 `bf28d105898603a3d3d1e9803c64914c32be39fddbc4a25361f03b7bc2d934cb`；worker 两地址均为 `200832fd14e0f0442f56bf533372d450679a4c26b9e6b7da0eadad67b67aabd4`。
- 公开 tarball 的 `session/codex.js` 包含最终空模型规范化；撤回的 `bundledDefault` / `defaultCatalog` 方案不存在；Codex `await client.close()` 清理边界保留。
- Server `/healthz` 正常，启动时间 `2026-10-19T08:05:22Z`；日常真实浏览器加载 `ca4b320c81f898e4` / `index-OVz8Fg9k.js`，草稿区正常显示。截图 `.foundry/attachments/dev006007/common-release-daily-drafts.png`。
- 已安装公开包直接执行独立只读验证，刻意传入缺省空 model；原生线程 `01a15337-a4cf-7f50-b7b9-f3a051047ea6` 实际运行 `sed -n '2p' README.md`，返回精确原文。不是私有诊断包结果。结束后临时 Codex/Claude 访问凭据副本均不存在；合成仓库所有 Git 对象仍仅含原 baseline commit。
- dev-server 设备报告 connected、daemon version `1792396585`，实际 PID 273706；执行宿主仍为 PID 161331 / `1792369800`。忙碌旧宿主不宣告草稿能力的保护仍有效，未强制切换。
- 无活动合成会话时，仅通过原受管 Worker 记录完成安全 stop（revision 6，当时 verified）→固定到公开包路径→resume（revision 7 / running / verified）。合成设备也实际报告 `1792396585`。DB、Server 和所有合成对象均保留；`iss_108` 仍 accepted，`iss_107` 仍 blocked/draft。后续验收不再依赖诊断运行时。

发布核验回执：`/tmp/foundry-dev006007-common-release-receipt.json`；已安装包验证回执：`/tmp/foundry-dev006007-published-verifier-smoke/receipt.json`。本轮没有创建新 Git commit 或新增计划，已有接续计划和两个服务继续保留。当前剩余项是原改动型候选自动提交及其依赖、实际宿主的安全加载，以及完成后的人验收。

### DEV-022 最终包的追加复核

最终共同包 `0.5.7-dev.39.gc2e46c6.local.1792399633` 已发布并安全加载到日常 daemon；本 owner 仅做只读复核和记录，没有并行部署或改源码。

- protocol SHA-256：`b8ba268b1bb12dbae75aa46a123a5092ec50b008e0310a9ec45876e76d91466d`；worker SHA-256：`e78d1a1178d68bc950d2255fd9186e664eda9c80e86ac609c092eced0ddec349`。两种包的 versioned/latest 与本地发布文件均一致。
- Verify 的 `session/codex.js`、`session/index.js`、原生控制传输 `agent-runtime/codex-client.js` 与已完成真实验证的公开 1792396585 包字节相同。runner 的新增差异仅位于显式 `workSessionId` 分支，转报原生工作发现错误；独立 judge 不设置此字段。没有重复花费模型请求，也没有将上一版实测写成新一次实测。
- 日常 Server 健康；设备报告 connected、daemon version `1792399633`，实际 PID 298186。execution host 仍为 PID 161331 / `1792369800`，不宣称宿主已更新。
- 原 Server 工作记录 revision 1 / generation 1、合成 Worker revision 7 / generation 4 仍运行；合成 Worker 继续使用公开 1792396585，原接续计划 revision 1 仍保留。未执行控制操作，也未新增计划。
- 关于短暂停止两个合成服务以便标准 idle 升级的方案仍待明确用户授权；交接消息不构成批准。本 owner 没有停止服务、清理 DB、切换宿主或改变原计划。

独立回执：`/tmp/foundry-dev006007-final-common-release-receipt.json`。原改动型候选集成、实际宿主安全加载及其后的人工验收仍未完成；DEV-006/007 保持进行中。

### 授权维护后的实际加载与复验

2026-10-19 20:04，本 owner 接回合成栈验收控制并独立核实以下结果。短维护由 DEV-022 owner 在用户明确授权后完成；没有在本轮重复控制服务或发布。

- 日常 execution host PID 374938 的实际入口为 `~/.foundry/runtime/0.5.7-dev.39.gc2e46c6.local.1792399633/node_modules/@bd777/foundry-worker/dist/execution-host/main.js`，daemon PID 298186。本会话本回合调用 `refresh_workspace_skills` 成功，返回 `enabled=true`、`supported=true`；这是实际宿主能力证据，不只是 daemon 版本。
- 原 Server 服务已恢复到 revision 3 / generation 2 / PID 375677，健康启动时间 `2026-10-19T11:53:56Z`；原 Worker 恢复到 revision 9 / generation 5 / PID 375855，helper 指向已安装的公开 1792399633。合成设备 connected 且宣告 `workspace_draft_skills_v1`。
- 当时的停止与恢复 verified 回执保存在 `/tmp/dev022-evidence/maintenance-stops.json` 和 `maintenance-restored.json`。Server 恢复操作 `wop_fb3cf62cf1a144b3795a6021640cc6ee`、Worker 恢复操作 `wop_f3409dc0c05f486a76367b51ec6e739f` 在本轮查询仍为 verified；两个服务均 confirmed running。Server 的 referenceRevision 为 2，后续控制须读取最新影响范围。原接续计划 revision 1 保留，由 1792399633 scheduler 接管，未重复登记。
- 使用日常主 Workspace 已有草稿做只读回归，没有改动 Skill 源文件、发布 Skill 或执行业务操作。当前回合可信快照 source digest 为 `7c2bd0739eb4d250186b833728b0e1d89daab6072dff1e336f511ab9f0064df8`，snapshot digest 为 `f9219f1689dd907b5314de88af91037648cf2f5429973fe891f8b749a91061c7`。
- fresh-history include 会话 `sess_1792411283760544901` 实际读取固定草稿管理副本；同一提示与草稿引用的 exclude 会话 `sess_1792411283845164312` 返回 ABSENT，无方法内容泄露到基线提示。普通新会话 `sess_1792411317652947819` 自动发现同一 source digest，并实际读取管理副本。三者均为真实 Codex gpt-6.1-sol，原生线程互不相同；记录在 `/tmp/foundry-dev006007-post-maintenance-trials.json`。
- 从公开 1792399633 安装目录直接调用生产 `startSession(role=verification, model="")`，原生线程 `01a15409-b716-7a52-8e8d-a0a726e405e1` 实际执行 `sed -n '2p' README.md` 并返回精确内容。回执为 `/tmp/foundry-dev006007-post-maintenance-verifier-smoke/receipt.json`。这是新的缺省模型独立验证冒烟，不冒充原改动型 Issue 的 Verify 或 Accept。
- 真实浏览器重新打开合成草稿页面，点击刷新后显示新的刷新时间、相同 v2 内容版本与可用 Trial 按钮；截图 `.foundry/attachments/dev006007/post-maintenance-drafts.png`。维护后的 API、环境文件和接受 journal 再次确认 `iss_108` accepted / integrated，原 candidate/review 身份未变，源目录干净，整个仓库仍仅原 baseline 一个 commit 对象。
- `iss_107` 仍为未确认 revision 4，blocked 原因为等待输入/明确确认。原 README 与 v2 Skill 摘要保持不变。下一步通过正常源文件提交处理 v2 baseline，再完成新增 result.txt 候选的自动快照、独立 Verify 与准确 review Accept；该链路尚未通过，不能用已完成的无差异场景替代。

本轮已消除“实际宿主未更新”的剩余项，DEV-006/007 继续保持进行中。当前未完成项是原改动型场景及之后的人工验收，历史部署段落只描述各自当时状态，以本节和文首摘要为当前结论。

## 改动型场景的最终闭环

2026-10-19 22:17，原 `iss_107` 已完成真实浏览器 Accept 与源工作区集成。本节覆盖前文尚未完成的原新增文件场景；不把历史独立 pass 或无文件差异场景当作替代。

### 候选与取证草案修订

- 将独立合成仓库中已验过的 v2 Skill 正常记录为基线 `55cbe9c7326fb96f78b7790ed0d79af5e4855003`，保留原文件字节。Foundry 源码主树仍为 `c2e46c6`，本轮未对它提交、推送或合并。
- 在页面审阅并确认 revision 4 / `sha256:2d4d4ae9a28335be0b095ce67b0c0563c006a310fdb9eb969b4f66819dcb29f0`；实施 Session `sess_1792418496425574746` 实际检查基线后新增 `result.txt`。自动快照产生候选 `76f1093bd15b6da07dd14d4c1532df62e83ca438`，相对基线只有 `A result.txt`。
- 两项程序检查通过。首次独立判断 `verify_a94fd11d-a974-4fb2-bcf2-94bd992fc572` 实际读取文件和差异，但改动范围 finding 没有证据引用，被严格门以 `pass_requires_cited_passing_findings` 拒绝。失败显示在页面，Accept 禁用；原始输出和失败历史保留。
- 进一步核查发现是合成取证草案遗漏：产品已支持 `candidate_changes` 系统导出，原第三条只要求 document 文件，没有 data 型改动清单。通过主聊天修订为同一候选的原文件文档及系统改动清单两项证据；基线与候选 commit 标识固定版本，从完整 changes 数组实际计数。没有修改产品源码、放宽引用门槛或伪造引用。
- 页面重新审阅并明确确认 revision 7 / `sha256:bd1e11528791a346c4a77e00e630ff8c66dac9c1813538a4be8f885ef0812fed`。目标、范围、约束、前两项程序检查与全部基线摘要经逐字段比较保持不变。新实施 Session `sess_1792419005499494152` 只读核对现有结果；候选 commit 仍为 `76f1093`，未制造额外文件改动。

### 当前证据与独立判断

页面自动建议并采集 `result.txt` 和系统生成的完整改动清单，无需手填材料 ID 或 HTTP binding。新封存候选 `snap_4eda2b75-5052-4d36-b92f-8c1224a44dce`，输入 `input_d5f78a4e-abf2-48d9-a7f8-d8177a30a75f`。

| 检查                          | 当前记录                                      | 结果                                |
| ----------------------------- | --------------------------------------------- | ----------------------------------- |
| 完整字节                      | `verify_6979cfed-c15f-42e5-87d1-7e107dd21a67` | pass，退出码 0                      |
| README / Skill 内容及文件集合 | `verify_7e259647-3cf4-41e3-a405-21c81c69f0c1` | pass，退出码 0                      |
| 独立文件阅读与改动范围        | `verify_b3ec51b7-15fa-461b-ba37-454be8bc14c8` | pass，两个 finding 分别引用实际材料 |

独立判断使用公开 1792399633 的缺省模型路径，原生 Codex 线程 `01a15480-61b0-7da1-b3d4-73bcdb9d906e` 与实施线程分离。原始活动包含读取候选 `result.txt`、完整差异及解析系统清单并累计 changes 长度；结论引用原文件第 1 行及清单字段，计数为 1，唯一记录为新增 result.txt。

- 原文件材料 `mat_2e96f7ca-9e62-4bcd-80ce-713634fdaa99`。
- 改动清单 `mat_208742a1-affb-4d9b-b1f5-10b18dc04668`，SHA-256 `60ff35104398acb180c5c7e1a9efcae222e3cb09867bdb71cebc2eba7399eb42`。已独立校验下载字节、候选身份、两个 commit 和完整 changes 数组。
- 原始判断材料 `mat_814a8b13-c13f-4a7f-bd05-6a7ae670b97b`，摘要已核验，归档 `/tmp/foundry-dev006007-changeful-verifier-proof.txt`。
- 判断局限保留：改动清单仅代表注册仓库和冻结 Git 跟踪交付文件，不代表忽略的外部输入。

### 负向与最终 Accept

- 缺少证据时，使用准确当时 review 的 Accept 请求仍返回 409。
- 第 7 版导出使用旧契约输入，返回 409 `input_changed`；使用另一合成 Issue 的输入，返回 404。没有把其他候选材料混入本次判断。
- 三项通过后，临时改变自己合成候选的 `result.txt`，review 立即变为 `candidate_changed`，原 eligible review 接受请求返回 409。恢复精确原始字节后，原 review ID 再次返回 409；重新读取当前 review 后才继续。没有改写候选 commit 或既有判断。
- 在真实页面明确 Accept 当前 `review_049b6940-e44a-4f95-bbaf-b2746445f8d0` / `sha256:a98170d848b2692ea3d80e4f1b3f78fdbb3c4c08ce11bf1bcd19c09c5170c9dc`。
- Issue 为 accepted，3/3 条件通过；环境 `env_1b18f78e-45e8-412f-b9ba-27da52238812` revision 3 为 integrated。接受 journal `acc_471ab295-c179-4200-ad65-0273f04d11ee` 为 integrated，准确绑定上述 review 和候选；决策 `decision_23096436-6b86-41df-bdce-a0e53da9ac96`，集成快照 `snap_c702ce11-50e0-4990-96eb-5f1e5b21525c`。
- journal 的 expected 为 v2 基线 `55cbe9c`、target 为候选 `76f1093`，仓库 applied；源 HEAD 实际为 target，只有新增 result.txt。源工作区 clean，文件精确 24 字节，README 与 v2 Skill 的原始 SHA-256 均未变。
- 页面重载后仍显示 Accepted and integrated；亮色桌面、暗色 390px 及两种实际证据预览已检查，窄屏 document/body 宽度均为 390px。

完整身份、API 结果、失败记录、负向回执及集成 journal 汇总在 `/tmp/foundry-dev006007-changeful-evidence.json`。截图在 `.foundry/attachments/dev006007/`：`changeful-system-evidence-plan.png`、`changeful-ready-after-verify.png`、`changeful-accepted-integrated.png`、`changeful-accepted-dark-390.png`、`changeful-result-evidence-dark-390.png`、`changeful-changes-evidence-dark-390.png`、`changeful-accepted-reloaded-light.png`。

本轮未改变源码或公开部署，沿用已通过的对应构建与回归，新增文档另行格式检查。当前交付是 dev-server Linux 本机范围；macOS 真实 Keychain 登录专项仍单独登记在 DEV-016，没有将本机结果扩大为跨平台实测。两项合成服务与 DB 保留供人工复验；一次性接续的归档需独立控制回执，不能用本答复结束替代。

### 已完成接续计划归档

2026-10-19 22:20，orchestrator 确认验收 owner 会话 completed 后，仅移除一次性接续 `work_5a71ddbc9f817ab5ea9e02547ec5ab44`。操作 `wop_4a28fcc8489a4371b6cde595ef628b4b` 的 remove 回执为 verified，revision 2。未调用 stop_all，未停止合成服务：Server revision 3、Worker revision 9 均 confirmed running，继续保留供人工验收。本项仍为待人工验收，不因计划归档自动关闭。

## 2026-10-20 显式委托准出记录

用户于 01:07 明确委托“你验证OK了的，你都先确认归档吧”。本轮按已验证范围由 Agent 准出，未追加用户本人测试的声明；历史未通过/待验条目是对应时点记录，不抹除。最终边界、浏览器/版本/合入证据见 [DEV-025](DEV-025-release-closure.md)。
