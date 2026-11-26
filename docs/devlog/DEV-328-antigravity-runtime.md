# DEV-328 第三个原生运行时：Antigravity（官方 `agy acp`，个人订阅登录）

本人 2026-11-23：「能同类地支持 gemini 的 antigravity 吗……鉴于他对反代的检测非常严格，我希望走官方途径」；「我就要用订阅。然后我这个是薄封装，因为我不喜欢 TUI。然后我在上面加了点自定义的 mcp 而已。」

## 调研结论（2026-11-23）

- 官方程序化入口：`agy acp`（ACP v1，stdio JSON-RPC，对标 Codex app-server）、`agy -p --output-format stream-json`（输入只收文本，无审批回路）、Python SDK `google-antigravity`（只收 API Key）、Gemini API Managed Agents（云端托管）。只有 CLI（`acp` / `-p`）支持 `oauth-personal` 订阅登录，所以选 `agy acp`。
- 条款：[Antigravity Terms](https://antigravity.google/terms/) §6 禁止 "third party software, tools, or services to access the Service"。论坛（2026-11-20，[thread 202970](https://discuss.ai.google.dev/t/tos-clarification-is-opencode-antigravity-acp-official-agy-acp-in-opencode-permitted-under-the-antigravity-terms-of-service/202970)）的口径：未修改的 `agy acp` 跑在 "Antigravity is the agent" 的薄客户端里可以；外层 harness 注入 system instructions、序列化工具定义、跨模型上下文或自动循环则不行。官方 [ACP 文档](https://antigravity.google/docs/ide/extensions/acp)支持编辑器提供 MCP（`--process-per-session` 用于编辑器配置的 HTTP MCP）。
- 本人决定用订阅。所以设计边界（下文 B1–B5）按薄客户端来定。

## 实测（本机，agy 1.5.15，装在 `/tmp/agy-bin`，HOME 为临时目录）

`initialize` 返回：`loadSession: true`；`promptCapabilities.image: true`、`embeddedContext: true`；`sessionCapabilities` 含 resume / load / list / close / additionalDirectories；`auth.logout`；`_meta.antigravity.systemPrompt.append: true`（不用）；authMethods 为 `oauth-personal`、`oauth-business`、`gemini-api-key`、`agent-platform`。未登录时 `session/new` 返回 `-32000 Authentication required`。`agy acp` 的 flag 含 `--gemini-dir`、`--app-data-dir`（每个账号一个独立 home）、`--login`（终端登录：打开 URL 后粘贴 code）和 `--process-per-session`。

## 设计边界

- B1 只运行官方安装器装的未修改 `agy` 二进制（自更新由 agy 自己负责），不传 `--override_user_agent_name`、`--cloud_code_endpoint` 等改身份或改端点的 flag。
- B2 登录走 agy 自己的流程（`agy acp --login` / ACP `authenticate`），凭据留在 OS keyring。Foundry 不读、不拷、不转发 token，额度和账号状态只从 agy 自己的输出读。
- B3 不用 `systemPrompt.append`，不注入行为指令。上下文靠工作区文件，由 agent 原生读取。
- B4 Foundry MCP 经 ACP `session/new.mcpServers` 交给 agent，这是官方支持的编辑器 MCP 形态。
- B5 没有自动选择：antigravity 档案不会自动成为助理 / worker group 的默认执行器，只在本人选择它时运行。

## 进展

| 时间（UTC+8）    | 内容                                             |
| ---------------- | ------------------------------------------------ |
| 2026-11-23 21:10 | 调研、ACP 实测、立项；实现交给独立 worktree 会话 |

## 运行时接入设计

基线 190f88e0 上，Go 源码中字符串字面量 `"codex"` 出现 441 次（含测试），Worker 的 69 个 src 文件包含该字面量。契约从 contracts/models 生成到 TypeScript 和 Go；更新调度表只负责安装更新，会话入口另有 dispatch。Web 的设备订阅、Chat 选模与默认执行器是三个不同的选择入口。

| ACP                                      | Foundry Chat                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| initialize                               | 确认协议版本、图像、内嵌资源和恢复能力                                       |
| session/new                              | 传 cwd、会话专用 stdio MCP，记录返回的原生 ID                                |
| session/resume、session/load             | 下一次输入或 Worker 重启后以原 ID 重新连接；load 重放期间不重复写 transcript |
| session/prompt                           | 本次输入正文，图像作为 image，已有文件作为 resource_link                     |
| session/update                           | 文本和思考按片段累积，工具按 toolCallId 更新                                 |
| session/request_permission               | 在当前 Chat 等待本人选择；拒绝、取消或超时都不授予权限                       |
| session/cancel                           | 中断当前输入，清理未完成的审批和子进程                                       |
| configOptions、session/set_config_option | 使用 agent 声明的 model 和 thought_level 选项及原始值                        |
| usage_update                             | 上下文用量取自原生通知；没有订阅额度数据时保留未知                           |

重新在临时 HOME 运行官方 1.5.15：initialize 协商为 1，session/new 返回 -32000 Authentication required；authenticate(oauth-personal) 返回 -32603，原因是没有图形浏览器，CLI 提示在终端运行 agy acp --login。

## 实现与验证

- 契约增加原生运行时、订阅登录的 profileId 和会话级 antigravityEffort。Server 在本人手动选择的 Chat 中保存档案、模型和原生会话 ID；自动选档、助理、worker group、自动重试和命名均绕开该订阅。跨档案移交历史和 fork 在入口报错。归档只影响 Foundry Chat。
- Worker 的 Chat dispatch 按运行时选适配器。ACP 进程由 Worker 的进程组管理器托管；每轮打开连接，沿用设备上保存的原生 ID。中途退出会结束正在等待的请求。原回合失去进程时保留现有 Worker 恢复语义，后续输入续接原生会话。官方 CLI 自更新，Foundry 的发布更新调度器继续只管理 Claude/Codex。
- agy 本地各入口共享 OS keyring。各档案独立存配置、会话和应用数据；每台设备只绑定最近成功登录的一个 Antigravity 档案。登录和退出需要拿到运行时独占锁，旧绑定在登录开始时失效。Foundry 无法核实其他应用在此后更改了 OS 中的 Google 登录。[Google 登录文档](https://antigravity.google/docs/install/)
- 模型和可用思考强度来自 agy 的 ACP catalog。工具审批交给 agy 提供的选项。普通消息在当前回合结束后作为下一次输入；账号额度缺少原生数据时显示未知。发现本机缺少 org.freedesktop.secrets 服务；订阅登录入口会明确报错。未做登录后的真实推理。
- 在远端运行 Worker build、Web build（含 TypeScript 检查）和两个定向 Worker 测试文件。Worker 测试命令为 `node scripts/run-worker-tests.mjs -- antigravity-turn.test.mjs antigravity-native.test.mjs`。ACP stub 检查启动 argv、会话专用 MCP、流式输出、审批、取消和新进程恢复，并断言 prompt 只含本人输入与附件。
- Server 定向检查覆盖本人选择、自动调度拒绝、设备登录转发、档案切换、原生历史保留和归档。Web 定向检查覆盖同设备两档案、助理和 worker group 默认值、设备运行时。Chromium 使用合成 API 点过新建、显示授权页、粘贴 code 和提交；这验证了页面与档案 ID 传递。
- 官方 1.5.15 仅实测未登录协议和终端授权入口。安装到 dev、用本人账号登录、真实工具调用与 Worker 服务重启均留待合入后的验收。

## 本人验收

1. 在已更新 Worker、有可用系统 keyring 的设备上，进入「模型提供方 → 订阅 → Antigravity 订阅」。若显示缺少 CLI，先点安装。点目标设备的「新增订阅档案」，输入档案名并登录。
2. 打开 agy 显示的 Google 链接，用个人订阅授权，把返回的 code 粘回同一登录对话框。预期该档案通过检查并显示设备端模型目录。
3. 在目标工作区新建 Chat，手动选择刚才的 Antigravity 档案；发送一张图片并让它描述内容，再让它用 Foundry MCP 查询当前工作区。预期可看到流式回答和工具事件。触发原生权限请求时，点选 agy 提供的选项并核对其执行结果。
4. 中止一次运行，确认该输入停止。记住一段仅存在该对话里的文本；在设备没有其他活跃任务时重启测试 Worker，再次打开同一 Chat 追问。预期继续同一原生会话，历史回答不会重复出现。

## 群内经验（「地狱焚诀 Agent 交流群」，2026-05-23 起关键词检索，非官方，2026-11-23）

- 报告的封号集中在：反代（CPA 等）、把号借给别人用、同一 session 多账号轮转、同一出口 IP 挂很多号、高吞吐（一例约 450 请求/小时出现 ToS 403）。有人说最近只封 agy、Pro 网页仍能用。申诉多数能成功，也有被秒拒、解封后再被封的。
- 群内的经验做法是每个号限 1–2 个并发。没人报告"单个人号、低并发、只用官方 agy"被封的案例，但这只能说明没人报告，不能证明安全。没找到长期用 `agy acp` 接工具的经验，也没找到挂 MCP 或 keyring 的讨论。
- 地区：有人说本机不走 sg 出口就用不了 agy，或者提示 location 不支持；也有人说不受限，说法不一。
- 和本实现的关系：B1–B5 已经排除了反代、多号轮转和自动循环。还没限制的一项是同一档案的并发 Chat 数（现在由本人手动开 Chat 的数量决定）。

## 部署（dev，2026-11-23 23:25 UTC+8）

- 合入方式：实现会话 `sess_1795439421594534410` 交回补丁（`.foundry/attachments/DEV-328/antigravity.patch`），应用到 `~/workspace/foundry`（main `ebc53cc8` 加上 DEV-328 未提交改动）。我修了两处 UI 审计问题：`runtime-mark` 品牌名的豁免注释放错了位置；`issues-feature.tsx` 超过 350 行，把过滤逻辑抽成 `issueEligibleAgents`。
- 批量检查（byte-dev，因为 CanWendeMac-mini 的计算通道无应答）：Server Go 定向测试、Web tsc 加 121 个测试文件、UI 审计、契约审计、protocol 构建与测试、Worker tsc，全部通过。Worker 159 个测试文件分 4 组跑，只有 `native-archive.test.mjs`「installed Codex archives a scratch cascade…」失败。它在干净的 main 上也失败，依赖 byte-dev 上装的 Codex CLI，和本项无关。
- 部署门槛拦下了第一次部署：线上 Server 和 Web 里有 PR #305（路由）的改动，当时还没进共享树。#305 合入 origin/main（`ebc53cc8`）后快进本地 main；逐文件核对线上 manifest 和新 manifest 的差异，剩下的都属于 DEV-328、生成文件、文档格式化，或者是已提交文件的更新版本，然后带 `--replaces` 部署。
- 版本：Server `54e01b199a1c`（回滚副本 `foundry-server.pre-dev328`），Web `f499fe2e6957b7a9`（之前的 `7c0496848b8616f7` 保存在 `releases/dev328/`），Worker `0.5.7-dev.395.gf4a433ad.local.1795446172`。CanWendeMac-mini、byte-dev、sg-chaos 三台均已更新并在线。
- 线上核对：`list_profiles`（CanWendeMac-mini）出现 `antigravity_local`（runtime `antigravity`），状态「Install the Antigravity CLI on this device.」。

## 补丁（2026-11-23 23:40 UTC+8）

- MCP `sign_in_subscription` 新增 `action: install_cli`，由 `sess_1795448020703475995` 实现，3 个 Go 定向测试通过；格式化了 `mcp_tools.json`。Server `af039d5befc0` 已上线（回滚副本 `foundry-server.pre-dev328b`）。实测在 CanWendeMac-mini 上调用该操作，返回 `{"ok":true,"runtime":"antigravity","version":"1.5.15"}`；`antigravity_local` 变为 `missing_auth`（「Sign in to this Antigravity profile.」）。随后用 MCP 发起登录，返回 Google 授权链接，`codeEntry: true`。
- Mac 计算通道 `device_error` 的根因：同一租约内等待空 slot 的 run 占住了 Worker 的串行请求队列约 825 秒（`sess_1795448028984725250` 诊断）。残留 slot 已清理，`echo ok` 前后两次实测都通过。修复把重试移到调用端（`scripts/lib/remote-compute.sh` 加 `scripts/test-remote-slot-contention.sh`），已合入共享树，脚本改动不需要部署。

## 补丁：agy 错误识别与同号重试（2026-11-25 12:01 UTC+8）

- 依据 agy-rotate（commit d170d46，只读，`sess_1795577375670315818`）观察到的 agy 行为。本人决定不做多号轮转（2026-11-25：「先不做多号轮转，只参考他们的一些处理修复我们已有的问题」）。实现见 `sess_1795578150183350491`：`⚠ … (code N)` 和地区错误收尾的回合判为失败，原因分为 quota / region / auth / transient；quota 进入「等你处理」并发通知；401 在同一回合、同一档案、同一会话里重试 1 次，transient 重试 2 次，只在还没有模型输出或工具活动时重试；`session/load` 之后、prompt 之前收到的更新被过滤。Server 仍不调度重试。
- 合入时 origin/main 已前进到 `c276f3e9`（#314–#318）。共享树里 DEV-331 的未提交副本有 105 个文件与 upstream 一致，19 个文件做了三方合并，只有 3 个文档冲突（旧状态对新状态，取 upstream）。合并前的整树备份在 `/tmp/shared-tree-backup-*.patch`。
- byte-dev 定向检查全部通过：antigravity 两个测试文件（3 项）、Worker tsc、Web typecheck，以及 Server `TestAntigravity|Pending|PersonNotice|TestSignInSubscription`。
- 部署 `--label dev328c`：Server `4dd5a43b20c2`（回滚副本 `foundry-server.pre-dev328c`），Worker 包 `0.5.7-dev.409.gc276f3e9.local.1795578879`，Web 构建号不变（`a2886d5d717f92e0`）。线上 Server 原为 DEV-331 合入前的 `dev331-fix`；与新构建不同的 7 个文件不在任何提交中，属于 DEV-331 评审修复前的版本，已被 #315 取代（其中一个文件仍叫 DEV-329 的旧编号），确认后带 `--replaces` 部署。
- 调研结论（未登录的 agy 1.5.15）：握手声明了 `_meta.antigravity.tier: true`；ACP `usage_update` 只有上下文 token 用量和可选成本；订阅额度在 agy 的 `/usage` 面板。登录后 ACP 是否带余额或重置字段：未核实。同一档案的两个进程并发刷新 keyring 是否互相覆盖：未核实，并发策略不变。

## 补：额度提示写明是哪一套额度（2026-11-25 21:56 UTC+8）

- 参考 nwverse/persona 的 `docs/plan-antigravity.md`（只是方案，没有落成代码；结论是个人订阅不建议驱动 agy，见 `sess_1795613225575543529`）：agy 的 Gemini 模型与 Claude/GPT 模型分开计额度，各自有每周和每 5 小时两个窗口。本人决定只做这一条（2026-11-25「只做第1条」）。
- 额度失败的原因改成「Antigravity Gemini quota exhausted for profile X, model M」或「Antigravity Claude/GPT quota exhausted …」，按本轮所用模型判断；没有明确模型（用 agy 默认）时不写是哪一套。服务端按「quota exhausted」识别，不受影响。测试覆盖 Gemini 与非 Gemini 两种（byte-dev，`antigravity-turn.test.mjs` 通过）。
- Mac 远程测试报「Cannot identify runtime lease owner」：远程计算作业里 `/bin/ps` 读不到进程启动时间，属于测试环境问题。真实回合与 Claude/Codex 走同一个 `acquireRuntime`，Codex 在 Mac 上正常。
- 部署 `--label dev328d`，只换 Worker：`0.5.7-dev.409.gc276f3e9.local.1795614842`。与线上 dev333 的包相比只有 `antigravity-turn.js` 不同，protocol 包一致。

## 未完成

- 登录后的真实对话、工具审批、续接和 Worker 重启：等本人登录订阅后验收。

## 原生回合错误与额度可见性（2026-11-25，实现会话的记录；已随 dev328c 合入部署，见上文）

- Worker 识别回合末尾的原生错误。额度耗尽写入所选档案，重置时间仅取自原生提示。Server 沿用终态失败待处理项，额度项通过本人现有的 ask 通知设置投递；同一条目沿用原有去重规则。
- 本人输入遇到 401 或临时服务、网络错误时，Worker 保留原进程 3.5 秒，随后以同一档案、同一原生会话 ID 和同一份输入块恢复。401 最多重试一次，临时错误最多两次；已有回答、思考、工具、计划或审批时直接报错。load 的输入边界取自写出 prompt 的时刻，ACP 在收到帧时过滤此前的更新。原生协议若在 prompt 发出后才交付没有来源标记的历史，客户端无法仅凭到达时间区分它。
- 在临时 HOME 下运行未登录的官方 `/tmp/agy-bin/agy acp`，initialize 返回 1.5.15、ACP 1 和 `_meta.antigravity.tier: true`。这个布尔值只声明能力。session/new 返回 -32000 Authentication required，因此没有登录后的 configOptions、usage_update 或逐会话 _meta 样本。二进制有 TierInfo.Meta、usageFromModelUsageStats 和 serverTurns.RetrieveUserQuotaSummary 符号；这些只能证明内部实现存在。公开 ACP 的 usage_update 定义了上下文已用和上限 token 数、可选会话成本。Google 文档把模型组五小时和每周额度列在交互式 /usage 面板中。未确认 1.5.15 会向 ACP 客户端发布可依赖的订阅余额或重置字段，本次只调研。[ACP schema](https://agentclientprotocol.com/protocol/v1/schema#usageupdate) · [Google ACP 指南](https://antigravity.google/docs/cli/acp/) · [Google /usage 指南](https://antigravity.google/docs/cli/commands/usage/)
- 同档案双进程刷新 keyring 是否互相覆盖：**未核实**。官方说明 CLI 和编辑器共享登录、复用缓存凭据，未描述跨进程刷新写入的顺序或冲突处理。未登录进程无法触发刷新；无同档案并发刷新日志。补丁沿用原有并发策略。[Google 登录文档](https://antigravity.google/docs/install/)
- 定向验证：CanWendeMac-mini 完成一次 Worker 类型检查，测试在进入 ACP 前因运行时租约无法识别进程而停止（Cannot identify runtime lease owner）。改在 byte-dev 仅转译并运行 antigravity-turn.test.mjs，最终样例全部通过，包括同号恢复、重试上限、部分输出、延迟历史、地区和额度详情。Server 的 TestAntigravityQuotaCreatesOneNotifiableFailure 通过，确认单条额度待处理项、通知资格和禁用 Server 重试。通知路由用合成记录验证；真实账号推理与卡片投递留待集成验收。
