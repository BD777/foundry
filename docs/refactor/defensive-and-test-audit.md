# 防御性代码与测试冗余抽样审计

来源：2026-11-02 只读抽样（未构建、未跑测试）。排除正在改动的 Issue / Feishu / Run 相关 Server 文件。原则：不兼容旧 Worker、旧 Server、旧数据；一条规则只有一个真相来源（信任边界除外）；无用即删；HTTP/MCP 输入、设备消息、文件路径、鉴权的校验保留。

缩写：`S/` = `apps/server/internal/`，`W/` = `packages/worker/src/`，`Web/` = `apps/web/src/`。

**结论：整体不算臃肿。** 测试/生产比 0.5–1.0，属正常；测试以场景式、经公开接口为主（Go 表驱动 `t.Run` 只有 55 处）。真正可删的集中在三类：遗留兼容分支（含 `legacy-inventory.md` 漏列的几处）、同一规则在 handler → service → store 多层重复检查、Web 端读源码做正则断言的测试。估计可删约 2–5k 行，占约 0.5–1.3%。

## 1. 度量

| 区域                                     | 生产行  | 测试行 | 测试/生产 | 最大测试文件                                                                                                     |
| ---------------------------------------- | ------- | ------ | --------- | ---------------------------------------------------------------------------------------------------------------- |
| `S/httpapi`                              | 38,309  | 37,403 | 0.98      | `server_test.go` 2,144（单个函数 `TestDaemonWebSocketFileReadAndAgentSession` 393 行）、`profiles_test.go` 1,052 |
| `S/sqlitestore`                          | 24,538  | 13,630 | 0.56      | `session_work_test.go` 611、`native_sessions_test.go` 549                                                        |
| `S/sessions`                             | 1,887   | 175    | 0.09      | 主要由 httpapi 测试覆盖                                                                                          |
| `S/personalagent`（含 assistant 5,558）  | 9,808   | 1,064  | 0.11      | assistant 只有 114 行测试，覆盖偏少，不是过多                                                                    |
| Server 合计（`internal` / 全部 `_test`） | 103,553 | 62,749 | 0.61      |                                                                                                                  |
| `W/`（281 个文件）                       | 74,574  | 50,434 | 0.68      | `session-work` 1,363、`session-files` 1,312、`resource-operations` 1,296                                         |
| `Web/`（568 个文件，其中 i18n 13,028）   | 104,056 | 49,197 | 0.47      | `external-accounts` 1,524、`device-held-connectors` 1,484                                                        |

模式计数（grep 启发式，排除 Issue/Feishu/Run 文件）：

| 模式                                    | Server Go（91.7k）                                                        | Worker                                                                            | Web                                                       |
| --------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 非 err 的 `== nil` 判断                 | 300；方法首行接收者 nil 守卫 8 处（均为有意的 nil 语义或惰性 map 初始化） | —                                                                                 | —                                                         |
| `TrimSpace` / `.trim()`                 | 647（httpapi 297、sqlitestore 166、personalagent 65）                     | 385                                                                               | 241                                                       |
| `catch` 总数 / 空 `catch {}`            | —                                                                         | 494 / 17（全在 execution-host、runtime-isolation、archive 锁：文件/进程尽力而为） | 239 / 0                                                   |
| `typeof x === …`                        | —                                                                         | 238（前几名 `sdk-messages` 28、`cua-driver` 13、`models` 8，均解析外部数据）      | 50                                                        |
| `?? '' / ?? []` 等                      | —                                                                         | 180                                                                               | 213（抽 12 处均为可选字段）                               |
| legacy/compat/fallback 字样             | 121                                                                       | 135（多数是 `openai_compatible` 命名，真兼容 ≤5 处）                              | 240（多数是 i18n/CSS fallback，真"旧 Worker"回退约 6 处） |
| 测试数                                  | 1,104 个 `Test*`                                                          | 1,133                                                                             | 996                                                       |
| 断言错误文案                            | 43 处 `err.Error()` 子串                                                  | 364 个 rejects/throws，56 处带消息正则                                            | —                                                         |
| 断言调用顺序/调用记录                   | 3                                                                         | 45（多为发往 Server 的请求体，属于契约）                                          | 57                                                        |
| 读源码做正则断言                        | —                                                                         | —                                                                                 | 7 个文件、77 处 `assert.match(source…)`                   |
| 断言界面文案                            | —                                                                         | —                                                                                 | 398 处（用户可见行为，合理）                              |
| Worker 宣告但 Server/Web 从不读取的能力 | —                                                                         | 49 个中有 26 个（`W/daemon/workspace-ops.ts:464`）                                | —                                                         |

## 2. 抽样（35 例）

a = 删除，b = 收拢/合并，c = 保留（信任边界或真实不变量）。

| #   | 位置                                                                                                                                     | 现象                                                                                       | 类  | 理由                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --- | ----------------------------------------------------------------------------------------------------- |
| 1   | `S/sqlitestore/session_work.go:271-273`                                                                                                  | `Observation.Error != ""` 在 266 行已 return，此处不可达                                   | a   | 死代码                                                                                                |
| 2   | `S/sqlitestore/session_work.go:212-249`                                                                                                  | `stop_all` 与 `pause_all` 两个循环主体逐行相同                                             | b   | 抽成一个带过滤函数的循环                                                                              |
| 3   | `S/sqlitestore/session_work.go:270-283`                                                                                                  | `ConfirmedRevision` 与 `target.Revision` 比较 3 次                                         | b   | 合成一个 if/else                                                                                      |
| 4   | `S/sqlitestore/session_work.go:548-557`                                                                                                  | "Old workers omit classification"                                                          | a   | 当前 Worker 恒发 `processRole`（`W/session-work/detached-processes.ts:102`）；对应 inventory B19 ❓   |
| 5   | `S/sqlitestore/session_work.go:291-297`                                                                                                  | `Native == nil` 时伪造 "legacy native agent lifecycle"                                     | a?  | 需先核实 Worker 对 claude/codex 项恒发 `native`（`W/session-work/supervisor.ts:855`）                 |
| 6   | `S/sqlitestore/session_work_test.go` `…SurviveLegacyReports`（45 行）、`…UnclassifiedProcesses…`（23 行）                                | 只测 #4 的旧 Worker 路径                                                                   | a   | 随 #4 删                                                                                              |
| 7   | `S/httpapi/mcp_resources.go:589-613` `prepareMacWindowActions`                                                                           | 补 `delivery_mode: background`、`activate_window` 必须 foreground、旧 Worker 截图需 target | a   | Worker 执行器已做同样的事（`W/resources/providers/cua-driver.ts:96,168`）；截图分支只为旧 Worker 存在 |
| 8   | `S/httpapi/mcp_resources.go:324-326,582-587`                                                                                             | `windowScope == "v1"` 能力门                                                               | a   | 当前 detector 恒报 `v1`（`W/resources/detectors/computer-use-cua-driver.ts:136`）；inventory 漏列     |
| 9   | `S/httpapi/macos_window_scope_test.go`（52 行）                                                                                          | 测滚动升级与能力门                                                                         | a   | 随 #7/#8 删                                                                                           |
| 10  | `W/daemon/workspace-ops.ts:464-512`                                                                                                      | 26 个能力字符串（`attachment_files`、`reply_chunk_ack`、`native_history_v1`…）无人读取     | a   | A1 只删了 Server 端检查，宣告端还在                                                                   |
| 11  | `S/httpapi/skills.go:593-597` → `workspace_lifecycle.go:397,408` → `S/sqlitestore/skills_catalog.go:638-641`                             | 同一个 workspaceId 被 trim + 判空 4 次                                                     | b   | 只留 handler 一处（路由参数本就非空）                                                                 |
| 12  | `S/sessions/lifecycle.go:139-141` 与 `S/sqlitestore/agent_sessions.go:754-758`；`agent_sessions.go:330-334`                              | "message/prompt is required" 在 service 与 store 各查一次                                  | b   | 保留 service（返回 400），store 不再重复                                                              |
| 13  | `S/sessions/lifecycle.go:124` 与 `S/sqlitestore/agent_sessions.go:751`                                                                   | `Role != ""` 两层都查                                                                      | b   | 只留事务内一处（防 TOCTOU），409 在错误映射里统一给                                                   |
| 14  | `S/sessions/inbox.go:149` 与 `S/sqlitestore/session_inbox.go:154`                                                                        | `NormalizeChatAttachments` 同一进程内跑两遍                                                | b   | 规范化一次                                                                                            |
| 15  | `S/sqlitestore/profiles.go:128`                                                                                                          | 再次 trim `httpapi/profiles.go:53` 已 trim 的 ID                                           | b   | 边界已规范化                                                                                          |
| 16  | `S/httpapi/devices_http.go:64`、`workspace_lifecycle.go:382`、`chat_titles.go:56`、`S/store/chat_layout.go:24`、`service_tunnels.go:260` | "1–120 字符、单行"写了 5 遍，`service_tunnels` 按字节算，其余按 rune                       | b   | 是边界校验，保留，但收成一个 helper（顺带修掉字节/rune 不一致）                                       |
| 17  | `Web/components/skills/skill-version-state.ts:76-77`                                                                                     | 复制 Server 的技能名正则与 64 上限（`S/skillarchive/archive.go:23`）                       | b   | 规则只留 Server；Web 需要预检时从 protocol 导出常量                                                   |
| 18  | `Web/…/device-rename-dialog.tsx:68` 等 `maxLength={120}`                                                                                 | 原生输入框长度提示                                                                         | c   | 不含逻辑，只是交互提示                                                                                |
| 19  | `S/httpapi/mcp_attachments.go:48,57,74`                                                                                                  | `h == nil` 接收者守卫                                                                      | c   | nil 有意表示"无附件"                                                                                  |
| 20  | `S/httpapi/registration_sections.go:131`、`skills.go:227`、`daemon_conn.go:185`                                                          | 惰性 map 初始化                                                                            | c   | Go 惯用写法，改了没有收益                                                                             |
| 21  | `S/personalagent/assistant/maintenance.go:216`、`run_control.go:153`、`operations.go:166`、`inbox.go:120`                                | `role_run_budgets_v1` / `exact_input_cancel_v1` 能力门                                     | c   | 执行宿主滞后是实时状态（inventory C2 已决定保留）                                                     |
| 22  | `W/execution-host/client.ts:511,524`；`service.ts:301`；`session/chat/native-archive.ts:137`                                             | 读/删状态文件的空 `catch {}`                                                               | c   | 文件缺失是预期状态                                                                                    |
| 23  | `W/execution-host/client.ts:515`                                                                                                         | `writePrivateJSONAtomic` 失败被吞掉                                                        | b   | 至少打日志，否则重启后的排空保持时间会悄悄丢失                                                        |
| 24  | `W/harness/models.ts:151-213`；`W/session/runner/sdk-messages.ts`（28 处 typeof）                                                        | 对 `/models` 响应和 SDK 流做形状检查                                                       | c   | 外部第三方数据                                                                                        |
| 25  | `W/daemon/handlers/files.ts:240-243`                                                                                                     | 检查 read_device_file 的 path/mode                                                         | c   | 设备文件访问的最后一道闸                                                                              |
| 26  | `W/session/worker-failure.ts:33-38`                                                                                                      | 注释称"为旧 Server 保留"的 `sessionCompleted`                                              | c   | 它其实是在用的结束路径，Server 只透传 `workerFailure`；改注释即可                                     |
| 27  | `Web/features/chat/thread/chat-model.ts:91-96`、`transcript-adapters.ts:21`                                                              | 没有 transcript 时用正则解析 `handoffContext` 重建消息                                     | a?  | 旧 handoff 记录的兼容；先查库确认是否还有不带 transcript 的 chat                                      |
| 28  | `Web/features/chat/chat-types.ts:199-200`、`detail/chat-detail-change.tsx:54`、`context/chat-schedule-model.ts:143`                      | "older workers/devices" 回退                                                               | a   | inventory 漏列 Web 端旧 Worker 回退                                                                   |
| 29  | `apps/web/test/evidence-readiness.test.mjs`（32 行）                                                                                     | 读 4 个源文件做正则断言                                                                    | a   | 测的是源码文本，不是行为                                                                              |
| 30  | `apps/web/test/model-combobox-scroll.test.mjs`（199 行）                                                                                 | 用正则断言 `Popover.Root modal` 与 CSS 规则                                                | b   | 不变量是真的，但应改成一条 `scripts/audit-*.mjs` 规则或渲染断言                                       |
| 31  | `apps/web/test/theme-contract.test.mjs`、`latin-punctuation-font.test.mjs`                                                               | CSS token 契约                                                                             | c   | 有意的设计审计（建议并入 `audit:ui`）                                                                 |
| 32  | `S/connectors/cloudflare_writes_test.go:269` 等 43 处                                                                                    | `strings.Contains(err.Error(), …)`                                                         | c   | 用来区分用户可见的失败原因；数量少                                                                    |
| 33  | `packages/worker/test/resource-operations.test.mjs:281-341`                                                                              | 11 个参数非法用例                                                                          | c   | 执行器对 Agent 输入的边界校验；每条对应不同分支                                                       |
| 34  | `apps/web/test/*` 398 处文案断言                                                                                                         | 按英文文案定位/断言                                                                        | c   | 测的是用户可见行为                                                                                    |
| 35  | `S/httpapi/server_test.go:1062`（393 行）                                                                                                | 单个测试覆盖文件读取 + 会话                                                                | b   | 只拆不删                                                                                              |

合计：a 11（含 2 个 a?），b 12，c 12。抽样是从可疑热点 grep 出来的，所以 a/b 占比明显高于全量代码。

## 3. 可删量估算

| 区域                    | 生产可删/可收拢     | 测试可删      | 依据                                                                 |
| ----------------------- | ------------------- | ------------- | -------------------------------------------------------------------- |
| Server（91.7k / 57.8k） | 0.7–1.8k（约 1–2%） | 0.3–0.9k      | 遗留分支各 20–60 行；多层重复检查每处 4–15 行，按 TrimSpace 热点外推 |
| Worker（74.6k / 50.4k） | 0.1–0.3k            | 0.15–0.5k     | 能力清单 + 少数吞错；typeof/catch 基本都是边界                       |
| Web（104k / 49.2k）     | 0.2–0.5k            | 0.5–1.4k      | 约 6 处旧 Worker 回退、handoff 解析；7 个读源码测试                  |
| 合计                    | **约 1–2.6k**       | **约 1–2.8k** | 占三区总量约 0.5–1.3%                                                |

不确定度约 ±2 倍：样本偏向可疑点（会高估），但只读了少数文件（未读到的冗余会低估）；Issue 相关代码未计入。

## 4. 清理时的机械规则

1. **规则只在边界查一次**：HTTP/MCP handler、daemon 入站、Worker 执行器。内部 service/store 不再对同一字段做 trim + 判空；store 依赖 schema 约束（NOT NULL / FK）。例外：必须在事务内重查的状态（防 TOCTOU）。
2. **跨端只有一个主人**：HTTP 输入规则归 Server；设备上的执行规则（路径、computer-use 参数）归 Worker；Web 只做原生 `maxLength`/`required` 这类提示，不复制正则或枚举，需要时从 `packages/protocol` 导出常量。
3. **能力门**：Worker 宣告但无人读取的能力直接删；Server 端只保留 inventory 中 `verification_sessions` 与执行宿主相关的几项。
4. **兼容分支**：注释含 older worker / legacy / rolling upgrade / predate 的分支逐条核对，删除时同时删除名字含 Legacy/Old/Upgrade 的对应测试；结果回写 `legacy-inventory.md`（本次新发现 #7、#8、#10、#27、#28）。
5. **不可达与重复分支**：同一函数内已 return 过的条件不再判断；逐行相同的循环合并。可以先跑一次 `staticcheck` 和 `deadcode` 找线索，但删前要逐处读代码确认。
6. **测试**：读源码做正则断言的测试，要么删，要么并入 `scripts/audit-*.mjs`；只删和被删代码一一对应的测试；大测试只拆不删。
7. **不要动**：解析外部数据的 typeof、文件/进程尽力而为的 catch、区分失败原因的错误文案子串、用户可见文案断言、nil 接收者语义、惰性 map 初始化。

## 5. 风险

- **并发改动**：Issue/Feishu/Run 相关文件正在被另一个 Agent 修改，本次没有采样；涉及 `S/sqlitestore` 和 `sessions` 的收拢要等它合入后再做。
- **单闸门**：删掉 Server 侧 computer-use 预检（#7）后，Worker 成为唯一闸门。需先确认所有在线设备的 Worker 都包含 `cua-driver.ts:96/168`（⏸ 类）。
- **store 的其他调用者**：store 也被 personalagent、feishu、MCP 调用，删 store 层检查前要逐个确认调用点都已过边界校验。
- **旧数据**：#5、#27 要先只读查开发库，确认没有不带 `native` 的 agent 项、没有不带 transcript 的 chat。
- **回归网**：本次估计的测试可删量只包括随代码一起删的测试；不建议为了缩短而删行为测试——它们大多数测的是公开行为。

## 6. 清理状态（2026-11-02 第一轮）

| #       | 状态   | 说明                                                                                                                                                                                                                                                                                                                  |
| ------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1、3    | 完成   | `workOperationState` 逐项分支收成一个 if/else，不可达的 `Error` 判断删除                                                                                                                                                                                                                                              |
| 2       | 完成   | `stop_all` / `pause_all` 合成一个循环，按动作选目标过滤与期望状态                                                                                                                                                                                                                                                     |
| 4、6    | 完成   | 删除旧 Worker 的 `processRole` 继承、未分类进程的 `processes: unverified` 推断、"legacy stop" 分支（当前 Worker 自己沿用分类：`W/session-work/supervisor.ts` `reconcile`）；"已确认退出不被 unknown 覆盖"是现行不变量，保留并改注释。`…UnclassifiedProcesses…` 删除，`…SurviveLegacyReports` 去掉旧路径断言后改名保留 |
| 5       | 完成   | 开发库只读核对：28 行不带 `native` 的 claude agent 项（最新 2026-10-16）是已存数据，读路径的 `Native == nil` 判断保留；写入时伪造 native 只服务旧 Worker（当前 Worker 恒发），删除                                                                                                                                    |
| 7、8、9 | 完成   | Worker detector 恒报 `windowScope: v1`，`cua-driver.ts` 已补 background、要求 `activate_window` foreground；删 `prepareMacWindowActions` 与 `windowScope` 判断及 detector 中这条无人读的 detail。`select_window` 仍只对 macOS cua-driver 后端开放（真实后端差异）；测试只留这一条                                     |
| 10      | 完成   | 逐个 grep 后删 37 个无人读取的能力及其 protocol 常量与断言；保留被 Server 读取的 7 个，以及 `issue_sessions`、`issue_clarification`、`feishu_gateway`（同样无人读，等 Issue/Feishu 重构合入后再删）                                                                                                                   |
| 16      | 完成   | `store.ValidDisplayName`：设备、Workspace、聊天标题、聊天分组、服务名统一按 rune 计 1–120、单行（开发库 42 个分组名均符合）                                                                                                                                                                                           |
| 17      | 完成   | Web 去掉正则与 64 上限，只留"不能为空"；非法名由 Server 预览的 problems 显示                                                                                                                                                                                                                                          |
| 23      | 完成   | 写 `switch.json` 失败打日志；读失败仍按缺文件处理                                                                                                                                                                                                                                                                     |
| 27      | 跳过   | 开发库仍有 45 个未归档 chat 只有 `handoffContext` 没有 transcript，回退仍在用                                                                                                                                                                                                                                         |
| 28      | 改注释 | 不是纯旧 Worker 回退：`diff` 在回合结束前本来就缺，按文件类型判断仍需要；定时器的空闲推断也覆盖事件里看不到的运行。只删"older workers"说法                                                                                                                                                                            |
| 29      | 完成   | 删除                                                                                                                                                                                                                                                                                                                  |
| 30、31  | 完成   | 不变量并入 `apps/web/scripts/audit-style-invariants.mjs`（`pnpm audit:style-invariants`，已接入 `audit:ui`），删除 3 个读源码测试                                                                                                                                                                                     |
| 11–15   | 未做   | 等 sessions/store 的 Issue 重构合入                                                                                                                                                                                                                                                                                   |
